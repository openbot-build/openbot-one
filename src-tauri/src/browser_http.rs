//! Private native HTTP half of the browser grant flow. The OS return owner
//! supplies callbacks directly; none of these methods are Tauri IPC commands.
use crate::{
    browser_auth::{AuthorizationCode, BrowserAttempt, Callback, Started},
    connection::{ConnectionState, Context},
    http::{sensitive_cookie, session_cookie, HttpState},
};
use reqwest::{
    header::{CONTENT_TYPE, COOKIE, ORIGIN},
    StatusCode,
};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub struct BrowserStart<'a> {
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub email: Option<&'a str>,
    pub invitation: Option<&'a str>,
}
pub struct BrowserFlow {
    context: Context,
    attempt: BrowserAttempt,
}
impl BrowserFlow {
    pub fn remaining(&self) -> Result<Duration, String> {
        self.attempt.remaining().map_err(|error| error.to_string())
    }
    pub fn accept_return(
        &mut self,
        connection: &ConnectionState,
        url: &str,
    ) -> Result<Callback, String> {
        current(connection, &self.context)?;
        self.attempt
            .take_callback(url)
            .map_err(|error| error.to_string())
    }
    /// The caller must put these bytes in an OS credential entry, never a file.
    pub fn encode_pending(&self) -> Result<Zeroizing<Vec<u8>>, String> {
        self.attempt
            .encode_pending()
            .map_err(|error| error.to_string())
    }
    pub fn restore_pending(
        connection: &ConnectionState,
        expected_origin: &str,
        runtime_id: &str,
        client: &str,
        redirect: &str,
        bytes: &[u8],
    ) -> Result<Self, String> {
        let context = connection.bound_context(expected_origin, runtime_id)?;
        let attempt = BrowserAttempt::restore_pending(bytes, &context.origin, client, redirect)
            .map_err(|error| error.to_string())?;
        Ok(Self { context, attempt })
    }
}
fn current(connection: &ConnectionState, context: &Context) -> Result<(), String> {
    let active = connection.context()?;
    if active.generation != context.generation || active.origin != context.origin {
        return Err("The service or sign-in changed. Start sign-in again.".into());
    }
    Ok(())
}
fn json_type(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        == Some("application/json")
}
async fn bounded_body(
    response: &mut reqwest::Response,
    limit: usize,
) -> Result<Zeroizing<Vec<u8>>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("The sign-in response is too large.".into());
    }
    let mut body = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The sign-in response could not be read.")?
    {
        if body.len() + chunk.len() > limit {
            return Err("The sign-in response is too large.".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
fn refused(status: StatusCode) -> String {
    match status.as_u16() {
        400 => "The sign-in attempt was not accepted. Start again.",
        404 => "This service does not support native browser sign-in. Update the service.",
        429 => "Too many sign-in attempts. Wait a minute and try again.",
        _ => "The sign-in service could not complete this request.",
    }
    .into()
}
impl HttpState {
    pub async fn browser_start(
        &self,
        connection: &ConnectionState,
        expected_origin: &str,
        runtime_id: &str,
        input: BrowserStart<'_>,
        cancel: &CancellationToken,
    ) -> Result<(BrowserFlow, Zeroizing<String>), String> {
        let context = connection.bound_context(expected_origin, runtime_id)?;
        if cancel.is_cancelled() {
            return Err("Sign-in was cancelled.".into());
        }
        let mut attempt = BrowserAttempt::new(&context.origin, input.client_id, input.redirect_uri)
            .map_err(|error| error.to_string())?;
        let body = attempt
            .start_body(input.email, input.invitation)
            .map_err(|error| error.to_string())?;
        let read = async {
            let mut response = self
                .client
                .post(format!("{}/auth/native/start", context.origin.as_str()))
                .header(ORIGIN, context.origin.as_str())
                .header(CONTENT_TYPE, "application/json")
                .body(body.to_vec())
                .send()
                .await
                .map_err(|_| "The sign-in service could not be reached.")?;
            if response.status() != StatusCode::OK {
                return Err(refused(response.status()));
            }
            if !json_type(&response) {
                return Err("The sign-in response is not valid.".into());
            }
            let bytes = bounded_body(&mut response, 8192).await?;
            serde_json::from_slice::<Started>(&bytes)
                .map_err(|_| "The sign-in response is not valid.".into())
        };
        let reply = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("Sign-in was cancelled.".into()),
            result = tokio::time::timeout(Duration::from_secs(15), read) =>
                result.map_err(|_| "The sign-in service did not answer in time.")??,
        };
        let url = attempt
            .bind_started(reply)
            .map_err(|error| error.to_string())?;
        let flow = BrowserFlow { context, attempt };
        let ready = if cancel.is_cancelled() {
            Err("Sign-in was cancelled.".into())
        } else {
            current(connection, &flow.context)
        };
        if let Err(error) = ready {
            let _ = self.browser_cancel(&flow).await;
            return Err(error);
        }
        Ok((flow, url))
    }

    /// Clear the saved pending entry before this call. Never retry an exchange
    /// after a lost reply. Keep this future owned through response and cleanup.
    pub async fn browser_exchange(
        &self,
        connection: &ConnectionState,
        flow: &mut BrowserFlow,
        code: AuthorizationCode,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        current(connection, &flow.context)?;
        if cancel.is_cancelled() {
            return Err("Sign-in was cancelled.".into());
        }
        let body = flow
            .attempt
            .take_exchange_body(code)
            .map_err(|error| error.to_string())?;
        // Do not drop a credential-creating request on UI cancellation. Once a
        // reply arrives, cancellation or a stale generation revokes its cookie.
        let response = self
            .client
            .post(format!(
                "{}/auth/native/exchange",
                flow.context.origin.as_str()
            ))
            .header(ORIGIN, flow.context.origin.as_str())
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_vec())
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| "The sign-in exchange did not finish. Start sign-in again.")?;
        if response.status() != StatusCode::NO_CONTENT {
            return Err(refused(response.status()));
        }
        let cookie = Zeroizing::new(
            session_cookie(response.headers())
                .ok_or("The sign-in service returned no valid session.")?,
        );
        let result = async {
            current(connection, &flow.context)?;
            if cancel.is_cancelled() {
                return Err("Sign-in was cancelled.".into());
            }
            let session = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("Sign-in was cancelled.".into()),
                checked = self.check_session(&flow.context, cookie.to_string()) =>
                    checked.map_err(|error| error.message())?,
            };
            connection
                .complete_session(&flow.context, session, Some(cancel))
                .await
        }
        .await;
        if let Err(error) = result {
            if self.browser_revoke(&flow.context, &cookie).await.is_err() {
                return Err(
                    "Sign-in did not finish. The service could not confirm session cleanup.".into(),
                );
            }
            return Err(error);
        }
        self.cancel_before(connection.generation()?);
        Ok(())
    }

    /// Cleanup deliberately uses the captured old service and only its proof.
    /// It never attaches either the old or current account's session Cookie.
    pub async fn browser_cancel(&self, flow: &BrowserFlow) -> Result<(), String> {
        let body = flow
            .attempt
            .cancel_body()
            .map_err(|error| error.to_string())?;
        let response = self
            .client
            .post(format!(
                "{}/auth/native/cancel",
                flow.context.origin.as_str()
            ))
            .header(ORIGIN, flow.context.origin.as_str())
            .header(CONTENT_TYPE, "application/json")
            .body(body.to_vec())
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| "The service could not confirm sign-in cancellation.")?;
        if response.status() != StatusCode::NO_CONTENT {
            return Err(refused(response.status()));
        }
        Ok(())
    }
    async fn browser_revoke(&self, context: &Context, cookie: &str) -> Result<(), String> {
        let response = self
            .client
            .post(format!("{}/auth/sign-out", context.origin.as_str()))
            .header(ORIGIN, context.origin.as_str())
            .header(
                COOKIE,
                sensitive_cookie(cookie).map_err(|_| "The fresh session is not valid.")?,
            )
            .header(CONTENT_TYPE, "application/json")
            .body("{}")
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|_| "The service could not confirm session cleanup.")?;
        if !response.status().is_success() {
            return Err("The service could not confirm session cleanup.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Clone, Copy, PartialEq, Eq)]
    pub(crate) enum Mode {
        Good,
        BadAccount,
        BadCookie,
        Redirect,
        Cancel,
        LateChange,
    }
    pub(crate) struct Captured {
        pub(crate) path: String,
        headers: String,
        pub(crate) body: Value,
    }
    pub(crate) struct Fixture {
        pub(crate) origin: String,
        pub(crate) calls: Arc<Mutex<Vec<Captured>>>,
        session_seen: Arc<tokio::sync::Notify>,
        resume_session: Arc<tokio::sync::Notify>,
        stop: CancellationToken,
        task: Option<tokio::task::JoinHandle<()>>,
    }
    impl Fixture {
        pub(crate) async fn start(mode: Mode, login_cancel: CancellationToken) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let calls = Arc::new(Mutex::new(Vec::new()));
            let stop = CancellationToken::new();
            let captured = calls.clone();
            let shutdown = stop.clone();
            let service = origin.clone();
            let session_seen = Arc::new(tokio::sync::Notify::new());
            let resume_session = Arc::new(tokio::sync::Notify::new());
            let seen = session_seen.clone();
            let resume = resume_session.clone();
            let task = tokio::spawn(async move {
                loop {
                    let (mut stream, _) = tokio::select! {
                        _ = shutdown.cancelled() => break,
                        accepted = listener.accept() => accepted.unwrap(),
                    };
                    let mut bytes = Vec::new();
                    let header_end = loop {
                        let mut chunk = [0_u8; 4096];
                        let size = stream.read(&mut chunk).await.unwrap();
                        if size == 0 {
                            break None;
                        }
                        bytes.extend_from_slice(&chunk[..size]);
                        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
                        {
                            break Some(end + 4);
                        }
                        assert!(bytes.len() < 16 * 1024);
                    };
                    let Some(end) = header_end else {
                        continue;
                    };
                    let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    while bytes.len() - end < length {
                        let mut chunk = [0_u8; 4096];
                        let size = stream.read(&mut chunk).await.unwrap();
                        if size == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&chunk[..size]);
                    }
                    let path = headers.split_whitespace().nth(1).unwrap().to_string();
                    let body: Value = if length == 0 {
                        Value::Null
                    } else {
                        serde_json::from_slice(&bytes[end..end + length]).unwrap()
                    };
                    captured.lock().unwrap().push(Captured {
                        path: path.clone(),
                        headers,
                        body,
                    });
                    let (status, extra, body) = match path.as_str() {
                        "/auth/native/start" => ("200 OK", "", json!({
                            "request": URL_SAFE_NO_PAD.encode([7_u8; 32]),
                            "url": format!("{service}/auth/native/authorize?request={}", URL_SAFE_NO_PAD.encode([7_u8; 32])),
                            "expiresIn": 300,
                        }).to_string()),
                        "/auth/native/exchange" if mode == Mode::Redirect => ("302 Found", "Location: https://evil.example.com/\r\n", String::new()),
                        "/auth/native/exchange" if mode == Mode::BadCookie => ("204 No Content", "Set-Cookie: __Host-openbot-session=invalid; Path=/\r\n", String::new()),
                        "/auth/native/exchange" => ("204 No Content", "Set-Cookie: __Host-openbot-session=fixture.signature; Secure; HttpOnly; Path=/\r\n", String::new()),
                        "/auth/session" if mode == Mode::BadAccount => ("401 Unauthorized", "", "{}".into()),
                        "/auth/session" => {
                            if mode == Mode::Cancel { login_cancel.cancel(); }
                            if mode == Mode::LateChange {
                                seen.notify_one();
                                resume.notified().await;
                            }
                            ("200 OK", "", json!({"userId":"person"}).to_string())
                        },
                        "/auth/sign-out" => ("200 OK", "", "{}".into()),
                        "/auth/native/cancel" => ("204 No Content", "", String::new()),
                        _ => panic!("Unexpected fixture path"),
                    };
                    let reply = format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}\r\n{body}", body.len());
                    let _ = stream.write_all(reply.as_bytes()).await;
                }
            });
            Self {
                origin,
                calls,
                session_seen,
                resume_session,
                stop,
                task: Some(task),
            }
        }
        pub(crate) fn target(&self) -> String {
            let calls = self.calls.lock().unwrap();
            let start = &calls[0].body;
            let mut url = url::Url::parse(start["redirectUri"].as_str().unwrap()).unwrap();
            url.query_pairs_mut()
                .append_pair("code", &URL_SAFE_NO_PAD.encode([8_u8; 32]))
                .append_pair("state", start["state"].as_str().unwrap())
                .append_pair("iss", &self.origin);
            url.into()
        }
        pub(crate) async fn finish(mut self) {
            self.stop.cancel();
            self.task.take().unwrap().await.unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.stop.cancel();
            if let Some(task) = self.task.take() {
                task.abort();
            }
        }
    }
    pub(crate) fn connection(fixture: &Fixture) -> (tempfile::TempDir, ConnectionState) {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = ConnectionState::load(
            directory.path().join("connection.json"),
            crate::service::ServiceOrigin::for_app(&fixture.origin).unwrap(),
        )
        .unwrap();
        connection.disable_credential_store_for_test();
        (directory, connection)
    }
    async fn start(
        http: &HttpState,
        connection: &ConnectionState,
        fixture: &Fixture,
        cancel: &CancellationToken,
    ) -> BrowserFlow {
        let snapshot = connection.snapshot().unwrap();
        http.browser_start(
            connection,
            &fixture.origin,
            &snapshot.runtime_id,
            BrowserStart {
                client_id: "openbot-one",
                redirect_uri: "http://127.0.0.1:53123/auth/callback",
                email: None,
                invitation: None,
            },
            cancel,
        )
        .await
        .unwrap()
        .0
    }
    fn code(
        flow: &mut BrowserFlow,
        connection: &ConnectionState,
        fixture: &Fixture,
    ) -> AuthorizationCode {
        let Callback::Code(code) = flow.accept_return(connection, &fixture.target()).unwrap()
        else {
            panic!("Expected code");
        };
        code
    }
    #[tokio::test]
    async fn complete_flow_keeps_the_cookie_private_and_publishes_only_a_checked_account() {
        let cancel = CancellationToken::new();
        let fixture = Fixture::start(Mode::Good, cancel.clone()).await;
        let (_directory, connection) = connection(&fixture);
        let http = HttpState::new().unwrap();
        let mut flow = start(&http, &connection, &fixture, &cancel).await;
        let code = code(&mut flow, &connection, &fixture);
        http.browser_exchange(&connection, &mut flow, code, &cancel)
            .await
            .unwrap();
        assert_eq!(
            connection.context().unwrap().cookie.as_deref(),
            Some("__Host-openbot-session=fixture.signature")
        );
        assert_eq!(connection.snapshot().unwrap().session_persistence, "memory");
        {
            let calls = fixture.calls.lock().unwrap();
            assert_eq!(calls.len(), 3);
            for call in calls.iter().take(2) {
                assert!(!call.headers.to_ascii_lowercase().contains("\r\ncookie:"));
                assert!(call
                    .headers
                    .to_ascii_lowercase()
                    .contains(&format!("\r\norigin: {}", fixture.origin)));
            }
            assert_eq!(calls[1].path, "/auth/native/exchange");
            let verifier = calls[1].body["codeVerifier"].as_str().unwrap();
            use sha2::{Digest, Sha256};
            assert_eq!(
                URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
                calls[0].body["codeChallenge"]
            );
        }
        fixture.finish().await;
    }
    #[tokio::test]
    async fn failed_or_cancelled_account_check_revokes_only_the_fresh_cookie() {
        for mode in [Mode::BadAccount, Mode::Cancel] {
            let cancel = CancellationToken::new();
            let fixture = Fixture::start(mode, cancel.clone()).await;
            let (_directory, connection) = connection(&fixture);
            connection
                .save_session(
                    &connection.context().unwrap(),
                    crate::connection::Session {
                        cookie: "old-private-session".into(),
                        account: "old-person".into(),
                        persisted: false,
                    },
                )
                .unwrap();
            let http = HttpState::new().unwrap();
            let mut flow = start(&http, &connection, &fixture, &cancel).await;
            let code = code(&mut flow, &connection, &fixture);
            assert!(http
                .browser_exchange(&connection, &mut flow, code, &cancel)
                .await
                .is_err());
            assert_eq!(
                connection.context().unwrap().cookie.as_deref(),
                Some("old-private-session")
            );
            {
                let calls = fixture.calls.lock().unwrap();
                assert_eq!(calls.len(), 4);
                for call in calls.iter().take(2) {
                    assert!(!call.headers.to_ascii_lowercase().contains("\r\ncookie:"));
                }
                assert_eq!(calls[3].path, "/auth/sign-out");
                assert!(calls[3]
                    .headers
                    .contains("__Host-openbot-session=fixture.signature"));
            }
            fixture.finish().await;
        }
    }
    #[tokio::test]
    async fn redirects_and_non_private_cookies_cannot_start_session_validation() {
        for mode in [Mode::Redirect, Mode::BadCookie] {
            let cancel = CancellationToken::new();
            let fixture = Fixture::start(mode, cancel.clone()).await;
            let (_directory, connection) = connection(&fixture);
            let http = HttpState::new().unwrap();
            let mut flow = start(&http, &connection, &fixture, &cancel).await;
            let code = code(&mut flow, &connection, &fixture);
            assert!(http
                .browser_exchange(&connection, &mut flow, code, &cancel)
                .await
                .is_err());
            assert!(connection.context().unwrap().cookie.is_none());
            assert_eq!(fixture.calls.lock().unwrap().len(), 2);
            fixture.finish().await;
        }
    }
    #[tokio::test]
    async fn a_stale_flow_cannot_exchange_and_cleanup_uses_only_its_old_proof() {
        let cancel = CancellationToken::new();
        let fixture = Fixture::start(Mode::Good, cancel.clone()).await;
        let (_directory, connection) = connection(&fixture);
        let http = HttpState::new().unwrap();
        let mut flow = start(&http, &connection, &fixture, &cancel).await;
        let code = code(&mut flow, &connection, &fixture);
        connection
            .select(Some("https://other.example.com"))
            .unwrap();
        assert!(http
            .browser_exchange(&connection, &mut flow, code, &cancel)
            .await
            .is_err());
        assert_eq!(fixture.calls.lock().unwrap().len(), 1);
        http.browser_cancel(&flow).await.unwrap();
        {
            let calls = fixture.calls.lock().unwrap();
            assert_eq!(calls.len(), 2);
            assert_eq!(calls[1].path, "/auth/native/cancel");
            assert!(!calls[1]
                .headers
                .to_ascii_lowercase()
                .contains("\r\ncookie:"));
            assert!(calls[1].body["codeVerifier"].is_string());
        }
        fixture.finish().await;
    }
    #[tokio::test]
    async fn a_service_change_during_account_validation_revokes_the_fresh_session() {
        let cancel = CancellationToken::new();
        let fixture = Fixture::start(Mode::LateChange, cancel.clone()).await;
        let (_directory, connection) = connection(&fixture);
        let http = HttpState::new().unwrap();
        let mut flow = start(&http, &connection, &fixture, &cancel).await;
        let code = code(&mut flow, &connection, &fixture);
        let exchange = http.browser_exchange(&connection, &mut flow, code, &cancel);
        tokio::pin!(exchange);
        tokio::time::timeout(Duration::from_secs(5), async {
            tokio::select! {
                _ = fixture.session_seen.notified() => (),
                result = &mut exchange => panic!("Exchange ended before account check: {result:?}"),
            }
        })
        .await
        .unwrap();
        connection
            .select(Some("https://other.example.com"))
            .unwrap();
        fixture.resume_session.notify_one();
        assert!(exchange.await.is_err());
        assert_eq!(
            connection.context().unwrap().origin.as_str(),
            "https://other.example.com"
        );
        assert!(connection.context().unwrap().cookie.is_none());
        {
            let calls = fixture.calls.lock().unwrap();
            assert_eq!(calls.len(), 4);
            assert_eq!(calls[3].path, "/auth/sign-out");
            assert!(calls[3]
                .headers
                .contains("__Host-openbot-session=fixture.signature"));
        }
        fixture.finish().await;
    }
}
