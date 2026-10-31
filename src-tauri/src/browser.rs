//! Owns one system-browser attempt; platform return owners keep URLs native.
mod mobile;
use crate::{
    browser_auth::Callback,
    browser_http::{BrowserFlow, BrowserStart},
    connection::ConnectionState,
    http::HttpState,
};
pub use mobile::{ResumeResult, ReturnNotice};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

const PREPARE_LIFETIME: Duration = Duration::from_secs(15);
const CALLBACK_PATH: &str = "/auth/callback";
struct Active {
    id: String,
    generation: u64,
    created: Instant,
    running: bool,
    cancel: CancellationToken,
}
#[derive(Default)]
pub struct BrowserState {
    active: Mutex<Option<Active>>,
    mobile: Option<mobile::MobileBrowser>,
}
struct Permit<'a> {
    owner: &'a BrowserState,
    id: String,
    cancel: CancellationToken,
}
impl Drop for Permit<'_> {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Ok(mut active) = self.owner.active.lock() {
            if active.as_ref().is_some_and(|value| value.id == self.id) {
                *active = None;
            }
        }
    }
}
impl BrowserState {
    /// Prepare first so an early AbortSignal cannot race past the native start.
    pub fn prepare(
        &self,
        connection: &ConnectionState,
        origin: &str,
        runtime: &str,
    ) -> Result<String, String> {
        let context = connection.bound_context(origin, runtime)?;
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Sign-in state is not available.")?;
        if active.as_ref().is_some_and(|value| {
            !value.running
                && (value.created.elapsed() >= PREPARE_LIFETIME
                    || value.cancel.is_cancelled()
                    || value.generation < context.generation)
        }) {
            if let Some(value) = active.take() {
                value.cancel.cancel();
            }
        }
        if active.is_some() {
            return Err("A browser sign-in is already running. Finish or cancel it first.".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        *active = Some(Active {
            id: id.clone(),
            generation: context.generation,
            created: Instant::now(),
            running: false,
            cancel: CancellationToken::new(),
        });
        Ok(id)
    }
    fn begin(
        &self,
        connection: &ConnectionState,
        origin: &str,
        runtime: &str,
        id: &str,
    ) -> Result<Permit<'_>, String> {
        let context = connection.bound_context(origin, runtime)?;
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Sign-in state is not available.")?;
        let value = active
            .as_mut()
            .filter(|value| value.id == id && value.generation == context.generation)
            .ok_or("This sign-in attempt ended. Start again.")?;
        if value.running {
            return Err("This sign-in attempt already started.".into());
        }
        if value.cancel.is_cancelled() || value.created.elapsed() >= PREPARE_LIFETIME {
            *active = None;
            return Err("This sign-in attempt ended. Start again.".into());
        }
        value.running = true;
        Ok(Permit {
            owner: self,
            id: id.into(),
            cancel: value.cancel.clone(),
        })
    }
    pub fn cancel(
        &self,
        connection: &ConnectionState,
        origin: &str,
        runtime: &str,
        id: &str,
    ) -> Result<(), String> {
        connection.bound_context(origin, runtime)?;
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Sign-in state is not available.")?;
        if let Some(value) = active.as_ref().filter(|value| value.id == id) {
            value.cancel.cancel();
            self.invalidate_mobile()?;
            if !value.running {
                *active = None;
            }
        }
        Ok(())
    }
    pub fn cancel_before(&self, generation: u64) {
        if let Ok(mut active) = self.active.lock() {
            if let Some(value) = active
                .as_ref()
                .filter(|value| value.generation < generation)
            {
                value.cancel.cancel();
                if !value.running {
                    *active = None;
                }
            }
        }
    }
    pub fn cancel_all(&self) {
        if let Ok(mut active) = self.active.lock() {
            if let Some(value) = active.as_ref() {
                value.cancel.cancel();
                if !value.running {
                    *active = None;
                }
            }
        }
    }
    pub async fn desktop(
        &self,
        connection: &ConnectionState,
        http: &HttpState,
        input: DesktopInput<'_>,
        open: impl FnOnce(&str) -> Result<(), String>,
    ) -> Result<(), String> {
        let permit = self.begin(connection, input.origin, input.runtime_id, input.id)?;
        let loopback = Loopback::bind().await?;
        let (mut flow, url) = http
            .browser_start(
                connection,
                input.origin,
                input.runtime_id,
                BrowserStart {
                    client_id: input.client_id,
                    redirect_uri: &loopback.redirect_uri,
                    email: input.email,
                    invitation: input.invitation,
                },
                &permit.cancel,
            )
            .await?;
        let result = async {
            connection.bound_context(input.origin, input.runtime_id)?;
            if permit.cancel.is_cancelled() {
                return Err("Sign-in was cancelled.".into());
            }
            open(&url)?;
            let returned = loopback
                .wait(
                    connection,
                    &mut flow,
                    &permit.cancel,
                    input.origin,
                    input.runtime_id,
                )
                .await?;
            match returned {
                Callback::Denied => Err(
                    "Sign-in was not allowed. Check your account or contact your administrator."
                        .into(),
                ),
                Callback::Code(code) => {
                    http.browser_exchange(connection, &mut flow, code, &permit.cancel)
                        .await
                }
            }
        }
        .await;
        if result.is_err() && http.browser_cancel(&flow).await.is_err() {
            return Err("Sign-in did not finish. The service could not confirm cancellation; the attempt will expire.".into());
        }
        result
    }
}
pub struct DesktopInput<'a> {
    pub origin: &'a str,
    pub runtime_id: &'a str,
    pub id: &'a str,
    pub client_id: &'a str,
    pub email: Option<&'a str>,
    pub invitation: Option<&'a str>,
}

