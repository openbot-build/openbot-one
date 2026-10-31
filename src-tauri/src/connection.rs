use crate::service::ServiceOrigin;
use crate::{
    http::{HttpState, SessionCheckError},
    vault::{Loaded, Vault},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_SETTINGS_BYTES: u64 = 64 * 1024;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionRecovery {
    InvalidSettings,
    UnsupportedVersion,
    UnreadableSettings,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SessionIssue {
    BrowserSignInIncomplete,
    StoreUnavailable,
    ServiceUnavailable,
    InvalidSavedSignIn,
    NotSaved,
    CleanupPending,
    SignOutIncomplete,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshot {
    pub default_origin: String,
    pub current_origin: String,
    pub development: bool,
    pub android: bool,
    pub mobile: bool,
    pub development_sign_in: bool,
    pub storage_namespace: String,
    pub recovery: Option<ConnectionRecovery>,
    pub session_issue: Option<SessionIssue>,
    pub session_persistence: &'static str,
    // A non-secret fence captured once by each document.
    pub runtime_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedConnection {
    version: u8,
    origin: Option<String>,
}

// Session credentials never enter connection.json, IPC output, or Debug logs.
pub(crate) struct Session {
    pub cookie: String,
    pub account: String,
    pub persisted: bool,
}

pub(crate) struct Context {
    pub origin: ServiceOrigin,
    pub generation: u64,
    pub cookie: Option<String>,
}

struct Inner {
    current: ServiceOrigin,
    generation: u64,
    sessions: HashMap<String, Session>,
    recovery: Option<ConnectionRecovery>,
    issues: HashMap<String, SessionIssue>,
    suppressed: HashSet<String>,
}

pub struct ConnectionState {
    path: PathBuf,
    default: ServiceOrigin,
    inner: Mutex<Inner>,
    vault: Vault,
    vault_ops: tokio::sync::Mutex<()>,
}

impl ConnectionState {
    pub fn load(path: PathBuf, default: ServiceOrigin) -> Result<Self, String> {
        let (current, recovery) = load_selection(&path, &default);
        Ok(Self {
            vault: Vault::new(
                path.parent()
                    .ok_or("The connection directory is missing.")?
                    .join("sessions"),
            ),
            vault_ops: tokio::sync::Mutex::new(()),
            path,
            default,
            inner: Mutex::new(Inner {
                current,
                generation: 0,
                sessions: HashMap::new(),
                recovery,
                issues: HashMap::new(),
                suppressed: HashSet::new(),
            }),
        })
    }

    #[cfg(test)]
    pub(crate) fn disable_credential_store_for_test(&mut self) {
        self.vault.disable_for_test();
    }

    pub fn snapshot(&self) -> Result<ConnectionSnapshot, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Connection state is not available.")?;
        let account = inner
            .sessions
            .get(inner.current.as_str())
            .map(|s| s.account.as_str())
            .unwrap_or("anonymous");
        let key = format!("{}\0{}", inner.current.as_str(), account);
        Ok(ConnectionSnapshot {
            runtime_id: inner.generation.to_string(),
            default_origin: self.default.as_str().to_string(),
            current_origin: inner.current.as_str().to_string(),
            development: cfg!(debug_assertions),
            android: cfg!(target_os = "android"),
            mobile: cfg!(mobile),
            development_sign_in: inner.recovery.is_none()
                && cfg!(debug_assertions)
                && inner.current.is_loopback(),
            storage_namespace: format!("openbot.native.{:x}", Sha256::digest(key)),
            recovery: inner.recovery,
            session_issue: inner.issues.get(inner.current.as_str()).copied(),
            session_persistence: inner
                .sessions
                .get(inner.current.as_str())
                .map(|s| if s.persisted { "saved" } else { "memory" })
                .unwrap_or("none"),
        })
    }

    /// A new WebView must not inherit requests abandoned by its old document.
    pub fn restart_runtime(&self) -> Result<ConnectionSnapshot, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Connection state is not available.")?;
        inner.generation += 1;
        drop(inner);
        self.snapshot()
    }

    #[cfg(test)]
    pub fn select(&self, input: Option<&str>) -> Result<ConnectionSnapshot, String> {
        self.select_inner(input, None)
    }

    pub fn select_bound(
        &self,
        input: Option<&str>,
        expected_origin: &str,
        runtime_id: &str,
    ) -> Result<ConnectionSnapshot, String> {
        self.select_inner(input, Some((expected_origin, runtime_id)))
    }

    fn select_inner(
        &self,
        input: Option<&str>,
        binding: Option<(&str, &str)>,
    ) -> Result<ConnectionSnapshot, String> {
        let selected = input
            .map(ServiceOrigin::for_app)
            .transpose()
            .map_err(str::to_string)?
            .unwrap_or_else(|| self.default.clone());
        // Hold the state lock through the atomic save, so failed writes leave
        // the old origin and its in-flight request generation unchanged.
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Connection state is not available.")?;
        check_binding(&inner, binding)?;
        let parent = self
            .path
            .parent()
            .ok_or("The connection directory is missing.")?;
        std::fs::create_dir_all(parent).map_err(|_| "The service address could not be saved.")?;
        let mut file = tempfile::NamedTempFile::new_in(parent)
            .map_err(|_| "The service address could not be saved.")?;
        let saved = SavedConnection {
            version: 1,
            origin: input.map(|_| selected.as_str().to_string()),
        };
        serde_json::to_writer(&mut file, &saved)
            .map_err(|_| "The service address could not be saved.")?;
        file.flush()
            .map_err(|_| "The service address could not be saved.")?;
        file.as_file()
            .sync_all()
            .map_err(|_| "The service address could not be saved.")?;
        file.persist(&self.path)
            .map_err(|_| "The service address could not be saved.")?;
        inner.current = selected;
        inner.recovery = None;
        inner.generation += 1;
        drop(inner);
        self.snapshot()
    }

    /// Re-read only a blocked selection. Ready sessions keep their selected service.
    #[cfg(test)]
    pub fn retry(&self) -> Result<ConnectionSnapshot, String> {
        self.retry_inner(None)
    }

    pub fn retry_bound(
        &self,
        expected_origin: &str,
        runtime_id: &str,
    ) -> Result<ConnectionSnapshot, String> {
        self.retry_inner(Some((expected_origin, runtime_id)))
    }

    fn retry_inner(&self, binding: Option<(&str, &str)>) -> Result<ConnectionSnapshot, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Connection state is not available.")?;
        check_binding(&inner, binding)?;
        if inner.recovery.is_some() {
            let (current, recovery) = load_selection(&self.path, &self.default);
            inner.current = current;
            inner.recovery = recovery;
            inner.generation += 1;
        }
        drop(inner);
        self.snapshot()
    }

    pub(crate) fn generation(&self) -> Result<u64, String> {
        self.inner
            .lock()
            .map(|inner| inner.generation)
            .map_err(|_| "Connection state is not available.".into())
    }

    /// Fence non-network native work while this exact document is current.
    /// The closure must not call back into ConnectionState.
    pub(crate) fn fence_bound(
        &self,
        origin: &str,
        runtime: &str,
        fence: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Connection state is not available.")?;
        check_binding(&inner, Some((origin, runtime)))?;
        fence()
    }

    pub(crate) fn bound_context(
        &self,
        expected_origin: &str,
        runtime_id: &str,
    ) -> Result<Context, String> {
        self.context_inner(Some((expected_origin, runtime_id)))
    }

    pub(crate) fn context(&self) -> Result<Context, String> {
        self.context_inner(None)
    }

    fn context_inner(&self, binding: Option<(&str, &str)>) -> Result<Context, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Connection state is not available.")?;
        check_binding(&inner, binding)?;
        if inner.recovery.is_some() {
            return Err("Choose a service in settings before connecting.".into());
        }
        Ok(Context {
            origin: inner.current.clone(),
            generation: inner.generation,
            cookie: inner
                .sessions
                .get(inner.current.as_str())
                .map(|s| s.cookie.clone()),
        })
    }

    pub(crate) fn save_session(&self, context: &Context, session: Session) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Connection state is not available.")?;
        if inner.recovery.is_some()
            || inner.generation != context.generation
            || inner.current != context.origin
        {
            return Err("The service changed while sign-in was running. Try again.".into());
        }
        inner
            .sessions
            .insert(context.origin.as_str().into(), session);
        inner.generation += 1;
        Ok(())
    }

    pub(crate) async fn complete_session(
        &self,
        context: &Context,
        mut session: Session,
        cancel: Option<&tokio_util::sync::CancellationToken>,
    ) -> Result<(), String> {
        let _operation = self.vault_ops.lock().await;
        if self.context()?.generation != context.generation {
            return Err("The service changed while sign-in was running. Try again.".into());
        }
        let permit = self.vault.begin(&context.origin).map_err(|_| {
            "Saved sign-in settings could not be written. Check the app's data folder."
        })?;
        // The previous credential is no longer eligible for restore while a
        // replacement is staged, even if this attempt is later cancelled.
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(previous) = inner.sessions.get_mut(context.origin.as_str()) {
                previous.persisted = false;
                inner
                    .issues
                    .insert(context.origin.as_str().into(), SessionIssue::NotSaved);
            }
        }
        let stored = self
            .vault
            .stage(&permit, &session.account, &session.cookie)
            .await
            .is_ok();
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Connection state is not available.")?;
        if cancel.is_some_and(|token| token.is_cancelled()) {
            return Err("Sign-in was cancelled.".into());
        }
        if inner.recovery.is_some()
            || inner.generation != context.generation
            || inner.current != context.origin
        {
            return Err("The service changed while sign-in was running. Try again.".into());
        }
        session.persisted = stored && self.vault.publish(&permit).is_ok();
        let origin = context.origin.as_str().to_string();
        if session.persisted {
            inner.issues.remove(&origin);
        } else {
            inner.issues.insert(origin.clone(), SessionIssue::NotSaved);
        }
        inner.suppressed.remove(&origin);
        inner.sessions.insert(origin, session);
        inner.generation += 1;
        Ok(())
    }

    fn issue(&self, context: &Context, issue: Option<SessionIssue>) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.generation == context.generation && inner.current == context.origin {
                let origin = context.origin.as_str().to_string();
                if let Some(issue) = issue {
                    inner.issues.insert(origin, issue);
                } else {
                    inner.issues.remove(&origin);
                }
            }
        }
    }

    pub(crate) async fn restore_session(&self, http: &HttpState) {
        let Ok(context) = self.context() else { return };
        self.restore_context(http, context).await;
    }

    async fn restore_context(&self, http: &HttpState, context: Context) {
        let _operation = self.vault_ops.lock().await;
        if self.generation().ok() != Some(context.generation) || context.cookie.is_some() {
            return;
        }
        if self
            .inner
            .lock()
            .map(|inner| inner.suppressed.contains(context.origin.as_str()))
            .unwrap_or(true)
        {
            return;
        }
        match self.vault.read(&context.origin).await {
            Ok(Loaded::Empty { cleanup_pending }) => self.issue(
                &context,
                cleanup_pending.then_some(SessionIssue::CleanupPending),
            ),
            Ok(Loaded::Missing) => {
                if let Ok(permit) = self.vault.begin(&context.origin) {
                    let removed = self.vault.delete(&permit).await.is_ok();
                    self.issue(&context, (!removed).then_some(SessionIssue::CleanupPending));
                } else {
                    self.issue(&context, Some(SessionIssue::InvalidSavedSignIn));
                }
            }
            Ok(Loaded::Saved(saved)) => match http
                .check_session(&context, saved.cookie.clone())
                .await
            {
                Ok(mut session) if session.account == saved.account => {
                    session.persisted = true;
                    if self.save_session(&context, session).is_ok() {
                        if let Ok(mut inner) = self.inner.lock() {
                            inner.issues.remove(context.origin.as_str());
                        }
                    }
                }
                Ok(_) => self.issue(&context, Some(SessionIssue::InvalidSavedSignIn)),
                Err(SessionCheckError::Rejected) => {
                    if let Ok(permit) = self.vault.begin(&context.origin) {
                        let removed = self.vault.delete(&permit).await.is_ok();
                        self.issue(&context, (!removed).then_some(SessionIssue::CleanupPending));
                    } else {
                        self.issue(&context, Some(SessionIssue::InvalidSavedSignIn));
                    }
                }
                Err(SessionCheckError::Unavailable) => {
                    self.issue(&context, Some(SessionIssue::ServiceUnavailable))
                }
            },
            Err(crate::vault::VaultError::Unavailable) => {
                self.issue(&context, Some(SessionIssue::StoreUnavailable))
            }
            Err(_) => self.issue(&context, Some(SessionIssue::InvalidSavedSignIn)),
        }
    }

    pub(crate) async fn forget_session(&self, expected: &Context) -> Result<(), String> {
        let _operation = self.vault_ops.lock().await;
        let (permit, current) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Connection state is not available.")?;
            if inner.recovery.is_some()
                || inner.generation != expected.generation
                || inner.current != expected.origin
            {
                return Err("The service changed while sign-out was running. Try again.".into());
            }
            let permit = self.vault.begin(&expected.origin);
            // Bind the durable block and memory clear to the same service.
            inner.sessions.remove(expected.origin.as_str());
            inner.suppressed.insert(expected.origin.as_str().into());
            inner.generation += 1;
            (
                permit,
                Context {
                    origin: expected.origin.clone(),
                    generation: inner.generation,
                    cookie: None,
                },
            )
        };
        let removed = match &permit {
            Ok(permit) => self.vault.delete(permit).await.is_ok(),
            Err(_) => self.vault.erase(&expected.origin).await.is_ok(),
        };
        if permit.is_err() && !removed {
            self.issue(&current, Some(SessionIssue::SignOutIncomplete));
            return Err("Your device could not remove the saved sign-in. Unlock its credential store and try again before closing the app.".into());
        }
        self.issue(&current, (!removed).then_some(SessionIssue::CleanupPending));
        Ok(())
    }

    pub(crate) async fn retry_session(
        &self,
        http: &HttpState,
        expected_origin: &str,
        runtime_id: &str,
    ) -> Result<(), String> {
        let context = self.bound_context(expected_origin, runtime_id)?;
        if let Some(cookie) = context.cookie.clone() {
            let session = http
                .check_session(&context, cookie)
                .await
                .map_err(|error| error.message())?;
            return self.complete_session(&context, session, None).await;
        }
        let cleanup = self
            .inner
            .lock()
            .map_err(|_| "Connection state is not available.")?
            .issues
            .get(context.origin.as_str())
            .is_some_and(|issue| {
                matches!(
                    issue,
                    SessionIssue::CleanupPending | SessionIssue::SignOutIncomplete
                )
            });
        if cleanup {
            return self.forget_session(&context).await;
        }
        self.restore_context(http, context).await;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn sign_out(&self) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Connection state is not available.")?;
        let origin = inner.current.as_str().to_string();
        inner.sessions.remove(&origin);
        inner.generation += 1;
        Ok(())
    }
}

