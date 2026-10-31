# Tauri desktop and mobile research

Checked: October 30, 2026 (Asia/Shanghai).

Status: research is complete for the first architecture decision. This document
records the starting evidence; current code and build progress are tracked in
the implementation plan and README. Recommendations
below are project decisions based on the linked sources; they are not all Tauri
requirements. The user chose `openbot-ui` as the shared Web app.

## Decision

Use stable Tauri 2 with one bundled React/Vite app from `openbot-ui`, a small
typed platform interface, and one Rust crate for desktop and mobile. Keep the
browser app working without Tauri. Keep business APIs in OpenBot. Add native
features only when a user flow needs them.

Tauri supports static frontends and recommends Vite for common SPA frameworks.
It does not provide a Node server or native SSR runtime. This fits the existing
UI. Bundling the UI is our choice for repeatable releases, local startup, and a
clear trust boundary. Tauri can also load remote URLs; that ability does not make
remote pages safe to grant native access.
[Frontend configuration](https://v2.tauri.app/start/frontend/).

Do not start with a remote website as the privileged app window. Do not copy the
React screens into this repository. Do not add a Node sidecar just to serve the
SPA. Do not move backend business logic into Rust merely because the app uses
Tauri. These choices keep the shared app and API as the source of product behavior.

## Version baseline

The official Tauri 2.12 announcement sets Rust MSRV to 1.90 and updates Android
project templates. Do not follow old Tauri 1 allowlist guides, old Android build
versions, or an old Rust 1.77 baseline.
[Tauri 2.12 announcement](https://v2.tauri.app/blog/tauri-2.12/).

Direct registry reads during this research returned these stable versions:

| Package | Version | Primary registry record |
| --- | --- | --- |
| Rust `tauri` | 2.12.5 | [crates.io](https://crates.io/api/v1/crates/tauri) |
| Rust `tauri-build` | 2.7.4 | [crates.io](https://crates.io/api/v1/crates/tauri-build) |
| JS `@tauri-apps/cli` | 2.12.4 | [npm](https://registry.npmjs.org/@tauri-apps%2fcli/latest) |
| JS `@tauri-apps/api` | 2.12.4 | [npm](https://registry.npmjs.org/@tauri-apps%2fapi/latest) |

These are dated observations, not a claim that every Tauri package shares one
version. Resolve compatible stable packages when implementation starts. Pin the
tested toolchain and direct JS versions. Commit `pnpm-lock.yaml` and
`src-tauri/Cargo.lock`; exclude build output. Build with locked dependencies.
[Source control](https://v2.tauri.app/develop/#source-control).

## Local findings

`openbot-one` has no tracked application files or commits at the start of this
work. It has a Git remote at `openbot-build/openbot-one` and no local `AGENTS.md`.
No files in the other repositories were changed for this research.

The initial UI checkout was clean at `43c91813ca35b37dc71691e2b4145709ff9c8baa`.
The table refers to that initial checkout. The sibling OpenBot checkout has existing
changes and is older than some API features used by the UI. Its client source
does not establish the behavior of the published client package.

| Evidence in sibling repositories | Effect on the native app |
| --- | --- |
| `openbot-ui/package.json`: React, Vite, React Router, Effect Atom; publishes `@openbot-build/web` with `dist` | Reuse the shared frontend and its package release path. No frontend framework migration is needed. |
| The Web package exports only `./package.json`; it ships built assets | It is not yet an importable React app with a platform bootstrap. Define that public integration seam in the UI repository first. |
| UI pins `@openbot-build/client` 0.1.2 from GitHub Packages | Inspect that exact release before designing a transport adapter. Do not import sibling private source files as a shortcut. |
| `openbot-ui/src/lib/api.ts`: `baseUrl` comes from `location.origin` | A bundled native origin will point API calls at the app, not the OpenBot server. |
| `openbot-ui/src/atoms/account.ts`: full-page sign-in redirects and relative cookie-based auth calls | Native sign-in, account lookup, and logout need an explicit adapter. |
| `openbot-ui/vite.config.ts`: development proxies `/v1`, `/auth`, `/health` and rewrites Origin | This works only in the dev server. It is not shipped in the static bundle. |
| `openbot-ui/src/hooks/use-live-talk.ts`: WebSocket address comes from the page origin | Native REST success alone will not make Live talk work. |
| `openbot-ui/src/lib/execution.ts`: execution observation through the client | Check authenticated streaming, cancellation, and resuming in the exact client release. |
| `openbot-ui/index.html`: viewport has no `viewport-fit=cover`; current source has no safe-area rules | Mobile layout needs work in the shared UI, followed by device checks. |
| `use-copy.ts`, `ui/code-block.tsx`, `Markdown.tsx`, `live-audio.ts` | Clipboard, external links, and microphone use need cross-platform verification and adapters where Web APIs are insufficient. |

The checked-out server contract in `openbot/packages/api/src/AuthApi.ts` has a
cookie-only `SessionAuth` for `/auth/session`, and accepts only local return
paths for browser sign-in. Ordinary operations also accept user bearer tokens.
This is evidence of an integration gap in the inspected checkout, not proof that
the latest published server lacks a native flow. Audit matching published
versions before changing the API. Do not confuse OpenBot's outbound OAuth for
connected Apps with login to OpenBot One.

Requests to GitHub Packages for `@openbot-build/web` and
`@openbot-build/client` returned HTTP 401 in this execution environment. The
published tarballs have therefore not been inspected. Package versions in the
UI manifest are source evidence only; they do not prove the contents of a
published release. Resolve registry access using the project's normal package
setup before the exact-package audit. Do not record credentials in this repo.

Follow-up audit: authenticated registry reads returned HTTP 403. Successful
GitHub Actions release artifacts remained accessible. The Web 0.1.5 tarball from
run `40883972367` and client 0.1.2 tarball from run `40731283376` were inspected.
The client tarball's SHA-512 also matches the UI lockfile; its contents could be
used to restore the locked local install from the package cache. This did not
restore registry permissions. The native runtime additions in the local UI are
new work and have not been published in either of those releases.

Later upstream check: UI main advanced to
`5362712082f3482173f9e3aee7be8bf75834a8e1`, with new account/admission/billing
screens, design rules, and client 0.1.5. The native integration now uses that
base in a separate worktree, keeping the earlier checkout intact. The matching
server v0.1.5 is `770126bda4c0cb5f737c42f54078ee9d67400d5d`. Its successful
official CI run `40875959543` produced the npm artifact `12900507595`.
The archive SHA-256 is
`dc21f9e2a52b943d44e833614cef1d7483a86174a4d7e3dd4e78736c11b5c4ce`.
Client 0.1.5's tarball SHA-512 matches the unchanged UI lockfile. Seeding the
package cache from that verified artifact allowed a frozen offline install;
registry access still returned 401. This does not establish registry access or
publish the added UI runtime. The new UI build, typecheck, 34 tests, packaged
Linux flow, and controlled Live lifecycle check pass against this version pair.

The user further specified that the app should start on the first-party service
without asking for a server address, while offering a configurable HTTPS server
in settings. Its public default origin comes from build environment configuration;
the production domain does not need to be chosen during this implementation.

## Shared UI and native ownership

`openbot-ui` owns screens, routing, design, account state, API use, and responsive
behavior. It should expose a documented bootstrap contract for API origin,
session lifecycle, stream transport, and platform actions. A native build entry
can use that contract; the browser entry supplies browser defaults.

`openbot-one` owns the Tauri project, native adapter, OS permissions, window
behavior, credentials, deep links, installers, and release jobs. It consumes an
exact version of the shared UI through a public package entry or a documented
native asset build. The choice of package entry must be proven with one packaged
vertical slice before adding a broad plugin set.

Use a single `src-tauri/src/lib.rs` `run()` entry with
`#[cfg_attr(mobile, tauri::mobile_entry_point)]`; desktop `main.rs` calls it.
The library builds for mobile and the binary for desktop. Use the official
generated project layout and check native project changes in deliberately.
[Project structure](https://v2.tauri.app/start/project-structure/).

Keep common settings in `tauri.conf.json`. Use platform overrides named
`tauri.linux.conf.json`, `tauri.windows.conf.json`, `tauri.macos.conf.json`,
`tauri.android.conf.json`, and `tauri.ios.conf.json` only where needed. Desktop
window options and plugins must not be assumed to work on mobile.
[Configuration files](https://v2.tauri.app/develop/configuration-files/).

## Native authentication is the first integration gate

Native browser contract preparation is in an isolated backend worktree,
`/home/edge/openbot/.worktrees/openbot-native-auth`, branch
`codex/native-browser-auth`, based on `a1fb2cd376af4de67120d5d1ae730e0c8c6e5e36`.
The released v0.1.5 API and that main-branch snapshot have browser SSO, but no
native browser handoff contract. A browser's Cookie is not a native login result.
The running local backend remains at its pinned v0.1.5 revision.

The prepared domain/API types use registered public client IDs, exact callback
matching, PKCE S256 fields, redacted secret values, and proof-bound cancel.
Only literal IPv4/IPv6 loopback callback ports may vary. HTTPS and private
reverse-DNS scheme callbacks otherwise match exactly. Remote HTTP, DNS names
for loopback, encoded paths, credentials, queries, fragments, and ambiguous
private-scheme authority forms are rejected. The API groups are mounted in the isolated backend feature branch. Native
clients remain disabled until an administrator registers their callback URLs.
The isolated backend now also has optional `nativeClients` platform settings,
with no clients enabled by default. Missing fields in existing settings still
mean disabled; a PATCH without the field keeps the list. A fresh lookup checks
the current list and issuer on each use. A generated additive migration creates
a separate native-attempt table without changing the running database.

The store keeps token/proof hashes and a caller-sealed payload. It binds one
browser, caps attempts at five minutes and codes at sixty seconds, and matches
the original issuer, client, callback, and S256 challenge at consumption. The
consumer locks the row and then checks the database clock in a fresh statement,
so waiting on a lock cannot extend the deadline. Atomic deletion lets only one
consumer or cancellation win. Cleanup is bounded to 1024 expired rows per pass.
Real PostgreSQL tests cover sixteen simultaneous consumers, wrong proofs,
browser takeover, late consumption after a lock wait, cancel/consume races,
expiration, and bounded cleanup. Separate SDK, provider callback, and HTTP tests
cover the full backend flow described below.

The private native-session primitive is now implemented with the pinned Better
Auth SDK's `createAuthEndpoint.serverOnly` and `setSessionCookie`. It creates a
fresh session rather than reusing the browser token, and its SDK endpoints have
no HTTP paths. It uses the ordinary account/provider checks and rejects a
changed sign-in configuration before returning the reply. `acquireUseRelease`
owns the fresh session through validation and the caller's use. A failed or
interrupted use revokes it; cleanup failures go to the sealed error store.

Real server/database tests prove distinct credentials, independent browser and
native sign-out, explicit native revocation, absence of the private HTTP routes,
unknown/suspended-user rejection, late issuer-change rejection, failed account
check cleanup, and cancellation while the SDK's session insert waits on a real
foreign-key row lock. Native OS return is a separate acceptance boundary.

The internal grant service now connects PKCE S256 to that primitive. It creates
32-byte random request IDs, browser proofs, and codes. Request/code/proof hashes
are stored; state, email, invitation, provider choice, and a sign-in-settings
fingerprint are sealed. Encryption is bound to request hash, issuer, client,
exact actual callback, and S256 challenge. A copied ciphertext is rejected.
Wrong proof keeps the code usable; a valid exchange consumes it once. It checks
the current client and settings before and after use of the new session. A late
client removal or failed use revokes that session. Eight parallel high-level
exchanges produce one session and one reply in the real-server test.

The completion entry point now requires the actual signed browser credential.
It resolves the SDK session and matches its token hash to this exact request.
The private start call uses the SDK's protected OAuth server context. Public
web `additionalData` cannot set the native flag. After verified OIDC claims and
account checks, the awaited session-create hook binds the fresh token hash
before inserting a browser session. This is an additive nullable column in a
new generated migration, not a change to the existing migration.

Real OIDC callback tests reject old/cross-request cookies, forged flat and
nested server-context input, replay, cancelled or expired flows, and expiry
during a real row-lock wait. The normal flow and PKCE exchange tests now use
this callback path instead of supplying a trusted user ID.

The public HTTP flow is implemented in the feature branch. A start reply opens
the service's authorize URL. That endpoint issues a unique host-only Secure,
HttpOnly, SameSite=Lax proof Cookie for the attempt and starts fresh OIDC
authentication. Finish checks the proof and exact verified browser session,
then returns only code, state, and issuer to the registered callback. Exchange
returns an empty 204 response with a new signed private session Cookie, after
all current-client and account checks. POSTs require the selected service's
Origin. Every reply uses no-store and no-referrer. Start/authorize each allow
10 requests per minute per remote address; other routes each allow 60. Rate
errors include Retry-After: 60. A scoped cleanup task starts with the HTTP layer
and sweeps once per minute, at most 1024 rows per pass.

HTTP acceptance proves the complete controlled OIDC flow, independent
browser/native logout, Origin rejection, proof requirements, wrong verifier,
replay, cancellation, rate limiting, startup cleanup after restart, and no
private values in success/failure trace attributes or public error bodies.
The HTTP logger already omits query strings; trace policy also redacts private
query fields, Cookie headers, and redirect locations, including 503 responses.
External proxy logs need the same protection.

Native code must still retain its verifier, validate issuer/state, and support
the actual OS return paths before the feature can ship. The running local
v0.1.5 service has not been changed and the preserved APKs do not yet have
company SSO.
The complete backend workspace builds and typechecks; 171 files / 1052 tests
pass. Provider and account refusal now return through a private browser-proof
check and emit only access_denied, state, and issuer. The route cannot end a
flow that has already issued a code. The normal browser error behavior is
preserved outside this native route.

The native Rust protocol/HTTP foundation is implemented separately. It uses
32-byte OS random verifier/state, S256, constant-time state checks, exact
callback/issuer matching, strict query keys, one-use return/exchange state,
bounded pending-record restore, native no-redirect HTTP, and fresh-session
cleanup. It reuses the existing account validation and fenced credential
publication. The suite passes with 51 tests and two existing explicit-host
checks ignored; Linux all-target Clippy passes. Desktop now owns a temporary
IP loopback listener and system browser invocation through a two-stage,
single-flight operation lease. Host, method, path, state and issuer checks run
before exchange; cancellation and generation changes end the old flow.
The shared UI exposes company sign-in and cancellation only when the shell
provides the optional browser action. The current local default still uses
development login.

Packaged Linux acceptance uses a private OS browser handler and Chromium
profile, actual OIDC SDK callbacks, throwaway PostgreSQL and private TLS.
The provider authorization endpoint runs locally; no external IdP is used.
Mobile warm return and cold-process recovery now use the same native parser,
exchange and account commit. The new APKs are preserved separately from the
previous baseline. Android device acceptance, iOS builds/devices and
Mac/Windows host acceptance remain open.

The pinned official deep-link plugin 2.6.3 emits incoming URLs through
`deep-link://new-url`; a Rust listener alone does not make them private.
Mobile capabilities explicitly deny general event listen/unlisten and the
plugin's raw URL commands. Only a typed origin/document-bound Channel carries
a return notice. The frontend receives no URL or code. Tests use Tauri's actual
ACL resolver for Android and iOS, including ungranted camel-case/native-only
fallback commands. The mobile native fallback in Tauri 2.12.5 runs only after
the same command ACL check.

Pending proofs are purpose-separated OS credentials with a random local restore
fence. Save and publication complete before the system browser opens. Explicit
cancel, settings/authentication changes and a same-process document reload
synchronously disable recovery. Initial app launch preserves a proof from the
old process; restoration checks the selected origin, public client, exact
callback and deadline. Wrong callbacks cannot consume it. A valid return
deletes the OS entry before exchange, and a lost reply is never retried.
No detached task owns an exchange. These native checks and compiled manifests
do not replace cold/warm OS delivery on devices.
[Official plugin source](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/deep-link/src/lib.rs).
[Native app browser flow](https://www.rfc-editor.org/info/rfc8252/),
[PKCE](https://www.rfc-editor.org/info/rfc7636/),
[OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html).

The third-party `tauri-plugin-better-auth` 0.1.1 documents a desktop browser/PKCE
flow with native transport and OS storage. Its server plugin is still required,
and its documented setup does not prove the mobile paths or this API contract.
It has not been added to the app. The current per-service native transport and
vault stay in place while the missing public server contract is prepared.
[Plugin's own documentation](https://docs.rs/tauri-plugin-better-auth/0.1.1/tauri_plugin_better_auth/).

Current first-party email path: published client/server 0.1.5 has
`GET /auth/options`, `POST /auth/email/send`, and `POST /auth/email/verify`.
The server binds the challenge to its origin, email, invitation, and five-minute
lifetime, rate-limits attempts, applies account admission, and consumes the code.
The shared UI can use these existing contracts in native mode. Rust accepts a
cookie only from a 204 verify response, requires the private host-only cookie
attributes, checks `/auth/session`, and commits it only if the selected service
and login generation are unchanged. Other API responses cannot establish a
session. Desktop company SSO uses the native browser flow above; mobile return\nis pending. Native OS credential storage
and its target acceptance are described below.
See the pinned server's
[email contract](https://github.com/openbot-build/openbot/blob/770126bda4c0cb5f737c42f54078ee9d67400d5d/packages/api/src/AccessApi.ts)
and [handler](https://github.com/openbot-build/openbot/blob/770126bda4c0cb5f737c42f54078ee9d67400d5d/packages/openbot/src/auth/BetterAuth.ts).

The official production authentication configuration requires an HTTPS public
origin, including on loopback. The explicit development entry is the only
HTTP exception. Local mail acceptance therefore uses a TLS edge in front of the
unchanged official HTTP server, with the selected HTTPS Origin and cookies
passed through unchanged. A private CA is scoped to the test processes; Linux
loads it through `SSL_CERT_FILE`, and the Node server through
`NODE_EXTRA_CA_CERTS`. The test also rejects an untrusted issuer. The real SMTP
adapter, email template, code check, native cookie check, and shared sign-out
pass in that local deployment. This does not establish external mailbox delivery.

Treat the app as a public native client. A client secret embedded in an app is
not private. For OAuth/company SSO, use the system browser or a platform
authentication session, an authorization code, PKCE S256, and exact redirect validation. Bind
each callback to the pending login with state; validate OIDC nonce when OIDC is
used. Do not collect identity-provider passwords in the app WebView.
[RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252).

Prefer `ASWebAuthenticationSession` on Apple platforms and a browser Custom Tab
on Android when the selected integration supports them. A Swift/Kotlin plugin
may be needed: Tauri deep linking and URL opening alone do not implement a
complete authentication session. Apple documents a system-managed session and
its callback delivery.
[Apple authentication sessions](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession).

The target flow is:

1. Rust starts a login attempt, keeps the verifier and state, and opens a trusted
   HTTPS authorization endpoint.
2. The browser signs the user in. OpenBot returns a short-lived, single-use code
   to a registered app callback.
3. Rust validates the callback and exchanges the code plus verifier with OpenBot.
4. The app restores account and organization state using a native session API.
5. Refresh and logout use explicit server contracts. Logout clears local
   credentials even when the network is down and reports remote revocation state.

This is a proposed flow, not an endpoint already verified in OpenBot. Use a
maintained standards implementation on the server; do not build a new OAuth
server from a few route handlers. The required contracts include native client
registration, callback rules, account lookup, refresh/revocation, organization
scope, and real-time authorization. Keep browser Cookie and CSRF behavior
working. A manually pasted long-lived user token is not a replacement for login.

Keep refresh credentials and PKCE verifiers in Rust. Use short-lived access
credentials and the smallest useful native interface. Prefer native transport
when it avoids exposing long-lived credentials to JavaScript. If a short-lived
access token must enter WebView memory, document that boundary and never persist
it in local storage. Apply refresh rotation or sender binding as required for
public clients by OAuth security guidance.
[RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700).

Choose and verify credential storage on all five targets. OS stores are the
preferred candidate; availability, locked-store behavior, and Linux fallback
must be explicit. Stronghold is another candidate, but its encryption still
needs a safe unlock-key design. Do not copy the example's hard-coded password
into an app. Plain JSON preference storage is not a credential vault.

The implementation now links Keyring Core 1.0.1 directly to platform stores,
following its advice to select only the needed backends. No keyring read/write
plugin permissions are granted to the WebView. Pins: Secret Service store
1.0.1, Apple native store 1.0.2, Windows native store 1.1.0, and Android native
store 1.0.0. Linux uses encrypted D-Bus sessions; Windows requests Local
persistence; macOS uses the login Keychain; iOS requests the local protected
store with WhenUnlockedThisDeviceOnly; Android uses its named Keystore and
encrypted SharedPreferences store. This does not promise hardware backing.
[Keyring integration guidance](https://docs.rs/keyring/4.2.0/keyring/),
[Secret Service](https://docs.rs/dbus-secret-service-keyring-store/1.0.1/dbus_secret_service_keyring_store/),
[Apple](https://docs.rs/apple-native-keyring-store/1.0.2/apple_native_keyring_store/),
[Windows](https://docs.rs/windows-native-keyring-store/1.1.0/windows_native_keyring_store/),
[Android](https://docs.rs/android-native-keyring-store/1.0.0/android_native_keyring_store/).

A single native worker serializes OS calls, with a bounded queue and a ten-second
wait. Serialized credential buffers are zeroized on drop. The app config folder
has only a versioned index of random IDs and flags. An inactive index is written
before staging an OS value. The current origin, account, generation, and index
ID must still agree before publication. Timed-out writes cannot publish their
own IDs. Logout blocks restoration before deletion, and pending deletion can
be retried. Startup verifies a saved cookie and its account with the server;
rejected credentials are removed, while network failure keeps them private for
a later retry. A failed write does not cause a plain-file fallback.

Linux acceptance passes with a private D-Bus session and fresh encrypted GNOME
keyring, including the real mail flow, cold process restoration, and a signed-out
restart. Android builds alone do not prove the device store; Apple and Windows
still require target-host acceptance. The Android backup rules exclude the
named encrypted preferences from cloud backup and Android device transfer.
Cross-platform transfer is not configured.
[Android backup rules](https://developer.android.com/identity/data/autobackup).
[Stronghold](https://v2.tauri.app/plugin/stronghold/).

## API, files, and real-time connections

Configure the API server separately from the frontend origin. Use the public
typed client and an explicit transport seam. Two valid options need a small
proof against the actual client release:

| Option | Requirements and tradeoff |
| --- | --- |
| WebView fetch with short-lived native access tokens | Server must explicitly support the real platform origins, bearer auth, CORS/preflight, streaming, and upload hosts. Avoid credentialed cross-site cookies. |
| Scoped native HTTP transport | Can keep credentials in Rust and avoid browser CORS. Must preserve cancellation, errors, multipart uploads, binary data, redirects, and streaming backpressure. It is more work than replacing `fetch`. |

The official HTTP plugin is an available transport, with scoped URL access. It
does not create a native login session or make existing cookie flows portable.
Start with the least powerful transport that passes the real flows. Never add
an arbitrary authenticated URL proxy, wildcard host scope, or unrestricted
redirects that can send credentials to another host.
[HTTP client plugin](https://v2.tauri.app/plugin/http-client/).

Browser WebSockets cannot set an arbitrary Authorization header. Verify the
server's supported native WebSocket authentication; candidates are a scoped
native socket transport or a short-lived single-use connection ticket. Do not
put persistent bearer tokens in URLs. Check REST, streamed execution events,
Live audio, signed uploads, downloads, and remote images separately. Cancel
old requests and streams on logout or an organization change.

Treat resume after backgrounding as a reconnect. Restore saved state, then
resume from server sequence/cursor data where supported. Do not replay an
uncertain message or tool action. Mobile operating systems may suspend the app;
an open socket does not promise continuous background execution.

## Security defaults

The implemented Live transport uses a small Rust wrapper over
[tokio-tungstenite](https://docs.rs/tokio-tungstenite/0.30.0/tokio_tungstenite/).
Unlike a general WebSocket command exposed to JavaScript, it adds the private
session cookie inside Rust, permits only the selected service's Live route,
and rejects URL credentials, token queries, and redirects. TLS uses the same
platform certificate verifier as HTTP. Pull-based binary IPC bounds inbound
data; the JavaScript send queue and native frame size are bounded too. Service
changes, logout, and a fresh runtime cancel old connections. This proves a
transport boundary; it does not prove microphone behavior on each OS.

Origin checks alone do not distinguish successive accounts on one service.
The native adapter now captures a non-secret runtime ID once per document.
New HTTP/socket work, authentication, and settings check both origin and ID.
An account commit, service change, or reload retires it. Request/socket handles
retain their original native context. Cleanup removes only older generations,
including signed upload grants; delayed old work cannot prune or replace newer
grants. The packaged Linux check rejects stale actions without another request
reaching its controlled peer, then reloads and checks the current account.
This ID prevents accidental stale work; it is not a credential or an XSS defense.

Implementation update: the current development default is the local backend
at `http://localhost:19380`, per the user's latest choice. The earlier online
Access setup is paused. Debug builds accept loopback HTTP; release builds
still require HTTPS. Service selection is persisted without session secrets.
Development sessions live only in Rust memory, with origin and account scopes.
The production external-browser and secure-storage work below remains required.

Use separate capability files with exact window labels and platform lists.
Explicitly list enabled capabilities in app configuration. Start with no
unneeded OS actions. Grant only the required commands and scopes; avoid broad
`core:default`, shell execution, file access, and window creation without a
feature that needs them.

Important exception: registered application commands are allowed by default
unless their names enter the app permission manifest. Use
`tauri_build::AppManifest::commands` and explicit permissions for custom commands.
Do not assume plugin default-deny behavior automatically protects custom Rust
commands. Remote pages receive no IPC capabilities. Linux and Android cannot
distinguish an iframe from its parent for some remote-origin checks.
[Capabilities](https://v2.tauri.app/security/capabilities/).

Set production CSP explicitly. Start with self-hosted assets, no remote scripts,
no script `unsafe-eval`, no objects, and no unneeded frames. Allow only the
actual IPC and API origins and required image, media, font, worker, and upload
sources. Preserve Tauri's automatic script hashes/nonces. Check the UI's inline
theme bootstrap and styles against the actual production build. A development
CSP may permit HMR without widening production policy.
[Content Security Policy](https://v2.tauri.app/security/csp/).

Guard navigation and new windows in Rust. Keep internal routes on the bundled
origin; route validated external HTTPS links to the system browser. Reject
unknown protocols, malformed links, and URLs with user information. Put
user-provided or third-party app content in a separately restricted surface.
Opening a URL must not turn a remote page into the privileged main window.
[Navigation callbacks](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html).

Native Rust code and plugins have OS access; capability files do not sandbox
them. Validate command arguments, paths, redirects, and account scope inside
Rust. Redact tokens, cookies, authorization codes, and user content in logs.
Keep blocking work off the UI thread.
[Security boundaries](https://v2.tauri.app/security/).

Keep the default asset protocol. The official localhost plugin warns about
added security risk. Starting a local HTTP server does not make a remote
OpenBot session same-origin, so it is not the default cookie workaround.
[Localhost plugin](https://v2.tauri.app/plugin/localhost/).

## Deep links and desktop behavior

Handle both cold-start links and links delivered to a running app. Subscribe
before processing the initial URL and deduplicate delivery. Parse links with a
URL parser. Validate scheme, host, path, parameter cardinality, size, login
state, and one-time use. A link is input, not proof of authentication.

Prefer verified HTTPS App Links/Universal Links on mobile when the domain is
controlled. These need hosted association files and signing identities; a
Tauri config alone is insufficient. A reverse-domain custom scheme is a
fallback and still needs PKCE. On desktop, conditionally register the single
instance plugin first when combining it with deep links.
[Deep linking](https://v2.tauri.app/plugin/deep-linking/).

Use normal OS window decorations initially. Add window-state restore with
off-screen recovery, keyboard shortcuts, file dialogs, and notifications only
as needed. Keep desktop-only plugins behind target dependencies, Rust cfgs,
and desktop capabilities. A close button should not silently enable a background
agent product; define close/quit behavior when adding a tray.

## Mobile is a product target

Android Rust TLS needs more than a compiled crate. The selected platform
verifier requires its matching Kotlin support package and one-time JVM/context
initialization before certificate verification. Read the Kotlin version from
Cargo.lock, keep its JNI classes through ProGuard, and initialize before Tauri
starts network work. The app uses this for both HTTP and WebSocket trust.
The custom Maven repository is restricted to the verifier's exact module.
[rustls platform verifier Android setup](https://github.com/rustls/rustls-platform-verifier#android).

Keep the shared design rules from `openbot-ui`. Add safe-area support, a dynamic
viewport layout, and keyboard-aware composer sizing there. Avoid applying both
native insets and CSS insets to the same edge. Android WebView inset and IME
behavior varies by WebView version. Test the oldest supported engine as well as
the current one; do not treat Chromium desktop emulation as an Android check.
[Android WebView insets](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets).

Define Android back behavior in order: dismiss keyboard or modal, close a
drawer, go back in app history, then use the platform's root behavior. Test iOS
gestures and text selection. Preserve drafts across activity/app recreation.
The adapter uses Tauri's Android `onBackButtonPress`; registering it takes over
the platform fallback, so it must handle both history and root exit. The shared
UI closes dialogs through Base UI's `actionsRef.close()` action, preserving
controlled state and focus restoration. These APIs do not establish device
acceptance by themselves.
[Tauri app API](https://v2.tauri.app/reference/javascript/api/namespaceapp/#onbackbuttonpress),
[Base UI Dialog](https://base-ui.com/react/components/dialog).
Check VoiceOver, TalkBack, font scaling, focus, touch targets, landscape, and
screen reader announcements for streamed messages.

Live talk requires OS microphone permission and the correct WebView media
handling, not just `getUserMedia`. Provide permission-denied and unavailable
states. Stop recording when leaving the session or when the app is suspended
unless a supported background audio feature is deliberately implemented.

Implementation: the capture worklet is a separate local Vite asset, with
`?no-inline`, so the native CSP needs no Blob script access. A microphone-only
permission policy checks the local main view and native account. Linux uses an
asynchronous GTK dialog because its default permission handling denies access;
other targets retain their OS/browser prompt. A late GTK response is checked
against the account/document generation. Apple microphone usage text and the
macOS audio-input entitlement are declared. GStreamer base/good plugins are
provided in the Linux shell, and AppImage media framework bundling is enabled.
[Vite asset handling](https://vite.dev/guide/assets.html),
[Tauri permission handler](https://docs.rs/tauri/2.12.5/tauri/struct.Builder.html#method.on_permission_request),
[Apple microphone description](https://developer.apple.com/documentation/bundleresources/information-property-list/nsmicrophoneusagedescription),
[Apple audio input entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input),
[AppImage media framework](https://v2.tauri.app/distribute/appimage/#multimedia-support-via-gstreamer).

The packaged Linux media check starts the ordinary app and uses the loopback
WebKit Inspector. WebDriver was rejected for consent acceptance after its
automation mode granted capture without invoking the app handler. The test
proves a real GTK deny/allow flow and rejects late approval after sign-out. A
private synthetic PulseAudio source passes through the actual shared worklet,
native authenticated binary sockets, and a private output monitor. PCM format,
resampled frequency, playback samples, and track/context cleanup pass. It does
not prove human voice processing, a real Live model, or phone interruptions.
[WebKit automation permission path](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/UserMediaPermissionRequestManagerProxy.cpp),
[WebKit Inspector environment](https://trac.webkit.org/wiki/EnvironmentVariables).

Tauri's mobile `WindowEvent::Suspended` maps to Android `onPause` and iOS
`applicationWillResignActive`. Handle it in Rust as well as in the shared UI:
native socket cancellation must not depend on JavaScript running in the
background. Send only activity state through the local runtime event boundary.
Resume may re-enable a new connection, but must not create one or replay audio.
The Web microphone API does not take an AbortSignal. Check cancellation after
a pending grant resolves and stop the returned tracks before loading worklets.
Abort should also stop tracks while an async worklet load is still pending.
[Tauri mobile WindowEvent source](https://docs.rs/tauri/latest/src/tauri/app.rs.html),
[Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/#dom-mediadevices-getusermedia).
Local notifications and mobile remote push are different features; select push
infrastructure only if the product needs it.

## Development and release

Use the Vite/Tauri hooks with a fixed port, `strictPort: true`,
`clearScreen: false`, and no Rust output watch loop. Honor `TAURI_DEV_HOST` for
physical devices and configure HMR for a reachable host. `localhost` on a phone
is not the development computer. Isolate development networking and cleartext
exceptions from production.
[Vite integration](https://v2.tauri.app/start/frontend/vite/).

The current execution host is Linux with Nix/devenv. Node is on PATH; Cargo and
pnpm are not on the host PATH. Provide the project tools through a reproducible
shell, following adjacent projects' development approach. Android also needs a
JDK, SDK, NDK, and Rust targets. iOS requires macOS and full Xcode; Linux cannot
validate an iOS build.
[Prerequisites](https://v2.tauri.app/start/prerequisites/).

| Target | Build and distribution path |
| --- | --- |
| Windows | Windows runner, MSVC/WebView2; signed installer; defined per-user install and upgrade behavior. |
| macOS | macOS runner, supported CPU targets; signed and notarized app/DMG for direct distribution. |
| Linux | Deliberate older build baseline for runtime compatibility; AppImage/deb as required; WebKitGTK runtime checks. |
| Android | Pinned SDK/NDK/JDK; debug APK for device work, signed AAB for Play; separate upload credentials. |
| iOS | macOS/Xcode; stable Bundle ID, team, entitlements, provisioning, signed archive, TestFlight/App Store. |

Use a CI matrix and build each target on its supported host. Pin third-party
actions to reviewed commit SHAs, keep permissions small, and keep signing
secrets out of pull request jobs. Record UI/client/native versions in each
artifact. Build checks should work without release signing secrets.
[Tauri GitHub pipelines](https://v2.tauri.app/distribute/pipelines/github/).

For direct desktop distribution, plan signed Tauri updater artifacts with an
embedded public key and protected private signing key. OS code signing and
updater signatures serve different purposes. Use HTTPS update metadata and
reject a bad signature. Mobile releases follow their store/distribution path;
do not assume the desktop updater is the mobile release mechanism.
[Updater](https://v2.tauri.app/plugin/updater/).

Apple and Google require their own signing and store setup. A working WebView
build is not a store-ready app. Apple review guideline 4.2 expects meaningful
app value beyond repackaging a website; choose useful native flows and prove
their quality, rather than adding empty native features. Review account,
privacy, and microphone declarations against the final feature set.
[Apple distribution](https://v2.tauri.app/distribute/app-store/),
[Google Play distribution](https://v2.tauri.app/distribute/google-play/),
[Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/).

## Verification

Keep browser tests in the shared UI. Add tests for the actual native boundaries:
rejected callbacks, wrong PKCE/state, replay, credential storage failure,
transport redirects, IPC permissions, external navigation, and cancellation.
Test packaged assets as well as the Vite server; dev proxies can hide broken
production origin handling.

Current official guidance recommends WebdriverIO with `@wdio/tauri-service`.
Its embedded driver supports Windows, Linux, and macOS; the traditional
`tauri-driver` route supports Windows/Linux, with other macOS options described
separately. Do not repeat the old blanket claim that Tauri cannot automate macOS.
Any embedded automation server must be absent from production builds. Browser
mode and mocked IPC tests do not prove OS integration.
[Tauri WebDriver testing](https://v2.tauri.app/develop/tests/webdriver/).

Run Android/iOS emulator or simulator checks and physical-device checks for
login return, cold/warm links, keyboard, microphone, permissions, backgrounding,
and interrupted networks. Track each platform separately. Compilation, tests,
device use, signing, and store acceptance are distinct results.

See the [implementation plan](implementation-plan.md) for the next work and
the acceptance gates. No native build or end-to-end login is claimed by this
research.


## Supported-host build checks

Native builds must run on their target hosts. The workflow separates debug
build artifacts from signed distribution, keeps repository permissions at
read-only, pins action commits and uses no signing secrets on pull requests.
macOS debug apps use ad-hoc signing. An unsigned iOS simulator artifact does
not prove device credentials or App Store readiness.
[Tauri GitHub pipeline](https://v2.tauri.app/distribute/pipelines/github/),
[GitHub secure workflow use](https://docs.github.com/en/actions/reference/security/secure-use).

The pinned CLI 2.12.4 source has `ios build --no-sign` and a simulator export
path, even though the online CLI reference omits some newer options. Its iOS
configuration warns about missing signing teams but does not invent one.
Use the pinned source when checking CI flags.
[Pinned iOS build source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-cli/src/mobile/ios/build.rs),
[Pinned iOS configuration](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-cli/src/mobile/ios/mod.rs).

Rustup reads the repository toolchain file; native runners should report the
active version. Node reads `.node-version` in setup-node, and Corepack uses the
pinned pnpm declaration. Linux/Android keep the existing Nix toolchain and
SDK/NDK profiles.
[Rustup toolchain file](https://rust-lang.github.io/rustup/overrides.html#the-toolchain-file).


## Linux package baseline

A native binary built in the Nix shell uses its Nix interpreter and newer glibc.
It is useful for developer checks but is not a portable Debian/AppImage result.
The separate Docker recipe uses Ubuntu 22.04, a documented Tauri v2 baseline,
so the app does not accidentally require the host's newer glibc. The AppImage
media framework option is checked in an Ubuntu build, as official guidance
requires. Standard desktop font and graphics libraries are still part of the
runtime baseline; the AppImage check deliberately excludes system GTK/WebKit.
[Tauri AppImage baseline and media guidance](https://v2.tauri.app/distribute/appimage/).

Package checks must launch the installed executable. Archive creation alone
does not prove an app can load its WebKit subprocesses or bundled assets.
Local checks cover a real WebView, default service, checked private native
session, empty document cookies, sign-out, launcher validation, and Debian
removal with test user data retained. CI also uses a network-isolated controlled
peer and labels that scope separately. FUSE, physical graphics/audio devices
and a full desktop Secret Service remain separate runtime inputs.

### Match native OS floors to the actual Web bundle

The checked Vite 8.3.4 package defines its default production targets as
Chrome 111, Edge 111, Firefox 114, Safari 16.4 and iOS 16.4. The native adapter
already builds for Safari 16.4 and Chrome 111. Vite handles syntax transforms;
it does not provide all missing browser APIs. See the
[Vite production compatibility guide](https://vite.dev/guide/build).

The pinned tauri-utils 2.10.2 defaults are macOS 10.13 and iOS 15.0.
Leaving those defaults would advertise native installation on systems older
than the Web asset baseline. The app now declares macOS 13.3 and iOS 16.4
as conservative packaging floors for this checked Web bundle. Tauri's
[WebView version table](https://v2.tauri.app/reference/webview-versions/)
maps macOS 13.3 to Safari/WebKit 16.4. WebKit's
[16.4 release article](https://webkit.org/blog/13966/webkit-features-in-safari-16-4/)
also describes its iOS/iPadOS 16.4 release.

This uses the system WKWebView baseline, not a separately installed browser
as a promise that an older OS works. A later release can raise these floors
based on the supported-device policy. Lowering them requires a compatible Web
build and actual testing.

The supported-host workflow checks LSMinimumSystemVersion in the built macOS
app and MinimumOSVersion in the built iOS simulator app before archiving.
Linux can validate the configuration and its own native build, but cannot
supply those Apple bundle or runtime results. Those jobs still await the
pending first-public-push approval. The source change does not rebuild the
saved APKs.

Android still depends on the selected system WebView provider, rather than
only the OS API level. A modern provider is needed for the Chromium 111 Web
baseline; the current minSdk 24 alone does not establish that browser version.
The saved Android check and device acceptance remain separate from an APK
signature or build result.

### Windows runtime floor and independent Android source

The Windows bundle now declares `minimumWebview2Version: 111.0.0.0`.
This is a comparison floor for the installed WebView2 runtime, not a fixed
runtime download version. The pinned Tauri configuration supports asking
the installer to update an older runtime. See
[Windows configuration](https://v2.tauri.app/reference/config/#windowsconfig).
The configuration parsed and built in the Android checks; Windows installer
execution still needs its supported host.

A fresh Android source build is needed in addition to a build in a prepared
workspace. Git ignore rules must not hide application package paths, and Rust
code generation must complete before Kotlin/Java compilation. Generated files
from a prior build can hide both source and task-order errors.

Artifact upload also has its own file-selection rules. The pinned
[upload-artifact action](https://github.com/actions/upload-artifact) excludes
hidden paths by default. The workflow enables hidden-file handling only with
specific build-output paths, rather than uploading `.cache` as a whole.

### Linux dependency version floor

The checked Linux binary imports `webkit_uri_scheme_request_get_http_body`.
The Tauri runtime enables Wry's `linux-body` feature, which requires
webkit2gtk `v2_40`. The upstream
[WebKit implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/glib/WebKitURISchemeRequest.cpp)
documents that request-body API as available since 2.40.

The previous Deb only named `libwebkit2gtk-4.1-0` without a version.
The app now adds `libwebkit2gtk-4.1-0 (>= 2.40)`. Tauri also adds its ordinary
platform dependencies; dpkg must satisfy the versioned requirement as well.

A check installs the actual package into an isolated dpkg root whose status
fixture declares WebKit 2.38.6. Configuration must fail on the declared 2.40
requirement. This tests the package dependency policy, not execution of an
old WebKit library. The separate native UI test uses Ubuntu's actual
2.50.4-0ubuntu0.22.04.1 runtime. The 2.40 engine itself was not runtime-tested.

The rebuilt AppImage runs without system GTK/WebKit. Both package formats
read all seven notice assets through their native protocol. For Rust HTML,
all rendered notice bodies are hashed after normal HTML parsing. This avoids
sending a large reference document through the Inspector connection.

Test image payloads are selected from the exact builder identity recorded
with the artifacts. The install checks no longer rely on the mutable latest
builder tag. Prior Linux debug packages are retained under
`.cache/linux-packages-before-webkit-floor`.
