//! Only typed activity state may enter the web view. Incoming auth URLs stay native.
use serde::Serialize;
use std::{collections::HashMap, sync::Mutex};
use tauri::ipc::Channel;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Active,
    Inactive,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityMessage {
    runtime_id: String,
    state: Activity,
}
struct Subscription {
    generation: u64,
    channel: Channel<ActivityMessage>,
}
struct Inner {
    generation: u64,
    state: Activity,
    subscriptions: HashMap<String, Subscription>,
}
pub struct LifecycleState {
    inner: Mutex<Inner>,
}
impl Default for LifecycleState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                generation: 0,
                state: Activity::Active,
                subscriptions: HashMap::new(),
            }),
        }
    }
}
impl LifecycleState {
    /// A late old startup/cleanup cannot clear a newer document's channels.
    pub fn advance(&self, generation: u64) {
        let old = if let Ok(mut inner) = self.inner.lock() {
            if generation <= inner.generation {
                return;
            }
            inner.generation = generation;
            std::mem::take(&mut inner.subscriptions)
        } else {
            return;
        };
        drop(old);
    }
    pub fn subscribe(
        &self,
        generation: u64,
        channel: Channel<ActivityMessage>,
    ) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        let state = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Activity state is not available.")?;
            if generation != inner.generation {
                return Err("The document changed. Reload the app.".into());
            }
            if inner.subscriptions.len() >= 16 {
                return Err("Too many activity listeners are open.".into());
            }
            inner.subscriptions.insert(
                id.clone(),
                Subscription {
                    generation,
                    channel: channel.clone(),
                },
            );
            inner.state
        };
        // The receiver also checks runtime_id. If reset races this delivery, an
        // old native channel cannot change the new document's activity state.
        if channel
            .send(ActivityMessage {
                runtime_id: generation.to_string(),
                state,
            })
            .is_err()
        {
            self.unsubscribe(&id);
            return Err("The activity listener could not start.".into());
        }
        Ok(id)
    }
    pub fn unsubscribe(&self, id: &str) {
        let old = self
            .inner
            .lock()
            .ok()
            .and_then(|mut inner| inner.subscriptions.remove(id));
        drop(old);
    }
    pub fn publish(&self, state: Activity) {
        let subscribers = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            if inner.state == state {
                return;
            }
            inner.state = state;
            inner
                .subscriptions
                .iter()
                .map(|(id, subscriber)| {
                    (
                        id.clone(),
                        subscriber.generation,
                        subscriber.channel.clone(),
                    )
                })
                .collect::<Vec<_>>()
        };
        for (id, generation, channel) in subscribers {
            if channel
                .send(ActivityMessage {
                    runtime_id: generation.to_string(),
                    state,
                })
                .is_err()
            {
                self.unsubscribe(&id);
            }
        }
    }
    pub fn clear(&self) {
        let old = self
            .inner
            .lock()
            .ok()
            .map(|mut inner| std::mem::take(&mut inner.subscriptions));
        drop(old);
    }
}

/// Mobile activity state is separate from desktop window focus.
pub fn handle(window: &tauri::Window, event: &tauri::WindowEvent) {
    use tauri::Manager;
    if window.label() != "main" {
        return;
    }
    if matches!(event, tauri::WindowEvent::Destroyed) {
        if let Some(lifecycle) = window.try_state::<LifecycleState>() {
            lifecycle.clear();
        }
        #[cfg(desktop)]
        if let Some(browser) = window.try_state::<crate::browser::BrowserState>() {
            browser.cancel_all();
        }
    }
    #[cfg(mobile)]
    {
        let active = match event {
            tauri::WindowEvent::Suspended => false,
            tauri::WindowEvent::Resumed => true,
            _ => return,
        };
        if let Some(sockets) = window.try_state::<crate::socket::SocketState>() {
            sockets.set_active(active);
        }
        if let Some(lifecycle) = window.try_state::<LifecycleState>() {
            lifecycle.publish(if active {
                Activity::Active
            } else {
                Activity::Inactive
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tauri::ipc::InvokeResponseBody;
    fn channel() -> (Channel<ActivityMessage>, Arc<Mutex<Vec<Value>>>) {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let captured = messages.clone();
        (
            Channel::new(move |body| {
                let InvokeResponseBody::Json(body) = body else {
                    panic!("Expected typed state");
                };
                captured
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(&body).unwrap());
                Ok(())
            }),
            messages,
        )
    }
    #[test]
    fn lifecycle_payload_is_only_state_and_document_id_and_old_cleanup_keeps_new_subscribers() {
        let state = LifecycleState::default();
        state.advance(1);
        let (old, old_messages) = channel();
        let old_id = state.subscribe(1, old).unwrap();
        state.publish(Activity::Inactive);
        state.advance(2);
        let (new, new_messages) = channel();
        let new_id = state.subscribe(2, new).unwrap();
        state.advance(1);
        state.unsubscribe(&old_id);
        state.publish(Activity::Active);
        assert_eq!(
            *old_messages.lock().unwrap(),
            vec![
                json!({"runtimeId":"1","state":"active"}),
                json!({"runtimeId":"1","state":"inactive"}),
            ]
        );
        assert_eq!(
            *new_messages.lock().unwrap(),
            vec![
                json!({"runtimeId":"2","state":"inactive"}),
                json!({"runtimeId":"2","state":"active"}),
            ]
        );
        state.unsubscribe(&new_id);
        state.publish(Activity::Inactive);
        assert_eq!(new_messages.lock().unwrap().len(), 2);
    }
    #[test]
    fn subscriptions_reject_stale_documents_and_are_bounded_and_pruned_on_failed_delivery() {
        let state = LifecycleState::default();
        state.advance(1);
        assert!(state.subscribe(0, channel().0).is_err());
        for _ in 0..16 {
            state.subscribe(1, channel().0).unwrap();
        }
        assert!(state.subscribe(1, channel().0).is_err());
        state.advance(2);
        assert!(state
            .subscribe(
                2,
                Channel::new(|_| Err(tauri::Error::FailedToReceiveMessage))
            )
            .is_err());
        assert!(state.inner.lock().unwrap().subscriptions.is_empty());
    }
    #[test]
    fn lifecycle_permission_has_no_general_event_or_deep_link_access() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/lifecycle.json")).unwrap();
        let permissions = capability["permissions"].as_array().unwrap();
        assert!(permissions.contains(&json!("lifecycle-channel")));
        assert!(permissions.contains(&json!("core:event:deny-listen")));
        assert!(permissions.contains(&json!("deep-link:deny-get-current")));
        assert!(!permissions
            .iter()
            .any(|permission| permission
                .as_str()
                .is_some_and(|value| value.starts_with("core:event:allow-")
                    || value.starts_with("deep-link:allow-")
                    || value == "deep-link:default")));
        let permission = include_str!("../permissions/lifecycle.toml");
        assert!(!permission.contains("core:event"));
        assert!(!permission.contains("deep-link"));
        assert!(permission.contains("lifecycle_subscribe"));
        assert!(permission.contains("lifecycle_unsubscribe"));
    }
}
