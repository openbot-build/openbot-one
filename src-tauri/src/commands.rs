use crate::{
    browser::{BrowserState, DesktopInput},
    connection::{ConnectionSnapshot, ConnectionState},
    http::{HttpState, RequestInput, ResponseHead},
    socket::SocketState,
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    State,
};

#[tauri::command]
pub fn connection_get(
    connection: State<'_, ConnectionState>,
) -> Result<ConnectionSnapshot, String> {
    connection.snapshot()
}

#[tauri::command]
pub fn connection_retry(
    expected_origin: String,
    runtime_id: String,
    connection: State<'_, ConnectionState>,
    browser: State<'_, BrowserState>,
) -> Result<ConnectionSnapshot, String> {
    browser.invalidate_mobile_bound(&connection, &expected_origin, &runtime_id)?;
    let result = connection.retry_bound(&expected_origin, &runtime_id)?;
    browser.cancel_before(connection.generation()?);
    Ok(result)
}

#[tauri::command]
pub async fn runtime_start(
    connection: State<'_, ConnectionState>,
    browser: State<'_, BrowserState>,
    lifecycle: State<'_, crate::lifecycle::LifecycleState>,
    http: State<'_, HttpState>,
    sockets: State<'_, SocketState>,
) -> Result<ConnectionSnapshot, String> {
    browser.document_started()?;
    connection.restart_runtime()?;
    let generation = connection.generation()?;
    lifecycle.advance(generation);
    browser.cancel_before(generation);
    http.cancel_before(generation);
    sockets.cancel_before(generation);
    connection.restore_session(&http).await;
    lifecycle.advance(connection.generation()?);
    let mut snapshot = connection.snapshot()?;
    if browser.take_mobile_issue() {
        snapshot.session_issue = Some(crate::connection::SessionIssue::BrowserSignInIncomplete);
    }
    Ok(snapshot)
}

#[tauri::command]
pub async fn session_retry(
    expected_origin: String,
    runtime_id: String,
    connection: State<'_, ConnectionState>,
    browser: State<'_, BrowserState>,
    http: State<'_, HttpState>,
    sockets: State<'_, SocketState>,
) -> Result<ConnectionSnapshot, String> {
    browser.invalidate_mobile_bound(&connection, &expected_origin, &runtime_id)?;
    connection
        .retry_session(&http, &expected_origin, &runtime_id)
        .await?;
    let generation = connection.generation()?;
    browser.cancel_before(generation);
    http.cancel_before(generation);
    sockets.cancel_before(generation);
    connection.snapshot()
}

#[tauri::command]
pub fn connection_set(
    origin: Option<String>,
    expected_origin: String,
    runtime_id: String,
    connection: State<'_, ConnectionState>,
    browser: State<'_, BrowserState>,
    http: State<'_, HttpState>,
    sockets: State<'_, SocketState>,
) -> Result<ConnectionSnapshot, String> {
    browser.invalidate_mobile_bound(&connection, &expected_origin, &runtime_id)?;
    let result = connection.select_bound(origin.as_deref(), &expected_origin, &runtime_id)?;
    let generation = connection.generation()?;
    browser.cancel_before(generation);
    http.cancel_before(generation);
    sockets.cancel_before(generation);
    Ok(result)
}

#[tauri::command]
pub fn http_prepare(
    input: RequestInput,
    connection: State<'_, ConnectionState>,
    http: State<'_, HttpState>,
) -> Result<String, String> {
    http.prepare(&connection, input)
}

#[tauri::command]
pub async fn http_open(
    id: String,
    connection: State<'_, ConnectionState>,
    browser: State<'_, BrowserState>,
    http: State<'_, HttpState>,
    sockets: State<'_, SocketState>,
) -> Result<ResponseHead, String> {
    let head = http.open(&connection, &id).await?;
    if head.session_changed {
        browser.invalidate_mobile_before(connection.generation()?)?;
        browser.cancel_before(connection.generation()?);
        sockets.cancel_before(connection.generation()?);
    }
    Ok(head)
}

#[tauri::command]
pub async fn http_write(request: Request<'_>, http: State<'_, HttpState>) -> Result<bool, String> {
    let id = request
        .headers()
        .get("x-openbot-request-id")
        .and_then(|v| v.to_str().ok())
        .ok_or("The upload request ID is missing.")?
        .to_string();
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("The upload body must be binary.".into()),
    };
    http.write(&id, bytes).await
}

#[tauri::command]
pub fn http_finish(id: String, http: State<'_, HttpState>) -> Result<(), String> {
    http.finish_upload(&id)
}

#[tauri::command]
pub async fn http_read(id: String, http: State<'_, HttpState>) -> Result<Response, String> {
    http.read(&id).await.map(Response::new)
}

#[tauri::command]
pub fn http_cancel(id: String, http: State<'_, HttpState>) {
    http.cancel(&id);
}

#[tauri::command]
pub async fn session_sign_in(
    expected_origin: String,
    runtime_id: String,
    connection: State<'_, ConnectionState>,
    browser: State<'_, BrowserState>,
    http: State<'_, HttpState>,
    sockets: State<'_, SocketState>,
) -> Result<(), String> {
    browser.invalidate_mobile_bound(&connection, &expected_origin, &runtime_id)?;
    http.development_sign_in(&connection, &expected_origin, &runtime_id)
        .await?;
    let generation = connection.generation()?;
    browser.cancel_before(generation);
    http.cancel_before(generation);
    sockets.cancel_before(generation);
    Ok(())
}

