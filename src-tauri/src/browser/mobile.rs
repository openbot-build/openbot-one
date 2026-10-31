//! Private mobile return queue and the owned warm/cold browser flow.
use super::{BrowserState, DesktopInput};
use crate::{
    browser_auth::Callback,
    browser_http::{BrowserFlow, BrowserStart},
    connection::ConnectionState,
    http::HttpState,
    pending::PendingStore,
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub const REDIRECT: &str = "build.openbot.one:/auth/callback";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnNotice {
    runtime_id: String,
    returned: bool,
}
#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "kebab-case")]
pub enum ResumeResult {
    NoReturn,
    Complete,
    Failed,
}
#[derive(Default)]
struct InboxInner {
    urls: VecDeque<Zeroizing<String>>,
    subscriber: Option<(u64, Channel<ReturnNotice>)>,
}
#[derive(Default)]
struct Inbox {
    inner: Mutex<InboxInner>,
    changed: Notify,
}
impl Inbox {
    fn notice(generation: u64) -> ReturnNotice {
        ReturnNotice {
            runtime_id: generation.to_string(),
            returned: true,
        }
    }
    fn offer(&self, input: &str) {
        // This filter bounds unsolicited OS input. The attempt still checks
        // exact callback, issuer, state, deadline, and one-use code before HTTP.
        if input.len() > 2048
            || !input.starts_with(&format!("{REDIRECT}?"))
            || input.contains('#')
            || input.bytes().any(|byte| byte.is_ascii_control())
        {
            return;
        }
        let subscriber = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            if inner.urls.iter().any(|url| url.as_str() == input) {
                return;
            }
            if inner.urls.len() == 8 {
                inner.urls.pop_front();
            }
            inner.urls.push_back(Zeroizing::new(input.into()));
            inner.subscriber.clone()
        };
        self.changed.notify_one();
        if let Some((generation, channel)) = subscriber {
            let _ = channel.send(Self::notice(generation));
        }
    }
    fn take(&self) -> VecDeque<Zeroizing<String>> {
        self.inner
            .lock()
            .ok()
            .map(|mut inner| std::mem::take(&mut inner.urls))
            .unwrap_or_default()
    }
    fn has_return(&self) -> bool {
        self.inner.lock().is_ok_and(|inner| !inner.urls.is_empty())
    }
    fn watch(&self, generation: u64, channel: Channel<ReturnNotice>) -> Result<(), String> {
        let queued = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Browser return is not available.")?;
            if inner
                .subscriber
                .as_ref()
                .is_some_and(|(current, _)| *current > generation)
            {
                return Err("The document changed. Reload the app.".into());
            }
            inner.subscriber = Some((generation, channel.clone()));
            !inner.urls.is_empty()
        };
        if queued {
            channel
                .send(Self::notice(generation))
                .map_err(|_| "Browser return listener could not start.")?;
        }
        Ok(())
    }
    fn retire(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.subscriber = None;
            inner.urls.clear();
        }
    }
}
pub(super) struct MobileBrowser {
    store: PendingStore,
    inbox: Inbox,
    runtime_started: AtomicBool,
    issue: AtomicBool,
}
impl MobileBrowser {
    fn new(store: PendingStore) -> Self {
        Self {
            store,
            inbox: Inbox::default(),
            runtime_started: AtomicBool::new(false),
            issue: AtomicBool::new(false),
        }
    }
    async fn wait(
        &self,
        connection: &ConnectionState,
        flow: &mut BrowserFlow,
        input: &DesktopInput<'_>,
        cancel: &CancellationToken,
    ) -> Result<Callback, String> {
        let deadline = tokio::time::Instant::now() + flow.remaining()?;
        let mut check = tokio::time::interval(Duration::from_millis(200));
        loop {
            // Register notification before draining so a return cannot be lost
            // between a queue check and sleeping.
            let changed = self.inbox.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            connection.bound_context(input.origin, input.runtime_id)?;
            if cancel.is_cancelled() {
                return Err("Sign-in was cancelled.".into());
            }
            for url in self.inbox.take() {
                if let Ok(callback) = flow.accept_return(connection, &url) {
                    return Ok(callback);
                }
            }
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("Sign-in was cancelled.".into()),
                _ = tokio::time::sleep_until(deadline) => return Err("This sign-in attempt expired. Start again.".into()),
                _ = check.tick() => {},
                _ = changed => {},
            }
        }
    }
    async fn finish(
        &self,
        connection: &ConnectionState,
        http: &HttpState,
        flow: &mut BrowserFlow,
        returned: Result<Callback, String>,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        // The OS record must be gone before the one-use exchange. Its local
        // fence is already disabled even if OS deletion fails or times out.
        let cleared = self.store.clear().await.map_err(|error| error.to_string());
        let result = match cleared {
            Err(error) => Err(error),
            Ok(()) => match returned {
                Err(error) => Err(error),
                Ok(Callback::Denied) => Err(
                    "Sign-in was not allowed. Check your account or contact your administrator."
                        .into(),
                ),
                Ok(Callback::Code(code)) => {
                    http.browser_exchange(connection, flow, code, cancel).await
                }
            },
        };
        if result.is_err() && http.browser_cancel(flow).await.is_err() {
            return Err("Sign-in did not finish. The service could not confirm cancellation; the attempt will expire.".into());
        }
        result
    }
}
impl BrowserState {
    pub fn with_pending(root: PathBuf) -> Self {
        Self {
            active: Mutex::new(None),
            mobile: Some(MobileBrowser::new(PendingStore::new(root))),
        }
    }
    pub fn invalidate_mobile(&self) -> Result<(), String> {
        if let Some(mobile) = &self.mobile {
            mobile
                .store
                .invalidate()
                .map_err(|error| error.to_string())?;
            mobile.inbox.retire();
        }
        Ok(())
    }
    pub fn invalidate_mobile_bound(
        &self,
        connection: &ConnectionState,
        origin: &str,
        runtime: &str,
    ) -> Result<(), String> {
        connection.fence_bound(origin, runtime, || self.invalidate_mobile())
    }
    pub fn invalidate_mobile_before(&self, generation: u64) -> Result<(), String> {
        let active = self
            .active
            .lock()
            .map_err(|_| "Sign-in state is not available.")?;
        if active
            .as_ref()
            .is_some_and(|value| value.generation >= generation)
        {
            return Ok(());
        }
        self.invalidate_mobile()
    }
    pub fn document_started(&self) -> Result<(), String> {
        if let Some(mobile) = &self.mobile {
            // Initial app launch must keep a pending proof from the old process.
            // A WebView reload in the same process retires its abandoned work.
            if mobile.runtime_started.swap(true, Ordering::SeqCst) {
                self.invalidate_mobile()?;
            }
        }
        Ok(())
    }
    pub fn take_mobile_issue(&self) -> bool {
        self.mobile
            .as_ref()
            .is_some_and(|mobile| mobile.issue.swap(false, Ordering::SeqCst))
    }
    pub fn receive_mobile_return(&self, url: &str) {
        if let Some(mobile) = &self.mobile {
            mobile.inbox.offer(url);
        }
    }
    pub fn watch_mobile(
        &self,
        connection: &ConnectionState,
        origin: &str,
        runtime: &str,
        channel: Channel<ReturnNotice>,
    ) -> Result<(), String> {
        let context = connection.bound_context(origin, runtime)?;
        self.mobile
            .as_ref()
            .ok_or("Mobile browser return is not available.")?
            .inbox
            .watch(context.generation, channel)
    }
    pub async fn mobile(
        &self,
        connection: &ConnectionState,
        http: &HttpState,
        input: DesktopInput<'_>,
        open: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        let permit = self.begin(connection, input.origin, input.runtime_id, input.id)?;
        let mobile = self
            .mobile
            .as_ref()
            .ok_or("Mobile browser return is not available.")?;
        mobile.inbox.take();
        // A new explicit sign-in replaces an abandoned pending attempt. No old
        // code can be used with the newly generated verifier and state.
        mobile
            .store
            .clear()
            .await
            .map_err(|error| error.to_string())?;
        connection.bound_context(input.origin, input.runtime_id)?;
        if permit.cancel.is_cancelled() {
            return Err("Sign-in was cancelled.".into());
        }
        let (mut flow, url) = http
            .browser_start(
                connection,
                input.origin,
                input.runtime_id,
                BrowserStart {
                    client_id: input.client_id,
                    redirect_uri: REDIRECT,
                    email: input.email,
                    invitation: input.invitation,
                },
                &permit.cancel,
            )
            .await?;
        let returned = async {
            let bytes = flow.encode_pending()?;
            let saved = mobile
                .store
                .stage(&bytes)
                .await
                .map_err(|error| error.to_string())?;
            connection.bound_context(input.origin, input.runtime_id)?;
            if permit.cancel.is_cancelled() {
                return Err("Sign-in was cancelled.".into());
            }
            mobile
                .store
                .publish(&saved)
                .await
                .map_err(|error| error.to_string())?;
            connection.bound_context(input.origin, input.runtime_id)?;
            if permit.cancel.is_cancelled() {
                return Err("Sign-in was cancelled.".into());
            }
            open(&url)?;
            mobile
                .wait(connection, &mut flow, &input, &permit.cancel)
                .await
        }
        .await;
        mobile
            .finish(connection, http, &mut flow, returned, &permit.cancel)
            .await
    }
    pub async fn resume_mobile(
        &self,
        connection: &ConnectionState,
        http: &HttpState,
        origin: &str,
        runtime: &str,
        client: &str,
    ) -> Result<ResumeResult, String> {
        connection.bound_context(origin, runtime)?;
        let mobile = self
            .mobile
            .as_ref()
            .ok_or("Mobile browser return is not available.")?;
        if !mobile.inbox.has_return() {
            return Ok(ResumeResult::NoReturn);
        }
        // Claim the single operation atomically with the idle check.
        let context = connection.bound_context(origin, runtime)?;
        let permit = {
            let mut active = self
                .active
                .lock()
                .map_err(|_| "Sign-in state is not available.")?;
            if active.is_some() {
                return Ok(ResumeResult::NoReturn);
            }
            let id = uuid::Uuid::new_v4().to_string();
            let cancel = CancellationToken::new();
            *active = Some(super::Active {
                id: id.clone(),
                generation: context.generation,
                created: std::time::Instant::now(),
                running: true,
                cancel: cancel.clone(),
            });
            super::Permit {
                owner: self,
                id,
                cancel,
            }
        };
        let result = async {
            let bytes = match mobile
                .store
                .read()
                .await
                .map_err(|error| error.to_string())?
            {
                Some(bytes) => bytes,
                None => {
                    mobile.inbox.take();
                    return Ok(ResumeResult::NoReturn);
                }
            };
            // An already checked account must not be replaced by a stale OS
            // callback after another sign-in completed.
            if connection.bound_context(origin, runtime)?.cookie.is_some() {
                return Err("You are already signed in.".to_string());
            }
            let mut flow = BrowserFlow::restore_pending(
                connection, origin, runtime, client, REDIRECT, &bytes,
            )?;
            let accepted = mobile
                .inbox
                .take()
                .into_iter()
                .find_map(|url| flow.accept_return(connection, &url).ok());
            let Some(accepted) = accepted else {
                return Ok(ResumeResult::NoReturn);
            };
            mobile
                .finish(connection, http, &mut flow, Ok(accepted), &permit.cancel)
                .await?;
            Ok(ResumeResult::Complete)
        }
        .await;
        match result {
            Ok(result) => Ok(result),
            Err(_) => {
                let _ = mobile.store.clear().await;
                let current = connection.fence_bound(origin, runtime, || {
                    mobile.issue.store(true, Ordering::SeqCst);
                    Ok(())
                });
                Ok(if current.is_ok() {
                    ResumeResult::Failed
                } else {
                    ResumeResult::NoReturn
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        browser_http::tests::{connection, Fixture, Mode},
        credentials::{Action, Backend, Error, Reply},
    };
    use serde_json::{json, Value};
    use std::{collections::HashMap, sync::Arc};
    struct Memory(Arc<Mutex<HashMap<String, Zeroizing<String>>>>);
    impl Backend for Memory {
        fn execute(&mut self, user: &str, action: Action) -> Result<Reply, Error> {
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
    type Values = Arc<Mutex<HashMap<String, Zeroizing<String>>>>;
    fn owner(root: &std::path::Path, values: Values) -> BrowserState {
        BrowserState {
            active: Mutex::new(None),
            mobile: Some(MobileBrowser::new(PendingStore::with_backend(
                root.into(),
                Box::new(Memory(values)),
            ))),
        }
    }
    fn input<'a>(origin: &'a str, runtime: &'a str, id: &'a str) -> DesktopInput<'a> {
        DesktopInput {
            origin,
            runtime_id: runtime,
            id,
            client_id: "openbot-one",
            email: None,
            invitation: None,
        }
    }
    async fn save_pending(
        owner: &BrowserState,
        http: &HttpState,
        connection: &ConnectionState,
        fixture: &Fixture,
    ) {
        let runtime = connection.snapshot().unwrap().runtime_id;
        let (flow, _) = http
            .browser_start(
                connection,
                &fixture.origin,
                &runtime,
                BrowserStart {
                    client_id: "openbot-one",
                    redirect_uri: REDIRECT,
                    email: None,
                    invitation: None,
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let store = &owner.mobile.as_ref().unwrap().store;
        let permit = store.stage(&flow.encode_pending().unwrap()).await.unwrap();
        store.publish(&permit).await.unwrap();
    }
    fn exchanges(fixture: &Fixture) -> usize {
        fixture
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call.path == "/auth/native/exchange")
            .count()
    }
    #[tokio::test]
    async fn warm_return_uses_private_exchange_and_deletes_saved_proof_before_finishing() {
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_dir, connection) = connection(&fixture);
        let dir = tempfile::tempdir().unwrap();
        let values = Values::default();
        let owner = owner(dir.path(), values.clone());
        let http = HttpState::new().unwrap();
        let runtime = connection.snapshot().unwrap().runtime_id;
        let id = owner
            .prepare(&connection, &fixture.origin, &runtime)
            .unwrap();
        owner
            .mobile(
                &connection,
                &http,
                input(&fixture.origin, &runtime, &id),
                |_| {
                    assert!(
                        !values.lock().unwrap().is_empty(),
                        "Proof must be saved before opening the browser"
                    );
                    let mut wrong = url::Url::parse(&fixture.target()).unwrap();
                    wrong.query_pairs_mut().append_pair("state", "wrong");
                    owner.receive_mobile_return(wrong.as_str());
                    owner.receive_mobile_return(&fixture.target());
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert!(values.lock().unwrap().is_empty());
        assert_eq!(exchanges(&fixture), 1);
        assert_eq!(connection.snapshot().unwrap().session_persistence, "memory");
        assert_eq!(
            fixture.calls.lock().unwrap()[0].body["redirectUri"],
            REDIRECT
        );
        fixture.finish().await;
    }
    #[tokio::test]
    async fn cancellation_after_open_disables_recovery_and_never_exchanges() {
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_dir, connection) = connection(&fixture);
        let dir = tempfile::tempdir().unwrap();
        let values = Values::default();
        let owner = owner(dir.path(), values.clone());
        let http = HttpState::new().unwrap();
        let runtime = connection.snapshot().unwrap().runtime_id;
        let id = owner
            .prepare(&connection, &fixture.origin, &runtime)
            .unwrap();
        assert!(owner
            .mobile(
                &connection,
                &http,
                input(&fixture.origin, &runtime, &id),
                |_| {
                    owner
                        .cancel(&connection, &fixture.origin, &runtime, &id)
                        .unwrap();
                    owner.receive_mobile_return(&fixture.target());
                    Ok(())
                }
            )
            .await
            .is_err());
        assert_eq!(exchanges(&fixture), 0);
        assert!(values.lock().unwrap().is_empty());
        assert!(owner
            .mobile
            .as_ref()
            .unwrap()
            .store
            .read()
            .await
            .unwrap()
            .is_none());
        fixture.finish().await;
    }
    #[tokio::test]
    async fn service_change_after_open_cannot_commit_the_old_account() {
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_dir, connection) = connection(&fixture);
        let dir = tempfile::tempdir().unwrap();
        let values = Values::default();
        let owner = owner(dir.path(), values.clone());
        let http = HttpState::new().unwrap();
        let runtime = connection.snapshot().unwrap().runtime_id;
        let id = owner
            .prepare(&connection, &fixture.origin, &runtime)
            .unwrap();
        assert!(owner
            .mobile(
                &connection,
                &http,
                input(&fixture.origin, &runtime, &id),
                |_| {
                    owner.invalidate_mobile().unwrap();
                    connection
                        .select_bound(Some("https://other.example.com"), &fixture.origin, &runtime)
                        .unwrap();
                    owner.receive_mobile_return(&fixture.target());
                    Ok(())
                }
            )
            .await
            .is_err());
        assert_eq!(exchanges(&fixture), 0);
        assert_eq!(connection.snapshot().unwrap().session_persistence, "none");
        assert!(values.lock().unwrap().is_empty());
        fixture.finish().await;
    }
    #[tokio::test]
    async fn cold_return_restores_only_from_os_proof_and_consumes_it_once() {
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_dir, connection) = connection(&fixture);
        let dir = tempfile::tempdir().unwrap();
        let values = Values::default();
        let first = owner(dir.path(), values.clone());
        let http = HttpState::new().unwrap();
        save_pending(&first, &http, &connection, &fixture).await;
        drop(first);
        let restarted = owner(dir.path(), values.clone());
        restarted.receive_mobile_return(&fixture.target());
        restarted.document_started().unwrap();
        let runtime = connection.snapshot().unwrap().runtime_id;
        assert_eq!(
            restarted
                .resume_mobile(&connection, &http, &fixture.origin, &runtime, "openbot-one")
                .await
                .unwrap(),
            ResumeResult::Complete
        );
        assert!(values.lock().unwrap().is_empty());
        restarted.receive_mobile_return(&fixture.target());
        let runtime = connection.snapshot().unwrap().runtime_id;
        assert_eq!(
            restarted
                .resume_mobile(&connection, &http, &fixture.origin, &runtime, "openbot-one")
                .await
                .unwrap(),
            ResumeResult::NoReturn
        );
        assert_eq!(exchanges(&fixture), 1);
        fixture.finish().await;
    }
    #[tokio::test]
    async fn wrong_cold_state_keeps_the_proof_but_cannot_exchange_or_steal_a_manual_operation() {
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_dir, connection) = connection(&fixture);
        let dir = tempfile::tempdir().unwrap();
        let owner = owner(dir.path(), Values::default());
        let http = HttpState::new().unwrap();
        save_pending(&owner, &http, &connection, &fixture).await;
        let runtime = connection.snapshot().unwrap().runtime_id;
        let mut wrong = url::Url::parse(&fixture.target()).unwrap();
        wrong.query_pairs_mut().append_pair("state", "wrong");
        owner.receive_mobile_return(wrong.as_str());
        assert_eq!(
            owner
                .resume_mobile(&connection, &http, &fixture.origin, &runtime, "openbot-one")
                .await
                .unwrap(),
            ResumeResult::NoReturn
        );
        assert_eq!(exchanges(&fixture), 0);
        assert!(owner
            .mobile
            .as_ref()
            .unwrap()
            .store
            .read()
            .await
            .unwrap()
            .is_some());
        let id = owner
            .prepare(&connection, &fixture.origin, &runtime)
            .unwrap();
        owner.receive_mobile_return(&fixture.target());
        assert_eq!(
            owner
                .resume_mobile(&connection, &http, &fixture.origin, &runtime, "openbot-one")
                .await
                .unwrap(),
            ResumeResult::NoReturn
        );
        owner
            .cancel(&connection, &fixture.origin, &runtime, &id)
            .unwrap();
        assert!(owner
            .mobile
            .as_ref()
            .unwrap()
            .store
            .read()
            .await
            .unwrap()
            .is_none());
        fixture.finish().await;
    }
    #[tokio::test]
    async fn reload_and_wrong_client_cannot_restore_old_pending_sign_in() {
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_dir, connection) = connection(&fixture);
        let dir = tempfile::tempdir().unwrap();
        let owner = owner(dir.path(), Values::default());
        let http = HttpState::new().unwrap();
        save_pending(&owner, &http, &connection, &fixture).await;
        owner.receive_mobile_return(&fixture.target());
        let runtime = connection.snapshot().unwrap().runtime_id;
        assert_eq!(
            owner
                .resume_mobile(
                    &connection,
                    &http,
                    &fixture.origin,
                    &runtime,
                    "other-client"
                )
                .await
                .unwrap(),
            ResumeResult::Failed
        );
        assert!(owner.take_mobile_issue());
        assert!(!owner.take_mobile_issue());
        assert_eq!(exchanges(&fixture), 0);
        save_pending(&owner, &http, &connection, &fixture).await;
        owner.document_started().unwrap();
        owner.document_started().unwrap();
        assert!(owner
            .mobile
            .as_ref()
            .unwrap()
            .store
            .read()
            .await
            .unwrap()
            .is_none());
        fixture.finish().await;
    }
    #[test]
    fn return_queue_is_bounded_and_only_typed_notices_enter_the_channel() {
        use tauri::ipc::InvokeResponseBody;
        let inbox = Inbox::default();
        let messages = Arc::new(Mutex::new(Vec::<Value>::new()));
        let saved = messages.clone();
        inbox.offer("https://other.example.com/code?secret=private");
        inbox.offer("build.openbot.one://auth/callback?code=private");
        assert!(!inbox.has_return());
        inbox.offer(&format!("{REDIRECT}?code=private&state=private"));
        inbox
            .watch(
                2,
                Channel::new(move |body| {
                    let InvokeResponseBody::Json(body) = body else {
                        panic!("Expected a typed notice")
                    };
                    saved
                        .lock()
                        .unwrap()
                        .push(serde_json::from_str(&body).unwrap());
                    Ok(())
                }),
            )
            .unwrap();
        assert_eq!(
            *messages.lock().unwrap(),
            vec![json!({"runtimeId":"2","returned":true})]
        );
        assert!(inbox.watch(1, Channel::new(|_| Ok(()))).is_err());
        for count in 0..100 {
            inbox.offer(&format!("{REDIRECT}?code={count}"));
        }
        assert_eq!(inbox.take().len(), 8);
        assert!(messages
            .lock()
            .unwrap()
            .iter()
            .all(|value| *value == json!({"runtimeId":"2","returned":true})));
        inbox.retire();
        assert!(!inbox.has_return());
    }
    #[tokio::test]
    async fn old_document_cleanup_cannot_disable_a_new_pending_proof() {
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_dir, connection) = connection(&fixture);
        let dir = tempfile::tempdir().unwrap();
        let owner = owner(dir.path(), Values::default());
        let http = HttpState::new().unwrap();
        let old = connection.snapshot().unwrap().runtime_id;
        owner.prepare(&connection, &fixture.origin, &old).unwrap();
        let current = connection.restart_runtime().unwrap().runtime_id;
        let id = owner
            .prepare(&connection, &fixture.origin, &current)
            .unwrap();
        save_pending(&owner, &http, &connection, &fixture).await;
        owner
            .invalidate_mobile_before(connection.generation().unwrap())
            .unwrap();
        assert!(owner
            .invalidate_mobile_bound(&connection, &fixture.origin, &old)
            .is_err());
        assert!(owner
            .mobile
            .as_ref()
            .unwrap()
            .store
            .read()
            .await
            .unwrap()
            .is_some());
        owner
            .cancel(&connection, &fixture.origin, &current, &id)
            .unwrap();
        assert!(owner
            .mobile
            .as_ref()
            .unwrap()
            .store
            .read()
            .await
            .unwrap()
            .is_none());
        fixture.finish().await;
    }
    #[tokio::test]
    async fn failed_os_deletion_prevents_exchange_and_disables_restore() {
        struct FailDelete {
            memory: Memory,
            deletes: usize,
        }
        impl Backend for FailDelete {
            fn execute(&mut self, user: &str, action: Action) -> Result<Reply, Error> {
                if matches!(action, Action::Delete) {
                    self.deletes += 1;
                    if self.deletes > 1 {
                        return Err(Error::Unavailable);
                    }
                }
                self.memory.execute(user, action)
            }
        }
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_dir, connection) = connection(&fixture);
        let dir = tempfile::tempdir().unwrap();
        let values = Values::default();
        let owner = BrowserState {
            active: Mutex::new(None),
            mobile: Some(MobileBrowser::new(PendingStore::with_backend(
                dir.path().into(),
                Box::new(FailDelete {
                    memory: Memory(values.clone()),
                    deletes: 0,
                }),
            ))),
        };
        let http = HttpState::new().unwrap();
        let runtime = connection.snapshot().unwrap().runtime_id;
        let id = owner
            .prepare(&connection, &fixture.origin, &runtime)
            .unwrap();
        assert!(owner
            .mobile(
                &connection,
                &http,
                input(&fixture.origin, &runtime, &id),
                |_| {
                    owner.receive_mobile_return(&fixture.target());
                    Ok(())
                }
            )
            .await
            .is_err());
        assert_eq!(exchanges(&fixture), 0);
        assert!(
            !values.lock().unwrap().is_empty(),
            "The failure fixture must keep the OS entry"
        );
        assert!(owner
            .mobile
            .as_ref()
            .unwrap()
            .store
            .read()
            .await
            .unwrap()
            .is_none());
        fixture.finish().await;
    }
    #[tokio::test]
    async fn a_late_cold_restore_failure_cannot_set_an_issue_in_a_new_document() {
        struct SlowGet {
            memory: Memory,
            seen: Arc<Notify>,
            gate: Arc<(Mutex<bool>, std::sync::Condvar)>,
        }
        impl Backend for SlowGet {
            fn execute(&mut self, user: &str, action: Action) -> Result<Reply, Error> {
                if matches!(action, Action::Get) {
                    self.seen.notify_one();
                    let _guard = self
                        .gate
                        .1
                        .wait_while(self.gate.0.lock().unwrap(), |ready| !*ready)
                        .unwrap();
                }
                self.memory.execute(user, action)
            }
        }
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_dir, connection) = connection(&fixture);
        let dir = tempfile::tempdir().unwrap();
        let seen = Arc::new(Notify::new());
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let owner = BrowserState {
            active: Mutex::new(None),
            mobile: Some(MobileBrowser::new(PendingStore::with_backend(
                dir.path().into(),
                Box::new(SlowGet {
                    memory: Memory(Values::default()),
                    seen: seen.clone(),
                    gate: gate.clone(),
                }),
            ))),
        };
        let http = HttpState::new().unwrap();
        save_pending(&owner, &http, &connection, &fixture).await;
        owner.receive_mobile_return(&fixture.target());
        let runtime = connection.snapshot().unwrap().runtime_id;
        let (result, ()) = tokio::join!(
            owner.resume_mobile(&connection, &http, &fixture.origin, &runtime, "openbot-one"),
            async {
                seen.notified().await;
                connection.restart_runtime().unwrap();
                *gate.0.lock().unwrap() = true;
                gate.1.notify_all();
            }
        );
        assert_eq!(result.unwrap(), ResumeResult::NoReturn);
        assert!(!owner.take_mobile_issue());
        assert_eq!(exchanges(&fixture), 0);
        fixture.finish().await;
    }
}
