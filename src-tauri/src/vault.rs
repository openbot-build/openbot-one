//! Private native credentials. The disk index contains only random IDs and
//! flags. An OS write never enables restore by itself: the caller must publish
//! its ID after checking the current service and request generation.
#[cfg(test)]
use crate::credentials::Backend;
use crate::credentials::{Action, Credentials, Purpose, Reply};
use crate::service::ServiceOrigin;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::time::Duration;
use std::{
    io::{Read, Write},
    path::PathBuf,
};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const LIMIT: usize = 16 * 1024;

pub(crate) use crate::credentials::Error as VaultError;

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Index {
    version: u8,
    generation: String,
    active: bool,
    pending_delete: bool,
}

#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
pub(crate) struct SavedSession {
    version: u8,
    generation: String,
    origin: String,
    pub account: String,
    pub cookie: String,
}

pub(crate) enum Loaded {
    Empty { cleanup_pending: bool },
    Missing,
    Saved(SavedSession),
}

pub(crate) struct Permit {
    origin: ServiceOrigin,
    generation: String,
}
pub(crate) struct Vault {
    root: PathBuf,
    store: Credentials,
}
impl Vault {
    #[cfg(test)]
    pub(crate) fn disable_for_test(&mut self) {
        self.store.disable_for_test();
    }
    pub fn new(root: PathBuf) -> Self {
        let store = Credentials::new(&root, Purpose::Sessions);
        Self { root, store }
    }
    #[cfg(test)]
    fn with_backend(root: PathBuf, backend: Box<dyn Backend>, wait: Duration) -> Self {
        Self {
            root,
            store: Credentials::with_backend(backend, wait),
        }
    }
    fn path(&self, origin: &ServiceOrigin) -> PathBuf {
        self.root.join(format!(
            "{:x}.json",
            Sha256::digest(origin.as_str().as_bytes())
        ))
    }

    fn index(&self, origin: &ServiceOrigin) -> Result<Option<Index>, VaultError> {
        let file = match std::fs::File::open(self.path(origin)) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(VaultError::Metadata),
        };
        let mut bytes = Vec::new();
        file.take(1025)
            .read_to_end(&mut bytes)
            .map_err(|_| VaultError::Metadata)?;
        let index: Index = serde_json::from_slice(&bytes).map_err(|_| VaultError::Metadata)?;
        if bytes.len() > 1024
            || index.version != 1
            || uuid::Uuid::parse_str(&index.generation).is_err()
            || (index.active && index.pending_delete)
        {
            return Err(VaultError::Metadata);
        }
        Ok(Some(index))
    }

    fn write_index(&self, origin: &ServiceOrigin, index: &Index) -> Result<(), VaultError> {
        std::fs::create_dir_all(&self.root).map_err(|_| VaultError::Metadata)?;
        let mut file =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|_| VaultError::Metadata)?;
        serde_json::to_writer(&mut file, index).map_err(|_| VaultError::Metadata)?;
        file.flush().map_err(|_| VaultError::Metadata)?;
        file.as_file()
            .sync_all()
            .map_err(|_| VaultError::Metadata)?;
        file.persist(self.path(origin))
            .map_err(|_| VaultError::Metadata)?;
        #[cfg(unix)]
        std::fs::File::open(&self.root)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| VaultError::Metadata)?;
        Ok(())
    }

    async fn call(&self, origin: &ServiceOrigin, action: Action) -> Result<Reply, VaultError> {
        self.store
            .call(
                &format!("{:x}", Sha256::digest(origin.as_str().as_bytes())),
                action,
            )
            .await
    }

    /// Disable restore before any native write. A late/timed-out OS write must
    /// not enable a credential after logout, cancellation, or a service change.
    pub fn begin(&self, origin: &ServiceOrigin) -> Result<Permit, VaultError> {
        let generation = uuid::Uuid::new_v4().to_string();
        self.write_index(
            origin,
            &Index {
                version: 1,
                generation: generation.clone(),
                active: false,
                pending_delete: true,
            },
        )?;
        Ok(Permit {
            origin: origin.clone(),
            generation,
        })
    }

    pub async fn stage(
        &self,
        permit: &Permit,
        account: &str,
        cookie: &str,
    ) -> Result<(), VaultError> {
        if account.is_empty() || account.len() > 512 || !valid_cookie(cookie) {
            return Err(VaultError::Invalid);
        }
        let value = SavedSession {
            version: 1,
            generation: permit.generation.clone(),
            origin: permit.origin.as_str().into(),
            account: account.into(),
            cookie: cookie.into(),
        };
        let serialized =
            Zeroizing::new(serde_json::to_string(&value).map_err(|_| VaultError::Invalid)?);
        if serialized.len() > LIMIT {
            return Err(VaultError::Invalid);
        }
        self.call(&permit.origin, Action::Set(serialized))
            .await
            .map(|_| ())
    }

    pub fn publish(&self, permit: &Permit) -> Result<(), VaultError> {
        let index = self.index(&permit.origin)?.ok_or(VaultError::Stale)?;
        if index.generation != permit.generation || index.active {
            return Err(VaultError::Stale);
        }
        self.write_index(
            &permit.origin,
            &Index {
                active: true,
                pending_delete: false,
                ..index
            },
        )
    }

    pub async fn read(&self, origin: &ServiceOrigin) -> Result<Loaded, VaultError> {
        let Some(index) = self.index(origin)? else {
            return Ok(Loaded::Empty {
                cleanup_pending: false,
            });
        };
        if !index.active {
            return Ok(Loaded::Empty {
                cleanup_pending: index.pending_delete,
            });
        }
        let Reply::Value(value) = self.call(origin, Action::Get).await? else {
            return Err(VaultError::Invalid);
        };
        let Some(value) = value else {
            return Ok(Loaded::Missing);
        };
        let saved: SavedSession = serde_json::from_str(&value).map_err(|_| VaultError::Invalid)?;
        if saved.version != 1
            || saved.generation != index.generation
            || saved.origin != origin.as_str()
            || saved.account.is_empty()
            || saved.account.len() > 512
            || !valid_cookie(&saved.cookie)
        {
            return Err(VaultError::Invalid);
        }
        Ok(Loaded::Saved(saved))
    }

    pub async fn delete(&self, permit: &Permit) -> Result<(), VaultError> {
        self.call(&permit.origin, Action::Delete).await?;
        let index = self.index(&permit.origin)?.ok_or(VaultError::Stale)?;
        if index.generation != permit.generation || index.active {
            return Err(VaultError::Stale);
        }
        self.write_index(
            &permit.origin,
            &Index {
                pending_delete: false,
                ..index
            },
        )
    }

    pub async fn erase(&self, origin: &ServiceOrigin) -> Result<(), VaultError> {
        self.call(origin, Action::Delete).await.map(|_| ())
    }
}

