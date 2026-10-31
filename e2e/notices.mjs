import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

// Read notices through the packaged WebView protocol, including font notices.
export async function noticeChecks({call}) {
  const files = ["dependencies.md", "openbot-web.txt", "dm-sans.txt", "dm-mono.txt", "fonts.json", "native-dependencies.md", "rust.html"]
  for (const name of files) {
    const expected = await readFile(join("dist/licenses", name), "utf8")
    const html = name === "rust.html"
    const actual = await call("/execute/async", {
      script: "const expected = arguments[0]; const done = arguments[1]; fetch(" + JSON.stringify("/licenses/" + name) + ").then(async response => { const text = await response.text(); "
        + (html
          // Tauri parses HTML when adding CSP metadata. Compare all rendered bodies.
          ? "const bodies = value => [...new DOMParser().parseFromString(value, 'text/html').querySelectorAll('pre')].map(node => node.textContent.trim()); const before = bodies(expected); const after = bodies(text); done({status:response.status,count:after.length,unchanged:before.length > 0 && JSON.stringify(before) === JSON.stringify(after)});"
          : "done({status:response.status,unchanged:text === expected});")
        + " }, error => done({error:String(error)}))",
      args:[expected],
    })
    assert.equal(actual.status, 200, "The app must serve its bundled notice: " + name)
    assert.equal(actual.unchanged, true, "The embedded notice changed: " + name)
  }
  console.log("PASS: all seven notice assets are readable from the packaged native app.")
}
