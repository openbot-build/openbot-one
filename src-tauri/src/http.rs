use crate::connection::{ConnectionState, Context, Session};
#[cfg(test)]
use crate::service::ServiceOrigin;
use crate::uploads::UploadGrants;
use bytes::Bytes;
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, CONTENT_LENGTH, COOKIE, ORIGIN, SET_COOKIE},
    Method,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;

const CHUNK_SIZE: usize = 64 * 1024;
const SESSION_COOKIE: &str = "__Host-openbot-session";

pub(crate) enum SessionCheckError {
    Rejected,
    Unavailable,
}
impl SessionCheckError {
    pub fn message(&self) -> String {
        match self {
            Self::Rejected => "The saved sign-in has ended. Sign in again.",
            Self::Unavailable => {
                "The session could not be checked. Check the service and try again."
            }
        }
        .into()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestInput {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub has_body: bool,
    pub expected_origin: String,
    pub runtime_id: String,
    pub content_length: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseHead {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub url: String,
    // Only the native command uses this to close the old account's sockets.
    #[serde(skip)]
    pub(crate) session_changed: bool,
}

struct ResponseBody {
    response: Option<reqwest::Response>,
    pending: Bytes,
}
struct RequestSlot {
    context: Context,
    request: Mutex<Option<reqwest::Request>>,
    response: AsyncMutex<Option<ResponseBody>>,
    sender: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    remaining: Mutex<Option<u64>>,
    cancel: CancellationToken,
    stop_upload: CancellationToken,
    signed_upload: bool,
    email_verification: bool,
}

pub struct HttpState {
    pub(crate) client: reqwest::Client,
    slots: Mutex<HashMap<String, Arc<RequestSlot>>>,
    uploads: UploadGrants,
}

impl HttpState {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .referer(false)
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "The HTTP client could not start.")?;
        Ok(Self {
            client,
            slots: Mutex::new(HashMap::new()),
            uploads: UploadGrants::default(),
        })
    }

    pub fn prepare(
        &self,
        connection: &ConnectionState,
        input: RequestInput,
    ) -> Result<String, String> {
        let context = connection.bound_context(&input.expected_origin, &input.runtime_id)?;
        if input.url.len() > 8192 || input.headers.len() > 128 {
            return Err("The request is too large.".into());
        }
        if input.content_length.is_some() && !input.has_body {
            return Err("An upload length needs a request body.".into());
        }
        let url = url::Url::parse(&input.url).map_err(|_| "The request address is not valid.")?;
        if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
            return Err("The request address is not allowed.".into());
        }
        let method = Method::from_bytes(input.method.as_bytes())
            .map_err(|_| "The request method is not valid.")?;
        let email_verification =
            method == Method::POST && url.path() == "/auth/email/verify" && url.query().is_none();
        let public_sign_in = url.query().is_none()
            && ((method == Method::GET && url.path() == "/auth/options")
                || (method == Method::POST && url.path() == "/auth/email/send")
                || email_verification);
        let authenticated = context.origin.allows_authenticated_request(&url)
            && (url.path().starts_with("/v1/")
                || url.path() == "/auth/session"
                || url.path() == "/health"
                || public_sign_in);
        if !matches!(
            method,
            Method::GET
                | Method::HEAD
                | Method::POST
                | Method::PUT
                | Method::PATCH
                | Method::DELETE
                | Method::OPTIONS
        ) {
            return Err("The request method is not allowed.".into());
        }
        let mut headers = HeaderMap::new();
        for (name, value) in input.headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "A request header is not valid.")?;
            if forbidden_header(name.as_str()) {
                return Err("The app cannot supply this authentication or network header.".into());
            }
            headers.append(
                name,
                HeaderValue::from_str(&value).map_err(|_| "A request header is not valid.")?,
            );
        }
        let upload = self.uploads.allows(
            &context,
            &url,
            &method,
            &headers,
            input.content_length,
            input.has_body,
        )?;
        if !authenticated && !upload {
            return Err(
                "This request is outside the selected service and its signed uploads.".into(),
            );
        }
        let signed_upload = authenticated
            && !upload
            && context.cookie.is_some()
            && method == Method::POST
            && url.path() == "/v1/files/uploads";
        if authenticated && !upload {
            headers.insert(
                ORIGIN,
                HeaderValue::from_str(context.origin.as_str())
                    .map_err(|_| "The service origin is not valid.")?,
            );
            if let Some(cookie) = context.cookie.as_ref() {
                let mut value =
                    HeaderValue::from_str(cookie).map_err(|_| "The session is not valid.")?;
                value.set_sensitive(true);
                headers.insert(COOKIE, value);
            }
        }
        let (sender, receiver) = mpsc::channel::<Vec<u8>>(2);
        let mut builder = self.client.request(method, url).headers(headers);
        if let Some(length) = input.content_length {
            builder = builder.header(CONTENT_LENGTH, length);
        }
        if input.has_body {
            let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
                receiver
                    .recv()
                    .await
                    .map(|chunk| (Ok::<_, std::io::Error>(chunk), receiver))
            });
            builder = builder.body(reqwest::Body::wrap_stream(stream));
        }
        let request = builder
            .build()
            .map_err(|_| "The request could not be made.")?;
        let slot = Arc::new(RequestSlot {
            context,
            request: Mutex::new(Some(request)),
            response: AsyncMutex::new(None),
            sender: Mutex::new(input.has_body.then_some(sender)),
            remaining: Mutex::new(input.content_length),
            cancel: CancellationToken::new(),
            stop_upload: CancellationToken::new(),
            signed_upload,
            email_verification,
        });
        let id = uuid::Uuid::new_v4().to_string();
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| "Network state is not available.")?;
        if slots.len() >= 128 {
            return Err("Too many requests are running. Try again.".into());
        }
        slots.insert(id.clone(), slot);
        Ok(id)
    }

    fn slot(&self, id: &str) -> Result<Arc<RequestSlot>, String> {
        self.slots
            .lock()
            .map_err(|_| "Network state is not available.")?
            .get(id)
            .cloned()
            .ok_or_else(|| "The request ended or was cancelled.".into())
    }

    pub async fn open(
        &self,
        connection: &ConnectionState,
        id: &str,
    ) -> Result<ResponseHead, String> {
        let slot = self.slot(id)?;
        if connection.context()?.generation != slot.context.generation {
            self.cancel(id);
            return Err("The service changed. Reload the app.".into());
        }
        let request = slot
            .request
            .lock()
            .map_err(|_| "The request is not available.")?
            .take()
            .ok_or("This request already started.")?;
        let result = tokio::select! {
            _ = slot.cancel.cancelled() => Err("The request was cancelled.".to_string()),
            result = self.client.execute(request) => result.map_err(|_| "The service could not be reached. Check its address and connection.".to_string()),
        };
        slot.stop_upload.cancel();
        let mut response = match result {
            Ok(response) => response,
            Err(error) => {
                self.cancel(id);
                return Err(error);
            }
        };
        let mut head = ResponseHead {
            status: response.status().as_u16(),
            status_text: response
                .status()
                .canonical_reason()
                .unwrap_or("")
                .to_string(),
            url: response.url().to_string(),
            session_changed: false,
            headers: response
                .headers()
                .iter()
                .filter(|(name, _)| *name != SET_COOKIE)
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|value| (name.to_string(), value.to_string()))
                })
                .collect(),
        };
        // Only this published first-party endpoint can establish a session.
        // Ordinary API responses and failed sign-ins never change credentials.
        if slot.email_verification && response.status() == reqwest::StatusCode::NO_CONTENT {
            let checked = async {
                let cookie = session_cookie(response.headers())
                    .ok_or("The sign-in service returned no valid session.")?;
                let session = self
                    .check_session(&slot.context, cookie)
                    .await
                    .map_err(|error| error.message())?;
                connection
                    .complete_session(&slot.context, session, Some(&slot.cancel))
                    .await
            };
            let committed = tokio::select! {
                biased;
                _ = slot.cancel.cancelled() => Err("Sign-in was cancelled.".to_string()),
                result = checked => result,
            };
            if let Err(error) = committed {
                self.cancel(id);
                return Err(error);
            }
            self.cancel_before(connection.generation()?);
            head.session_changed = true;
            return Ok(head);
        }
        if slot.signed_upload && response.status() == reqwest::StatusCode::CREATED {
            let captured = tokio::select! {
                _ = slot.cancel.cancelled() => Err("The upload request was cancelled.".to_string()),
                body = tokio::time::timeout(Duration::from_secs(10), upload_document(&mut response)) => body.map_err(|_| "The signed upload response timed out.".to_string()).and_then(|body| body),
            };
            let registered = captured.and_then(|body| {
                if connection.context()?.generation != slot.context.generation {
                    return Err("The service changed. Start the upload again.".into());
                }
                self.uploads.install(&slot.context, &body)?;
                Ok(body)
            });
            match registered {
                Ok(body) => {
                    *slot.response.lock().await = Some(ResponseBody {
                        response: None,
                        pending: body.into(),
                    });
                    return Ok(head);
                }
                Err(error) => {
                    self.cancel(id);
                    return Err(error);
                }
            }
        }
        *slot.response.lock().await = Some(ResponseBody {
            response: Some(response),
            pending: Bytes::new(),
        });
        Ok(head)
    }

    pub async fn write(&self, id: &str, bytes: Vec<u8>) -> Result<bool, String> {
        if bytes.len() > CHUNK_SIZE {
            return Err("The upload chunk is too large.".into());
        }
        let slot = self.slot(id)?;
        if slot.stop_upload.is_cancelled() {
            return Ok(false);
        }
        {
            let mut remaining = slot
                .remaining
                .lock()
                .map_err(|_| "The upload is not available.")?;
            if let Some(count) = remaining.as_mut() {
                if bytes.len() as u64 > *count {
                    self.cancel(id);
                    return Err("The upload has more bytes than its declared length.".into());
                }
                *count -= bytes.len() as u64;
            }
        }
        let sender = slot
            .sender
            .lock()
            .map_err(|_| "The upload is not available.")?
            .clone();
        let Some(sender) = sender else {
            return Ok(false);
        };
        tokio::select! {
            _ = slot.cancel.cancelled() => Err("The request was cancelled.".to_string()),
            _ = slot.stop_upload.cancelled() => Ok(false),
            result = sender.send(bytes) => Ok(result.is_ok()),
        }
    }

    pub fn finish_upload(&self, id: &str) -> Result<(), String> {
        let slot = self.slot(id)?;
        if slot
            .remaining
            .lock()
            .map_err(|_| "The upload is not available.")?
            .is_some_and(|remaining| remaining != 0)
        {
            self.cancel(id);
            return Err("The upload ended before its declared length.".into());
        }
        slot.sender
            .lock()
            .map_err(|_| "The upload is not available.")?
            .take();
        Ok(())
    }

    pub async fn read(&self, id: &str) -> Result<Vec<u8>, String> {
        let slot = self.slot(id)?;
        let mut body = slot.response.lock().await;
        let response = body.as_mut().ok_or("The response is not ready.")?;
        while response.pending.is_empty() {
            let Some(network) = response.response.as_mut() else {
                drop(body);
                self.cancel(id);
                return Ok(Vec::new());
            };
            let next = tokio::select! {
                _ = slot.cancel.cancelled() => return Err("The request was cancelled.".into()),
                next = network.chunk() => next,
            };
            match next {
                Ok(Some(bytes)) => response.pending = bytes,
                Ok(None) => {
                    drop(body);
                    self.cancel(id);
                    return Ok(Vec::new());
                }
                Err(_) => {
                    drop(body);
                    self.cancel(id);
                    return Err("The connection ended while reading the response.".into());
                }
            }
        }
        let count = CHUNK_SIZE.min(response.pending.len());
        Ok(response.pending.split_to(count).to_vec())
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(mut slots) = self.slots.lock() {
            if let Some(slot) = slots.remove(id) {
                slot.cancel.cancel();
            }
        }
    }

    /// A delayed auth/restore operation must leave newer requests untouched.
    pub fn cancel_before(&self, generation: u64) {
        if let Ok(mut slots) = self.slots.lock() {
            slots.retain(|_, slot| {
                if slot.context.generation < generation {
                    slot.cancel.cancel();
                    false
                } else {
                    true
                }
            });
        }
        self.uploads.revoke_before(generation);
    }

    #[cfg(test)]
    pub fn cancel_all(&self) {
        if let Ok(mut slots) = self.slots.lock() {
            for (_, slot) in slots.drain() {
                slot.cancel.cancel();
            }
        }
        self.uploads.clear();
    }

    pub async fn development_sign_in(
        &self,
        connection: &ConnectionState,
        expected_origin: &str,
        runtime_id: &str,
    ) -> Result<(), String> {
        let context = connection.bound_context(expected_origin, runtime_id)?;
        if !cfg!(debug_assertions) || !context.origin.is_loopback() {
            return Err("Use company sign-in or an email code for this service.".into());
        }
        let origin = context.origin.as_str();
        let response = self
            .client
            .post(format!("{origin}/auth/development/sign-in"))
            .header(ORIGIN, origin)
            .header("content-type", "application/json")
            .body("{}")
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| "The local sign-in service could not be reached.")?;
        if !response.status().is_success() {
            return Err("The local backend did not accept development sign-in.".into());
        }
        let cookie = session_cookie(response.headers())
            .ok_or("The local sign-in service returned no session.")?;
        let session = self
            .check_session(&context, cookie)
            .await
            .map_err(|error| error.message())?;
        connection.complete_session(&context, session, None).await
    }

    pub(crate) async fn check_session(
        &self,
        context: &Context,
        cookie: String,
    ) -> Result<Session, SessionCheckError> {
        let origin = context.origin.as_str();
        let mut response = self
            .client
            .get(format!("{origin}/auth/session"))
            .header(
                COOKIE,
                sensitive_cookie(&cookie).map_err(|_| SessionCheckError::Unavailable)?,
            )
            .header(ORIGIN, origin)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| SessionCheckError::Unavailable)?;
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(SessionCheckError::Rejected);
        }
        if response.status() != reqwest::StatusCode::OK
            || response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(';').next())
                != Some("application/json")
        {
            return Err(SessionCheckError::Unavailable);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| SessionCheckError::Unavailable)?
        {
            if body.len() + chunk.len() > 64 * 1024 {
                return Err(SessionCheckError::Unavailable);
            }
            body.extend_from_slice(&chunk);
        }
        let value: serde_json::Value =
            serde_json::from_slice(&body).map_err(|_| SessionCheckError::Unavailable)?;
        let account = value
            .get("userId")
            .and_then(|v| v.as_str())
            .filter(|id| !id.is_empty() && id.len() <= 512)
            .ok_or(SessionCheckError::Unavailable)?;
        Ok(Session {
            cookie,
            account: account.to_string(),
            persisted: false,
        })
    }

    pub async fn sign_out(
        &self,
        connection: &ConnectionState,
        expected_origin: &str,
        runtime_id: &str,
    ) -> Result<(), String> {
        let context = connection.bound_context(expected_origin, runtime_id)?;
        let local = connection.forget_session(&context).await;
        self.cancel_before(context.generation + 1);
        if let Some(cookie) = context.cookie {
            let origin = context.origin.as_str();
            let result = self
                .client
                .post(format!("{origin}/auth/sign-out"))
                .header(ORIGIN, origin)
                .header(
                    COOKIE,
                    sensitive_cookie(&cookie).map_err(|_| "The session is not valid.")?,
                )
                .header("content-type", "application/json")
                .body("{}")
                .timeout(Duration::from_secs(10))
                .send()
                .await;
            if !matches!(result, Ok(response) if response.status().is_success()) {
                return Err(
                    "You signed out here, but the service could not confirm sign-out.".into(),
                );
            }
        }
        local
    }
}