fn valid_cookie(value: &str) -> bool {
    if value.len() > 8192 || reqwest::header::HeaderValue::from_str(value).is_err() {
        return false;
    }
    value
        .strip_prefix("__Host-openbot-session=")
        .is_some_and(|value| {
            !value.is_empty()
                && !value
                    .bytes()
                    .any(|b| b <= 32 || b == 127 || b == b';' || b == b',')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };
    struct Memory(Arc<Mutex<HashMap<String, Zeroizing<String>>>>);
    impl Backend for Memory {
        fn execute(&mut self, user: &str, action: Action) -> Result<Reply, VaultError> {
            let mut values = self.0.lock().unwrap();
            match action {
                Action::Get => Ok(Reply::Value(values.get(user).cloned())),
                Action::Set(value) => {
                    values.insert(user.into(), value);
                    Ok(Reply::Done)
                }
                Action::Delete => {
                    values.remove(user);
                    Ok(Reply::Done)
                }
            }
        }
    }
    fn origin() -> ServiceOrigin {
        ServiceOrigin::parse("https://service.test").unwrap()
    }
    #[tokio::test]
    async fn os_write_needs_publication_and_metadata_contains_no_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let values = Arc::new(Mutex::new(HashMap::new()));
        let vault = Vault::with_backend(
            dir.path().into(),
            Box::new(Memory(values.clone())),
            Duration::from_secs(1),
        );
        let origin = origin();
        let permit = vault.begin(&origin).unwrap();
        vault
            .stage(
                &permit,
                "account-one",
                "__Host-openbot-session=private-value",
            )
            .await
            .unwrap();
        assert!(matches!(
            vault.read(&origin).await.unwrap(),
            Loaded::Empty { .. }
        ));
        vault.publish(&permit).unwrap();
        let disk = std::fs::read_to_string(vault.path(&origin)).unwrap();
        assert!(
            !disk.contains("private-value")
                && !disk.contains("account-one")
                && !disk.contains("service.test")
        );
        let reopened = Vault::with_backend(
            dir.path().into(),
            Box::new(Memory(values)),
            Duration::from_secs(1),
        );
        let Loaded::Saved(saved) = reopened.read(&origin).await.unwrap() else {
            panic!("No restored entry")
        };
        assert_eq!(saved.account, "account-one");
        let logout = reopened.begin(&origin).unwrap();
        reopened.delete(&logout).await.unwrap();
        assert!(matches!(
            reopened.read(&origin).await.unwrap(),
            Loaded::Empty {
                cleanup_pending: false
            }
        ));
    }
    #[tokio::test]
    async fn blocked_index_rejects_old_publications_and_wrong_service_values() {
        let dir = tempfile::tempdir().unwrap();
        let values = Arc::new(Mutex::new(HashMap::new()));
        let vault = Vault::with_backend(
            dir.path().into(),
            Box::new(Memory(values.clone())),
            Duration::from_secs(1),
        );
        let origin = origin();
        let permit = vault.begin(&origin).unwrap();
        vault
            .stage(&permit, "account", "__Host-openbot-session=private")
            .await
            .unwrap();
        let _logout = vault.begin(&origin).unwrap();
        assert_eq!(vault.publish(&permit).err(), Some(VaultError::Stale));
        let another = ServiceOrigin::parse("https://another.test").unwrap();
        let permit = vault.begin(&another).unwrap();
        vault.publish(&permit).unwrap();
        let old = format!("{:x}", Sha256::digest(origin.as_str().as_bytes()));
        let new = format!("{:x}", Sha256::digest(another.as_str().as_bytes()));
        let copied = values.lock().unwrap().get(&old).unwrap().clone();
        values.lock().unwrap().insert(new, copied);
        assert_eq!(vault.read(&another).await.err(), Some(VaultError::Invalid));
    }
    #[tokio::test]
    async fn invalid_index_stays_untouched_and_no_plain_file_fallback_exists() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().into());
        let origin = origin();
        let bytes = b"{\"version\":2,\"cookie\":\"must-not-load\"}";
        std::fs::write(vault.path(&origin), bytes).unwrap();
        assert_eq!(vault.read(&origin).await.err(), Some(VaultError::Metadata));
        assert_eq!(std::fs::read(vault.path(&origin)).unwrap(), bytes);
    }

    #[tokio::test]
    async fn late_native_writes_cannot_restore_a_cancelled_sign_in() {
        struct Slow {
            values: Memory,
            gate: Arc<(Mutex<bool>, std::sync::Condvar)>,
        }
        impl Backend for Slow {
            fn execute(&mut self, user: &str, action: Action) -> Result<Reply, VaultError> {
                if matches!(action, Action::Set(_)) {
                    let (lock, wake) = &*self.gate;
                    let _guard = wake
                        .wait_while(lock.lock().unwrap(), |ready| !*ready)
                        .unwrap();
                }
                self.values.execute(user, action)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let values = Arc::new(Mutex::new(HashMap::new()));
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let vault = Vault::with_backend(
            dir.path().into(),
            Box::new(Slow {
                values: Memory(values.clone()),
                gate: gate.clone(),
            }),
            Duration::from_millis(50),
        );
        let origin = origin();
        let old = vault.begin(&origin).unwrap();
        assert_eq!(
            vault
                .stage(&old, "account", "__Host-openbot-session=late")
                .await
                .err(),
            Some(VaultError::Unavailable)
        );
        let logout = vault.begin(&origin).unwrap();
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        vault.delete(&logout).await.unwrap();
        assert_eq!(vault.publish(&old).err(), Some(VaultError::Stale));
        assert!(matches!(
            vault.read(&origin).await.unwrap(),
            Loaded::Empty {
                cleanup_pending: false
            }
        ));
        assert!(values.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn native_failure_keeps_the_old_secret_disabled_and_never_writes_a_fallback() {
        struct Unavailable;
        impl Backend for Unavailable {
            fn execute(&mut self, _: &str, _: Action) -> Result<Reply, VaultError> {
                Err(VaultError::Unavailable)
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::with_backend(
            dir.path().into(),
            Box::new(Unavailable),
            Duration::from_secs(1),
        );
        let origin = origin();
        let permit = vault.begin(&origin).unwrap();
        assert_eq!(
            vault
                .stage(&permit, "account", "__Host-openbot-session=secret")
                .await
                .err(),
            Some(VaultError::Unavailable)
        );
        assert!(matches!(
            vault.read(&origin).await.unwrap(),
            Loaded::Empty {
                cleanup_pending: true
            }
        ));
        let paths = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(paths.len(), 1);
        assert!(!std::fs::read_to_string(&paths[0])
            .unwrap()
            .contains("secret"));
    }
    #[tokio::test]
    #[ignore = "Run in an unlocked native credential store; use the private Linux test bus."]
    async fn native_vault_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().into());
        let origin = origin();
        let permit = vault.begin(&origin).unwrap();
        vault
            .stage(
                &permit,
                "native-test-account",
                "__Host-openbot-session=native-test-secret",
            )
            .await
            .unwrap();
        vault.publish(&permit).unwrap();
        let reopened = Vault::new(dir.path().into());
        let Loaded::Saved(saved) = reopened.read(&origin).await.unwrap() else {
            panic!("No native credential")
        };
        assert_eq!(saved.account, "native-test-account");
        let logout = reopened.begin(&origin).unwrap();
        reopened.delete(&logout).await.unwrap();
        assert!(matches!(
            vault.read(&origin).await.unwrap(),
            Loaded::Empty {
                cleanup_pending: false
            }
        ));
    }
}
