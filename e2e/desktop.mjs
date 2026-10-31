import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { existsSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
import { socketFixture } from "./socket-fixture.mjs"
import { fileChecks } from "./files.mjs"
import { layoutChecks } from "./layout.mjs"
import { recoveryChecks } from "./recovery.mjs"
import { emailSignInChecks } from "./email-sign-in.mjs"
import { noticeChecks } from "./notices.mjs"
import { clipboardChecks } from "./clipboard.mjs"

// This check runs the packaged Linux WebView, real IPC, and the local backend.
const output = resolve(".cache/native-e2e")
const connectionPath = resolve(output,"config/build.openbot.one/connection.json")
const invalidSettings = '{"version":1,"origin":'
await mkdir(output, { recursive: true })
const display = process.env.E2E_DISPLAY ?? ":194"
const env = { ...process.env, DISPLAY: display, LIBGL_ALWAYS_SOFTWARE: "1", WEBKIT_DISABLE_COMPOSITING_MODE: "1",
  XDG_CONFIG_HOME: output + "/config", XDG_DATA_HOME: output + "/data", XDG_CACHE_HOME: output + "/cache" }
const children = []
function start(command, args) {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] })
  child.on("error", (error) => { process.stderr.write(error.message + "\n") })
  child.stderr.on("data", (data) => process.stderr.write(data))
  children.push(child)
  return child
}
const base = "http://127.0.0.1:19444"
const webkit = process.env.E2E_WEBKIT_DRIVER ?? process.env.PATH.split(":").map((dir) => resolve(dir, "WebKitWebDriver")).find(existsSync)
if (!webkit) throw new Error("WebKitWebDriver is missing from the test environment.")
let session
let fixture
async function call(path, body, method = "POST") {
  const response = await fetch(base + (session ? `/session/${session}` : "") + path, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  })
  const result = await response.json()
  if (!response.ok && result.value?.error) throw new Error(`${result.value.error}: ${result.value.message}`)
  return result.value
}
const execute = (script) => call("/execute/sync", { script, args: [] })
async function waitFor(check, message) {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await check()) return; await delay(150) }
  throw new Error(message)
}
async function element(using, value) {
  const found = await call("/element", { using, value })
  return `/element/${found["element-6066-11e4-a52e-4f735466cecf"]}`
}
async function button(label) {
  await waitFor(() => execute(`return [...document.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`), `The button ${label} did not appear.`)
  await call(await element("xpath", `//button[normalize-space(.)='${label}']`) + "/click", {})
}
async function input(selector, text) {
  await waitFor(() => execute(`return !!document.querySelector(${JSON.stringify(selector)})`), `The input ${selector} did not appear.`)
  const path = await element("css selector", selector)
  await call(path + "/clear", {})
  await call(path + "/value", { text })
}
async function screenshot(name) {
  const data = await call("/screenshot", undefined, "GET")
  await writeFile(`${output}/${name}.png`, Buffer.from(data, "base64"))
}
async function launchApp() {
  const created = await call("/session", { capabilities: { alwaysMatch: { "tauri:options": { application: resolve("src-tauri/target/debug/openbot-one") } } } })
  session = created.sessionId
  assert.ok(session)
}
async function restartApp(settings) {
  await call('',undefined,'DELETE')
  session = undefined
  await writeFile(connectionPath,settings)
  await launchApp()
}
try {
  // WebKit pointer coordinates need a 1x display for this headless check.
  start(process.env.E2E_XVFB ?? "Xvfb", [display, "-screen", "0", "1365x900x24", "-dpi", "96", "-nolisten", "tcp"])
  await delay(500)
  start(process.env.E2E_TAURI_DRIVER ?? resolve(".cache/test-tools/bin/tauri-driver"), ["--port", "19444", "--native-port", "19445", "--native-driver", webkit])
  await waitFor(async () => { try { return (await fetch(base + "/status")).ok } catch { return false } }, "The native driver did not start.")
  await mkdir(resolve(output,"config/build.openbot.one"),{recursive:true})
  await writeFile(connectionPath,invalidSettings)
  await launchApp()
  await recoveryChecks({call,execute,button,waitFor,screenshot,path:connectionPath,invalid:invalidSettings,restart:restartApp})
  await waitFor(async () => (await execute("return document.body.innerText")).includes("Sign in to the test account"), "The local sign-in page did not appear.")
  await execute("globalThis.__e2eErrors = []; addEventListener('error', e => globalThis.__e2eErrors.push(e.message)); const report = console.error; console.error = (...args) => { globalThis.__e2eErrors.push(args.map(x => x instanceof Error ? x.message : String(x)).join(' ')); report(...args) }; return true")
  assert.equal(await execute("return location.protocol"), "tauri:")
  await noticeChecks({call})
  await clipboardChecks({call,env})
  assert.ok(Math.abs(await execute("return devicePixelRatio") - 1) < 0.01, "The headless WebDriver display must use 96 DPI.")
  await screenshot("sign-in")
  await layoutChecks({call, execute, waitFor, element, button, screenshot})
  await button("Service settings")
  await input("input[type=url]", "https://example.test/v1")
  await button("Save and connect")
  await waitFor(async () => execute("return !!document.querySelector('[role=alert]')"), "Invalid service addresses must show an error.")
  await input("input[type=url]", "http://localhost:19381")
  await button("Save and connect")
  await waitFor(async () => execute("return globalThis.__OPENBOT_RUNTIME__?.apiOrigin === 'http://localhost:19381'"), "The selected service did not reload.")
  await execute("location.assign('/'); return true")
  await waitFor(async () => (await execute("return document.body.innerText")).includes("OpenBot is not reachable"), "A stopped service must show a recoverable error.")
  await button("Service settings")
  await button("Use default")
  await waitFor(async () => execute("return globalThis.__OPENBOT_RUNTIME__?.apiOrigin === 'http://localhost:19380'"), "The default service did not reload.")
  await button("Sign in to the test account")
  await waitFor(async () => execute("return location.pathname === '/' && !document.body.innerText.includes('Welcome')"), "Native development sign-in did not return to the app.")
  const sessionStatus = await call("/execute/async", { script: "globalThis.__OPENBOT_RUNTIME__.fetch('http://localhost:19380/auth/session').then(r => arguments[0](r.status), () => arguments[0](0))", args: [] })
  assert.equal(sessionStatus, 200)
  await waitFor(() => execute("return document.body.innerText.includes('Make your organization') || !!document.querySelector('[data-slot=sidebar]')"), "The signed-in screen did not appear.")
  if ((await execute("return document.body.innerText")).includes("Make your organization")) {
    await input("input[aria-label='Organization name']", "OpenBot One local")
    await button("Create")
    await waitFor(async () => execute("return !!document.querySelector('[data-slot=sidebar]')"), "The local organization was not created.")
  }
  await screenshot("signed-in")
  const botsLink = await element("css selector", "a[href='/bots']")
  await call(botsLink + "/click", {})
  await button("New Bot")
  const botName = `Native check ${Date.now()}`
  await input("#bot-name", botName)
  await input("#bot-role", "Check the native chat transport")
  await button("Create")
  await waitFor(() => execute(`return document.body.innerText.includes(${JSON.stringify(botName)}) && !document.querySelector('[role=dialog]')`), "The native Bot creation did not finish.")
  const chatButton = await element("xpath", `//*[@data-slot='item'][contains(.,'${botName}')]//button[normalize-space(.)='Chat']`)
  await call(chatButton + "/click", {})
  const message = `Native stream check ${Date.now()}`
  await input("textarea[aria-label=Message]", message)
  const sendButton = await element("css selector", "button[aria-label=Send]")
  await call(sendButton + "/click", {})
  await waitFor(() => execute("return location.pathname.startsWith('/c/')"), "The native message did not open a chat.")
  await waitFor(() => execute(`return document.body.innerText.includes(${JSON.stringify("Development response: " + message)}) && !document.querySelector('button[aria-label=Stop]')`), "The native chat stream did not finish.")
  await screenshot("chat")
  await fileChecks({ call, execute, element, waitFor, output, screenshot })
  const accountMenu = await element("css selector", "[data-slot=sidebar-footer] button")
  await call(accountMenu + "/click", {})
  await waitFor(() => execute("return [...document.querySelectorAll('[role=menuitem]')].some(item=>item.textContent.trim()==='Sign out')"), "The account menu did not open.")
  await call(await element("xpath", "//*[@role='menuitem' and normalize-space(.)='Sign out']") + "/click", {})
  await waitFor(() => execute("return location.pathname === '/sign-in' && !!globalThis.__OPENBOT_RUNTIME__"), "Sign-out did not return to the sign-in page.")
  const signedOut = await call("/execute/async", { script: "globalThis.__OPENBOT_RUNTIME__.fetch('http://localhost:19380/auth/session').then(r => arguments[0](r.status), () => arguments[0](0))", args: [] })
  assert.equal(signedOut, 401)
  fixture = await socketFixture()
  await button("Service settings")
  await input("input[type=url]", fixture.origin)
  await button("Save and connect")
  await waitFor(() => execute(`return globalThis.__OPENBOT_RUNTIME__?.apiOrigin === ${JSON.stringify(fixture.origin)} && location.pathname==='/sign-in' && document.body.innerText.includes('Sign in to the test account')`), "The socket test service did not load.")
  await call("/execute/async", { script: "globalThis.__OPENBOT_RUNTIME__.signIn({}).then(() => arguments[0](true), () => arguments[0](false))", args: [] }).then((signedIn) => assert.equal(signedIn, true))
  await execute("location.replace('/');return true")
  await waitFor(() => execute("return document.body.innerText.includes('Your organization access')"), "The fixture's signed-in document did not load.")
  const wsOrigin = fixture.origin.replace("http:", "ws:")
  const echo = await call("/execute/async", { script: `
    const done = arguments[0]; const values = [];
    const socket = globalThis.__OPENBOT_RUNTIME__.createWebSocket(${JSON.stringify(wsOrigin + "/v1/chats/native-check/live?organization=fixture")});
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => { socket.send('Native IPC 世界'); socket.send(new Uint8Array([0,1,255])); };
    socket.onmessage = event => values.push(typeof event.data === 'string' ? event.data : [...new Uint8Array(event.data)]);
    socket.onclose = event => done({values, code:event.code, clean:event.wasClean, cookieVisible:document.cookie.includes('__Host-openbot-session')});
  `, args: [] })
  assert.deepEqual(echo, { values: ["Native IPC 世界", [0, 1, 255]], code: 1000, clean: true, cookieVisible: false })
  const storage = await call('/execute/async', {script:`
    const done = arguments[0], native = globalThis.__OPENBOT_RUNTIME__;
    (async () => {
      const response = await native.fetch(native.apiOrigin + '/v1/files/uploads', {method:'POST',headers:{'content-type':'application/json'},body:'{}'});
      const target = await response.json(); globalThis.__e2eUploadTarget = target;
      const upload = await native.fetch(target.url, {method:target.method,headers:target.headers,body:'new'});
      done(upload.status);
    })().catch(() => done(0));
  `, args:[]})
  assert.equal(storage, 204)
  assert.deepEqual(fixture.storageStatus(), {requests:1,privateHeaders:false})
  const stopped = await call("/execute/async", { script: `
    const done = arguments[0];
    const socket = globalThis.__OPENBOT_RUNTIME__.createWebSocket(${JSON.stringify(wsOrigin + "/v1/chats/stopped/live")});
    socket.onopen = () => globalThis.__TAURI_INTERNALS__.invoke('connection_get').then(c=>globalThis.__TAURI_INTERNALS__.invoke('connection_set', {origin:null,expectedOrigin:c.currentOrigin,runtimeId:c.runtimeId}));
    socket.onclose = event => done(event.code);
  `, args: [] })
  assert.equal(stopped, 1001)
  assert.equal(fixture.accepted(), 2)
  const staleUpload = await call('/execute/async', {script:`
    const done = arguments[0];
    (async () => {
      await globalThis.__TAURI_INTERNALS__.invoke('connection_get').then(c=>globalThis.__TAURI_INTERNALS__.invoke('connection_set',{origin:${JSON.stringify(fixture.origin)},expectedOrigin:c.currentOrigin,runtimeId:c.runtimeId}));
      const target = globalThis.__e2eUploadTarget; let blocked = false;
      try { const response = await globalThis.__OPENBOT_RUNTIME__.fetch(target.url,{method:target.method,headers:target.headers,body:'new'}); await response.body?.cancel(); }
      catch { blocked = true; }
      await globalThis.__TAURI_INTERNALS__.invoke('connection_get').then(c=>globalThis.__TAURI_INTERNALS__.invoke('connection_set',{origin:null,expectedOrigin:c.currentOrigin,runtimeId:c.runtimeId}));
      done(blocked);
    })().catch(() => done(false));
  `,args:[]})
  assert.equal(staleUpload, true)
  assert.equal(fixture.storageStatus().requests, 1)
  await execute("location.assign('/sign-in'); return true")
  await waitFor(() => execute("return globalThis.__OPENBOT_RUNTIME__?.apiOrigin === 'http://localhost:19380'"), "The local backend was not restored.")
  await emailSignInChecks({call,execute,button,input,waitFor,screenshot,fixture,restart:restartApp})
  if (process.env.OPENBOT_CHECK_LOCAL_MAIL==='1') {
    const {backendMailChecks}=await import('./backend-mail.mjs')
    await backendMailChecks({call,execute,button,input,waitFor,screenshot,restart:restartApp})
  }
  console.log("PASS: packaged chat, files, per-service signed storage grants, private credentials, WebSocket IPC, and service isolation")
} catch (error) {
  if (session) await screenshot("failure").catch(() => {})
  if (session) console.error(await execute("return {errors:globalThis.__e2eErrors, text:document.body.innerText.slice(0,1500)}").catch(() => "The native page ended."))
  throw error
} finally {
  if (session) await call("", undefined, "DELETE").catch(() => {})
  for (const child of children.reverse()) child.kill("SIGTERM")
  await fixture?.close()
}
