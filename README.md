# OpenBot One

The Tauri desktop and mobile shell for OpenBot. It shares the Web app
from [openbot-ui](https://github.com/openbot-build/openbot-ui).

Targets: Windows, macOS, Linux, Android, and iOS. This is work in progress.
Local development sign-in and chat work through the native adapter. Email-code
sign-in is integrated with the published server contract. Company browser
sign-in is implemented; target-host and device acceptance still need work. Native credential persistence
is integrated; Linux restart and logout checks use a real private Secret Service.
The shell does not provide a second copy of the screens.

- [Tauri research](docs/tauri-research.md): sources and architecture decisions.
- [Implementation plan](docs/implementation-plan.md): remaining work and gates.

## Default service

Copy `.env.example` to `.env`. The current development default is
`http://localhost:19380`. This is public build configuration, not a secret.
The Tauri command wrapper reads `.env` and checks the value before dev/build.
Do not put API tokens or client secrets in this variable.

The intended first-run flow uses that service without asking for an address.
A settings entry on the sign-in, connection error, and account screens lets
users select another HTTPS service or return to the default. Settings persist
across restarts. Account state and in-memory sessions are scoped to each origin;
switching services cancels old requests. Release builds require HTTPS. Debug
builds also allow loopback HTTP. The native process stores a checked session in
the OS credential store and checks it with the service before restoring it.
The disk index contains random IDs and flags, with no session cookie. If saving
cannot be confirmed, the app keeps the sign-in in memory and says that another
sign-in may be needed after closing.
There is no plain-file fallback. Service/account namespaces remain separate.

If saved service settings are damaged, from another version, or unreadable, the
app opens a repair screen. Requests and sign-in stay blocked until the user saves
an address, returns to the default, or retries after repairing the file. Loading
the app does not overwrite the original file.

The online Access setup is paused at the user's request. Start a local backend:

```sh
devenv shell -- pnpm backend:local
# In another terminal:
devenv shell -- pnpm backend:check
```

Docker must be running. The script checks out the server revision that matches
client 0.1.5 under `.cache/backend-0.1.5`, starts isolated Postgres and file storage,
builds, migrates, and runs the development server. Its model/app providers are
simulated. It does not edit the sibling backend checkout. Data stays in this
Compose project's named volumes. Stop the server with Ctrl-C, then stop the
containers with `pnpm backend:local:stop`.

Keep the checkout's private `.env.development` with the database: its encryption
keys must survive a version change. The script keeps the keys from the earlier
`.cache/backend` checkout when creating the new one. Back up an existing database
before upgrading; do not run migration while another server uses that database.

The app's local sign-in button uses the server's development test account. It is
available only in a debug build connected to a loopback service. Native Rust
holds the session cookie; the WebView never receives it.

When a service enables email sign-in, the shared form sends and checks its
eight-digit code through the native transport. Rust accepts a session only from
the exact verify endpoint's 204 response and a successful bounded account check.
Cookie attributes are checked; no cookie is returned to JavaScript. Failed codes
and admission errors keep the server's typed error reason. A service switch or
cancellation during checking prevents a late session from being saved. A new
session closes old requests/sockets and clears old signed upload grants before
the shared page reloads.

Desktop company sign-in opens the system browser. Rust keeps its PKCE verifier,
state, one-use code and session Cookie private. A temporary 127.0.0.1 listener
checks the exact return path, Host, state and issuer, then closes before the
exchange. The form supports cancellation. Reload, account change and service
change end old attempts; an old cancellation ID cannot stop a new one.

The service must include the native sign-in API and register the public
`OPENBOT_NATIVE_CLIENT_ID` (default `openbot-one`) with
`http://127.0.0.1/auth/callback` in its `nativeClients` settings. The actual
loopback port is temporary; the registered host and path must match. The
running local v0.1.5 backend is unchanged and still supports development and
email sign-in. The native API changes are in the isolated backend worktree.
Mobile company sign-in also opens the system browser. Register
`build.openbot.one:/auth/callback` for the same public client. Rust owns the
return queue and checks the saved proof, selected service, client, state, issuer
and deadline before exchanging a code. Pending proofs live in a separate OS
credential purpose and are deleted before exchange. A typed notification lets
a fresh document resume a valid return after process restart. No return URL,
code, verifier or session Cookie is delivered to the WebView. Actual Android
and iOS browser return still needs device acceptance.

Each document captures a non-secret native runtime ID. HTTP and Live preparation,
sign-in/out, credential retry, and service settings require that ID and the
selected origin. Reloading, changing services, or committing an account change
retires it, including changes at the same origin. The adapter never refreshes
an old document's ID. Stream and socket handles stay bound to their captured
native context; cleanup only removes older generations, so a delayed operation
cannot close a newer account's requests or channels.

## Development

Use the pinned environment and dependencies:

```sh
devenv shell -- pnpm install --frozen-lockfile
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm native:check
devenv shell -- pnpm native:test
devenv shell -- cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

The default build installs a fixed Web package from `vendor/openbot-web` through
`pnpm-lock.yaml`. It contains the same real UI used by the checked native builds,
not a test adapter. No sibling checkout or private registry token is needed for
this app's installation. The package stays separate from shell code and the
shell imports only its public runtime entry.

This is an unpublished integration snapshot, not a registry release.
`vendor/openbot-web/provenance.json` records its package hash, upstream base
commit, client version and source patch. Review the package and patch together
when updating it. The MIT license remains in the package and staged app assets.

Bundled Web code notices and the two font OFL files are also preserved.
Native adapter code notices and the checked Rust notice collection are added
under `dist/licenses`. `pnpm build` rejects stale Rust notices; ordinary builds
use the saved collection without installing a scanner.
See [third-party notices](docs/distribution-notices.md) for refresh commands and
the remaining review limits. These records do not choose an application license.

Switch the dependency to the official package once that runtime entry is
published; keep the version and integrity locked.

For UI development, build `openbot-ui` in its own repository with
`devenv shell -- pnpm build` and optionally set `OPENBOT_WEB_PACKAGE_DIR` to
that package directory. An extracted package tarball also works. This override
does not change the default locked package.

The current integration branch is `codex/native-runtime-integration`, based on
UI commit `5362712082f3482173f9e3aee7be8bf75834a8e1`. It keeps the new account,
billing, and design work and uses published client 0.1.5. The matching local
server is pinned to `770126bda4c0cb5f737c42f54078ee9d67400d5d` (v0.1.5).

The build compiles the native adapter from `src/bootstrap.mjs` and stages it
with the shared package's public runtime. The adapter uses bounded binary IPC
for uploads and response streams, cancels aborted requests, and rejects network
redirects. Rust permits only the selected API and configured anonymous file
signed upload addresses. Older UI packages without the runtime entry are rejected.

Direct file uploads use the same transport. A known body size is sent as
`Content-Length`, and Rust checks the byte count before accepting the upload
end. This supports the size signed by object storage without allowing the Web
app to set arbitrary network headers. Storage never receives the API session
cookie. A successful authenticated `POST /v1/files/uploads` grants access to
only the returned URL, PUT method, headers, and file size. Grants expire with
the server's expiry, capped at 15 minutes. Service changes, sign-out, and runtime
restart clear them. Other backends need no build-time storage allowlist. The
upload metadata response is limited to 64 KiB; other responses still stream.

Live WebSockets also use Rust. The native process adds its private session cookie
and the selected service's Origin header. Only that service's chat Live route is
allowed; credentials in URLs and redirects are rejected. Text and binary frames
use bounded IPC. Switching services, signing out, or starting a new WebView
document stops old requests and sockets. The Android manifest includes microphone
permissions; Wry requests them when capture starts. Real microphone/audio tests
still need a configured Live provider and device checks.

Mobile suspension closes Live sockets in Rust before it notifies the shared
UI, so cancellation does not wait for JavaScript. The UI then closes audio and
microphone resources. A new chat or organization also ends the previous talk.
Resuming requires a new user action; it never replays a turn or starts capture.
The app listens for mobile lifecycle events without granting event emission.

Once those inputs are ready:

```sh
devenv shell -- pnpm desktop:dev
devenv shell -- pnpm desktop:build --debug --no-bundle
```

The development asset server binds to `TAURI_DEV_HOST` when Tauri sets it and
otherwise to `localhost:1420`. It serves built assets; rebuild the shared UI to
see changes. It has no API proxy. Production bundles use the default Tauri asset
protocol, an explicit CSP, and permissions limited to the local main window's
transport, connection settings, clipboard writes, and HTTPS link opening.

## Mobile tools

`devenv --profile android shell` provides a pinned JDK, SDK platforms 36/37,
build tools, NDK, and Android Rust targets. The Tauri Android library requires
platform 36 even though this app targets 37. Both are included in the Nix SDK.
The generated Android project is checked in; local SDK paths, generated Rust
bindings, assets, and native libraries are excluded.

```sh
devenv --profile android shell -- pnpm android:dev
devenv --profile android shell -- pnpm android:build --debug --target aarch64 --apk --ci
# Build, verify, and preserve each architecture before cleaning the next:
devenv --profile android shell -- pnpm android:package aarch64 x86_64
```

On an Android test device, forward the local services before launch:

```sh
adb reverse tcp:19380 tcp:19380
adb reverse tcp:19300 tcp:19300
```

Phone loopback refers to the phone; it needs these forwards to reach the host.

The `emulator` profile adds an API 36 x86_64 image. Its runner keeps the AVD
and a private ADB server separate from other Android work:

```sh
devenv --profile emulator shell -- pnpm android:emulator
# In another terminal, after sys.boot_completed is 1:
devenv --profile emulator shell -- adb -P19373 -s emulator-5558 shell getprop sys.boot_completed
devenv --profile emulator shell -- adb -P19373 -s emulator-5558 reverse tcp:19380 tcp:19380
devenv --profile emulator shell -- adb -P19373 -s emulator-5558 reverse tcp:19300 tcp:19300
```

Build x86_64 with the `android` profile, then copy the APK to a fixed test path
before installing it. Do not rebuild a file while ADB is reading it. The runner
uses KVM when available; software CPU emulation can take many minutes to boot.
The emulator profile clears desktop WebKit library paths to avoid C++ runtime
conflicts. Use the `android` profile, which includes platform 37, for builds.
For software CPU emulation, `CARGO_PROFILE_DEV_DEBUG=0` keeps the app debuggable
while leaving Rust debug symbols out of the APK. Gradle's `:app:clean` task
removes old incremental package data before a fresh test package is built.

Android HTTPS uses the system trust verifier. Its Kotlin support version comes
from Cargo.lock, and the activity initializes its JVM context before Tauri
starts. This is required for both HTTP and secure Live sockets.

With the debug APK installed and services forwarded, run
`devenv --profile emulator shell -- pnpm android:check`. This uses Playwright's
experimental Android WebView support against only `emulator-5558` on the private
ADB port. To select a future physical device, set `OPENBOT_ANDROID_SERIAL` to
its exact serial and `OPENBOT_ADB_PORT` to its local ADB server port (often 5037).
The script never chooses another connected device. It starts the app, checks the local native runtime, opens the software
keyboard, checks dialog bounds and focus, presses the real Android Back key,
and signs in against the local backend. Begin signed out, with the local backend
running and both ports forwarded. Screenshots and results go under
`.cache/emulator`. Device acceptance is deferred at the user's request until a
working device or accelerated host is available.
The current image's WebView 133 crashes during creation, also in a plain native
WebView app that loads static HTML. System UI has ANR dialogs. Installation
passes; keyboard, Back, and sign-in checks have not passed on this emulator.
Use a working test device or accelerated host before treating mobile behavior
as accepted.

Saved local debug packages are `.cache/emulator/openbot-one-arm64-debug.apk`
and `.cache/emulator/openbot-one-current-debug.apk` (x86_64). Both now include
the current UI integration, email-code login, OS credential storage, configuration
recovery, and OB icon. Android credential restore still needs a device check. Their APK
signatures, ZIP contents, and single ABI were checked. Exact hashes and evidence
are in `.cache/emulator/artifacts.json`; neither current package has device
acceptance. The earlier WebView crash package is retained separately.

Check the preserved APK sizes and SHA-256 hashes without a device or Android SDK:

```sh
devenv shell -- pnpm android:artifacts:check
```

This compares both packages with the saved build manifest. It does not launch an
emulator or change either APK. The APK baseline predates desktop company sign-in
and the typed mobile activity channel; newer source checks do not change its
recorded build or device status.

New mobile browser builds are saved separately in `.cache/mobile-browser-apks/`.
Their `verified.json` records debug signatures, a single ABI, ZIP integrity,
the compiled callback manifest, backup exclusions, sizes and hashes. These
checks do not prove device behavior. Check these newer files without a device:

```sh
devenv shell -- pnpm android:artifacts:check --manifest .cache/mobile-browser-apks/verified.json
```

The verifier also accepts the baseline object manifest. It reads each APK beside
the selected manifest, so copied archives do not depend on the original host's
absolute paths. A missing, changed or ambiguous APK record fails the check.

To build into another repository-relative directory without replacing the baseline:

```sh
OPENBOT_ANDROID_ARTIFACT_DIR=.cache/mobile-browser-apks devenv --profile android shell -- pnpm android:package aarch64 x86_64
```

The existing device script also has an optional privacy check for these newer
APKs. With an explicitly selected device, forwarded services and a signed-out
app, set `OPENBOT_ANDROID_BROWSER_PRIVACY_CHECK=1` as well as
`OPENBOT_ANDROID_SERIAL` and `OPENBOT_ADB_PORT` before running
`devenv --profile android shell -- pnpm android:check`. It checks that raw
deep-link and general event IPC is denied and an unsolicited OS callback cannot
sign in. It does not replace a real company-provider cold/warm round trip.

The shared UI now uses safe areas and visual viewport height for chat, dialogs,
and side sheets. Android Back closes the last open dialog or sheet before
going through WebView history or finishing the app. This uses Android-only
core permissions. Device acceptance, keyboard dismissal order, landscape,
and large text checks still need evidence.

On macOS with full Xcode installed, use the `ios` profile for Apple Rust targets,
then run `pnpm ios:init` and the iOS dev/build commands inside that environment.
The Apple project has not been generated or tested on the current Linux host.
Signing, store accounts, and device acceptance are separate release work.

## Checks so far

For packaged Linux media acceptance:

```sh
devenv --profile test shell -- pnpm media:check
```

This starts the normal debug app, a loopback WebKit Inspector, and a private
PulseAudio server with a synthetic microphone and null speaker. It does not
use host audio devices, the user's keyring, or an external Live provider.
WebDriver is unsuitable for this permission check because WebKit's automation
mode bypasses the app's consent handler. The check uses the real GTK consent
dialog, tests denial and a late response after sign-out, and loads the shared
local worklet under the packaged CSP. It checks 24 kHz mono PCM, resampled
frequency, authenticated native binary echo, real playback samples, and cleanup.
The synthetic input disables echo/noise/gain processing; human voice quality
and a complete Live-model conversation still need acceptance.
Results and native screenshots are in `.cache/media-e2e/run-*`.

The native permission policy permits only microphone consent for the signed-in
local main view. Linux shows a GTK prompt and remembers approval for the current
document/account generation. Other targets use their OS/browser prompt. Camera,
display capture, and unrelated Web permissions are denied. Apple microphone
usage text and the macOS audio-input entitlement are configured; Apple builds
and device permission flows are still unverified. Android keeps its existing
runtime microphone permissions. No Blob script allowance is added to CSP.

The Linux development shell supplies GStreamer base/good plugins. AppImage
configuration enables media framework bundling. The Ubuntu-baseline Debian and
AppImage checks below cover install or launch, real UI and local sign-in.
Physical audio hardware and other distributions still need their own checks.

The shared UI builds and its tests cover native transport injection as well as
the existing browser behavior. Asset staging tests reject incompatible Web
packages, unsafe entry URLs, symlinks, and path traversal. Native tests cover
window navigation, service/account isolation, and transport boundaries. An
explicit local integration check proves native development login and logout:

```sh
devenv shell -- cargo test --locked --manifest-path src-tauri/Cargo.toml local_backend_native_session_round_trip -- --ignored
```

The backend must be running for this check. Browser mocks do not prove mobile
device behavior.

For native credential acceptance on Linux:

```sh
devenv --profile test shell -- pnpm credentials:check
```

This creates a private D-Bus session and a fresh, encrypted GNOME keyring. It
does not use the user's keyring. It checks native storage, then the real local
mail flow, process restart with restored sign-in, and restart after sign-out.
It also returns to a remembered service and checks unavailable storage in a
separate process with no usable D-Bus connection. A memory-only sign-in must
not survive restart through a plain-file fallback.
The normal developer backend keeps running. Results are in
`.cache/credentials-e2e/run-*`. Other OS stores still need target-host acceptance.

To check only the Rust native stores, without starting the app or mail fixture:

```sh
devenv --profile test shell -- pnpm credentials:native:check
```

This uses the same isolated encrypted keyring. It verifies the existing session
store and the separate pending browser-proof store, including reopen, deletion,
and isolation between their purposes. Pending proof storage is used by the mobile return owner. Its OS delivery and
credential-store behavior still need target-device acceptance.

Native credentials use Secret Service on Linux, Credential Manager with local
persistence on Windows, the login Keychain on macOS, device-only unlocked
Keychain items on iOS, and Keystore-encrypted private preferences on Android.
Reads and writes run serially on one worker with a bounded queue and wait time.
Saving first disables restore. Only a completed write for the current service
and account enables its random record ID. A late write cannot re-enable logout.
Storage errors, pending removal, and failed account checks have a shared retry
entry. No raw credential read/write command is exposed to the WebView.

For the packaged Linux WebView check, build the desktop app first, then run:

```sh
devenv shell -- cargo install tauri-driver --version 2.1.0 --locked --root .cache/test-tools
devenv --profile test shell -- pnpm desktop:check
```

This starts isolated Xvfb and WebDriver processes, uses the local backend, and
checks service validation, failed-service recovery, login, authenticated REST,
organization setup, Bot creation, a chat response, and logout. It also copies
clipboard text through the native runtime and reads it back from the private X11
display with xclip. Unicode and line breaks must match, while native clipboard
read and clear commands must be denied. This checks Linux only.
It also selects
an image in the real composer, checks its preview and API content, sends a
190 KB signed upload to local object storage, compares the downloaded bytes,
and deletes the test files. It saves screenshots
under `.cache/native-e2e`. Chat uses the local development model. A separate local
socket fixture checks the real WebView/Rust text and binary bridge, cookie
isolation, close events, and service-change cancellation. It is not a Live model.
The fixture also checks an unconfigured storage port, missing API cookies on
storage requests, and revocation after switching services. File checks reject
changed upload URLs, methods, and byte counts before sending their contents.
The test uses a separate app settings directory. It can create the test account's
first organization and test Bots in the local database. It does not run an API
proxy or mock IPC. Socket fixture data stays separate from the local backend.
It also checks damaged settings at startup, blocked requests during recovery,
retry after file repair, and return to the default from unsupported settings.
The controlled email peer checks the shared form and invitation, bad/used codes,
admission errors, private checked cookies, cancellation, service changes, login
redirect rejection, and old resource revocation. It does not send real mail.

For real local email acceptance, run:

```sh
devenv --profile test shell -- pnpm mail:check
```

This includes the desktop checks, then starts the exact official backend's
production entry in a fresh test database. Its public API uses a local HTTPS
edge and its mail adapter sends to a local TLS receiver. A private one-day CA
is trusted only by the test processes. The native client must accept that CA
and reject a different issuer; normal certificate checks remain enabled.
The receiver accepts one test address and holds the message only in memory.
The check enters the real delivered code in the shared form, verifies the
account, and signs out through the first account screen. It checks that the
server session count goes from one to zero. Test servers and the test database
are removed at the end. Results and private logs are in `.cache/mail-e2e/run-*`.
This verifies local SMTP delivery; external mailbox delivery and mobile device
behavior still need separate acceptance.

See the plan for the current platform evidence and the remaining integration
work. There is no complete desktop/mobile product release yet.

For the shared React Live resource check:

```sh
devenv --profile test shell -- pnpm live:check
```

This starts the shared UI's own Vite server, mounts its real Live hook in
Chromium, and controls test audio/socket resources. It checks chat/organization
changes, delayed microphone grants, duplicate readiness, pause/page hide,
resume, and stale audio errors. The test removes its temporary UI fixtures and
stops the server. It proves component cleanup, not a real Live provider or an
OS microphone permission flow. Results go under `.cache/lifecycle-e2e`.
Set `OPENBOT_UI_CHECKOUT` when testing a UI worktree other than `../openbot-ui`.

For the packaged desktop browser flow on Linux:

```sh
devenv --profile test shell -- pnpm browser:check
```

This uses a private default-browser handler and Chromium profile, the actual
packaged WebKit app, a throwaway PostgreSQL server, and a local HTTPS OIDC
authorization fixture. It does not change browser associations, trust stores,
the running development service, or the user keyring. Native TLS trusts only
the test's private CA; the controlled Chromium context allows that test
issuer. Set `OPENBOT_NATIVE_AUTH_WORKTREE` to the backend source with the native
API (the default is `../.worktrees/openbot-native-auth`). The check proves
cancel/retry, denial, wrong state, stale document refusal, private session
exchange, and independent browser/native logout. Screenshots and a result
file go to a private `/tmp/openbot-browser-qa-*` directory. Mac/Windows browser
return and mobile cold/warm return still need target-host acceptance.


## Native CI

`.github/workflows/check.yml` defines Linux, macOS ARM64/Intel, Windows x64,
Android ARM64/x86_64, and an unsigned iOS simulator build. Linux and Android use
the pinned devenv profiles. Native Apple/Windows runners use `.node-version`,
`rust-toolchain.toml`, Corepack 0.36.0 and the package manager in `package.json`.
They build the same locked Web package. Windows does not require a Nix layer.

The workflow checks JavaScript and Rust and builds real debug artifacts.
macOS uses ad-hoc signing; Windows produces an unsigned debug NSIS installer.
The iOS job generates the Xcode project, builds an unsigned ARM64 simulator app
and checks its bundle ID, microphone text and callback scheme. These are build
checks, not device or store acceptance. The pinned CLI supports
`ios build --no-sign`; no Apple team is invented for this job.

Actions are pinned to full commits. Jobs have read-only repository permissions,
do not retain checkout credentials, and do not receive signing or private
package secrets. Outputs are short-lived debug artifacts; no release is
published. The workflow is checked locally with actionlint. See
[GitHub Actions](https://github.com/openbot-build/openbot-one/actions) for
supported-host results; local Linux/Android evidence alone does not prove
the Apple/Windows builds.

To check an independent Linux source copy:

```sh
devenv shell -- pnpm clean:check
```

It copies only source files, starts with no `.env`, sibling UI or installed
JavaScript dependencies, then installs with the frozen lockfile, checks,
stages the real UI and builds a debug binary. Cargo compilation output is
shared as a cache; JavaScript installation and Web outputs start empty.
Results are kept in `.cache/clean-build/run */result.json`.


## Linux distribution packages

The Nix debug binary is a development artifact with a Nix loader and libraries.
For normal Linux desktop packages, use the isolated Ubuntu 22.04 baseline:

```sh
devenv shell -- pnpm linux:package
devenv shell -- pnpm linux:install:check
```

Docker must be available. The recipe pins its Ubuntu image digest, reads exact
Node/Rust versions from the repository and checks their official downloads.
The build uses the locked Web package without copying `.env`, installed host
dependencies or a sibling UI. It produces a debug `.deb` and AppImage under
`.cache/linux-packages`. `build.json` records hashes and the immutable built
image identity; `build-packages.txt` records installed build package versions.
The default service and public native client use the normal build environment.
These local debug packages are not a signed production release.

The install check runs as a separate user in disposable containers. Debian
installation uses its declared runtime dependencies, checks its launcher and
non-Nix loader, launches the real UI and signs in/out through the running local
backend. Removing the package must remove its executable while keeping marker
files in the app's config and data directories. This does not test account or
draft restoration. No package is installed on the host.

The Deb requires WebKitGTK 2.40 or newer. Its dependency check also tries the
actual Deb against old-version metadata in an isolated dpkg root and requires
rejection. The real UI checks use the installed engine version recorded in the
result. Test images take their payload from the immutable builder image in
`build.json`. Both formats must preserve all seven bundled notice assets.

The AppImage check has no system GTK or WebKit package. It supplies the usual
desktop font, X11, OpenGL/EGL/GLES and audio base libraries, and checks that the
bundled framework can show the same real UI and use private native login.
It uses extract-and-run without FUSE. A desktop without FUSE 2 can use the
same `APPIMAGE_EXTRACT_AND_RUN=1` mode. Physical graphics/audio hardware is
outside this container check. The test intentionally has no desktop keyring;
a memory-only sign-in and its visible warning are expected.

For isolated CI without a running backend:

```sh
devenv shell -- pnpm linux:install:check --fixture
```

This starts the existing controlled public-API peer inside each test container
with networking disabled. It proves package/UI/native transport behavior, not
the real server or an external identity provider. Both this mode and the real
local-backend mode passed. The workflow includes a separate Ubuntu-baseline
package job; Nix binary artifacts are named as development binaries.

Check an Android build from a fresh source copy with both ABIs:

```sh
devenv --profile android shell -- pnpm android:clean:check aarch64 x86_64
```

This starts without machine-generated Gradle files, JavaScript dependencies or
an existing Cargo target. It uses the pinned Web package, checks the signed
single-ABI outputs, and confirms MainActivity is in each APK's DEX.
No emulator or device is started. A source directory containing a space is
used to check build paths too.

The checked local copies from this source check are in
`.cache/clean-android-apks/`, with `verified.json` and `source-build.json`.
Earlier APK pairs are still in their original directories. Check the new pair:

```sh
devenv shell -- pnpm android:artifacts:check --manifest .cache/clean-android-apks/verified.json
```
