use crate::{connection::ConnectionState, navigation::NavigationPolicy};
use tauri::{
    webview::{PermissionKind, PermissionResponse},
    Manager,
};

/// Only the signed-in local app may enter the platform microphone flow.
pub fn permission(
    view: &tauri::Webview,
    kind: PermissionKind,
    policy: &NavigationPolicy,
) -> PermissionResponse {
    let local = view.label() == "main" && view.url().is_ok_and(|url| policy.allows(&url));
    let signed_in = view
        .try_state::<ConnectionState>()
        .and_then(|state| state.context().ok())
        .is_some_and(|context| context.cookie.is_some());
    decision(local && signed_in, kind)
}

fn decision(allowed_view: bool, kind: PermissionKind) -> PermissionResponse {
    if allowed_view && kind == PermissionKind::Microphone {
        // Linux continues to our asynchronous GTK prompt below. Other targets
        // continue to their OS/browser prompts, including Android runtime consent.
        PermissionResponse::Default
    } else {
        PermissionResponse::Deny
    }
}

#[cfg(not(target_os = "linux"))]
pub fn install(_: &tauri::WebviewWindow, _: NavigationPolicy) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn install(window: &tauri::WebviewWindow, policy: NavigationPolicy) -> tauri::Result<()> {
    use gtk::prelude::*;
    use std::{cell::Cell, rc::Rc};
    use webkit2gtk::{PermissionRequestExt, UserMediaPermissionRequestExt, WebViewExt};

    let owner = window.clone();
    window.with_webview(move |platform| {
        let view = platform.inner();
        let app = owner.app_handle().clone();
        let parent = owner.gtk_window().ok().map(|window| window.downgrade());
        let pending = Rc::new(Cell::new(false));
        let approved = Rc::new(Cell::new(None::<u64>));
        view.connect_permission_request(move |view, request| {
            let Some(media) = request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>() else { return false };
            // Combined camera/microphone and display requests are never allowed.
            let audio_only = media.is_for_audio_device() && !media.is_for_video_device();
            let local = view.uri().and_then(|uri| url::Url::parse(&uri).ok()).is_some_and(|url| policy.allows(&url));
            let context = app.state::<ConnectionState>().context().ok();
            if !audio_only || !local || context.as_ref().is_none_or(|context| context.cookie.is_none()) {
                request.deny();
                return true;
            }
            let generation = context.unwrap().generation;
            if approved.get() == Some(generation) {
                request.allow();
                return true;
            }
            if pending.replace(true) {
                request.deny();
                return true;
            }
            let Some(parent) = parent.as_ref().and_then(|parent| parent.upgrade()) else {
                pending.set(false);
                request.deny();
                return true;
            };
            let dialog = gtk::MessageDialog::builder()
                .transient_for(&parent).modal(true).title("Microphone access")
                .text("Allow microphone access?")
                .secondary_text("OpenBot will use your microphone during Live talks. You can stop the talk at any time.")
                .build();
            dialog.add_buttons(&[("_Don't allow", gtk::ResponseType::Reject), ("_Allow", gtk::ResponseType::Accept)]);
            dialog.set_default_response(gtk::ResponseType::Reject);
            let request = request.clone();
            let app = app.clone();
            let approved = approved.clone();
            let pending = pending.clone();
            dialog.connect_response(move |dialog, response| {
                pending.set(false);
                // A late response cannot grant access to a later document/account.
                let current = app.state::<ConnectionState>().context().ok();
                if response == gtk::ResponseType::Accept && current.is_some_and(|context| context.generation == generation && context.cookie.is_some()) {
                    approved.set(Some(generation));
                    request.allow();
                } else { request.deny(); }
                dialog.close();
            });
            dialog.show_all();
            true
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_microphone_in_the_signed_in_local_view_reaches_a_consent_flow() {
        assert_eq!(
            decision(true, PermissionKind::Microphone),
            PermissionResponse::Default
        );
        assert_eq!(
            decision(false, PermissionKind::Microphone),
            PermissionResponse::Deny
        );
        for kind in [
            PermissionKind::Camera,
            PermissionKind::DisplayCapture,
            PermissionKind::Geolocation,
            PermissionKind::ClipboardRead,
            PermissionKind::MediaKeySystemAccess,
            PermissionKind::Other,
        ] {
            assert_eq!(decision(true, kind), PermissionResponse::Deny);
        }
    }
}
