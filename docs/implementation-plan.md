# OpenBot One implementation plan

> Implementation record: the checkpoints below describe work done before the
> first source push. Earlier references to pending publication are historical.
> Current supported-host build results are available in
> [GitHub Actions](https://github.com/openbot-build/openbot-one/actions).
> Debug artifacts do not establish signed-release or physical-device acceptance.

Date: October 30, 2026. Source UI: `openbot-ui`, confirmed by the user.

This is the work plan after the [Tauri research](tauri-research.md).
Research and the first implementation pass are complete. The unchecked items
below remain required work, not existing features. A successful build with a
test adapter does not establish a working native login.

The user has paused the online Cloudflare Access setup. Current development
uses `http://localhost:19380` and a pinned isolated backend checkout. HTTP and
test-account sign-in are limited to debug builds on loopback origins.

## Current evidence

- The shared UI has a public version 1 runtime module, declarations, and asset
  manifest. Its API Atom uses the injected native transport and explicit origin.
  Login, logout, Live sockets, clipboard, and external links have native entry
  points. Browser behavior remains the default.
- UI build/typecheck and 34 tests pass on the current integration worktree.
  Seven package release tests also pass, and a local tarball was built.
  A local package tarball includes the public runtime entry and can be staged
  without importing source files. The new entry is not yet published.
- The shell has locked Node/pnpm/Rust/Tauri inputs, platform tool profiles,
  strict asset staging, CSP, scoped main-window capabilities, navigation guards,
  and a generated Android project. The native adapter has binary streaming IPC,
  bounded upload chunks, pull-based response reads, cancellation, and redirect
  rejection. Linux compilation and Clippy pass.
- A Linux desktop debug executable and Android ARM64 debug APK were built with
  the real native adapter. Tauri embeds assets in the native library. These
  are development artifacts, not releases or physical-device evidence.
- Browser integration checks at 1365x900 and 390x844 verify the shared page,
  adapter login dispatch, visible failure, button recovery, and no page errors.
  These checks use a test adapter and do not prove an OS login/session.
- The default first-party origin is supplied by `OPENBOT_DEFAULT_API_ORIGIN` in
  `.env` or the build environment. The CLI validates it before native dev/build.
  The Rust service type normalizes selected HTTPS origins and prevents sending
  credentials to another origin or a non-API route. Service settings are
  reachable before login and on connection failures. Selection is saved with
  an atomic write. Sessions remain only in native memory, scoped by origin;
  UI organization state is scoped by service and account. Native credentials
  now use an OS store with a public, secret-free restore index.
- An explicit Rust integration test against the real local backend proves
  anonymous 401, development sign-in, authenticated session 200, and logout 401.
  The WebView receives no session cookie. The real Linux packaged WebView also
  reached organization setup through its sign-in button.
- The packaged Linux WebDriver check passes service-address validation,
  failed-service recovery, native development login, authenticated REST, and
  organization setup and logout. It uses the real adapter and backend, without mocked IPC.
  Desktop click checks use a 96 DPI virtual display; the default Xvfb DPI caused
  WebKit to send pointer events above their target.
- The native adapter now opens authenticated Live WebSockets in Rust. Session
  cookies stay out of IPC and URLs. The selected origin and chat Live route are
  checked before connecting. Binary/text IPC has message and queue limits;
  old sockets stop on service change, logout, or WebView restart. Actual speech
  still needs a Live model and microphone/device acceptance.
- The packaged chat check creates a Bot, sends a message, and shows the local
  development model's response. It uses the shared typed client and execution
  stream through the native fetch bridge.
- A separate socket fixture in the packaged Linux check passes authenticated
  text and binary echo, a clean peer close, private-cookie isolation, and
  cancellation on service change. This fixture is not a Live model and does not
  establish microphone/audio behavior. The shell has 21 JavaScript boundary
  tests and 36 passing Rust tests; the explicit local session check also passed.
- The packaged file check passes the shared composer's image selection and
  preview, multipart API upload, API byte download, a 190 KB signed upload to
  the real local object store, exact download comparison, and test file deletion.
  The UI direct-upload fallback now uses native fetch, including cancellation
  and response cleanup. Rust verifies declared upload lengths and keeps API
  credentials out of object-store requests.
- Signed upload grants now come only from a successful authenticated response
  read by Rust at the selected service's upload endpoint. They permit the exact
  URL, PUT method, headers, and size until expiry, capped at 15 minutes. The
  packaged check proves an unconfigured storage destination, rejects changed
  URL/method/size requests, and proves old grants stop after service switches.
  There is no build-time storage-origin allowlist or JavaScript grant command.
- The supported-host workflow now covers Linux, macOS ARM64/Intel, Windows x64,
  both Android ABIs and an unsigned ARM64 iOS simulator build. It is linted but
  has not run on GitHub. The default source build consumes a frozen, provenanced
  local Web package dependency. A clean Linux source copy installs and builds
  without a sibling UI or private package token. Target-host/device results and
  production signing/release remain unverified.
- The shared UI now uses safe-area insets and visual viewport height for the
  main app, dialogs, and side sheets. Resize keeps field focus and pinch zoom
  keeps its normal behavior. The packaged Linux check also opens the service
  dialog in a narrow window, shrinks it, checks its bounds and focus, and
  restores the desktop size. This is not an Android keyboard check.
- Android Back has an optional runtime listener. Shared dialog, alert-dialog,
  and sheet roots register their own close actions in order. The native
  fallback goes through WebView history or finishes the activity. A boundary
  test checks nested dismissal and cleanup; physical Back remains unverified.
- The isolated API 36 emulator boots through software CPU emulation. This host
  has no KVM. The earlier x86_64 debug APK passed APK signature verification
  and installed successfully. The first app launch crashed with SIGTRAP in
  Android WebView 133's libmonochrome while creating the WebView. System UI
  also shows ANR dialogs. A plain Java Activity that creates a WebView and
  loads static HTML, without Tauri or Rust, reproduces SIGTRAP. This isolates
  a failure in this WebView test environment; its underlying cause remains
  unresolved. Both stacks have the same first libmonochrome offset `0x3d41e3d`
  in WebView `133.0.6943.137` (build ID
  `8adcf5dede4f0fdb7588d446d13e50840cf83aa8`). Android keyboard, Back, and
  sign-in acceptance have not passed.
  The minimal app and logs stay under `.cache/android-smoke` and
  `.cache/emulator`. A working Android device or accelerated host is needed
  for reliable acceptance evidence.
- Android TLS now includes the verifier's Kotlin component, with its version
  read from Cargo.lock. MainActivity initializes its JVM context before Tauri
  starts network work. ProGuard keeps the JNI entry and verifier classes. The
  x86_64 and ARM64 debug builds pass; on-device HTTPS verification is still
  pending. The current APKs are about 42 MiB, contain their intended single
  ABI, and pass APK signature and ZIP checks. Stable test copies and SHA-256
  records are in `.cache/emulator`; these use debug signing keys.
  The latest lifecycle changes have not been installed on a device. The prior
  installed package is kept as `openbot-one-before-lifecycle-x86_64.apk` so the
  crash reproduction remains tied to its exact artifact.
- The user has no Android test device or accelerated host available now and
  asked to retain the APKs and check scripts. Mobile acceptance remains open.
  Both saved debug APKs have now been rebuilt with the current UI/client 0.1.5,
  configuration recovery, and OB icon. Signatures, ZIP contents, and one ABI per
  package pass. The artifact manifest records their exact hashes and keeps the
  earlier crash evidence separate. The check script can select a future physical
  device by exact serial and local ADB port; that device flow is still unverified.
- Native mobile pause closes Live sockets and rejects new ones until resume.
  A local main-window event tells the shared UI to stop media; the Web app also
  watches page hide and visibility changes. Returning to the foreground never
  starts a talk. The actual React hook check passes chat/organization cleanup,
  late microphone grants, duplicate readiness, pause/page hide, resume, stale
  audio failures, socket setup failure, and unmount. It uses controlled media/socket
  resources, not a Live provider or OS microphone permission dialog.
- Capture cancellation now stops tracks during worklet loading as well as after
  a late permission grant. Unit tests cover prompt avoidance after cancellation,
  late grants, worklet failure, port/node cleanup, and delayed listener teardown.
- The current UI integration is based on upstream main at
  `5362712082f3482173f9e3aee7be8bf75834a8e1`. It retains the new account,
  admission, billing, and design work. Client 0.1.5 matches the v0.1.5 server at
  `770126bda4c0cb5f737c42f54078ee9d67400d5d`. The isolated local database was
  backed up before migration, and its existing encryption keys were retained.
  Packaged Linux chat, files, login/logout, service switching, and the Live hook
  lifecycle checks pass with this pair. This uses simulated model providers.
- Damaged, unsupported, or unreadable saved settings now open a shared repair
  screen instead of ending startup. Native HTTP, sockets, and sign-in stay
  blocked until explicit repair. The packaged Linux check proves no overwrite
  on load, failed retry, retry after file repair, and return to the default from
  a newer settings version. The Rust loader bounds file size and rejects
  duplicate fields; atomic saving clears recovery only after a successful write.
- First-party email-code login now uses the published 0.1.5 routes and the
  shared form. An optional runtime flag says the native transport supports it.
  Rust requires a 204 verify response, a valid private host-only cookie, and a
  bounded account check before committing a session. It checks service generation
  and cancellation; a new session ends old sockets/requests and storage grants.
  The packaged Linux check passes the real form, invitation forwarding, invalid
  code, admission denial, one-use code, hidden cookies, rejected login redirects,
  invalid/oversized account responses, cancellation, stale service checks, and
  old resource revocation. The peer is a controlled fixture. A separate local
  mail check uses the unchanged official production server, a fresh database,
  HTTPS, and its real TLS mail adapter. The delivered code signs in through the
  packaged shared form. Wrong codes fail; the account has the verified email and
  its bootstrap role. Native HTTPS rejects an untrusted issuer. Shared sign-out
  removes the only server session. Test services and the test database are
  removed at the end. External mailbox delivery, company SSO, and durable
  credentials still need acceptance or implementation.
- A new account with no organization now has a shared Sign out button. The real
  local mail check exercises it, so first-time users can leave that account.
- A serial native worker now uses Keyring Core 1.0.1 and target-specific OS
  stores. Only random IDs and flags enter the public disk index. A record is
  disabled before staging a secret and published only for the current service
  and request generation. Timeouts, stale writes, and failed device writes
  cannot enable it. A failed save permits a clearly marked memory-only sign-in;
  no plain-file fallback exists. Restore checks the server and stored account.
  Logout blocks restore before removing memory and OS data; failed removal has
  a retry state. Old service origins cannot invoke sign-in/out/retry for the new
  service. The real Linux Secret Service round trip and packaged process-restart
  checks pass with an isolated D-Bus session and encrypted GNOME keyring. Both
  sign-in restoration and signed-out restart pass against the real mail backend.
  Returning to a remembered service also resumes the account without a new code.
  A second packaged run with no usable D-Bus connection shows memory-only status
  and proves that restart cannot restore it from a plain file. Native tests also
  cover late OS writes, disabled records, wrong origins/IDs, and invalid indexes.
  Android and Apple/Windows store acceptance remain target-host work.
- Live capture now ships a separate local worklet asset. The packaged CSP still
  rejects Blob scripts. A scoped native permission handler permits microphone
  consent for the signed-in local main view and denies other Web permissions.
  Linux adds an asynchronous GTK prompt, with a generation check on late
  responses; other targets continue to system/browser consent. The normal Linux
  app passes private synthetic capture, 24 kHz PCM and frequency checks, native
  binary echo, actual playback, denial, late consent rejection, and cleanup.
  This uses WebKit Inspector rather than WebDriver, whose automation mode skips
  native media consent. Voice processing, real Live providers, mobile
  interruptions, and other OS permission flows remain unaccepted. Apple usage
  text/entitlements and Linux media dependency/bundle settings are now explicit.
  `pnpm android:package` builds, verifies, and preserves each APK before cleaning
  the next architecture; failure stops the sequence.
- Native browser sign-in is implemented in the isolated backend branch
  `codex/native-browser-auth`, based on `a1fb2cd376af4de67120d5d1ae730e0c8c6e5e36`,
  at `/home/edge/openbot/.worktrees/openbot-native-auth`. The mounted public API
  has options, start, authorize, finish, exchange, and proof-bound cancel.
  Current client registration, exact redirects, PKCE S256, encrypted row-bound
  state, verified OIDC browser-session binding, one-use consumption, and
  independent SDK sessions are implemented. Real database tests cover concurrent
  consumers, cancellation, expiry after lock waits, and fresh-session cleanup.
  HTTP acceptance covers the complete provider callback and exchange, distinct
  browser/native sign-out, Origin refusal, private per-request proof Cookies,
  replay, non-revealing cancellation, rate limits, no-store/no-referrer replies,
  sensitive trace/error redaction, and startup cleanup after a server restart.
  Cleanup is owned by the HTTP layer and bounded to 1024 expired rows per pass.
  These backend tests use a controlled OIDC provider. Separate packaged Linux
  checks now prove the desktop OS return. The running v0.1.5 backend, database,
  and preserved APKs remain at their prior versions. Public package publication
  remains open. Mobile cold/warm return is now implemented; its device acceptance remains open.
  Current full workspace build/typecheck and 171 files / 1052 regression tests
  pass; Effect rules cover 1025 files. The saved patch and evidence are in
  `.cache/native-auth-contract.json`. Provider and account refusal now use a
  proof-bound native failure route with a fixed access_denied callback. This
  path cannot cancel an attempt that already issued a code.
- Native Rust browser grant state and HTTP exchange are implemented in
  `browser_auth.rs` and `browser_http.rs`. They keep random verifier/state and
  all callback/session values out of IPC, validate the exact browser entry and
  callback state/issuer, reject replay and malformed pending state, and bound
  HTTP reads/timeouts. Exchange uses the existing private Cookie/account check
  and fenced OS-vault commit. Failed or cancelled checks and late service
  changes revoke the fresh session without replacing the previous account.
  Full Rust tests pass (51 plus 2 existing ignored host checks); Linux Clippy
  passes with warnings denied. Ten tests cover the new foundation, using
  private local HTTP and an explicitly unavailable test credential store.
  Desktop now has a two-stage operation lease, one owned ephemeral loopback
  listener and system browser opening, a shared UI entry with AbortSignal
  cancellation, and generation cancellation on reload/account/service change.
  Native proof values never cross IPC. The old cancellation ID cannot release
  a newer attempt. The callback server bounds reads and time, refuses wrong
  Host/method/state and returns only a fixed no-store/no-referrer page.
  Packaged Linux checks use real backend HTTP/OIDC, private TLS and an isolated
  Chromium handler. Mobile OS return/pending-proof storage and Mac/Windows
  acceptance remain open. APKs and the previous Linux binary are preserved;
  the current Linux build includes desktop browser sign-in.

## 1. Pin and prove the shared boundary

- [x] Confirm the shared UI repository and inspect its package/build contract.
- [x] Check official Tauri guidance and current version records.
- [x] Identify origin, cookie login, Live WebSocket, and mobile layout gaps.
- [ ] Fetch and inspect the exact published Web/client/server versions that will
  ship together. Save the resolved versions and build inputs.
- [ ] In `openbot-ui`, add a small public runtime/platform contract. Cover API
  origin, session restore/sign-in/sign-out, stream transport, external URLs,
  clipboard, and lifecycle events. Browser defaults must keep current behavior.
- [ ] Add a public native build entry or importable app entry to the UI package.
  Prove that the shell consumes a published package without private source imports,
  a copied UI, or paths to a sibling checkout.
- [ ] Make unsupported native features explicit. Do not report success for a
  no-op. Do not add plugins before their user flows exist.

Exit check: one UI release supports browser and native bootstrap; browser build,
typecheck, and existing tests pass. An exact package can be consumed from a clean
checkout. The shell has no copy of the screens.

Registry access returned 401 without credentials and 403 with the current CLI
credential. Release artifacts allowed the package audit to proceed as described
in the research. The new UI runtime still needs a package release before the
shell can pin it as a normal registry dependency.

## 2. Prove native sign-in and transport

The isolated backend branch has the public native HTTP flow and durable
one-use store with two additive migrations. Real PostgreSQL, OIDC callback,
SDK session, and HTTP tests prove the backend boundary. The private SDK session
methods have no direct HTTP path; the public exchange calls them only after
validating and consuming a PKCE grant. Attempts expire after five minutes and
codes after at most sixty seconds. The native app must retain its verifier,
validate state and issuer, and finish through an owned OS return path. Tauri
mobile browser return integration and a public SDK release remain open. The current
local v0.1.5 service and preserved APKs are unchanged.

- [ ] Confirm the current server's native authentication support. Add missing
  public contracts in OpenBot first and publish them before updating the UI.
  Respect each repository's rules and preserve existing browser login.
- [ ] Define native client IDs, exact redirects, code lifetime, PKCE S256,
  state, account lookup, organization scope, refresh, and revocation.
- [ ] Implement login in an external browser/platform authentication session.
  Prove cancellation, expiry, wrong state/verifier, replay, cold launch, warm
  return, and a second simultaneous login.
- [ ] Select and test credential storage on each OS. Handle locked/unavailable
  storage and account isolation. Never persist refresh tokens in Web storage.
- [ ] Prove the typed client's transport against the packaged app origin.
  Include authenticated REST, execution streams, file upload/download, and Live
  talk. Test cancellation and cross-host redirect rejection.
- [x] Define native WebSocket authentication without persistent URL tokens.
- [ ] Prove logout and organization switching stop old requests, subscriptions,
  and audio. Resume must not repeat a mutation whose result was lost.

Exit check: a packaged vertical slice can sign in, show the account, open a
chat, send once, receive real events, reconnect, and sign out. No development
proxy is needed for this test. Failure cases are covered at the boundary.

## 3. Build the common shell

Proposed layout, to be created after the UI entry contract is proved:

```text
package.json                  # exact shared UI and Tauri JS versions
pnpm-lock.yaml
devenv.nix                    # development tools and Linux native libraries
devenv.yaml
src/                          # native bootstrap and platform adapter only
src-tauri/
  Cargo.toml
  Cargo.lock
  build.rs                    # custom command permission manifest
  tauri.conf.json
  capabilities/
  permissions/
  src/main.rs                 # desktop entry calls the shared library
  src/lib.rs                  # common run() and mobile entry
  src/auth/
  icons/
  gen/android/                # generated with the selected CLI, then reviewed
  gen/apple/                  # generated on macOS with the selected CLI
.github/workflows/
```

- [x] Use Tauri 2's structure and shared mobile library entry.
- [x] Pin Node, pnpm, Rust, Tauri, and Android tools; add lockfiles.
- [x] Add the needed Linux WebKitGTK/GTK/pkg-config build libraries to the
  development shell. Do not install into an unrelated repository's environment.
- [x] Wire shared UI build/dev hooks; set fixed ports and `TAURI_DEV_HOST`.
- [x] Bundle local assets; set a production CSP tested with the real UI build.
- [x] Declare custom commands in the build permission manifest; grant exact
  permissions by window and target. No remote IPC capability.
- [x] Guard navigation, new windows, URL opening, and untrusted content.
- [x] Register mobile deep links before the main window; keep cold/warm
  callbacks in Rust and validate them before exchange. Device acceptance is open.
- [ ] Decide the desktop single-instance policy for release. Desktop PKCE uses
  a temporary loopback listener and does not need desktop deep-link routing.
- [x] Generate icons from the existing OpenBot mark and add version metadata.
- [ ] Finalize the Bundle ID for signing and add scoped native log handling.

Exit check: locked builds from a clean checkout use the shared UI package.
Rust format/check/clippy and boundary tests pass. The production app rejects
ungranted commands, remote navigation, and remote IPC.

## 4. Desktop behavior and packaging

- [ ] Build Windows, macOS, and Linux on their supported CI hosts.
- [ ] Prove clipboard, external URLs, file selection/save, and permissions.
- [ ] Test shortcuts, focus, resize, restore after monitor removal, and quit.
- [ ] Keep all desktop-only plugins and dependencies out of mobile builds.
- [ ] Produce local install artifacts and test install/launch/uninstall.
- [ ] Add signed release paths and signed updater artifacts only when real
  keys and endpoints are configured. Check rejected update signatures.
- [ ] Test a previous-version upgrade with account state and drafts preserved.

Exit check: each desktop target has its own build/test/install evidence.
Signing and update readiness are reported separately from an unsigned build.

## 5. Android and iOS

- [x] Generate Android with the pinned CLI/SDK/NDK/JDK; add the reviewed
  project and use explicit production network/permission settings.
- [ ] Generate iOS on macOS with full Xcode; set the real development team,
  entitlements, usage descriptions, and provisioning when available.
- [ ] In the shared UI, add safe areas and keyboard-aware layout. Test composer,
  dialogs, drawers, landscape, long text, and large font sizes.
- [ ] Prove Android back behavior, iOS gestures, text selection, accessibility,
  clipboard, file inputs, and external browser return.
- [ ] Verify microphone permission grant/deny, audio cleanup, interruptions,
  suspend/resume, and lost network. Do not promise background socket uptime.
- [ ] Verify App Links/Universal Links with hosted association files and actual
  app signing identities. Test cold and warm links on devices.
- [ ] Build Android APK/AAB and iOS simulator/device/archive targets as applicable.
- [ ] Prepare useful native user flows, store metadata, privacy declarations,
  and review access for TestFlight/Play internal distribution.

Exit check: both mobile targets have simulator/emulator and physical-device
evidence. iOS build checks must run on macOS. Store signing and review remain
separate recorded steps.

## 6. CI and completion evidence

- [ ] Keep browser checks in `openbot-ui`; run native contract/security checks
  here, then the supported-host build matrix.
- [ ] Use current WDIO Tauri integration for packaged desktop flow checks.
  Include actual OS behavior; browser mocks alone do not count.
- [ ] Keep test-only automation servers and development exceptions out of
  release artifacts. Keep signing secrets out of untrusted pull request jobs.
- [x] Pin workflow actions to reviewed SHAs and minimize job token permissions.
- [ ] Save UI/client/native versions and artifact checksums with build results.
- [ ] Report results per target: built, tested, device checked, signed, and
  released. Mark unavailable environments or credentials explicitly.

## Inputs still needed for release

Implementation can proceed without these release-only inputs. They must be
resolved before signed distribution, and must not be invented:

- Production default origin in the build environment and allowed login providers.
  The code uses an environment variable; no concrete domain is required now.
- Final Bundle ID, owned callback domain, and association-file hosting.
- Apple team, certificates/profiles, and macOS/Xcode runner access.
- Android signing/upload identity and Play Console access.
- Windows signing identity and desktop update endpoint/signing key.
- Minimum supported OS/WebView versions and the required CPU architectures.
- The license and distribution terms for this new application repository.

The next integration work includes Live audio, mobile acceptance, OS credential
failure/recovery acceptance, company browser sign-in, and external mail acceptance.
Transport now binds new HTTP and socket work, authentication, and settings to
the document's native runtime ID as well as its origin. Account commits and
document reloads retire the ID. Late cleanup removes only older generations.
Native checks cover same-origin account changes, reloads, and delayed upload
grant work. Packaged Linux checks reject stale HTTP, Live, authentication, and
settings actions without another request reaching the test peer, then reload
and confirm that the checked account still works. Real local mail, credential
restart/logout, and unavailable-store checks also pass with this binding.
First-run setup uses the configured default and
does not require entering a server address. The local test-account flow does
not establish production OAuth, physical-device behavior, or store readiness.


### Mobile browser foundation checkpoint

The preserved ARM64 and x86_64 debug APKs remain unchanged. The user deferred
device acceptance until a working Android device or accelerated host is
available. `pnpm android:artifacts:check` checks their recorded size and SHA-256
without starting a device. `pnpm android:check` remains available for a selected
serial and ADB port; it has not passed on this host's broken WebView image.

Current source replaces mobile general event listening with a typed activity
Channel bound to the current origin and document. Native and adapter checks
cover old-document delivery, bounded subscriptions, failed subscription,
disposal, and late cleanup. No raw deep-link URL is sent by this channel.

Session and pending browser proofs use the same bounded serial worker design
with separate OS purposes. Session credential names remain unchanged.
Pending proofs require a completed OS write and explicit publication. Their
local metadata contains only a random generation and state flags. Clear fences
restoration before OS deletion, and old permits cannot publish after clear.
There is no plain-file proof fallback. Android cloud backup and device transfer
exclude both named encrypted preference stores.

Linux Rust tests, Clippy with warnings denied, adapter typecheck/tests, private
encrypted Secret Service round trips and purpose isolation passed. Current
source also passed Rust checks for Android ARM64 and x86_64 using NDK 28.
These checks do not replace APK installation, mobile credential-store behavior,
or cold/warm browser return on a device. The private return owner and recovery
path are now implemented; target-device acceptance remains open.
The running local backend and the original UI/backend checkouts are unchanged.


### Mobile browser return checkpoint

Current Android ARM64 and x86_64 APKs are in `.cache/mobile-browser-apks`.
The earlier `.cache/emulator` packages remain unchanged. Both new packages
passed debug signature, single ABI, ZIP, callback manifest and compiled backup
exclusion checks. The release callback is still a private scheme; owned HTTPS
App Links/Universal Links and signing identities need separate release work.

The mobile browser owner saves the pending proof before opening the browser,
keeps the callback queue in Rust, and owns cancellation, timeout and exchange.
Only a typed notification reaches JavaScript. Process restart can recover a
valid pending proof for the current selected origin/client/callback. An
existing checked account cannot be replaced by an old OS return. Wrong state,
wrong client, service change, cancellation, replay, failed OS deletion, late
restore errors and old document cleanup are covered by native checks. Pending OS storage is removed
before the one-use exchange. No exchange is retried after a lost result.

Tauri's real ACL resolver checks both mobile targets. Raw deep-link commands,
camel-case/native-only fallback commands and general event listening have no
grant. The typed activity and return commands remain local to the main window.
The optional device privacy flow in `e2e/android.mjs` is syntax checked, not run.

Native tests, warning-free Clippy, adapter typecheck/tests, shared UI
build/typecheck/tests and private Linux native-store checks passed. Packaged
Linux chat/files/storage/transport and real local OIDC browser regression also
passed after this integration. Android actual browser delivery and device
credentials, iOS build/device work, and Mac/Windows target-host checks remain
open. The running local backend has not gained the new native API; its normal
development/email sign-in stays available. No online Access flow was resumed.


### Independent package and platform workflow checkpoint

The app now pins the checked UI snapshot as a local tarball dependency with
pnpm integrity. The snapshot includes only built assets, the public runtime,
package metadata and MIT license; its development dependencies are not
installed in this app. Provenance preserves the upstream base, integration
patch hash, archive hash and client version. It is an unpublished snapshot and
does not replace the upstream release gate.

The default build was checked without `OPENBOT_WEB_PACKAGE_DIR`. A separate
source copy with a fresh JavaScript install, no `.env` and no sibling UI also
passed typecheck, tests, staging and the real Linux native build. Cargo used
the existing compilation cache. The copy's path includes a space, exercising
the direct Node CLI invocation as well as asset paths.

The CLI wrapper now runs Tauri's pinned JavaScript entry through Node rather
than relying on a platform command shim. Asset staging rejects both nested
and ancestor output before deleting or copying files. Its symbolic-link check
uses a directory junction on Windows without requiring file-symlink privilege.
Pending-proof metadata follows the existing session store's Unix-only parent
directory sync; Windows does not try to open a directory as an ordinary file.

The workflow uses Nix for Linux/Android and pinned native Node/Rust tools for
Apple/Windows hosts. It builds debug artifacts without production credentials.
The iOS simulator command was checked against the pinned CLI 2.12.4 source;
it supports unsigned archive/export and accepts a missing development team.
The workflow includes checks on the generated simulator app, not a fabricated
Apple project from this Linux host.

Remote branches were checked through GitHub: `openbot-build/openbot-one` is an
empty public repository. Running these jobs requires the first public source
push. No push, remote workflow run, package publication or release is claimed
by this checkpoint. Existing APKs and the running local backend stay in place.


### Ubuntu-baseline Linux package checkpoint

A pinned Ubuntu 22.04 Docker recipe builds Debian and AppImage debug packages
from the real locked Web dependency. It avoids the Nix loader/glibc dependency
of the developer binary. Node and Rust versions follow the repository pins;
tool downloads are checked and package versions are saved with artifacts.

The Debian package was installed in a separate container without developer
libraries, its launcher validated and its executable checked for a non-Nix
loader. Real UI/default local backend sign-in, private session and logout
passed. Removal deleted package files and retained the test user's data.
The AppImage ran in a separate container with no system GTK/WebKit, using its
bundled framework plus ordinary desktop font/graphics base libraries.
Its real local-service sign-in/logout and UI snapshot also passed.

`linux:install:check --fixture` uses a controlled API peer in a container
without networking for reproducible CI; the normal mode uses the running local
backend. Both modes are recorded separately. No WebDriver permission override
or WebKit sandbox-disable flag is used. This does not establish FUSE, physical
display/audio, real desktop keyring or every Linux distribution.

A separate supported-host workflow job now builds and tests these portable
packages. The original Linux job labels its Nix binary as a developer artifact.
The first public push and all remote CI results still await the pending user
approval. Existing APKs and the running local backend version remain unchanged.

### Preserved Android artifact verification

The integrity command now accepts `--manifest <path>` in addition to its
original baseline default. Both the baseline object manifest and newer
mobile-browser array manifest are supported. APKs are resolved beside the
manifest rather than at a previous machine's absolute path. Duplicate target
records, size changes and same-size corruption fail verification.

Both original APKs and both newer mobile-browser APKs passed their recorded
size/SHA-256 checks. Typecheck and all 34 JavaScript tests passed, including
moved-archive and corruption checks. This changed only scripts, tests and
documentation: no APK was rebuilt, no emulator was started and no Android
device acceptance is claimed.

The distribution notice inventory is recorded in
`docs/distribution-notices.md`. It identifies a remaining release task:
installed dependency metadata and existing system copyright files do not
provide the complete Rust/Web/font notice bundle. The application license
remains a separate release input. No public source push or publication was
performed.

### Bundled third-party notice checkpoint

The fixed Web package already contained Vite's bundled code license report.
The previous inventory missed it; it was not missing from the saved package.
The UI runtime build now also copies the two font packages' original OFL
files and a version index. The updated local tarball, source patch, provenance
hashes and frozen pnpm lock match that source change.

The native adapter build now produces its own Vite dependency notice file.
A pinned cargo-about 0.9.3 collection adds Rust notices, including the
all-platform/build dependency graph and original notice files found in source.
The checked record contains 529 packages, 225 selected license texts and
888 original files grouped into 312 texts. Cargo marks the application private
and excludes it from this dependency collection; no app license is assigned.

Normal staging checks the Rust manifest, lock file, collector configuration,
collector source and generated HTML hashes before copying notices. LF checkout
rules keep these hashes stable across hosts. The generator is only needed
when refreshing the collection, not in a normal build or supported-host CI.

A fresh source copy without a sibling UI, local environment file, registry
token or existing JavaScript install passed frozen install, typecheck, all
35 JavaScript tests, staging and a real Linux debug build. The UI's required
build, typecheck, 34 tests and 7 package checks also passed.

The packaged Linux WebView read all seven notice assets through its native
protocol. Six assets matched the source text exactly. All 537 Rust notice
bodies matched after normal HTML parsing and trimming leading/trailing space;
Tauri's HTML processing may change entity spelling and CSP metadata.
The full existing desktop regression passed too.

This is a generated notice collection, not complete release compliance:
37 packages lack local notice files and 71 package entries used generic license
fallback at least once. Upstream attributions and target runtime components
still need review. See `docs/distribution-notices.md`. Saved APKs and the
previous Debian/AppImage files were not rebuilt or replaced. Public push,
remote platform CI and the unavailable mobile-device checks remain pending.

### Original notice provenance checkpoint

The 37 entries from the first notice inventory now have original notice
material. The collector reads AUTHORS files and files within notice
directories, and retains original source license headers where no separate
file is shipped. Thirty-two dependency packages also have reviewed source
records tied to their published crate's VCS commit, with 15 distinct files
saved locally. Their source URLs, crate versions and SHA-256 hashes are kept.

The two old WinAPI import-library packages have no VCS metadata. Their original
source license headers are used without claiming a source commit. The r-efi
AUTHORS files include license terms and contributors. Upstream repository
moves are explicit: ndk-context retains its original repository field while
its recorded commit is read from the current rust-mobile/ndk repository.

The collection now contains 937 original file/header records, grouped into
323 distinct texts, alongside 225 selected license texts for 529 packages.
No package in that collected graph lacks original notice material. The
71 generic cargo-about fallback entries remain visible, with original source
material collected beside them. License choices and target runtime release
requirements remain separate from this provenance check.

Normal builds verify the upstream index and all original file hashes.
Generation also checks crate repository/version/commit bindings and stops
for an uncovered dependency. Git leaves saved upstream file bytes unchanged.
The notice integrity test now proves that changing an upstream file fails.

Fresh-source frozen installation, typecheck, all 35 JavaScript tests, staging
and the real Linux debug build passed. The packaged WebView read all seven
notice assets and preserved all 548 Rust notice bodies under normal HTML
parsing. Existing desktop login/chat/files/sockets/service-isolation regression
also passed. No shared UI or backend source changed in this checkpoint.
Saved APKs and prior portable Linux packages were not replaced, and no public
push, remote CI, mobile-device or Apple/Windows runtime result is claimed.

### Native clipboard and Apple WebView floor checkpoint

A packaged Linux check now writes unique text with Chinese characters, an
emoji and line breaks through the actual native clipboard runtime. xclip
reads it from the owned private Xvfb display and confirms an exact match.
Direct native clipboard read_text and clear commands are rejected by the
permission boundary; their rejection leaves the clipboard unchanged.
The test profile supplies xclip. No user's desktop clipboard is read.
The existing full packaged desktop regression passed with this added check.

A compatibility audit found that tauri-utils 2.10.2's default macOS 10.13 and
iOS 15.0 floors predate the checked Web bundle's Safari/iOS 16.4 baseline.
The native configuration now sets macOS 13.3 and iOS 16.4 as conservative
technical floors. Supported-host CI inspects the actual Apple bundle minimum
version fields, in addition to its existing identity and usage-text checks.
Workflow lint and the actual Linux debug build passed. Apple packaging and
runtime results remain unverified on this Linux host.

These changes do not claim that all desktop behavior or target-platform
acceptance is complete. The public repository's branch list is still empty.
No public push, remote workflow run, production release or APK replacement
was performed.

### Independent Android build checkpoint

Android's old unanchored `build` ignore pattern also hid the Kotlin package
path `java/build/openbot/one`. It omitted MainActivity and the buildSrc Kotlin
plugin sources from the Git source list. Build output ignores now name only
the generated build directories; generated activity/bridge files remain ignored.

The packager previously invoked Gradle clean before Tauri had written the
machine-specific Gradle settings. It now skips that step only in a new tree
without generated outputs. Existing initialized projects still use Gradle clean.
Captured child output is consumed through process close before verification.

Kotlin and Java compile tasks now depend on the Rust task that creates their
activity/WebView sources. The source-copy check uses a new Cargo target
directory because Android code generation has app-project side effects that
cannot be assumed to exist when a target cache comes from another source path.

`pnpm android:clean:check aarch64 x86_64` passed from a fresh source copy with
no local environment file, sibling UI, registry token, generated Android settings,
JavaScript installation or Cargo compilation output. All 35 JavaScript checks
and typecheck passed there. Both APKs passed debug signature and single-ABI
checks; MainActivity is present in each DEX. The saved copies also have the
expected package/version/launcher metadata. This does not establish device
or WebView runtime acceptance.

CI now uses that fresh Android check. Its artifact steps explicitly include
the selected outputs under hidden `.cache` paths, naming only APKs, build
metadata and the existing known desktop/iOS/Linux outputs. No whole cache
directory is uploaded. Workflow lint passed; remote CI has not run.

The new pair is saved in `.cache/clean-android-apks`, with portable integrity
metadata and a link back to the source-build result. Both earlier saved APK
pairs still match their original checksums. No emulator was started.

Windows packaging now sets `minimumWebview2Version` to `111.0.0.0`, matching
the checked Web bundle's Chromium 111 floor. Tauri's installer can request an
update for an older runtime. Actual Windows installation remains unverified.

### Linux runtime dependency and current package checkpoint

The Deb's runtime dependency now declares WebKitGTK >= 2.40, matching the
request-body API imported by the checked binary. The actual Deb rejects
old-version dependency metadata in an isolated dpkg root. No old engine
is executed by that policy probe.

Current Debian and AppImage debug artifacts were rebuilt in the Ubuntu 22.04
baseline. Both passed real native UI, private sign-in and logout against the
controlled isolated peer and the unchanged running local v0.1.5 backend.
The Debian tests used real WebKit 2.50.4. AppImage tests ran without system
GTK/WebKit. Neither check uses a WebDriver permission override or explicit
WebKit sandbox-disable flag.

Each installed/running package preserves all seven notice assets. Text assets
must match their source digest; every Rust license body must match after
normal HTML parsing. Inspector payload size no longer requires transmitting
the whole expected Rust notice file into the WebView.

Installer checks use the immutable builder recorded in build.json, rather
than the mutable default builder tag. Debian removal checks marker files
inside the actual app config/data directories. Its result states this narrow
scope; it does not claim account or draft restoration. This replaces the
earlier marker at the config root.

Prior Linux packages are saved in .cache/linux-packages-before-webkit-floor.
Saved Android APKs were not replaced. macOS, Windows and iOS host acceptance
still has no remote build result: GitHub remains a public empty repository
with no branches or workflow runs. First public source push confirmation
has not been received; Android runtime acceptance was explicitly deferred
until a usable device or accelerated host is available.
