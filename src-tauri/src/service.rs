use url::Url;

/// A user-selected HTTPS service. Credentials must be stored under this exact
/// normalized origin, never under a host name alone or a display label.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServiceOrigin(Url);

impl ServiceOrigin {
    /// The first-party default is set by the build environment. A user override
    /// must use the same validation and a separate credential storage key.
    pub fn build_default() -> Result<Self, &'static str> {
        Self::for_app(
            option_env!("OPENBOT_DEFAULT_API_ORIGIN")
                .ok_or("The default service is not set in this build.")?,
        )
    }

    pub fn parse(input: &str) -> Result<Self, &'static str> {
        Self::parse_for_mode(input, false)
    }

    pub fn for_app(input: &str) -> Result<Self, &'static str> {
        Self::parse_for_mode(input, cfg!(debug_assertions))
    }

    fn parse_for_mode(input: &str, allow_local_http: bool) -> Result<Self, &'static str> {
        let url = Url::parse(input.trim()).map_err(|_| "Enter an HTTPS service address.")?;
        let loopback = match url.host() {
            Some(url::Host::Domain("localhost")) => true,
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        };
        let local_http = allow_local_http && url.scheme() == "http" && loopback;
        if (url.scheme() != "https" && !local_http)
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Use an HTTPS origin without a path, query, or credentials.");
        }
        Ok(Self(url))
    }

    pub fn as_str(&self) -> &str {
        self.0.as_str().trim_end_matches('/')
    }

    pub fn is_loopback(&self) -> bool {
        match self.0.host() {
            Some(url::Host::Domain("localhost")) => true,
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            _ => false,
        }
    }

    /// Only server API routes can receive this service's credentials. File
    /// storage URLs need a separate anonymous transport and explicit scope.
    pub fn allows_authenticated_request(&self, url: &Url) -> bool {
        url.origin() == self.0.origin()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && (url.path().starts_with("/v1/")
                || url.path().starts_with("/auth/")
                || url.path() == "/health")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_service_origins_for_account_storage() {
        assert_eq!(
            ServiceOrigin::parse(" https://EXAMPLE.com:443/ ")
                .unwrap()
                .as_str(),
            "https://example.com"
        );
        assert_eq!(
            ServiceOrigin::parse("https://example.com:8443")
                .unwrap()
                .as_str(),
            "https://example.com:8443"
        );
        assert_ne!(
            ServiceOrigin::parse("https://example.com").unwrap(),
            ServiceOrigin::parse("https://example.com:8443").unwrap()
        );
    }

    #[test]
    fn rejects_insecure_and_ambiguous_service_addresses() {
        for value in [
            "http://example.com",
            "file:///tmp/test",
            "https://name:secret@example.com",
            "https://example.com/path",
            "https://example.com?next=other",
            "https://example.com#token",
            "//example.com",
        ] {
            assert!(ServiceOrigin::parse(value).is_err(), "{value}");
        }
    }

    #[test]
    fn development_http_is_limited_to_loopback() {
        for value in [
            "http://localhost:19380",
            "http://127.0.0.1:19380",
            "http://[::1]:19380",
        ] {
            assert!(ServiceOrigin::parse_for_mode(value, true).is_ok());
            assert!(ServiceOrigin::parse_for_mode(value, false).is_err());
        }
        for value in ["http://localhost.evil.test", "http://192.168.1.10"] {
            assert!(ServiceOrigin::parse_for_mode(value, true).is_err());
        }
    }

    #[test]
    fn credentials_cannot_follow_a_different_host_port_or_non_api_route() {
        let service = ServiceOrigin::parse("https://example.com").unwrap();
        for value in [
            "https://example.com/v1/chats",
            "https://example.com/auth/session",
            "https://example.com/health",
        ] {
            assert!(service.allows_authenticated_request(&Url::parse(value).unwrap()));
        }
        for value in [
            "https://other.test/v1/chats",
            "https://example.com:8443/v1/chats",
            "https://example.com.evil.test/v1/chats",
            "http://example.com/v1/chats",
            "https://example.com/v1/../untrusted",
            "https://example.com/readme",
            "https://user@example.com/auth/session",
            "https://example.com/auth/session#secret",
        ] {
            assert!(
                !service.allows_authenticated_request(&Url::parse(value).unwrap()),
                "{value}"
            );
        }
    }
}
