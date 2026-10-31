//! Bounded serial OS operations shared by separate credential purposes.
use keyring_core::{CredentialStore, Error as StoreError};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::{
    collections::HashMap,
    sync::{mpsc, Arc},
    time::Duration,
};
use tokio::sync::oneshot;
use zeroize::Zeroizing;
pub(crate) const LIMIT: usize = 16 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Error {
    Unavailable,
    Invalid,
    Metadata,
    Stale,
}
#[derive(Clone, Copy)]
pub(crate) enum Purpose {
    Sessions,
    BrowserProofs,
}
impl Purpose {
    #[cfg(target_os = "android")]
    fn android_name(self) -> &'static str {
        match self {
            Self::Sessions => "openbot-sessions-v1",
            Self::BrowserProofs => "openbot-browser-proofs-v1",
        }
    }
}
pub(crate) enum Action {
    Get,
    Set(Zeroizing<String>),
    Delete,
}
pub(crate) enum Reply {
    Value(Option<Zeroizing<String>>),
    Done,
}
struct Command {
    user: String,
    action: Action,
    reply: oneshot::Sender<Result<Reply, Error>>,
}

pub(crate) trait Backend: Send {
    fn execute(&mut self, user: &str, action: Action) -> Result<Reply, Error>;
}

struct NativeBackend {
    service: String,
    purpose: Purpose,
}

fn native_store(purpose: Purpose) -> Result<Arc<CredentialStore>, StoreError> {
    #[cfg(not(target_os = "android"))]
    let _ = purpose;
    #[cfg(target_os = "linux")]
    return dbus_secret_service_keyring_store::Store::new().map(|v| v as Arc<CredentialStore>);
    #[cfg(target_os = "windows")]
    return windows_native_keyring_store::Store::new().map(|v| v as Arc<CredentialStore>);
    #[cfg(target_os = "macos")]
    return apple_native_keyring_store::keychain::Store::new().map(|v| v as Arc<CredentialStore>);
    #[cfg(target_os = "ios")]
    return apple_native_keyring_store::protected::Store::new().map(|v| v as Arc<CredentialStore>);
    #[cfg(target_os = "android")]
    return android_native_keyring_store::Store::new_with_configuration(&HashMap::from([(
        "name",
        purpose.android_name(),
    )]))
    .map(|v| v as Arc<CredentialStore>);
    #[cfg(not(any(
        target_os = "linux",
        target_os = "windows",
        target_os = "macos",
        target_os = "ios",
        target_os = "android"
    )))]
    Err(StoreError::NotSupportedByStore(
        "This system has no credential store.".into(),
    ))
}

impl Backend for NativeBackend {
    fn execute(&mut self, user: &str, action: Action) -> Result<Reply, Error> {
        // Reconnect for each operation so an unlocked/restarted service can
        // recover. Every operation still runs on the same single worker.
        let store = native_store(self.purpose).map_err(|_| Error::Unavailable)?;
        let modifiers: HashMap<&str, &str> = {
            #[cfg(target_os = "windows")]
            {
                HashMap::from([("persistence", "Local")])
            }
            #[cfg(target_os = "ios")]
            {
                HashMap::from([("access-policy", "when-unlocked-this-device-only")])
            }
            #[cfg(not(any(target_os = "windows", target_os = "ios")))]
            {
                HashMap::new()
            }
        };
        let entry = store
            .build(&self.service, user, Some(&modifiers))
            .map_err(|_| Error::Unavailable)?;
        match action {
            Action::Get => match entry.get_password() {
                Ok(value) if value.len() <= LIMIT => Ok(Reply::Value(Some(Zeroizing::new(value)))),
                Ok(value) => {
                    drop(Zeroizing::new(value));
                    Err(Error::Invalid)
                }
                Err(StoreError::NoEntry) => Ok(Reply::Value(None)),
                Err(_) => Err(Error::Unavailable),
            },
            Action::Set(value) => entry
                .set_password(&value)
                .map(|_| Reply::Done)
                .map_err(|_| Error::Unavailable),
            Action::Delete => match entry.delete_credential() {
                Ok(()) | Err(StoreError::NoEntry) => Ok(Reply::Done),
                Err(_) => Err(Error::Unavailable),
            },
        }
    }
}

pub(crate) struct Credentials {
    worker: Option<mpsc::SyncSender<Command>>,
    wait: Duration,
}
impl Credentials {
    pub fn new(root: &Path, purpose: Purpose) -> Self {
        let prefix = match purpose {
            Purpose::Sessions => "build.openbot.one.sessions.v1",
            Purpose::BrowserProofs => "build.openbot.one.browser-proofs.v1",
        };
        let suffix = if cfg!(debug_assertions) {
            format!(
                ".debug.{:x}",
                Sha256::digest(root.to_string_lossy().as_bytes())
            )
        } else {
            String::new()
        };
        Self::with_backend(
            Box::new(NativeBackend {
                service: format!("{prefix}{suffix}"),
                purpose,
            }),
            Duration::from_secs(10),
        )
    }
    pub(crate) fn with_backend(mut backend: Box<dyn Backend>, wait: Duration) -> Self {
        let (send, receive) = mpsc::sync_channel::<Command>(16);
        let started = std::thread::Builder::new()
            .name("openbot-credentials".into())
            .spawn(move || {
                while let Ok(command) = receive.recv() {
                    let result = backend.execute(&command.user, command.action);
                    let _ = command.reply.send(result);
                }
            })
            .is_ok();
        Self {
            worker: started.then_some(send),
            wait,
        }
    }
    #[cfg(test)]
    pub fn disable_for_test(&mut self) {
        self.worker = None;
    }
    pub async fn call(&self, user: &str, action: Action) -> Result<Reply, Error> {
        if user.is_empty()
            || user.len() > 128
            || matches!(&action, Action::Set(value) if value.len() > LIMIT)
        {
            return Err(Error::Invalid);
        }
        let (send, receive) = oneshot::channel();
        self.worker
            .as_ref()
            .ok_or(Error::Unavailable)?
            .try_send(Command {
                user: user.into(),
                action,
                reply: send,
            })
            .map_err(|_| Error::Unavailable)?;
        tokio::time::timeout(self.wait, receive)
            .await
            .map_err(|_| Error::Unavailable)?
            .map_err(|_| Error::Unavailable)?
    }
}
