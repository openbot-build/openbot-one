use crate::connection::{ConnectionState, Context};
use futures_util::{
    stream::{SplitSink, SplitStream},
    SinkExt, StreamExt,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{net::TcpStream, sync::Mutex as AsyncMutex};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::{
        header::{COOKIE, ORIGIN},
        HeaderValue, Request,
    },
    protocol::{frame::coding::CloseCode, CloseFrame, WebSocketConfig},
    Message,
};
use tokio_tungstenite::{
    connect_async_tls_with_config, Connector, MaybeTlsStream, WebSocketStream,
};
use tokio_util::sync::CancellationToken;

const MAX_MESSAGE: usize = 1024 * 1024;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
struct Slot {
    context: Context,
    request: Mutex<Option<Request<()>>>,
    reader: AsyncMutex<Option<SplitStream<Socket>>>,
    writer: AsyncMutex<Option<SplitSink<Socket, Message>>>,
    cancel: CancellationToken,
}

pub struct SocketState {
    active: AtomicBool,
    slots: Arc<Mutex<HashMap<String, Arc<Slot>>>>,
    tls: Arc<rustls::ClientConfig>,
}

impl SocketState {
    pub fn new() -> Result<Self, String> {
        // Use the same platform trust as HTTP, including mobile trust stores.
        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let verifier = rustls_platform_verifier::Verifier::new(provider.clone())
            .map_err(|_| "The system certificate verifier could not start.")?;
        let tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|_| "The secure socket client could not start.")?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        Ok(Self {
            active: AtomicBool::new(true),
            slots: Arc::new(Mutex::new(HashMap::new())),
            tls: Arc::new(tls),
        })
    }

    pub fn prepare(
        &self,
        connection: &ConnectionState,
        input: &str,
        expected_origin: &str,
        runtime_id: &str,
    ) -> Result<String, String> {
        let context = connection.bound_context(expected_origin, runtime_id)?;
        let request = socket_request(&context, input)?;
        let mut slots = self
            .slots
            .lock()
            .map_err(|_| "Live connections are not available.")?;
        if !self.active.load(Ordering::SeqCst) {
            return Err("Resume the app before starting Live talk.".into());
        }
        if slots.len() >= 8 {
            return Err("Too many live connections are open.".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        slots.insert(
            id.clone(),
            Arc::new(Slot {
                context,
                request: Mutex::new(Some(request)),
                reader: AsyncMutex::new(None),
                writer: AsyncMutex::new(None),
                cancel: CancellationToken::new(),
            }),
        );
        Ok(id)
    }

    fn slot(&self, id: &str) -> Result<Arc<Slot>, String> {
        self.slots
            .lock()
            .map_err(|_| "Live connections are not available.")?
            .get(id)
            .cloned()
            .ok_or_else(|| "The live connection has ended.".into())
    }

    pub async fn open(&self, connection: &ConnectionState, id: &str) -> Result<(), String> {
        let slot = self.slot(id)?;
        if connection.context()?.generation != slot.context.generation {
            self.cancel(id);
            return Err("The service changed. Reload the app.".into());
        }
        let request = slot
            .request
            .lock()
            .map_err(|_| "The live request is not available.")?
            .take()
            .ok_or("The live request already started.")?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE))
            .max_frame_size(Some(MAX_MESSAGE))
            .max_write_buffer_size(MAX_MESSAGE * 2);
        let result = tokio::select! {
            _ = slot.cancel.cancelled() => Err("The live connection was cancelled.".to_string()),
            result = tokio::time::timeout(Duration::from_secs(15), connect_async_tls_with_config(request, Some(config), false, Some(Connector::Rustls(self.tls.clone())))) => {
                result.map_err(|_| "The live connection timed out.".to_string())
                    .and_then(|result| result.map_err(|_| "The service did not accept the live connection. Check the session and live model.".to_string()))
            }
        };
        match result {
            Ok((socket, _)) if !slot.cancel.is_cancelled() => {
                let (writer, reader) = socket.split();
                *slot.writer.lock().await = Some(writer);
                *slot.reader.lock().await = Some(reader);
                Ok(())
            }
            _ => {
                self.cancel(id);
                Err("The live connection could not start.".into())
            }
        }
    }

    // Binary IPC packets: 0 = UTF-8 text, 1 = binary, 2 = close code and reason.
    pub async fn read(&self, id: &str) -> Result<Vec<u8>, String> {
        // A service switch can remove the slot before the first IPC read.
        // That is still a closed socket, without another network operation.
        let slot = match self.slot(id) {
            Ok(slot) => slot,
            Err(_) => return Ok(close_packet(1001, false, "The live connection has ended.")),
        };
        let mut reader = slot.reader.lock().await;
        let reader = reader.as_mut().ok_or("The live connection is not ready.")?;
        loop {
            let message = tokio::select! {
                _ = slot.cancel.cancelled() => { self.cancel(id); return Ok(close_packet(1001, false, "The live connection was stopped.")); },
                message = reader.next() => message,
            };
            match message {
                Some(Ok(Message::Text(text))) => return Ok(packet(0, text.as_bytes())),
                Some(Ok(Message::Binary(bytes))) => return Ok(packet(1, &bytes)),
                Some(Ok(Message::Close(frame))) => {
                    if let Some(writer) = slot.writer.lock().await.as_mut() {
                        let _ = tokio::time::timeout(Duration::from_secs(1), writer.flush()).await;
                    }
                    self.cancel(id);
                    return Ok(match frame {
                        Some(frame) => close_packet(frame.code.into(), true, &frame.reason),
                        None => close_packet(1005, true, ""),
                    });
                }
                Some(Ok(_)) => {} // The protocol handles ping and pong frames.
                _ => {
                    self.cancel(id);
                    return Ok(close_packet(1006, false, "The live connection ended."));
                }
            }
        }
    }

    pub async fn write(&self, id: &str, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.len() > MAX_MESSAGE + 1 {
            return Err("The live message is too large.".into());
        }
        let message = match bytes.split_first() {
            Some((0, data)) => Message::Text(
                String::from_utf8(data.to_vec())
                    .map_err(|_| "The live text is not valid UTF-8.")?
                    .into(),
            ),
            Some((1, data)) => Message::Binary(data.to_vec().into()),
            _ => return Err("The live message type is not allowed.".into()),
        };
        let slot = self.slot(id)?;
        let mut writer = slot.writer.lock().await;
        let writer = writer.as_mut().ok_or("The live connection is not ready.")?;
        tokio::select! {
            _ = slot.cancel.cancelled() => Err("The live connection was cancelled.".to_string()),
            result = tokio::time::timeout(Duration::from_secs(10), writer.send(message)) => {
                if matches!(result, Ok(Ok(()))) { Ok(()) } else { self.cancel(id); Err("The live message could not be sent.".into()) }
            }
        }
    }

    pub async fn close(&self, id: &str, code: u16, reason: String) -> Result<(), String> {
        if (code != 1000 && !(3000..=4999).contains(&code)) || reason.len() > 123 {
            return Err("The close code or reason is not allowed.".into());
        }
        let Ok(slot) = self.slot(id) else {
            return Ok(());
        };
        let mut writer = slot.writer.lock().await;
        if let Some(writer) = writer.as_mut() {
            let result = tokio::time::timeout(
                Duration::from_secs(3),
                writer.send(Message::Close(Some(CloseFrame {
                    code: CloseCode::from(code),
                    reason: reason.into(),
                }))),
            )
            .await;
            if !matches!(result, Ok(Ok(()))) {
                self.cancel(id);
            }
            // Give the peer time to reply. A stalled peer cannot keep a read open.
            let cancel = slot.cancel.clone();
            let slots = self.slots.clone();
            let id = id.to_string();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                cancel.cancel();
                if let Ok(mut slots) = slots.lock() {
                    slots.remove(&id);
                }
            });
        } else {
            self.cancel(id);
        }
        Ok(())
    }

    fn cancel(&self, id: &str) {
        if let Ok(mut slots) = self.slots.lock() {
            if let Some(slot) = slots.remove(id) {
                slot.cancel.cancel();
            }
        }
    }

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
    }

    pub fn cancel_all(&self) {
        if let Ok(mut slots) = self.slots.lock() {
            for (_, slot) in slots.drain() {
                slot.cancel.cancel();
            }
        }
    }

    /// Pause closes native sockets even while the WebView cannot run JavaScript.
    pub fn set_active(&self, active: bool) {
        self.active.store(active, Ordering::SeqCst);
        if !active {
            self.cancel_all();
        }
    }
}