fn check_binding(inner: &Inner, binding: Option<(&str, &str)>) -> Result<(), String> {
    if let Some((origin, runtime_id)) = binding {
        if inner.current.as_str() != origin || inner.generation.to_string() != runtime_id {
            return Err("The service or sign-in changed. Reload the app.".into());
        }
    }
    Ok(())
}

fn load_selection(
    path: &Path,
    default: &ServiceOrigin,
) -> (ServiceOrigin, Option<ConnectionRecovery>) {
    let result = read_selection(path).and_then(|saved| {
        saved
            .and_then(|saved| saved.origin)
            .as_deref()
            .map(ServiceOrigin::for_app)
            .transpose()
            .map_err(|_| ConnectionRecovery::InvalidSettings)
    });
    match result {
        Ok(origin) => (origin.unwrap_or_else(|| default.clone()), None),
        Err(reason) => (default.clone(), Some(reason)),
    }
}

fn read_selection(path: &Path) -> Result<Option<SavedConnection>, ConnectionRecovery> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ConnectionRecovery::UnreadableSettings),
    };
    let mut data = Vec::new();
    file.take(MAX_SETTINGS_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|_| ConnectionRecovery::UnreadableSettings)?;
    if data.len() as u64 > MAX_SETTINGS_BYTES {
        return Err(ConnectionRecovery::InvalidSettings);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&data).map_err(|_| ConnectionRecovery::InvalidSettings)?;
    match value.get("version").and_then(serde_json::Value::as_u64) {
        Some(1) => {}
        Some(_) => return Err(ConnectionRecovery::UnsupportedVersion),
        None => return Err(ConnectionRecovery::InvalidSettings),
    }
    if value.get("origin").is_none() {
        return Err(ConnectionRecovery::InvalidSettings);
    }
    serde_json::from_slice(&data)
        .map(Some)
        .map_err(|_| ConnectionRecovery::InvalidSettings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unusable_settings_are_preserved_and_cannot_connect_before_repair() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connection.json");
        let default = ServiceOrigin::parse("https://default.test").unwrap();
        for (data, reason) in [
            (
                r#"{"version":1,"origin":"#,
                ConnectionRecovery::InvalidSettings,
            ),
            (r#"{"version":1}"#, ConnectionRecovery::InvalidSettings),
            (
                r#"{"version":1,"origin":"https://other.test","origin":null}"#,
                ConnectionRecovery::InvalidSettings,
            ),
            (
                r#"{"version":1,"origin":"http://insecure.test"}"#,
                ConnectionRecovery::InvalidSettings,
            ),
            (
                r#"{"version":1,"origin":null,"extra":true}"#,
                ConnectionRecovery::InvalidSettings,
            ),
            (
                r#"{"version":2,"origin":"https://other.test","extra":true}"#,
                ConnectionRecovery::UnsupportedVersion,
            ),
        ] {
            std::fs::write(&path, data).unwrap();
            let state = ConnectionState::load(path.clone(), default.clone()).unwrap();
            let snapshot = state.snapshot().unwrap();
            assert_eq!(snapshot.recovery, Some(reason));
            assert!(!snapshot.development_sign_in);
            assert!(state.context().is_err());
            assert_eq!(state.retry().unwrap().recovery, Some(reason));
            assert!(state.select(Some("https://other.test/v1")).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), data);
            let ready = state.select(Some("https://chosen.test")).unwrap();
            assert!(ready.recovery.is_none());
            assert_eq!(
                state.context().unwrap().origin.as_str(),
                "https://chosen.test"
            );
        }
    }

    #[test]
    fn retry_reads_repaired_settings_without_changing_a_ready_selection() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connection.json");
        std::fs::write(&path, "broken").unwrap();
        let state = ConnectionState::load(
            path.clone(),
            ServiceOrigin::parse("https://default.test").unwrap(),
        )
        .unwrap();
        assert!(state.context().is_err());
        let repaired = r#"{"version":1,"origin":"https://restored.test"}"#;
        std::fs::write(&path, repaired).unwrap();
        assert!(state.context().is_err());
        assert!(state.retry().unwrap().recovery.is_none());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), repaired);
        let ready = state.context().unwrap();
        assert_eq!(ready.origin.as_str(), "https://restored.test");
        std::fs::write(&path, r#"{"version":1,"origin":null}"#).unwrap();
        assert_eq!(
            state.retry().unwrap().current_origin,
            "https://restored.test"
        );
        assert_eq!(state.context().unwrap().generation, ready.generation);
    }

    #[test]
    fn unreadable_and_oversized_settings_stay_blocked_until_they_are_repaired() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connection.json");
        std::fs::create_dir(&path).unwrap();
        let state = ConnectionState::load(
            path.clone(),
            ServiceOrigin::parse("https://default.test").unwrap(),
        )
        .unwrap();
        assert_eq!(
            state.snapshot().unwrap().recovery,
            Some(ConnectionRecovery::UnreadableSettings)
        );
        assert!(state.select(None).is_err());
        assert!(state.context().is_err());
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, vec![b' '; MAX_SETTINGS_BYTES as usize + 1]).unwrap();
        assert_eq!(
            state.retry().unwrap().recovery,
            Some(ConnectionRecovery::InvalidSettings)
        );
        assert!(state.context().is_err());
        let snapshot = state.select(None).unwrap();
        assert!(snapshot.recovery.is_none());
        assert_eq!(
            state.context().unwrap().origin.as_str(),
            "https://default.test"
        );
    }

    #[test]
    fn first_start_uses_the_default_and_selected_origins_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connection.json");
        let default = ServiceOrigin::parse("https://default.test").unwrap();
        let state = ConnectionState::load(path.clone(), default.clone()).unwrap();
        assert_eq!(
            state.snapshot().unwrap().current_origin,
            "https://default.test"
        );
        state.select(Some("https://other.test/")).unwrap();
        let next = ConnectionState::load(path.clone(), default.clone()).unwrap();
        assert_eq!(
            next.snapshot().unwrap().current_origin,
            "https://other.test"
        );
        next.select(None).unwrap();
        assert_eq!(
            ConnectionState::load(path, default)
                .unwrap()
                .snapshot()
                .unwrap()
                .current_origin,
            "https://default.test"
        );
    }

    #[test]
    fn credentials_and_ui_storage_do_not_cross_service_or_account_boundaries() {
        let dir = tempfile::tempdir().unwrap();
        let state = ConnectionState::load(
            dir.path().join("connection.json"),
            ServiceOrigin::parse("https://one.test").unwrap(),
        )
        .unwrap();
        let before = state.context().unwrap();
        let anonymous = state.snapshot().unwrap().storage_namespace;
        state
            .save_session(
                &before,
                Session {
                    cookie: "secret-one".into(),
                    account: "person".into(),
                    persisted: false,
                },
            )
            .unwrap();
        assert_ne!(anonymous, state.snapshot().unwrap().storage_namespace);
        state.select(Some("https://two.test")).unwrap();
        assert!(state.context().unwrap().cookie.is_none());
        assert!(state
            .save_session(
                &before,
                Session {
                    cookie: "stale".into(),
                    account: "person".into(),
                    persisted: false,
                }
            )
            .is_err());
        let saved = std::fs::read_to_string(dir.path().join("connection.json")).unwrap();
        assert!(!saved.contains("secret-one"));
        state.select(None).unwrap();
        assert_eq!(
            state.context().unwrap().cookie.as_deref(),
            Some("secret-one")
        );
        state.sign_out().unwrap();
        assert!(state.context().unwrap().cookie.is_none());
    }

    #[test]
    fn a_failed_save_keeps_the_old_connection() {
        let dir = tempfile::tempdir().unwrap();
        let blocked = dir.path().join("not-a-directory");
        std::fs::write(&blocked, "file").unwrap();
        let state = ConnectionState::load(
            dir.path().join("selection.json"),
            ServiceOrigin::parse("https://one.test").unwrap(),
        )
        .unwrap();
        let state = ConnectionState {
            path: blocked.join("connection.json"),
            ..state
        };
        assert!(state.select(Some("https://two.test")).is_err());
        assert_eq!(state.snapshot().unwrap().current_origin, "https://one.test");
    }
}