#[tauri::command]
pub async fn session_sign_out(
    expected_origin: String,
    runtime_id: String,
    connection: State<'_, ConnectionState>,
    browser: State<'_, BrowserState>,
    http: State<'_, HttpState>,
    sockets: State<'_, SocketState>,
) -> Result<(), String> {
    let context = connection.bound_context(&expected_origin, &runtime_id)?;
    browser.invalidate_mobile_bound(&connection, &expected_origin, &runtime_id)?;
    browser.cancel_before(context.generation + 1);
    sockets.cancel_before(context.generation + 1);
    let result = http
        .sign_out(&connection, &expected_origin, &runtime_id)
        .await;
    sockets.cancel_before(connection.generation()?);
    result
}

#[tauri::command]
pub fn socket_prepare(
    url: String,
    expected_origin: String,
    runtime_id: String,
    connection: State<'_, ConnectionState>,
    sockets: State<'_, SocketState>,
) -> Result<String, String> {
    sockets.prepare(&connection, &url, &expected_origin, &runtime_id)
}

#[tauri::command]
pub async fn socket_open(
    id: String,
    connection: State<'_, ConnectionState>,
    sockets: State<'_, SocketState>,
) -> Result<(), String> {
    sockets.open(&connection, &id).await
}

#[tauri::command]
pub async fn socket_read(id: String, sockets: State<'_, SocketState>) -> Result<Response, String> {
    sockets.read(&id).await.map(Response::new)
}

#[tauri::command]
pub async fn socket_write(
    request: Request<'_>,
    sockets: State<'_, SocketState>,
) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-openbot-socket-id")
        .and_then(|value| value.to_str().ok())
        .ok_or("The live connection ID is missing.")?
        .to_string();
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("Live messages must use binary IPC.".into()),
    };
    sockets.write(&id, bytes).await
}

#[tauri::command]
pub async fn socket_close(
    id: String,
    code: u16,
    reason: String,
    sockets: State<'_, SocketState>,
) -> Result<(), String> {
    sockets.close(&id, code, reason).await
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserUserInput {
    email: Option<String>,
    invitation: Option<String>,
}
#[tauri::command]
pub fn browser_sign_in_prepare(
    expected_origin: String,
    runtime_id: String,
    connection: State<'_, ConnectionState>,
    browser: State<'_, BrowserState>,
) -> Result<String, String> {
    browser.prepare(&connection, &expected_origin, &runtime_id)
}
#[tauri::command]
pub fn browser_sign_in_cancel(
    expected_origin: String,
    runtime_id: String,
    id: String,
    connection: State<'_, ConnectionState>,
    browser: State<'_, BrowserState>,
) -> Result<(), String> {
    browser.cancel(&connection, &expected_origin, &runtime_id, &id)
}
#[tauri::command]
pub async fn browser_sign_in_open(
    expected_origin: String,
    runtime_id: String,
    id: String,
    input: BrowserUserInput,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    let connection = app.state::<ConnectionState>();
    let browser = app.state::<BrowserState>();
    let http = app.state::<HttpState>();
    let input = DesktopInput {
        origin: &expected_origin,
        runtime_id: &runtime_id,
        id: &id,
        client_id: option_env!("OPENBOT_NATIVE_CLIENT_ID").unwrap_or("openbot-one"),
        email: input.email.as_deref(),
        invitation: input.invitation.as_deref(),
    };
    let open = |url: &str| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "The system browser could not open.".into())
    };
    let result = if cfg!(mobile) {
        browser.mobile(&connection, &http, input, open).await
    } else {
        browser.desktop(&connection, &http, input, open).await
    };
    let generation = connection.generation()?;
    http.cancel_before(generation);
    app.state::<SocketState>().cancel_before(generation);
    result
}

#[tauri::command]
pub fn lifecycle_subscribe(
    expected_origin: String,
    runtime_id: String,
    on_state: tauri::ipc::Channel<crate::lifecycle::ActivityMessage>,
    connection: State<'_, ConnectionState>,
    lifecycle: State<'_, crate::lifecycle::LifecycleState>,
) -> Result<String, String> {
    let context = connection.bound_context(&expected_origin, &runtime_id)?;
    lifecycle.subscribe(context.generation, on_state)
}
#[tauri::command]
pub fn lifecycle_unsubscribe(id: String, lifecycle: State<'_, crate::lifecycle::LifecycleState>) {
    lifecycle.unsubscribe(&id);
}

#[tauri::command]
pub fn browser_sign_in_watch(
    expected_origin: String,
    runtime_id: String,
    on_return: tauri::ipc::Channel<crate::browser::ReturnNotice>,
    connection: State<'_, ConnectionState>,
    browser: State<'_, BrowserState>,
) -> Result<(), String> {
    browser.watch_mobile(&connection, &expected_origin, &runtime_id, on_return)
}
#[tauri::command]
pub async fn browser_sign_in_resume(
    expected_origin: String,
    runtime_id: String,
    connection: State<'_, ConnectionState>,
    browser: State<'_, BrowserState>,
    http: State<'_, HttpState>,
    sockets: State<'_, SocketState>,
) -> Result<crate::browser::ResumeResult, String> {
    let result = browser
        .resume_mobile(
            &connection,
            &http,
            &expected_origin,
            &runtime_id,
            option_env!("OPENBOT_NATIVE_CLIENT_ID").unwrap_or("openbot-one"),
        )
        .await?;
    let generation = connection.generation()?;
    http.cancel_before(generation);
    sockets.cancel_before(generation);
    Ok(result)
}