struct Loopback {
    listener: TcpListener,
    authority: String,
    redirect_uri: String,
}
impl Loopback {
    async fn bind() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|_| "The sign-in return port could not open.")?;
        let authority = listener
            .local_addr()
            .map_err(|_| "The sign-in return port is not available.")?
            .to_string();
        Ok(Self {
            redirect_uri: format!("http://{authority}{CALLBACK_PATH}"),
            authority,
            listener,
        })
    }
    // Consuming self closes the listener before the credential-creating exchange.
    async fn wait(
        self,
        connection: &ConnectionState,
        flow: &mut BrowserFlow,
        cancel: &CancellationToken,
        origin: &str,
        runtime: &str,
    ) -> Result<Callback, String> {
        let deadline = tokio::time::Instant::now() + flow.remaining()?;
        let mut check = tokio::time::interval(Duration::from_millis(200));
        loop {
            let (mut stream, _) = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("Sign-in was cancelled.".into()),
                _ = tokio::time::sleep_until(deadline) => return Err("This sign-in attempt expired. Start again.".into()),
                _ = check.tick() => { connection.bound_context(origin, runtime)?; continue; },
                accepted = self.listener.accept() => accepted.map_err(|_| "The sign-in return port stopped.")?,
            };
            let target = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("Sign-in was cancelled.".into()),
                _ = tokio::time::sleep_until(deadline) => return Err("This sign-in attempt expired. Start again.".into()),
                read = tokio::time::timeout(Duration::from_secs(1), read_target(&mut stream, &self.authority)) => read.ok().and_then(Result::ok),
            };
            let accepted = target.and_then(|target| flow.accept_return(connection, &target).ok());
            reply(&mut stream, accepted.is_some()).await;
            if let Some(accepted) = accepted {
                return Ok(accepted);
            }
        }
    }
}
async fn read_target(stream: &mut TcpStream, authority: &str) -> Result<Zeroizing<String>, ()> {
    let mut bytes = Zeroizing::new(Vec::new());
    loop {
        let mut chunk = Zeroizing::new([0_u8; 1024]);
        let size = stream.read(chunk.as_mut()).await.map_err(|_| ())?;
        if size == 0 || bytes.len() + size > 8192 {
            return Err(());
        }
        bytes.extend_from_slice(&chunk[..size]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| ())?;
    if !text.ends_with("\r\n\r\n") {
        return Err(());
    }
    let mut lines = text[..text.len() - 4].split("\r\n");
    let mut first = lines.next().ok_or(())?.split(' ');
    if first.next() != Some("GET") {
        return Err(());
    }
    let target = first
        .next()
        .filter(|target| target.len() <= 4096 && target.starts_with("/auth/callback?"))
        .ok_or(())?;
    if first.next() != Some("HTTP/1.1") || first.next().is_some() {
        return Err(());
    }
    let mut host = false;
    let mut count = 0;
    for line in lines {
        count += 1;
        if count > 64 || line.len() > 2048 || line.starts_with([' ', '\t']) {
            return Err(());
        }
        let (name, value) = line.split_once(':').ok_or(())?;
        let name = name.to_ascii_lowercase();
        if name == "host" {
            if host || value.trim() != authority {
                return Err(());
            }
            host = true;
        }
        if matches!(
            name.as_str(),
            "content-length" | "transfer-encoding" | "origin"
        ) {
            return Err(());
        }
    }
    if !host {
        return Err(());
    }
    Ok(Zeroizing::new(format!("http://{authority}{target}")))
}
async fn reply(stream: &mut TcpStream, accepted: bool) {
    let (status, body) = if accepted {
        (
            "200 OK",
            "<!doctype html><title>OpenBot</title><p>Return to OpenBot.</p>",
        )
    } else {
        (
            "400 Bad Request",
            "<!doctype html><title>OpenBot</title><p>This sign-in response was not accepted.</p>",
        )
    };
    let response = format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; base-uri 'none'; frame-ancestors 'none'\r\n\r\n{body}", body.len());
    let _ = tokio::time::timeout(
        Duration::from_millis(500),
        stream.write_all(response.as_bytes()),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_http::tests::{connection, Fixture, Mode};
    use reqwest::header::HOST;
    use tokio::sync::Notify;

    #[test]
    fn prepared_cancel_expiry_and_old_ids_do_not_release_a_new_attempt() {
        let directory = tempfile::tempdir().unwrap();
        let connection = ConnectionState::load(
            directory.path().join("connection.json"),
            crate::service::ServiceOrigin::parse("https://service.example.com").unwrap(),
        )
        .unwrap();
        let state = BrowserState::default();
        let snapshot = connection.snapshot().unwrap();
        let origin = &snapshot.current_origin;
        let runtime = &snapshot.runtime_id;
        let first = state.prepare(&connection, origin, runtime).unwrap();
        assert!(state.prepare(&connection, origin, runtime).is_err());
        state.cancel(&connection, origin, runtime, &first).unwrap();
        let second = state.prepare(&connection, origin, runtime).unwrap();
        state.cancel(&connection, origin, runtime, &first).unwrap();
        assert!(state.begin(&connection, origin, runtime, &first).is_err());
        assert!(state.prepare(&connection, origin, runtime).is_err());
        state.active.lock().unwrap().as_mut().unwrap().created = Instant::now() - PREPARE_LIFETIME;
        assert!(state.begin(&connection, origin, runtime, &second).is_err());
        let third = state.prepare(&connection, origin, runtime).unwrap();
        let permit = state.begin(&connection, origin, runtime, &third).unwrap();
        assert!(state.begin(&connection, origin, runtime, &third).is_err());
        state.cancel_before(connection.generation().unwrap() + 1);
        assert!(permit.cancel.is_cancelled());
        drop(permit);
        assert!(state.prepare(&connection, origin, runtime).is_ok());
    }

    #[tokio::test]
    async fn desktop_return_checks_host_method_state_and_closes_before_exchange() {
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_directory, connection) = connection(&fixture);
        let state = BrowserState::default();
        let http = HttpState::new().unwrap();
        let runtime = connection.snapshot().unwrap().runtime_id;
        let id = state
            .prepare(&connection, &fixture.origin, &runtime)
            .unwrap();
        let opened = Notify::new();
        let driver = async {
            opened.notified().await;
            assert!(state
                .prepare(&connection, &fixture.origin, &runtime)
                .is_err());
            state
                .cancel(&connection, &fixture.origin, &runtime, "old-id")
                .unwrap();
            let target = fixture.target();
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            let wrong = client
                .get(&target)
                .header(HOST, "evil.example.com")
                .send()
                .await
                .unwrap();
            assert_eq!(wrong.status(), 400);
            let post = client.post(&target).send().await.unwrap();
            assert_eq!(post.status(), 400);
            let mut invalid = url::Url::parse(&target).unwrap();
            let pairs: Vec<(String, String)> = invalid
                .query_pairs()
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect();
            invalid.set_query(None);
            for (key, value) in pairs {
                invalid
                    .query_pairs_mut()
                    .append_pair(&key, if key == "state" { "wrong" } else { &value });
            }
            let wrong = client.get(invalid).send().await.unwrap();
            assert_eq!(wrong.status(), 400);
            assert_eq!(wrong.headers()["cache-control"], "no-store");
            assert_eq!(wrong.headers()["referrer-policy"], "no-referrer");
            assert!(!wrong.text().await.unwrap().contains("wrong"));
            let reply = client.get(&target).send().await.unwrap();
            assert_eq!(reply.status(), 200);
            assert!(reply.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .contains("default-src 'none'"));
            let body = reply.text().await.unwrap();
            assert!(!body.contains("state="));
            target
        };
        let run = state.desktop(
            &connection,
            &http,
            DesktopInput {
                origin: &fixture.origin,
                runtime_id: &runtime,
                id: &id,
                client_id: "openbot-one",
                email: None,
                invitation: None,
            },
            |url| {
                assert!(url.starts_with(&format!(
                    "{}/auth/native/authorize?request=",
                    fixture.origin
                )));
                opened.notify_one();
                Ok(())
            },
        );
        let (result, target) = tokio::join!(run, driver);
        result.unwrap();
        assert!(connection.context().unwrap().cookie.is_some());
        assert_eq!(fixture.calls.lock().unwrap().len(), 3);
        assert!(reqwest::Client::new()
            .get(target)
            .timeout(Duration::from_millis(100))
            .send()
            .await
            .is_err());
        fixture.finish().await;
    }

    #[tokio::test]
    async fn cancellation_owns_listener_cleanup_and_does_not_exchange() {
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_directory, connection) = connection(&fixture);
        let state = BrowserState::default();
        let http = HttpState::new().unwrap();
        let runtime = connection.snapshot().unwrap().runtime_id;
        let id = state
            .prepare(&connection, &fixture.origin, &runtime)
            .unwrap();
        let opened = Notify::new();
        let driver = async {
            opened.notified().await;
            let target = fixture.target();
            state
                .cancel(&connection, &fixture.origin, &runtime, &id)
                .unwrap();
            target
        };
        let run = state.desktop(
            &connection,
            &http,
            DesktopInput {
                origin: &fixture.origin,
                runtime_id: &runtime,
                id: &id,
                client_id: "openbot-one",
                email: None,
                invitation: None,
            },
            |_| {
                opened.notify_one();
                Ok(())
            },
        );
        let (result, target) = tokio::join!(run, driver);
        assert!(result.is_err());
        assert!(connection.context().unwrap().cookie.is_none());
        {
            let calls = fixture.calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            assert_eq!(calls[1].path, "/auth/native/cancel");
        }
        assert!(reqwest::get(target).await.is_err());
        let next = state
            .prepare(&connection, &fixture.origin, &runtime)
            .unwrap();
        state
            .cancel(&connection, &fixture.origin, &runtime, &next)
            .unwrap();
        fixture.finish().await;
    }

    #[tokio::test]
    async fn service_change_while_waiting_cancels_only_the_old_flow() {
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_directory, connection) = connection(&fixture);
        let state = BrowserState::default();
        let http = HttpState::new().unwrap();
        let runtime = connection.snapshot().unwrap().runtime_id;
        let id = state
            .prepare(&connection, &fixture.origin, &runtime)
            .unwrap();
        let opened = Notify::new();
        let driver = async {
            opened.notified().await;
            connection
                .select(Some("https://other.example.com"))
                .unwrap();
            state.cancel_before(connection.generation().unwrap());
        };
        let run = state.desktop(
            &connection,
            &http,
            DesktopInput {
                origin: &fixture.origin,
                runtime_id: &runtime,
                id: &id,
                client_id: "openbot-one",
                email: None,
                invitation: None,
            },
            |_| {
                opened.notify_one();
                Ok(())
            },
        );
        let (result, ()) = tokio::join!(run, driver);
        assert!(result.is_err());
        assert_eq!(
            connection.context().unwrap().origin.as_str(),
            "https://other.example.com"
        );
        assert_eq!(fixture.calls.lock().unwrap().len(), 2);
        fixture.finish().await;
    }

    #[tokio::test]
    async fn browser_open_failure_releases_the_lease_and_cancels_the_attempt() {
        let fixture = Fixture::start(Mode::Good, CancellationToken::new()).await;
        let (_directory, connection) = connection(&fixture);
        let state = BrowserState::default();
        let http = HttpState::new().unwrap();
        let runtime = connection.snapshot().unwrap().runtime_id;
        let id = state
            .prepare(&connection, &fixture.origin, &runtime)
            .unwrap();
        assert!(state
            .desktop(
                &connection,
                &http,
                DesktopInput {
                    origin: &fixture.origin,
                    runtime_id: &runtime,
                    id: &id,
                    client_id: "openbot-one",
                    email: None,
                    invitation: None
                },
                |_| Err("Browser is unavailable.".into())
            )
            .await
            .is_err());
        assert_eq!(fixture.calls.lock().unwrap().len(), 2);
        assert!(state
            .prepare(&connection, &fixture.origin, &runtime)
            .is_ok());
        fixture.finish().await;
    }
}
