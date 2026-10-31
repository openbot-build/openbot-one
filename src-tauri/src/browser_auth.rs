//! Native-only browser grant state. No proof or callback value belongs in IPC.
//! Pending bytes may be saved only in a purpose-separated OS credential entry.
use crate::service::ServiceOrigin;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;
use url::Url;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const MAX_ATTEMPT_MS: u64 = 300_000;
const MAX_PENDING_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Invalid,
    Expired,
    AlreadyUsed,
    Unavailable,
}
impl std::fmt::Display for Error {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        output.write_str(match self {
            Self::Invalid => "The sign-in response does not match this attempt.",
            Self::Expired => "This sign-in attempt expired. Start again.",
            Self::AlreadyUsed => "This sign-in response was already used.",
            Self::Unavailable => "Native sign-in could not start. Try again.",
        })
    }
}
impl std::error::Error for Error {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Started {
    request: String,
    url: String,
    expires_in: u64,
}
impl Drop for Started {
    fn drop(&mut self) {
        self.request.zeroize();
        self.url.zeroize();
    }
}
#[derive(Serialize, Deserialize, PartialEq, Eq, Zeroize)]
enum Phase {
    Starting,
    Waiting,
    Returned,
    Spent,
}

// Deliberately no Debug or Clone: logs and UI must never receive these values.
#[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserAttempt {
    version: u8,
    origin: String,
    client_id: String,
    redirect_uri: String,
    verifier: String,
    state: String,
    request: Option<String>,
    created_at_ms: u64,
    expires_at_ms: u64,
    phase: Phase,
}
pub struct AuthorizationCode {
    value: Zeroizing<String>,
    request: Zeroizing<String>,
}
pub enum Callback {
    Code(AuthorizationCode),
    Denied,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartBody<'a> {
    client_id: &'a str,
    redirect_uri: &'a str,
    code_challenge: String,
    code_challenge_method: &'static str,
    state: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    invitation: Option<&'a str>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeBody<'a> {
    client_id: &'a str,
    redirect_uri: &'a str,
    code: &'a str,
    code_verifier: &'a str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelBody<'a> {
    client_id: &'a str,
    request: &'a str,
    code_verifier: &'a str,
}

fn now_ms() -> Result<u64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| time.as_millis().try_into().ok())
        .ok_or(Error::Unavailable)
}
fn random() -> Result<String, Error> {
    let mut bytes = Zeroizing::new([0_u8; 32]);
    getrandom::fill(bytes.as_mut()).map_err(|_| Error::Unavailable)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes.as_ref()))
}
fn secret32(value: &str) -> bool {
    value.len() == 43
        && URL_SAFE_NO_PAD
            .decode(value)
            .is_ok_and(|bytes| bytes.len() == 32 && URL_SAFE_NO_PAD.encode(bytes) == value)
}
fn same(left: &str, right: &str) -> bool {
    bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}
