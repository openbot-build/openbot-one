use std::collections::BTreeMap;
use tauri::utils::{
    acl::{capability::Capability, manifest::Manifest, resolved::Resolved, ExecutionContext},
    platform::Target,
};

#[test]
fn mobile_permissions_resolve_to_typed_channels_and_deny_raw_urls() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifests: BTreeMap<String, Manifest> = serde_json::from_slice(
        &std::fs::read(root.join("gen/schemas/acl-manifests.json")).unwrap(),
    )
    .unwrap();
    let config: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("tauri.conf.json")).unwrap()).unwrap();
    let mut capabilities = BTreeMap::new();
    for item in config["app"]["security"]["capabilities"]
        .as_array()
        .unwrap()
    {
        let name = item
            .as_str()
            .expect("Audit inline capabilities before adding them");
        let capability: Capability = serde_json::from_slice(
            &std::fs::read(root.join("capabilities").join(format!("{name}.json"))).unwrap(),
        )
        .unwrap();
        capabilities.insert(name.to_string(), capability);
    }
    for target in [Target::Android, Target::Ios] {
        let resolved = Resolved::resolve(&manifests, capabilities.clone(), target).unwrap();
        assert!(resolved.has_app_acl);
        for command in [
            "lifecycle_subscribe",
            "browser_sign_in_watch",
            "browser_sign_in_resume",
        ] {
            let entries = resolved
                .allowed_commands
                .get(command)
                .expect("A typed command is missing");
            assert!(entries
                .iter()
                .all(|entry| entry.context == ExecutionContext::Local
                    && entry
                        .windows
                        .iter()
                        .all(|window| window.matches("main") && !window.matches("other"))));
        }
        for command in [
            "plugin:event|listen",
            "plugin:event|unlisten",
            "plugin:deep-link|get_current",
            "plugin:deep-link|register",
            "plugin:deep-link|unregister",
            "plugin:deep-link|is_registered",
        ] {
            assert!(
                !resolved.allowed_commands.contains_key(command),
                "Unexpected grant: {command}"
            );
            assert!(
                resolved.denied_commands.contains_key(command),
                "Missing denial: {command}"
            );
        }
        assert!(!resolved
            .allowed_commands
            .keys()
            .any(|command| command.starts_with("plugin:deep-link|")));
        // The mobile native fallback is reached only after the same ACL check.
        // Camel-case spellings and the native-only event channel have no grant.
        for command in [
            "plugin:deep-link|getCurrent",
            "plugin:deep-link|setEventHandler",
            "plugin:deep-link|set_event_handler",
        ] {
            assert!(!resolved.allowed_commands.contains_key(command));
        }
    }
    let desktop = Resolved::resolve(&manifests, capabilities, Target::Linux).unwrap();
    assert!(!desktop
        .allowed_commands
        .contains_key("browser_sign_in_resume"));
    assert!(!desktop.allowed_commands.contains_key("plugin:event|listen"));
}
