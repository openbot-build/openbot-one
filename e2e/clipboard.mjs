import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promisify } from "node:util"

const run = promisify(execFile)

// The caller owns an isolated Xvfb display. Never read the user's desktop clipboard.
export async function clipboardChecks({call, env}) {
  const text = "OpenBot " + randomUUID() + "\n中文 clipboard 🙂\nsecond line"
  const copied = await call("/execute/async", {
    script:"globalThis.__OPENBOT_RUNTIME__.writeClipboard(" + JSON.stringify(text)
      + ").then(() => arguments[0]({copied:true}), error => arguments[0]({error:String(error)}))",
    args:[],
  })
  assert.equal(copied.copied, true, copied.error)
  const read = () => run("xclip", ["-selection", "clipboard", "-out", "-target", "UTF8_STRING"], {
    env, timeout:5000, maxBuffer:65536,
  })
  assert.equal((await read()).stdout, text, "The native copy must reach the OS clipboard without changing text.")
  for (const command of ["read_text", "clear"]) {
    const result = await call("/execute/async", {
      script:"globalThis.__TAURI_INTERNALS__.invoke(" + JSON.stringify("plugin:clipboard-manager|" + command)
        + ").then(() => arguments[0]({allowed:true}), error => arguments[0]({error:String(error)}))",
      args:[],
    })
    assert.equal(result.allowed, undefined)
    assert.match(result.error, /not allowed|permission denied/i, "The command must be rejected by native permissions.")
  }
  assert.equal((await read()).stdout, text, "Denied clipboard commands must leave its contents unchanged.")
  console.log("PASS: native Unicode clipboard write reaches private X11; clipboard read and clear are denied.")
}
