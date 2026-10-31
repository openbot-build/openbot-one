use url::Url;

/// Only bundled pages can replace the main app. Remote API calls use a
/// separate transport and do not need permission to navigate this window.
#[derive(Clone)]
pub struct NavigationPolicy {
    development_origin: Option<url::Origin>,
}

impl NavigationPolicy {
    pub fn production() -> Self {
        Self {
            development_origin: None,
        }
    }

    pub fn allow_development_origin(&mut self, url: Url) {
        self.development_origin = Some(url.origin());
    }

    pub fn allows(&self, url: &Url) -> bool {
        if !url.username().is_empty() || url.password().is_some() {
            return false;
        }
        let bundled = match url.scheme() {
            "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
            "http" | "https" => {
                url.host_str() == Some("tauri.localhost")
                    && url.port_or_known_default()
                        == Some(if url.scheme() == "https" { 443 } else { 80 })
            }
            _ => false,
        };
        bundled
            || self
                .development_origin
                .as_ref()
                .is_some_and(|origin| &url.origin() == origin)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_bundled_routes_on_system_webviews() {
        let policy = NavigationPolicy::production();
        for value in [
            "tauri://localhost/",
            "http://tauri.localhost/c/chat",
            "https://tauri.localhost/sign-in",
        ] {
            assert!(policy.allows(&Url::parse(value).unwrap()), "{value}");
        }
    }

    #[test]
    fn rejects_remote_pages_and_disguised_app_origins() {
        let policy = NavigationPolicy::production();
        for value in [
            "https://example.com/",
            "https://tauri.localhost.evil.test/",
            "tauri://evil.test/",
            "http://tauri.localhost:5173/",
            "tauri://localhost:5173/",
            "https://user:secret@tauri.localhost/",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hello",
            "http://localhost:1420/",
        ] {
            assert!(!policy.allows(&Url::parse(value).unwrap()), "{value}");
        }
    }

    #[test]
    fn development_accepts_only_the_exact_configured_origin() {
        let mut policy = NavigationPolicy::production();
        policy.allow_development_origin(Url::parse("http://192.168.1.10:1420").unwrap());
        assert!(policy.allows(&Url::parse("http://192.168.1.10:1420/c/chat").unwrap()));
        for value in [
            "http://192.168.1.10:1421/",
            "https://192.168.1.10:1420/",
            "http://localhost:1420/",
        ] {
            assert!(!policy.allows(&Url::parse(value).unwrap()));
        }
    }
}
