#[cfg(target_os = "android")]
mod android_tls;
pub mod browser;
pub mod browser_auth;
pub mod browser_http;
mod commands;
pub mod connection;
mod credentials;
pub mod http;
pub mod lifecycle;
mod media;
mod navigation;
pub mod pending;
pub mod service;
pub mod socket;
mod uploads;
mod vault;

use navigation::NavigationPolicy;
use tauri::{Manager, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .on_window_event(lifecycle::handle)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_deep_link::init());
    builder
        .invoke_handler(tauri::generate_handler![
            commands::browser_sign_in_watch,
            commands::browser_sign_in_resume,
            commands::browser_sign_in_prepare,
            commands::browser_sign_in_open,
            commands::browser_sign_in_cancel,
            commands::lifecycle_subscribe,
            commands::lifecycle_unsubscribe,
            commands::connection_get,
            commands::connection_retry,
            commands::runtime_start,
            commands::connection_set,
            commands::http_prepare,
            commands::http_open,
            commands::http_write,
            commands::http_finish,
            commands::http_read,
            commands::http_cancel,
            commands::session_sign_in,
            commands::session_sign_out,
            commands::session_retry,
            commands::socket_prepare,
            commands::socket_open,
            commands::socket_read,
            commands::socket_write,
            commands::socket_close,
        ])
        .setup(|app| {
            app.manage(connection::ConnectionState::load(
                app.path().app_config_dir()?.join("connection.json"),
                service::ServiceOrigin::build_default()?,
            )?);
            app.manage(lifecycle::LifecycleState::default());
            app.manage(if cfg!(mobile) {
                browser::BrowserState::with_pending(app.path().app_config_dir()?.join("browser"))
            } else {
                browser::BrowserState::default()
            });
            #[cfg(mobile)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls().into_iter().take(8) {
                        handle
                            .state::<browser::BrowserState>()
                            .receive_mobile_return(url.as_str());
                    }
                });
                // Android stores its initial Intent before the Rust listener is
                // attached. iOS Opened events are also handled by the listener.
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls.into_iter().take(8) {
                        app.state::<browser::BrowserState>()
                            .receive_mobile_return(url.as_str());
                    }
                }
            }
            app.manage(http::HttpState::new()?);
            app.manage(socket::SocketState::new()?);
            let mut policy = NavigationPolicy::production();
            if cfg!(debug_assertions) {
                if let Some(url) = app.config().build.dev_url.as_ref() {
                    policy.allow_development_origin(url.clone());
                }
            }
            let config = app
                .config()
                .app
                .windows
                .first()
                .expect("The main window is missing from the app config");
            let media_policy = policy.clone();
            let permission_policy = policy.clone();
            let window = WebviewWindowBuilder::from_config(app, config)?
                .on_navigation(move |url| policy.allows(url))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_permission_request(move |view, kind| {
                    media::permission(&view, kind, &permission_policy)
                })
                .build()?;
            media::install(&window, media_policy)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Could not run OpenBot");
}