fn packet(kind: u8, data: &[u8]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(data.len() + 1);
    packet.push(kind);
    packet.extend_from_slice(data);
    packet
}
fn close_packet(code: u16, clean: bool, reason: &str) -> Vec<u8> {
    let mut data = vec![2, (code >> 8) as u8, code as u8, u8::from(clean)];
    data.extend_from_slice(reason.as_bytes());
    data
}

fn socket_request(context: &Context, input: &str) -> Result<Request<()>, String> {
    if input.len() > 8192 {
        return Err("The live address is too large.".into());
    }
    let url = url::Url::parse(input).map_err(|_| "The live address is not valid.")?;
    let mut http = url.clone();
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => return Err("The live address needs WS or WSS.".into()),
    };
    http.set_scheme(scheme)
        .map_err(|_| "The live address is not valid.")?;
    let parts: Vec<_> = url.path().split('/').collect();
    let valid_path = parts.len() == 5
        && parts[1] == "v1"
        && parts[2] == "chats"
        && !parts[3].is_empty()
        && parts[3]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        && parts[4] == "live";
    let query: Vec<_> = url.query_pairs().collect();
    if !context.origin.allows_authenticated_request(&http)
        || !valid_path
        || query.len() > 1
        || query
            .iter()
            .any(|(name, value)| name != "organization" || value.is_empty())
    {
        return Err("The live address is outside the selected service or live route.".into());
    }
    let cookie = context
        .cookie
        .as_ref()
        .ok_or("Sign in before starting a live connection.")?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "The live request could not be made.")?;
    request.headers_mut().insert(
        ORIGIN,
        HeaderValue::from_str(context.origin.as_str())
            .map_err(|_| "The service origin is not valid.")?,
    );
    let mut cookie = HeaderValue::from_str(cookie).map_err(|_| "The session is not valid.")?;
    cookie.set_sensitive(true);
    request.headers_mut().insert(COOKIE, cookie);
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{connection::Session, service::ServiceOrigin};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{
        Request as ServerRequest, Response as ServerResponse,
    };

    fn connection(origin: &str) -> (tempfile::TempDir, ConnectionState) {
        let dir = tempfile::tempdir().unwrap();
        let state = ConnectionState::load(
            dir.path().join("connection.json"),
            ServiceOrigin::for_app(origin).unwrap(),
        )
        .unwrap();
        state
            .save_session(
                &state.context().unwrap(),
                Session {
                    cookie: "test-session=value".into(),
                    account: "person".into(),
                    persisted: false,
                },
            )
            .unwrap();
        (dir, state)
    }

    #[test]
    fn credentials_are_only_added_to_the_selected_live_route() {
        let (_dir, state) = connection("https://service.test");
        let context = state.context().unwrap();
        for url in [
            "wss://evil.test/v1/chats/chat/live",
            "ws://service.test/v1/chats/chat/live",
            "wss://service.test/health",
            "wss://user:secret@service.test/v1/chats/chat/live",
            "wss://service.test/v1/chats/chat/live?token=secret",
            "wss://service.test/v1/chats/chat/live?organization=one&organization=two",
            "wss://service.test/v1/chats/chat/live#token",
        ] {
            assert!(socket_request(&context, url).is_err());
        }
        let request = socket_request(
            &context,
            "wss://service.test/v1/chats/chat/live?organization=one",
        )
        .unwrap();
        assert_eq!(request.headers()[ORIGIN], "https://service.test");
        assert!(request.headers()[COOKIE].is_sensitive());
        assert_eq!(request.uri().query(), Some("organization=one"));
        state.sign_out().unwrap();
        assert!(socket_request(
            &state.context().unwrap(),
            "wss://service.test/v1/chats/chat/live"
        )
        .is_err());
    }

    #[tokio::test]
    // Tungstenite's callback requires an unboxed HTTP error response.
    #[allow(clippy::result_large_err)]
    async fn text_binary_and_close_use_real_authenticated_socket_io() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (_dir, state) = connection(&origin);
        let expected_origin = origin.clone();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(
                tcp,
                move |request: &ServerRequest, response: ServerResponse| {
                    assert_eq!(request.headers()[ORIGIN], expected_origin);
                    assert_eq!(request.headers()[COOKIE], "test-session=value");
                    assert_eq!(request.uri().path(), "/v1/chats/chat/live");
                    Ok(response)
                },
            )
            .await
            .unwrap();
            for _ in 0..2 {
                let message = socket.next().await.unwrap().unwrap();
                socket.send(message).await.unwrap();
            }
            socket
                .close(Some(CloseFrame {
                    code: CloseCode::Normal,
                    reason: "Done".into(),
                }))
                .await
                .unwrap();
            let _ = socket.next().await;
        });
        let sockets = SocketState::new().unwrap();
        let url = origin.replacen("http:", "ws:", 1) + "/v1/chats/chat/live?organization=one";
        let id = sockets
            .prepare(&state, &url, &origin, &state.snapshot().unwrap().runtime_id)
            .unwrap();
        sockets.open(&state, &id).await.unwrap();
        sockets
            .write(&id, packet(0, "Hello 世界".as_bytes()))
            .await
            .unwrap();
        assert_eq!(
            sockets.read(&id).await.unwrap(),
            packet(0, "Hello 世界".as_bytes())
        );
        sockets.write(&id, packet(1, &[0, 1, 255])).await.unwrap();
        assert_eq!(sockets.read(&id).await.unwrap(), packet(1, &[0, 1, 255]));
        assert_eq!(
            sockets.read(&id).await.unwrap(),
            close_packet(1000, true, "Done")
        );
        assert!(sockets.slot(&id).is_err());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn changed_services_and_reloaded_documents_cannot_open_old_sockets() {
        let (_dir, state) = connection("https://service.test");
        let sockets = SocketState::new().unwrap();
        let id = sockets
            .prepare(
                &state,
                "wss://service.test/v1/chats/chat/live",
                "https://service.test",
                &state.snapshot().unwrap().runtime_id,
            )
            .unwrap();
        state.restart_runtime().unwrap();
        assert!(sockets.open(&state, &id).await.is_err());
        assert!(sockets.slot(&id).is_err());
        let id = sockets
            .prepare(
                &state,
                "wss://service.test/v1/chats/chat/live",
                "https://service.test",
                &state.snapshot().unwrap().runtime_id,
            )
            .unwrap();
        sockets.cancel_all();
        assert!(sockets.open(&state, &id).await.is_err());
        assert_eq!(
            sockets.read(&id).await.unwrap(),
            close_packet(1001, false, "The live connection has ended.")
        );
    }

    #[tokio::test]
    async fn old_document_bindings_cannot_open_channels_for_the_new_account() {
        let (_dir, state) = connection("https://service.test");
        let sockets = SocketState::new().unwrap();
        let url = "wss://service.test/v1/chats/stopped/live";
        let old = state.snapshot().unwrap();
        let old_id = sockets
            .prepare(&state, url, &old.current_origin, &old.runtime_id)
            .unwrap();
        state
            .save_session(
                &state.context().unwrap(),
                Session {
                    cookie: "second-private-session".into(),
                    account: "second-account".into(),
                    persisted: false,
                },
            )
            .unwrap();
        assert!(sockets
            .prepare(&state, url, &old.current_origin, &old.runtime_id)
            .is_err());
        let new = state.snapshot().unwrap();
        let new_id = sockets
            .prepare(&state, url, &new.current_origin, &new.runtime_id)
            .unwrap();
        sockets.cancel_before(state.generation().unwrap());
        assert!(sockets.slot(&old_id).is_err());
        assert!(sockets.slot(&new_id).is_ok());
        assert!(sockets.open(&state, &old_id).await.is_err());
        // Reloading at the same origin also retires the document's binding.
        state.restart_runtime().unwrap();
        assert!(sockets
            .prepare(&state, url, &new.current_origin, &new.runtime_id)
            .is_err());
        assert!(sockets.open(&state, &new_id).await.is_err());
    }

    #[tokio::test]
    async fn suspension_revokes_old_sockets_and_resume_requires_a_new_talk() {
        let (_dir, state) = connection("https://service.test");
        let sockets = SocketState::new().unwrap();
        let url = "wss://service.test/v1/chats/chat/live";
        let id = sockets
            .prepare(
                &state,
                url,
                "https://service.test",
                &state.snapshot().unwrap().runtime_id,
            )
            .unwrap();
        let slot = sockets.slot(&id).unwrap();
        sockets.set_active(false);
        assert!(slot.cancel.is_cancelled());
        assert!(sockets.slot(&id).is_err());
        assert!(sockets
            .prepare(
                &state,
                url,
                "https://service.test",
                &state.snapshot().unwrap().runtime_id
            )
            .is_err());
        sockets.set_active(true);
        assert!(sockets.open(&state, &id).await.is_err());
        let next = sockets
            .prepare(
                &state,
                url,
                "https://service.test",
                &state.snapshot().unwrap().runtime_id,
            )
            .unwrap();
        assert_ne!(next, id);
        assert!(!sockets.slot(&next).unwrap().cancel.is_cancelled());
        sockets.cancel_all();
    }
}
