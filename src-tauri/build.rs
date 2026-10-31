fn main() {
    println!("cargo:rerun-if-env-changed=OPENBOT_NATIVE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=OPENBOT_DEFAULT_API_ORIGIN");
    // List all app commands here when adding IPC. Unlisted custom commands do
    // not gain a permission boundary merely by using a capability file.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "browser_sign_in_watch",
            "browser_sign_in_resume",
            "browser_sign_in_prepare",
            "browser_sign_in_open",
            "browser_sign_in_cancel",
            "lifecycle_subscribe",
            "lifecycle_unsubscribe",
            "connection_get",
            "connection_retry",
            "runtime_start",
            "connection_set",
            "http_prepare",
            "http_open",
            "http_write",
            "http_finish",
            "http_read",
            "http_cancel",
            "session_sign_in",
            "session_sign_out",
            "session_retry",
            "socket_prepare",
            "socket_open",
            "socket_read",
            "socket_write",
            "socket_close",
        ]),
    ))
    .expect("Could not build the OpenBot app metadata");
}