fn client_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}
fn callback_base(value: &str) -> bool {
    if value.len() > 2048
        || value
            .bytes()
            .any(|byte| byte <= b' ' || byte == 127 || b"\\%?#".contains(&byte))
    {
        return false;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    if url.port() == Some(0)
        || url.as_str() != value
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().starts_with('/')
        || url.path().starts_with("//")
        || !url
            .path()
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/_~.-".contains(&byte))
    {
        return false;
    }
    if url.scheme() == "https" {
        return url.host_str().is_some();
    }
    if url.scheme() == "http" {
        return matches!(url.host_str(), Some("127.0.0.1" | "[::1]"));
    }
    let mut parts = url.scheme().split('.');
    let first = parts.next().unwrap_or("");
    !first.is_empty()
        && first.as_bytes()[0].is_ascii_lowercase()
        && first
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && parts.clone().count() >= 1
        && parts.all(|part| {
            !part.is_empty()
                && part.as_bytes()[0].is_ascii_alphanumeric()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
        && url.host_str().is_none()
        && value == format!("{}:{}", url.scheme(), url.path())
}

impl BrowserAttempt {
    pub fn new(origin: &ServiceOrigin, client: &str, redirect: &str) -> Result<Self, Error> {
        if !client_id(client) || !callback_base(redirect) {
            return Err(Error::Invalid);
        }
        let created_at_ms = now_ms()?;
        Ok(Self {
            version: 1,
            origin: origin.as_str().into(),
            client_id: client.into(),
            redirect_uri: redirect.into(),
            verifier: random()?,
            state: random()?,
            request: None,
            created_at_ms,
            expires_at_ms: created_at_ms + MAX_ATTEMPT_MS,
            phase: Phase::Starting,
        })
    }
    fn live(&self) -> Result<(), Error> {
        let now = now_ms()?;
        if now < self.created_at_ms || now >= self.expires_at_ms {
            return Err(Error::Expired);
        }
        Ok(())
    }
    pub fn start_body(
        &self,
        email: Option<&str>,
        invitation: Option<&str>,
    ) -> Result<Zeroizing<Vec<u8>>, Error> {
        self.live()?;
        if self.phase != Phase::Starting {
            return Err(Error::AlreadyUsed);
        }
        if email.is_some_and(|value| value.is_empty() || value.len() > 320)
            || invitation.is_some_and(|value| value.is_empty() || value.len() > 4096)
        {
            return Err(Error::Invalid);
        }
        serde_json::to_vec(&StartBody {
            client_id: &self.client_id,
            redirect_uri: &self.redirect_uri,
            code_challenge: URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes())),
            code_challenge_method: "S256",
            state: &self.state,
            email,
            invitation,
        })
        .map(Zeroizing::new)
        .map_err(|_| Error::Unavailable)
    }
    /// Accept only this service's precise browser entry, never an arbitrary opener URL.
    pub fn bind_started(&mut self, reply: Started) -> Result<Zeroizing<String>, Error> {
        self.live()?;
        if self.phase != Phase::Starting {
            return Err(Error::AlreadyUsed);
        }
        if !secret32(&reply.request) || !(1..=300).contains(&reply.expires_in) {
            return Err(Error::Invalid);
        }
        let expected = format!(
            "{}/auth/native/authorize?request={}",
            self.origin, reply.request
        );
        if reply.url != expected {
            return Err(Error::Invalid);
        }
        self.expires_at_ms = self.expires_at_ms.min(now_ms()? + reply.expires_in * 1000);
        self.request = Some(reply.request.clone());
        self.phase = Phase::Waiting;
        Ok(Zeroizing::new(reply.url.clone()))
    }
    pub fn remaining(&self) -> Result<Duration, Error> {
        self.live()?;
        Ok(Duration::from_millis(
            self.expires_at_ms.saturating_sub(now_ms()?),
        ))
    }
    /// Wrong callbacks do not consume the attempt. The first valid return does.
    pub fn take_callback(&mut self, input: &str) -> Result<Callback, Error> {
        self.live()?;
        if self.phase != Phase::Waiting {
            return Err(Error::AlreadyUsed);
        }
        if input.len() > 4096
            || input
                .bytes()
                .any(|byte| byte <= b' ' || byte == 127 || byte == b'\\')
        {
            return Err(Error::Invalid);
        }
        let (base, _) = input.split_once('?').ok_or(Error::Invalid)?;
        if base != self.redirect_uri {
            return Err(Error::Invalid);
        }
        let url = Url::parse(input).map_err(|_| Error::Invalid)?;
        if url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
            return Err(Error::Invalid);
        }
        let mut code = None;
        let mut error = None;
        let mut state = None;
        let mut issuer = None;
        for (key, value) in url.query_pairs() {
            let field = match key.as_ref() {
                "code" => &mut code,
                "error" => &mut error,
                "state" => &mut state,
                "iss" => &mut issuer,
                _ => return Err(Error::Invalid),
            };
            if field.is_some() {
                return Err(Error::Invalid);
            }
            *field = Some(Zeroizing::new(value.into_owned()));
        }
        if !state.as_ref().is_some_and(|value| same(value, &self.state))
            || !issuer
                .as_ref()
                .is_some_and(|value| value.as_str() == self.origin)
        {
            return Err(Error::Invalid);
        }
        match (code, error) {
            (Some(value), None) if secret32(&value) => {
                let request = Zeroizing::new(self.request.as_ref().ok_or(Error::Invalid)?.clone());
                self.phase = Phase::Returned;
                Ok(Callback::Code(AuthorizationCode { value, request }))
            }
            (None, Some(error)) if error.as_str() == "access_denied" => {
                self.phase = Phase::Spent;
                Ok(Callback::Denied)
            }
            _ => Err(Error::Invalid),
        }
    }
    /// Build at most one exchange. A lost reply requires a fresh sign-in.
    pub fn take_exchange_body(
        &mut self,
        code: AuthorizationCode,
    ) -> Result<Zeroizing<Vec<u8>>, Error> {
        self.live()?;
        if self.phase != Phase::Returned {
            return Err(Error::AlreadyUsed);
        }
        if !self
            .request
            .as_ref()
            .is_some_and(|request| same(request, &code.request))
        {
            return Err(Error::Invalid);
        }
        let body = serde_json::to_vec(&ExchangeBody {
            client_id: &self.client_id,
            redirect_uri: &self.redirect_uri,
            code: &code.value,
            code_verifier: &self.verifier,
        })
        .map_err(|_| Error::Unavailable)?;
        self.phase = Phase::Spent;
        Ok(Zeroizing::new(body))
    }
    pub fn cancel_body(&self) -> Result<Zeroizing<Vec<u8>>, Error> {
        serde_json::to_vec(&CancelBody {
            client_id: &self.client_id,
            request: self.request.as_deref().ok_or(Error::Invalid)?,
            code_verifier: &self.verifier,
        })
        .map(Zeroizing::new)
        .map_err(|_| Error::Unavailable)
    }
    pub fn encode_pending(&self) -> Result<Zeroizing<Vec<u8>>, Error> {
        self.live()?;
        if self.phase != Phase::Waiting {
            return Err(Error::AlreadyUsed);
        }
        serde_json::to_vec(self)
            .map(Zeroizing::new)
            .map_err(|_| Error::Unavailable)
    }
    /// OS storage is still untrusted input. Never restore against another service/config.
    pub fn restore_pending(
        bytes: &[u8],
        origin: &ServiceOrigin,
        client: &str,
        redirect: &str,
    ) -> Result<Self, Error> {
        if bytes.len() > MAX_PENDING_BYTES {
            return Err(Error::Invalid);
        }
        let attempt: Self = serde_json::from_slice(bytes).map_err(|_| Error::Invalid)?;
        if attempt.version != 1
            || attempt.origin != origin.as_str()
            || attempt.client_id != client
            || attempt.redirect_uri != redirect
            || !client_id(client)
            || !callback_base(redirect)
            || !secret32(&attempt.state)
            || !secret32(&attempt.verifier)
            || !attempt
                .request
                .as_ref()
                .is_some_and(|request| secret32(request))
            || attempt.phase != Phase::Waiting
            || attempt.expires_at_ms <= attempt.created_at_ms
            || attempt.expires_at_ms - attempt.created_at_ms > MAX_ATTEMPT_MS
        {
            return Err(Error::Invalid);
        }
        attempt.live()?;
        Ok(attempt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn origin() -> ServiceOrigin {
        ServiceOrigin::parse("https://api.example.com").unwrap()
    }
    fn attempt() -> BrowserAttempt {
        BrowserAttempt::new(
            &origin(),
            "openbot-one",
            "http://127.0.0.1:53123/auth/callback",
        )
        .unwrap()
    }
    fn started(attempt: &mut BrowserAttempt) {
        let request = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        attempt
            .bind_started(Started {
                url: format!("{}/auth/native/authorize?request={request}", attempt.origin),
                request,
                expires_in: 300,
            })
            .unwrap();
    }
    fn callback(attempt: &BrowserAttempt, result: (&str, &str)) -> String {
        let mut url = Url::parse(&attempt.redirect_uri).unwrap();
        url.query_pairs_mut()
            .append_pair(result.0, result.1)
            .append_pair("state", &attempt.state)
            .append_pair("iss", &attempt.origin);
        url.into()
    }
    #[test]
    fn pkce_matches_rfc_and_proofs_use_separate_random_values() {
        let mut first = attempt();
        let second = attempt();
        for value in [
            &first.state,
            &first.verifier,
            &second.state,
            &second.verifier,
        ] {
            assert!(secret32(value));
        }
        assert_ne!(first.state, first.verifier);
        assert_ne!(first.state, second.state);
        assert_ne!(first.verifier, second.verifier);
        first.verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into();
        let body: serde_json::Value =
            serde_json::from_slice(&first.start_body(None, None).unwrap()).unwrap();
        assert_eq!(
            body["codeChallenge"],
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(body["codeChallengeMethod"], "S256");
        assert!(body.get("codeVerifier").is_none());
    }
    #[test]
    fn browser_entry_is_exact_and_not_an_untrusted_opener() {
        let mut value = attempt();
        let request = URL_SAFE_NO_PAD.encode([7_u8; 32]);
        let expected = format!("{}/auth/native/authorize?request={request}", value.origin);
        for url in [
            expected.replace("api.example.com", "evil.example.com"),
            expected.replace("/authorize", "/authorize/"),
            expected.clone() + "&next=evil",
            expected.clone() + "#fragment",
            expected.replace("https://", "https://user:secret@"),
            expected.replace("/auth/", "/a/../auth/"),
        ] {
            assert!(matches!(
                value.bind_started(Started {
                    request: request.clone(),
                    url,
                    expires_in: 300
                }),
                Err(Error::Invalid)
            ));
        }
        assert!(value
            .bind_started(Started {
                request,
                url: expected,
                expires_in: 301
            })
            .is_err());
        started(&mut value);
        assert!(value.start_body(None, None).is_err());
    }
    #[test]
    fn callback_rejects_issuer_state_duplicates_paths_and_credentials_before_exchange() {
        let mut value = attempt();
        started(&mut value);
        let code = URL_SAFE_NO_PAD.encode([8_u8; 32]);
        let valid = callback(&value, ("code", &code));
        for invalid in [
            valid.replace(&value.state, "wrong-state"),
            valid.replace("api.example.com", "evil.example.com"),
            valid.clone() + "&code=duplicate",
            valid.clone() + "&state=duplicate",
            valid.clone() + "&iss=duplicate",
            valid.clone() + "&unknown=value",
            valid.clone() + "#fragment",
            valid.replace("/auth/callback", "/other/../auth/callback"),
            valid.replace("127.0.0.1", "localhost"),
            valid.replace("53123", "53124"),
            valid.replace("http://", "http://user:secret@"),
            valid.replace(&code, "invalid"),
            valid.clone() + "&error=access_denied",
        ] {
            assert!(matches!(value.take_callback(&invalid), Err(Error::Invalid)));
        }
        let Callback::Code(code) = value.take_callback(&valid).unwrap() else {
            panic!("Expected code");
        };
        assert!(matches!(
            value.take_callback(&valid),
            Err(Error::AlreadyUsed)
        ));
        assert!(value.encode_pending().is_err());
        let exchange: serde_json::Value =
            serde_json::from_slice(&value.take_exchange_body(code).unwrap()).unwrap();
        assert_eq!(exchange["codeVerifier"], value.verifier);
        assert_eq!(exchange["redirectUri"], value.redirect_uri);
        assert!(matches!(
            value.take_callback(&valid),
            Err(Error::AlreadyUsed)
        ));
    }
    #[test]
    fn denial_is_bound_to_state_and_issuer_and_cannot_exchange() {
        let mut value = attempt();
        started(&mut value);
        let denied = callback(&value, ("error", "access_denied"));
        assert!(matches!(
            value.take_callback(&denied.replace("access_denied", "arbitrary-detail")),
            Err(Error::Invalid)
        ));
        assert!(matches!(value.take_callback(&denied), Ok(Callback::Denied)));
        assert!(value.encode_pending().is_err());
        assert!(matches!(
            value.take_callback(&denied),
            Err(Error::AlreadyUsed)
        ));
    }
    #[test]
    fn pending_restore_checks_service_config_deadline_and_rejects_corrupt_data() {
        let mut value = attempt();
        started(&mut value);
        let bytes = value.encode_pending().unwrap();
        assert!(BrowserAttempt::restore_pending(
            &bytes,
            &origin(),
            "openbot-one",
            &value.redirect_uri
        )
        .is_ok());
        assert!(BrowserAttempt::restore_pending(
            &bytes,
            &ServiceOrigin::parse("https://other.example.com").unwrap(),
            "openbot-one",
            &value.redirect_uri
        )
        .is_err());
        assert!(
            BrowserAttempt::restore_pending(&bytes, &origin(), "other", &value.redirect_uri)
                .is_err()
        );
        assert!(BrowserAttempt::restore_pending(
            &bytes,
            &origin(),
            "openbot-one",
            "build.openbot.one:/auth/callback"
        )
        .is_err());
        assert!(BrowserAttempt::restore_pending(
            b"{}",
            &origin(),
            "openbot-one",
            &value.redirect_uri
        )
        .is_err());
        for changed in ["version", "verifier", "phase", "expiresAtMs"] {
            let mut wire: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            wire[changed] = match changed {
                "version" => 2.into(),
                "verifier" => "short".into(),
                "phase" => "Spent".into(),
                _ => 0.into(),
            };
            assert!(BrowserAttempt::restore_pending(
                &serde_json::to_vec(&wire).unwrap(),
                &origin(),
                "openbot-one",
                &value.redirect_uri
            )
            .is_err());
        }
        value.expires_at_ms = now_ms().unwrap();
        assert!(matches!(
            value.take_callback("anything"),
            Err(Error::Expired)
        ));
    }
}