pub(crate) fn forbidden_header(name: &str) -> bool {
    matches!(
        name,
        "authorization"
            | "cookie"
            | "origin"
            | "host"
            | "referer"
            | "content-length"
            | "connection"
            | "upgrade"
            | "forwarded"
    ) || ["proxy-", "sec-", "cf-access-", "x-forwarded-"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

async fn upload_document(response: &mut reqwest::Response) -> Result<Vec<u8>, String> {
    const LIMIT: usize = 64 * 1024;
    if response
        .content_length()
        .is_some_and(|length| length > LIMIT as u64)
    {
        return Err("The signed upload response is too large.".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The signed upload response could not be read.")?
    {
        if body.len() + chunk.len() > LIMIT {
            return Err("The signed upload response is too large.".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub(crate) fn session_cookie(headers: &HeaderMap) -> Option<String> {
    let mut cookies = headers
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| cookie::Cookie::parse(value).ok())
        .filter(|cookie| cookie.name() == SESSION_COOKIE);
    let cookie = cookies.next()?;
    if cookies.next().is_some()
        || cookie.value().is_empty()
        || cookie.value().len() > 8192
        || cookie.secure() != Some(true)
        || cookie.http_only() != Some(true)
        || cookie.path() != Some("/")
        || cookie.domain().is_some()
        || cookie.max_age().is_some_and(|age| age.whole_seconds() <= 0)
        || cookie
            .expires_datetime()
            .is_some_and(|date| date <= cookie::time::OffsetDateTime::now_utc())
    {
        return None;
    }
    Some(format!("{SESSION_COOKIE}={}", cookie.value()))
}

pub(crate) fn sensitive_cookie(value: &str) -> Result<HeaderValue, ()> {
    let mut header = HeaderValue::from_str(value).map_err(|_| ())?;
    header.set_sensitive(true);
    Ok(header)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "Start pnpm backend:local before this check."]
    async fn local_backend_native_session_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let origin = "http://localhost:19380";
        let state = ConnectionState::load(
            dir.path().join("connection.json"),
            ServiceOrigin::for_app(origin).unwrap(),
        )
        .unwrap();
        let http = HttpState::new().unwrap();
        async fn session(
            http: &HttpState,
            state: &ConnectionState,
            origin: &str,
        ) -> (u16, Vec<u8>) {
            let id = http
                .prepare(
                    state,
                    RequestInput {
                        url: format!("{origin}/auth/session"),
                        method: "GET".into(),
                        headers: vec![],
                        has_body: false,
                        expected_origin: origin.into(),
                        runtime_id: state.snapshot().unwrap().runtime_id,
                        content_length: None,
                    },
                )
                .unwrap();
            let head = http.open(state, &id).await.unwrap();
            assert!(!head.headers.iter().any(|(name, _)| name == "set-cookie"));
            let mut body = Vec::new();
            loop {
                let chunk = http.read(&id).await.unwrap();
                if chunk.is_empty() {
                    break;
                }
                body.extend(chunk);
            }
            (head.status, body)
        }
        assert_eq!(session(&http, &state, origin).await.0, 401);
        http.development_sign_in(&state, origin, &state.snapshot().unwrap().runtime_id)
            .await
            .unwrap();
        let (status, body) = session(&http, &state, origin).await;
        assert_eq!(status, 200);
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(value["userId"].is_string());
        http.sign_out(&state, origin, &state.snapshot().unwrap().runtime_id)
            .await
            .unwrap();
        assert_eq!(session(&http, &state, origin).await.0, 401);
        assert!(!dir.path().join("connection.json").exists());
    }

    fn connection() -> (tempfile::TempDir, ConnectionState) {
        let dir = tempfile::tempdir().unwrap();
        let state = ConnectionState::load(
            dir.path().join("connection.json"),
            ServiceOrigin::parse("https://service.test").unwrap(),
        )
        .unwrap();
        (dir, state)
    }

    fn request(connection: &ConnectionState, url: &str) -> RequestInput {
        RequestInput {
            url: url.into(),
            method: "GET".into(),
            headers: vec![],
            has_body: false,
            expected_origin: "https://service.test".into(),
            runtime_id: connection.snapshot().unwrap().runtime_id,
            content_length: None,
        }
    }

    #[tokio::test]
    async fn arbitrary_hosts_credentials_and_login_endpoints_are_rejected_before_network_io() {
        let (_dir, connection) = connection();
        let http = HttpState::new().unwrap();
        for url in [
            "https://evil.test/v1/chats",
            "http://service.test/v1/chats",
            "https://user:secret@service.test/v1/chats",
            "https://service.test/auth/development/sign-in",
        ] {
            assert!(http
                .prepare(&connection, request(&connection, url))
                .is_err());
        }
        let mut input = request(&connection, "https://service.test/auth/session");
        input.headers = vec![("Authorization".into(), "Bearer from-ui".into())];
        assert!(http.prepare(&connection, input).is_err());
    }

    #[tokio::test]
    async fn email_routes_require_the_exact_origin_method_and_path() {
        let (_dir, connection) = connection();
        let http = HttpState::new().unwrap();
        for (path, method, allowed) in [
            ("/auth/options", "GET", true),
            ("/auth/options", "POST", false),
            ("/auth/email/send", "POST", true),
            ("/auth/email/verify", "POST", true),
            ("/auth/email/verify", "GET", false),
            ("/auth/email/verify?next=/", "POST", false),
            ("/auth/email/verify/", "POST", false),
            ("/auth/sign-in", "POST", false),
            ("/auth/callback/email", "POST", false),
        ] {
            let mut input = request(&connection, &format!("https://service.test{path}"));
            input.method = method.into();
            assert_eq!(
                http.prepare(&connection, input).is_ok(),
                allowed,
                "{method} {path}"
            );
        }
        let mut input = request(&connection, "https://another.test/auth/email/verify");
        input.method = "POST".into();
        assert!(http.prepare(&connection, input).is_err());
        http.cancel_all();
    }

    #[tokio::test]
    async fn old_runtimes_cannot_change_the_new_services_session() {
        let (_dir, connection) = connection();
        let http = HttpState::new().unwrap();
        connection
            .save_session(
                &connection.context().unwrap(),
                Session {
                    cookie: "current-secret".into(),
                    account: "current-account".into(),
                    persisted: false,
                },
            )
            .unwrap();
        let generation = connection.context().unwrap().generation;
        assert!(http
            .sign_out(
                &connection,
                "https://old.test",
                &connection.snapshot().unwrap().runtime_id
            )
            .await
            .is_err());
        assert!(http
            .development_sign_in(
                &connection,
                "https://old.test",
                &connection.snapshot().unwrap().runtime_id
            )
            .await
            .is_err());
        assert!(connection
            .retry_session(
                &http,
                "https://old.test",
                &connection.snapshot().unwrap().runtime_id
            )
            .await
            .is_err());
        assert_eq!(connection.context().unwrap().generation, generation);
        assert_eq!(
            connection.context().unwrap().cookie.as_deref(),
            Some("current-secret")
        );
    }

    #[tokio::test]
    async fn old_documents_cannot_use_or_replace_a_new_account_on_the_same_service() {
        let (_dir, connection) = connection();
        let http = HttpState::new().unwrap();
        let old = connection.snapshot().unwrap();
        let stale_request = request(&connection, "https://service.test/auth/session");
        let old_id = http
            .prepare(
                &connection,
                request(&connection, "https://service.test/health"),
            )
            .unwrap();
        connection
            .save_session(
                &connection.context().unwrap(),
                Session {
                    cookie: "new-private-session".into(),
                    account: "new-account".into(),
                    persisted: false,
                },
            )
            .unwrap();
        assert!(http.prepare(&connection, stale_request).is_err());
        assert!(http
            .development_sign_in(&connection, &old.current_origin, &old.runtime_id)
            .await
            .is_err());
        assert!(http
            .sign_out(&connection, &old.current_origin, &old.runtime_id)
            .await
            .is_err());
        assert!(connection
            .retry_session(&http, &old.current_origin, &old.runtime_id)
            .await
            .is_err());
        assert!(connection
            .select_bound(None, &old.current_origin, &old.runtime_id)
            .is_err());
        assert!(connection
            .retry_bound(&old.current_origin, &old.runtime_id)
            .is_err());
        assert!(!_dir.path().join("connection.json").exists());
        let current = connection.context().unwrap();
        assert_eq!(current.cookie.as_deref(), Some("new-private-session"));
        let new_id = http
            .prepare(
                &connection,
                request(&connection, "https://service.test/auth/session"),
            )
            .unwrap();
        // A completion from before the account change only removes older work.
        http.cancel_before(current.generation);
        assert!(http.slot(&old_id).is_err());
        assert!(http.slot(&new_id).is_ok());
        assert!(http.open(&connection, &old_id).await.is_err());
        let prepared = http.slot(&new_id).unwrap();
        assert_eq!(
            prepared.request.lock().unwrap().as_ref().unwrap().headers()[COOKIE],
            "new-private-session"
        );
    }

    #[tokio::test]
    async fn file_storage_requests_never_receive_the_api_session() {
        let (_dir, connection) = connection();
        connection
            .save_session(
                &connection.context().unwrap(),
                Session {
                    cookie: "private-session".into(),
                    account: "person".into(),
                    persisted: false,
                },
            )
            .unwrap();
        let http = HttpState::new().unwrap();
        let document = serde_json::json!({"file":{"id":"file","status":"pending","bytes":3},"url":"https://storage.test/object?signed=value","method":"PUT","headers":{"content-length":"3"},
            "expiresAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 60000});
        http.uploads
            .install(
                &connection.context().unwrap(),
                &serde_json::to_vec(&document).unwrap(),
            )
            .unwrap();
        let mut input = request(&connection, "https://storage.test/object?signed=value");
        input.method = "PUT".into();
        input.has_body = true;
        input.content_length = Some(3);
        let id = http.prepare(&connection, input).unwrap();
        let slot = http.slot(&id).unwrap();
        let prepared = slot.request.lock().unwrap();
        let headers = prepared.as_ref().unwrap().headers();
        assert!(!headers.contains_key(COOKIE));
        assert!(!headers.contains_key(ORIGIN));
        assert_eq!(headers[CONTENT_LENGTH], "3");
    }

    #[tokio::test]
    async fn declared_upload_lengths_must_match_the_streamed_bytes() {
        let (_dir, connection) = connection();
        let http = HttpState::new().unwrap();
        for (body, valid) in [
            (vec![1, 2, 3], true),
            (vec![1, 2], false),
            (vec![1, 2, 3, 4], false),
        ] {
            let mut input = request(&connection, "https://service.test/v1/files");
            input.method = "PUT".into();
            input.has_body = true;
            input.content_length = Some(3);
            let id = http.prepare(&connection, input).unwrap();
            let write = http.write(&id, body).await;
            let result = write.and_then(|_| http.finish_upload(&id));
            assert_eq!(result.is_ok(), valid);
            if !valid {
                assert!(http.slot(&id).is_err());
            }
            http.cancel(&id);
        }
    }

    #[tokio::test]
    async fn a_service_change_invalidates_prepared_requests() {
        let (_dir, connection) = connection();
        let http = HttpState::new().unwrap();
        let id = http
            .prepare(
                &connection,
                request(&connection, "https://service.test/auth/session"),
            )
            .unwrap();
        connection.select(Some("https://another.test")).unwrap();
        assert!(http
            .open(&connection, &id)
            .await
            .err()
            .unwrap()
            .contains("service changed"));
    }

    #[test]
    fn cookie_parser_does_not_accept_other_cookie_names() {
        let mut headers = HeaderMap::new();
        headers.insert(SET_COOKIE, HeaderValue::from_static("other=secret; Secure"));
        assert!(session_cookie(&headers).is_none());
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static("__Host-openbot-session=value; Secure; HttpOnly; Path=/"),
        );
        assert_eq!(
            session_cookie(&headers).as_deref(),
            Some("__Host-openbot-session=value")
        );
    }

    #[test]
    fn session_cookies_must_be_host_only_private_current_and_unambiguous() {
        for value in [
            "__Host-openbot-session=value; HttpOnly; Path=/",
            "__Host-openbot-session=value; Secure; Path=/",
            "__Host-openbot-session=value; Secure; HttpOnly; Path=/auth",
            "__Host-openbot-session=value; Secure; HttpOnly; Path=/; Domain=service.test",
            "__Host-openbot-session=; Secure; HttpOnly; Path=/",
            "__Host-openbot-session=value; Secure; HttpOnly; Path=/; Max-Age=0",
            "__Host-openbot-session=value; Secure; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(SET_COOKIE, HeaderValue::from_str(value).unwrap());
            assert!(session_cookie(&headers).is_none(), "{value}");
        }
        let valid =
            HeaderValue::from_static("__Host-openbot-session=value; Secure; HttpOnly; Path=/");
        let mut headers = HeaderMap::new();
        headers.append(SET_COOKIE, valid.clone());
        headers.append(SET_COOKIE, valid);
        assert!(session_cookie(&headers).is_none());
        assert!(!serde_json::to_string(&ResponseHead {
            status: 204,
            status_text: "No Content".into(),
            headers: vec![],
            url: "https://service.test/auth/email/verify".into(),
            session_changed: true,
        })
        .unwrap()
        .contains("sessionChanged"));
    }
}
