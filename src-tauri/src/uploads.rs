use crate::{connection::Context, service::ServiceOrigin};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, CONTENT_LENGTH},
    Method,
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_GRANTS: usize = 128;
const MAX_LIFETIME: Duration = Duration::from_secs(15 * 60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Upload {
    file: File,
    url: String,
    method: String,
    headers: HashMap<String, String>,
    expires_at: u64,
}

#[derive(Deserialize)]
struct File {
    id: String,
    bytes: u64,
    status: String,
}

struct Grant {
    service: String,
    generation: u64,
    headers: HeaderMap,
    bytes: u64,
    expires: Instant,
}

/// Only a successful upload response read by Rust can grant storage access.
/// There is no IPC command for adding destinations supplied by JavaScript.
#[derive(Default)]
pub(crate) struct UploadGrants(Mutex<HashMap<String, Grant>>);

impl UploadGrants {
    pub fn install(&self, context: &Context, body: &[u8]) -> Result<(), String> {
        let upload: Upload = serde_json::from_slice(body)
            .map_err(|_| "The service returned an invalid signed upload.")?;
        let url =
            url::Url::parse(&upload.url).map_err(|_| "The signed upload address is not valid.")?;
        ServiceOrigin::for_app(&url.origin().ascii_serialization())
            .map_err(|_| "The signed upload needs an HTTPS storage address.")?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || upload.url.len() > 8192
            || upload.method != "PUT"
            || upload.file.bytes == 0
            || upload.file.status != "pending"
            || upload.file.id.is_empty()
            || upload.file.id.len() > 128
            || upload.headers.len() > 64
            || context.cookie.is_none()
        {
            return Err("The service returned an invalid signed upload.".into());
        }
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "The system clock is not valid.")?
            .as_millis();
        let lifetime = (upload.expires_at as u128)
            .checked_sub(now_ms)
            .filter(|ms| *ms > 0)
            .ok_or("The signed upload has expired. Start the upload again.")?;
        let mut headers = HeaderMap::new();
        for (name, value) in upload.headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "The signed upload headers are not valid.")?;
            if name != CONTENT_LENGTH && crate::http::forbidden_header(name.as_str()) {
                return Err("The signed upload contains a private or network header.".into());
            }
            if headers.contains_key(&name) {
                return Err("The signed upload has repeated headers.".into());
            }
            headers.insert(
                name,
                HeaderValue::from_str(&value)
                    .map_err(|_| "The signed upload headers are not valid.")?,
            );
        }
        if headers
            .remove(CONTENT_LENGTH)
            .as_ref()
            .and_then(|value| value.to_str().ok())
            != Some(upload.file.bytes.to_string().as_str())
        {
            return Err("The signed upload length does not match the file.".into());
        }
        let now = Instant::now();
        let grant = Grant {
            service: context.origin.as_str().into(),
            generation: context.generation,
            headers,
            bytes: upload.file.bytes,
            expires: now + Duration::from_millis(lifetime.min(MAX_LIFETIME.as_millis()) as u64),
        };
        let mut grants = self
            .0
            .lock()
            .map_err(|_| "Upload permissions are not available.")?;
        grants.retain(|_, grant| grant.expires > now && grant.generation >= context.generation);
        if grants
            .get(url.as_str())
            .is_some_and(|grant| grant.generation > context.generation)
        {
            return Err("The sign-in changed. Start the upload again.".into());
        }
        if grants.len() >= MAX_GRANTS {
            return Err("Too many signed uploads are pending. Try again later.".into());
        }
        grants.insert(url.to_string(), grant);
        Ok(())
    }

    pub fn allows(
        &self,
        context: &Context,
        url: &url::Url,
        method: &Method,
        headers: &HeaderMap,
        bytes: Option<u64>,
        has_body: bool,
    ) -> Result<bool, String> {
        let mut grants = self
            .0
            .lock()
            .map_err(|_| "Upload permissions are not available.")?;
        let now = Instant::now();
        grants.retain(|_, grant| grant.expires > now && grant.generation >= context.generation);
        let Some(grant) = grants.get(url.as_str()) else {
            return Ok(false);
        };
        if grant.generation != context.generation || grant.service != context.origin.as_str() {
            return Ok(false);
        }
        if *method != Method::PUT
            || !has_body
            || bytes != Some(grant.bytes)
            || headers != &grant.headers
        {
            return Err(
                "This request does not match the signed upload's method, headers, or size.".into(),
            );
        }
        Ok(true)
    }

    pub fn revoke_before(&self, generation: u64) {
        if let Ok(mut grants) = self.0.lock() {
            grants.retain(|_, grant| grant.generation >= generation);
        }
    }

    #[cfg(test)]
    pub fn clear(&self) {
        if let Ok(mut grants) = self.0.lock() {
            grants.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{ConnectionState, Session};

    fn context() -> (tempfile::TempDir, ConnectionState, Context) {
        let dir = tempfile::tempdir().unwrap();
        let state = ConnectionState::load(
            dir.path().join("connection.json"),
            ServiceOrigin::parse("https://service.test").unwrap(),
        )
        .unwrap();
        state
            .save_session(
                &state.context().unwrap(),
                Session {
                    cookie: "private".into(),
                    account: "person".into(),
                    persisted: false,
                },
            )
            .unwrap();
        let context = state.context().unwrap();
        (dir, state, context)
    }

    fn document() -> serde_json::Value {
        serde_json::json!({"file":{"id":"file","bytes":3,"status":"pending"},"url":"https://storage.test/object?signature=value","method":"PUT",
            "headers":{"content-length":"3","content-type":"text/plain"},"expiresAt":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 + 60000})
    }

    #[test]
    fn grants_allow_only_the_exact_upload_and_expire_with_the_service_context() {
        let (_dir, state, context) = context();
        let grants = UploadGrants::default();
        grants
            .install(&context, &serde_json::to_vec(&document()).unwrap())
            .unwrap();
        let url = url::Url::parse("https://storage.test/object?signature=value").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("text/plain"));
        assert!(grants
            .allows(&context, &url, &Method::PUT, &headers, Some(3), true)
            .unwrap());
        assert!(grants
            .allows(&context, &url, &Method::GET, &headers, Some(3), true)
            .is_err());
        assert!(grants
            .allows(&context, &url, &Method::PUT, &headers, Some(4), true)
            .is_err());
        headers.insert("openbot-organization", HeaderValue::from_static("private"));
        assert!(grants
            .allows(&context, &url, &Method::PUT, &headers, Some(3), true)
            .is_err());
        headers.remove("openbot-organization");
        let mut changed = url.clone();
        changed.set_query(Some("signature=other"));
        assert!(!grants
            .allows(&context, &changed, &Method::PUT, &headers, Some(3), true)
            .unwrap());
        state.restart_runtime().unwrap();
        assert!(!grants
            .allows(
                &state.context().unwrap(),
                &url,
                &Method::PUT,
                &headers,
                Some(3),
                true
            )
            .unwrap());
    }

    #[test]
    fn late_upload_work_cannot_remove_or_replace_a_newer_accounts_grant() {
        let (_dir, state, old) = context();
        state.restart_runtime().unwrap();
        let current = state.context().unwrap();
        let grants = UploadGrants::default();
        let body = serde_json::to_vec(&document()).unwrap();
        grants.install(&current, &body).unwrap();
        let url = url::Url::parse("https://storage.test/object?signature=value").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("text/plain"));
        assert!(!grants
            .allows(&old, &url, &Method::PUT, &headers, Some(3), true)
            .unwrap());
        assert!(grants.install(&old, &body).is_err());
        grants.revoke_before(current.generation);
        assert!(grants
            .allows(&current, &url, &Method::PUT, &headers, Some(3), true)
            .unwrap());
        grants.revoke_before(current.generation + 1);
        assert!(!grants
            .allows(&current, &url, &Method::PUT, &headers, Some(3), true)
            .unwrap());
    }

    #[test]
    fn expired_insecure_and_private_header_uploads_are_not_granted() {
        let (_dir, _state, context) = context();
        let grants = UploadGrants::default();
        let mut expired = document();
        expired["expiresAt"] = serde_json::json!(1);
        assert!(grants
            .install(&context, &serde_json::to_vec(&expired).unwrap())
            .is_err());
        for url in [
            "http://storage.test/object",
            "https://name:secret@storage.test/object",
            "https://storage.test/object#token",
        ] {
            let mut upload = document();
            upload["url"] = serde_json::json!(url);
            assert!(grants
                .install(&context, &serde_json::to_vec(&upload).unwrap())
                .is_err());
        }
        let mut upload = document();
        upload["headers"]["cookie"] = serde_json::json!("private");
        assert!(grants
            .install(&context, &serde_json::to_vec(&upload).unwrap())
            .is_err());
        grants
            .install(&context, &serde_json::to_vec(&document()).unwrap())
            .unwrap();
        for grant in grants.0.lock().unwrap().values_mut() {
            grant.expires = Instant::now() - Duration::from_secs(1);
        }
        assert!(!grants
            .allows(
                &context,
                &url::Url::parse("https://storage.test/object?signature=value").unwrap(),
                &Method::PUT,
                &HeaderMap::new(),
                Some(3),
                true
            )
            .unwrap());
    }
}
