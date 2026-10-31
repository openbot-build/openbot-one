use jni::{errors::ThrowRuntimeExAndDefault, jni_mangle, objects::JObject, EnvUnowned};

/// Called by MainActivity before Tauri starts requests on worker threads.
#[allow(non_snake_case)]
#[jni_mangle("build.openbot.one.MainActivity")]
pub fn initCertificateVerifier<'local>(
    mut env: EnvUnowned<'local>,
    _activity: JObject<'local>,
    context: JObject<'local>,
) {
    env.with_env(|env| rustls_platform_verifier::android::init_with_env(env, context))
        .resolve::<ThrowRuntimeExAndDefault>();
}
