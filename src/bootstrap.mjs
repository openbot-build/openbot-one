import { Channel, invoke } from "@tauri-apps/api/core"
import { onBackButtonPress, exit } from "@tauri-apps/api/app"
import { openUrl } from "@tauri-apps/plugin-opener"
import { writeText } from "@tauri-apps/plugin-clipboard-manager"
import { createAppStateSubscription } from "./lifecycle.mjs"
import { watchBrowserReturn } from "./browser-return.mjs"
import { createBrowserSignIn } from "./browser-sign-in.mjs"
import { createNativeFetch } from "./transport.mjs"
import { createNativeWebSocket } from "./socket.mjs"

/** @typedef {{defaultOrigin:string,currentOrigin:string,development:boolean,developmentSignIn:boolean,storageNamespace:string,android:boolean,mobile:boolean,recovery:'invalid-settings'|'unsupported-version'|'unreadable-settings'|null,sessionIssue?:'browser-sign-in-incomplete'|'store-unavailable'|'service-unavailable'|'invalid-saved-sign-in'|'not-saved'|'cleanup-pending'|'sign-out-incomplete'|null,runtimeId:string,sessionPersistence:'none'|'saved'|'memory'}} Connection */

// This is the public runtime module shipped by the shared Web package. It is
// loaded beside this bundle, without an import from the UI's private source.
const moduleUrl = "./runtime.js"
const { installRuntime } = await import(/* @vite-ignore */ moduleUrl)
const connection = /** @type {Connection} */ (await invoke("runtime_start"))

installRuntime({
  version: 1,
  kind: "native",
  apiOrigin: connection.currentOrigin,
  development: connection.development,
  developmentSignIn: connection.developmentSignIn,
  emailSignIn: true,
  browserSignIn: createBrowserSignIn(connection, invoke),
  session: {
    issue: connection.sessionIssue ?? undefined,
    persistence: connection.sessionPersistence,
    retry: async () => {
      let snapshot
      try { snapshot = /** @type {Connection} */ (await invoke("session_retry", { expectedOrigin: connection.currentOrigin, runtimeId: connection.runtimeId })) }
      catch (error) { throw new Error(String(error)) }
      globalThis.location.replace(snapshot.sessionPersistence === "none" ? "/sign-in" : "/")
    },
  },
  storageNamespace: connection.storageNamespace,
  fetch: createNativeFetch(connection.currentOrigin, connection.runtimeId, invoke),
  signIn: async () => {
    try { await invoke("session_sign_in", { expectedOrigin: connection.currentOrigin, runtimeId: connection.runtimeId }) }
    catch (error) { throw new Error(String(error)) }
  },
  signOut: async () => {
    try { await invoke("session_sign_out", { expectedOrigin: connection.currentOrigin, runtimeId: connection.runtimeId }) }
    catch (error) { throw new Error(String(error)) }
  },
  writeClipboard: writeText,
  openExternal: openUrl,
  createWebSocket: createNativeWebSocket(connection.currentOrigin, connection.runtimeId, invoke),
  onAppStateChange: connection.mobile ? createAppStateSubscription(connection, invoke, () => new Channel()) : undefined,
  onBackPress: connection.android ? async (/** @type {() => boolean} */ handler) => {
    const listener = await onBackButtonPress(({ canGoBack }) => {
      if (handler()) return
      if (canGoBack) globalThis.history.back()
      else void exit(0)
    })
    return () => { void listener.unregister() }
  } : undefined,
  connection: {
    defaultOrigin: connection.defaultOrigin,
    recovery: connection.recovery ?? undefined,
    retry: async () => {
      try { await invoke("connection_retry", { expectedOrigin: connection.currentOrigin, runtimeId: connection.runtimeId }) }
      catch (error) { throw new Error(String(error)) }
      globalThis.location.replace("/")
    },
    /** @param {string | null} origin */
    change: async (origin) => {
      try { await invoke("connection_set", { origin, expectedOrigin: connection.currentOrigin, runtimeId: connection.runtimeId }) }
      catch (error) { throw new Error(String(error)) }
      globalThis.location.replace("/")
    },
  },
})


if (connection.mobile) {
  const stop = await watchBrowserReturn(connection, invoke, () => new Channel(), result => {
    // Native commit changes the account/document lease. Install a fresh runtime
    // and namespace before rendering the recovered account.
    globalThis.location.replace(result === "complete" ? "/" : "/sign-in")
  })
  globalThis.addEventListener("pagehide", stop, {once:true})
}
