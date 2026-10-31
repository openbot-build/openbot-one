//! A pending browser proof lives only in an OS credential purpose.
//! The local index holds a random generation and restore/cleanup flags.
use crate::credentials::{Action, Credentials, Error as StoreError, Purpose, Reply, LIMIT};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::PathBuf,
};
use tokio::sync::Mutex;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const USER: &str = "pending-browser";
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Unavailable,
    Invalid,
    Metadata,
    Stale,
}
impl From<StoreError> for Error {
    fn from(value: StoreError) -> Self {
        match value {
            StoreError::Unavailable => Self::Unavailable,
            StoreError::Invalid => Self::Invalid,
            StoreError::Metadata => Self::Metadata,
            StoreError::Stale => Self::Stale,
        }
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unavailable => {
                "The device could not keep the pending sign-in. Unlock it and start again."
            }
            Self::Invalid | Self::Metadata => {
                "The saved browser sign-in could not be checked. Start again."
            }
            Self::Stale => "This browser sign-in ended. Start again.",
        })
    }
}
impl std::error::Error for Error {}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index {
    version: u8,
    generation: String,
    active: bool,
    pending_delete: bool,
}
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
struct Saved {
    version: u8,
    generation: String,
    payload: String,
}
pub struct Permit {
    generation: String,
}
pub struct PendingStore {
    root: PathBuf,
    store: Credentials,
    operations: Mutex<()>,
    metadata: std::sync::Mutex<()>,
}
impl PendingStore {
    pub fn new(root: PathBuf) -> Self {
        let store = Credentials::new(&root, Purpose::BrowserProofs);
        Self {
            root,
            store,
            operations: Mutex::new(()),
            metadata: std::sync::Mutex::new(()),
        }
    }
    #[cfg(test)]
    pub(crate) fn with_backend(
        root: PathBuf,
        backend: Box<dyn crate::credentials::Backend>,
    ) -> Self {
        Self {
            root,
            store: Credentials::with_backend(backend, std::time::Duration::from_secs(1)),
            operations: Mutex::new(()),
            metadata: std::sync::Mutex::new(()),
        }
    }
    fn index(&self) -> Result<Option<Index>, Error> {
        let file = match std::fs::File::open(self.root.join("pending.json")) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::Metadata),
        };
        let mut bytes = Vec::new();
        file.take(1025)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Metadata)?;
        if bytes.len() > 1024 {
            return Err(Error::Metadata);
        }
        let index: Index = serde_json::from_slice(&bytes).map_err(|_| Error::Metadata)?;
        if index.version != 1
            || uuid::Uuid::parse_str(&index.generation).is_err()
            || (index.active && index.pending_delete)
        {
            return Err(Error::Metadata);
        }
        Ok(Some(index))
    }
    fn write(&self, index: &Index) -> Result<(), Error> {
        std::fs::create_dir_all(&self.root).map_err(|_| Error::Metadata)?;
        let mut file = tempfile::NamedTempFile::new_in(&self.root).map_err(|_| Error::Metadata)?;
        serde_json::to_writer(&mut file, index).map_err(|_| Error::Metadata)?;
        file.flush()
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| Error::Metadata)?;
        file.persist(self.root.join("pending.json"))
            .map_err(|_| Error::Metadata)?;
        #[cfg(unix)]
        std::fs::File::open(&self.root)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| Error::Metadata)?;
        Ok(())
    }
    fn begin(&self) -> Result<Permit, Error> {
        let _metadata = self.metadata.lock().map_err(|_| Error::Metadata)?;
        let generation = uuid::Uuid::new_v4().to_string();
        self.write(&Index {
            version: 1,
            generation: generation.clone(),
            active: false,
            pending_delete: true,
        })?;
        Ok(Permit { generation })
    }
    /// A successful OS write is not enough. The caller must check its current
    /// lease, then publish. Late or timed-out writes never enable restoration.
    pub async fn stage(&self, payload: &[u8]) -> Result<Permit, Error> {
        if payload.is_empty() || payload.len() > LIMIT {
            return Err(Error::Invalid);
        }
        let text = std::str::from_utf8(payload).map_err(|_| Error::Invalid)?;
        let _operation = self.operations.lock().await;
        let permit = self.begin()?;
        let saved = Saved {
            version: 1,
            generation: permit.generation.clone(),
            payload: text.into(),
        };
        let value = Zeroizing::new(serde_json::to_string(&saved).map_err(|_| Error::Invalid)?);
        self.store
            .call(USER, Action::Set(value))
            .await
            .map_err(Error::from)?;
        Ok(permit)
    }
    pub async fn publish(&self, permit: &Permit) -> Result<(), Error> {
        let _operation = self.operations.lock().await;
        let _metadata = self.metadata.lock().map_err(|_| Error::Metadata)?;
        let index = self.index()?.ok_or(Error::Stale)?;
        if index.generation != permit.generation || index.active {
            return Err(Error::Stale);
        }
        self.write(&Index {
            active: true,
            pending_delete: false,
            ..index
        })
    }
    pub async fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, Error> {
        let _operation = self.operations.lock().await;
        let Some(index) = self.index()? else {
            return Ok(None);
        };
        if !index.active {
            return Ok(None);
        }
        let Reply::Value(value) = self
            .store
            .call(USER, Action::Get)
            .await
            .map_err(Error::from)?
        else {
            return Err(Error::Invalid);
        };
        let current = self.index()?.ok_or(Error::Stale)?;
        if !current.active || current.generation != index.generation {
            return Err(Error::Stale);
        }
        let Some(value) = value else {
            return Err(Error::Invalid);
        };
        let saved: Saved = serde_json::from_str(&value).map_err(|_| Error::Invalid)?;
        if saved.version != 1
            || saved.generation != index.generation
            || saved.payload.is_empty()
            || saved.payload.len() > LIMIT
        {
            return Err(Error::Invalid);
        }
        Ok(Some(Zeroizing::new(saved.payload.as_bytes().to_vec())))
    }
    /// Synchronous cancellation fence. It also races safely with publication
    /// while a slow native write owns the async operation lock.
    pub fn invalidate(&self) -> Result<(), Error> {
        self.begin().map(|_| ())
    }
    /// Disable restore before requesting OS deletion. Exchange may start only
    /// after this succeeds. The serial worker orders deletion after late writes.
    pub async fn clear(&self) -> Result<(), Error> {
        let _operation = self.operations.lock().await;
        let permit = self.begin()?;
        self.store
            .call(USER, Action::Delete)
            .await
            .map_err(Error::from)?;
        let _metadata = self.metadata.lock().map_err(|_| Error::Metadata)?;
        let index = self.index()?.ok_or(Error::Stale)?;
        if index.generation != permit.generation {
            return Err(Error::Stale);
        }
        self.write(&Index {
            pending_delete: false,
            ..index
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::Backend;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex as SyncMutex},
        time::Duration,
    };
    struct Memory(Arc<SyncMutex<HashMap<String, Zeroizing<String>>>>);
    impl Backend for Memory {
        fn execute(&mut self, user: &str, action: Action) -> Result<Reply, StoreError> {
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
    fn memory(
        root: PathBuf,
        values: Arc<SyncMutex<HashMap<String, Zeroizing<String>>>>,
    ) -> PendingStore {
        PendingStore {
            root,
            store: Credentials::with_backend(Box::new(Memory(values)), Duration::from_secs(1)),
            operations: Mutex::new(()),
            metadata: std::sync::Mutex::new(()),
        }
    }
    fn payload() -> Zeroizing<Vec<u8>> {
        use crate::{browser_auth::BrowserAttempt, service::ServiceOrigin};
        let origin = ServiceOrigin::parse("https://service.example.com").unwrap();
        let mut attempt =
            BrowserAttempt::new(&origin, "openbot-one", "build.openbot.one:/auth/callback")
                .unwrap();
        attempt.bind_started(serde_json::from_value(serde_json::json!({
            "request":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "url":"https://service.example.com/auth/native/authorize?request=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "expiresIn":300,
        })).unwrap()).unwrap();
        attempt.encode_pending().unwrap()
    }
    #[tokio::test]
    async fn a_pending_proof_requires_publication_and_never_appears_in_local_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let values = Arc::new(SyncMutex::new(HashMap::new()));
        let store = memory(directory.path().into(), values.clone());
        let proof = payload();
        let permit = store.stage(&proof).await.unwrap();
        assert!(store.read().await.unwrap().is_none());
        store.publish(&permit).await.unwrap();
        let saved = store.read().await.unwrap().unwrap();
        assert_eq!(&*saved, &*proof);
        let disk = std::fs::read_to_string(directory.path().join("pending.json")).unwrap();
        for key in ["verifier", "state", "service.example.com", "codeChallenge"] {
            assert!(!disk.contains(key));
        }
        let restored = memory(directory.path().into(), values);
        assert!(restored.read().await.unwrap().is_some());
        restored.clear().await.unwrap();
        assert!(restored.read().await.unwrap().is_none());
        assert_eq!(restored.publish(&permit).await.err(), Some(Error::Stale));
    }
    #[tokio::test]
    async fn unavailable_storage_has_no_plain_fallback_and_old_generations_cannot_restore() {
        struct Unavailable;
        impl Backend for Unavailable {
            fn execute(&mut self, _: &str, _: Action) -> Result<Reply, StoreError> {
                Err(StoreError::Unavailable)
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let store = PendingStore {
            root: directory.path().into(),
            store: Credentials::with_backend(Box::new(Unavailable), Duration::from_secs(1)),
            operations: Mutex::new(()),
            metadata: std::sync::Mutex::new(()),
        };
        assert_eq!(
            store.stage(&payload()).await.err(),
            Some(Error::Unavailable)
        );
        assert!(store.read().await.unwrap().is_none());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        let values = Arc::new(SyncMutex::new(HashMap::new()));
        let store = memory(directory.path().into(), values.clone());
        let first = store.stage(&payload()).await.unwrap();
        let old = values.lock().unwrap().get(USER).unwrap().clone();
        let current = store.stage(&payload()).await.unwrap();
        store.publish(&current).await.unwrap();
        values.lock().unwrap().insert(USER.into(), old);
        assert_eq!(store.read().await.err(), Some(Error::Invalid));
        assert_eq!(store.publish(&first).await.err(), Some(Error::Stale));
        store.clear().await.unwrap();
        assert!(values.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn late_os_writes_cannot_restore_after_clear_or_publish_an_old_permit() {
        struct Slow {
            memory: Memory,
            gate: Arc<(SyncMutex<bool>, std::sync::Condvar)>,
        }
        impl Backend for Slow {
            fn execute(&mut self, user: &str, action: Action) -> Result<Reply, StoreError> {
                if matches!(action, Action::Set(_)) {
                    let (lock, wake) = &*self.gate;
                    let _guard = wake
                        .wait_while(lock.lock().unwrap(), |ready| !*ready)
                        .unwrap();
                }
                self.memory.execute(user, action)
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let values = Arc::new(SyncMutex::new(HashMap::new()));
        let gate = Arc::new((SyncMutex::new(false), std::sync::Condvar::new()));
        let store = PendingStore {
            root: directory.path().into(),
            store: Credentials::with_backend(
                Box::new(Slow {
                    memory: Memory(values.clone()),
                    gate: gate.clone(),
                }),
                Duration::from_millis(50),
            ),
            operations: Mutex::new(()),
            metadata: std::sync::Mutex::new(()),
        };
        assert_eq!(
            store.stage(&payload()).await.err(),
            Some(Error::Unavailable)
        );
        assert!(!store.index().unwrap().unwrap().active);
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        store.clear().await.unwrap();
        assert!(store.read().await.unwrap().is_none());
        assert!(values.lock().unwrap().is_empty());
        let old = store.stage(&payload()).await.unwrap();
        // A queued publication is serialized with cleanup and must see its fence.
        let lock = store.operations.lock().await;
        let clear = store.clear();
        let publish = store.publish(&old);
        drop(lock);
        let (cleared, published) = tokio::join!(clear, publish);
        cleared.unwrap();
        assert_eq!(published.err(), Some(Error::Stale));
        assert!(store.read().await.unwrap().is_none());
    }

    #[tokio::test]
    #[ignore = "Run in an unlocked native credential store; use the private Linux test bus."]
    async fn native_vault_round_trip_pending_purpose_is_separate() {
        let directory = tempfile::tempdir().unwrap();
        let pending = PendingStore::new(directory.path().into());
        let session = Credentials::new(directory.path(), Purpose::Sessions);
        session
            .call(
                USER,
                Action::Set(Zeroizing::new("session-purpose-only".into())),
            )
            .await
            .unwrap();
        let proof = payload();
        let permit = pending.stage(&proof).await.unwrap();
        pending.publish(&permit).await.unwrap();
        let reopened = PendingStore::new(directory.path().into());
        assert_eq!(&*reopened.read().await.unwrap().unwrap(), &*proof);
        pending.clear().await.unwrap();
        let Reply::Value(Some(value)) = session.call(USER, Action::Get).await.unwrap() else {
            panic!("The separate session entry was removed");
        };
        assert_eq!(&*value, "session-purpose-only");
        session.call(USER, Action::Delete).await.unwrap();
        assert!(reopened.read().await.unwrap().is_none());
    }
    #[tokio::test]
    async fn synchronous_invalidation_fences_publication_while_the_async_worker_is_busy() {
        let directory = tempfile::tempdir().unwrap();
        let values = Arc::new(SyncMutex::new(HashMap::new()));
        let store = memory(directory.path().into(), values);
        let permit = store.stage(&payload()).await.unwrap();
        let guard = store.operations.lock().await;
        store.invalidate().unwrap();
        drop(guard);
        assert_eq!(store.publish(&permit).await.err(), Some(Error::Stale));
        assert!(store.read().await.unwrap().is_none());
        store.clear().await.unwrap();
    }
}
