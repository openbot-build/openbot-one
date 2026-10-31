import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { stageWebAssets, webServer } from "../scripts/web-assets.mjs"

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "openbot-assets-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "package")
  await mkdir(join(source, "dist/assets"), { recursive: true })
  await mkdir(join(source, "runtime"))
  await mkdir(join(source, "dist/licenses"))
  await writeFile(join(source, "dist/licenses/dependencies.md"), "Bundled Web dependency notices")
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "@openbot-build/web", version: "0.1.0" }))
  await writeFile(join(source, "dist/openbot-runtime.json"), JSON.stringify({ version: 1, packageVersion: "0.1.0", entry: "index.html" }))
  await writeFile(join(source, "dist/index.html"), '<html><script type="module" crossorigin src="/assets/app-123.js"></script></html>')
  await writeFile(join(source, "dist/assets/app-123.js"), "globalThis.uiStarted = true")
  await writeFile(join(source, "runtime/runtime.js"), "export const version = 1")
  await writeFile(join(source, "LICENSE"), "Shared UI license")
  const bootstrap = join(root, "adapter.js")
  await writeFile(bootstrap, "globalThis.__OPENBOT_RUNTIME__ = { version: 1 }")
  await writeFile(join(root, "native-notices.md"), "Native dependency notices")
  return { source, bootstrap, output: join(root, "dist"), licenses:[{source:join(root, "native-notices.md"),name:"native-dependencies.md"}] }
}

test("staging preserves assets and license and waits for the native adapter", async (t) => {
  const options = await fixture(t)
  await stageWebAssets(options)
  const html = await readFile(join(options.output, "index.html"), "utf8")
  assert.match(html, /src="\/native\/loader.js"/)
  assert.doesNotMatch(html, /src="\/assets\/app/)
  const loader = await readFile(join(options.output, "native/loader.js"), "utf8")
  assert.ok(loader.indexOf('await import("./bootstrap.js")') < loader.indexOf('await import("/assets/app-123.js")'))
  assert.match(loader, /throw new Error/)
  assert.equal(await readFile(join(options.output, "licenses/openbot-web.txt"), "utf8"), "Shared UI license")
  assert.equal(await readFile(join(options.output, "assets/app-123.js"), "utf8"), "globalThis.uiStarted = true")
  assert.equal(await readFile(join(options.output, "licenses/dependencies.md"), "utf8"), "Bundled Web dependency notices")
  assert.equal(await readFile(join(options.output, "licenses/native-dependencies.md"), "utf8"), "Native dependency notices")
})

test("old or mismatched Web packages cannot become native builds", async (t) => {
  const options = await fixture(t)
  await writeFile(join(options.source, "dist/openbot-runtime.json"), JSON.stringify({ version: 1, packageVersion: "0.0.0", entry: "index.html" }))
  await assert.rejects(stageWebAssets(options), /does not support/)
})

test("staging rejects remote entry scripts and symbolic links", async (t) => {
  const options = await fixture(t)
  await writeFile(join(options.source, "dist/index.html"), '<script type="module" src="https://evil.test/app.js"></script>')
  await assert.rejects(stageWebAssets(options), /one local Vite module/)
  await symlink(options.source, join(options.source, "dist/linked"), process.platform === "win32" ? "junction" : "dir")
  await assert.rejects(stageWebAssets(options), /symbolic links/)
})

test("the dev server serves routes and rejects file traversal and mutations", async (t) => {
  const options = await fixture(t)
  await stageWebAssets(options)
  const server = webServer(options.output)
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined))))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  assert.equal((await fetch(origin + "/c/chat")).status, 200)
  assert.equal((await fetch(origin + "/assets/missing.js")).status, 404)
  assert.equal((await fetch(origin + "/%2e%2e%2fpackage/package.json")).status, 404)
  assert.equal((await fetch(origin + "/%00")).status, 404)
  assert.equal((await fetch(origin + "/", { method: "POST" })).status, 405)
  assert.equal(await (await fetch(origin + "/assets/app-123.js", { method: "HEAD" })).text(), "")
})


test("asset staging rejects both nested and ancestor output before changing package files", async (t) => {
  const options = await fixture(t)
  const before = await readFile(join(options.source, "dist/index.html"), "utf8")
  for (const output of [options.source, join(options.source, "nested/output"), join(options.source, "../..")]) {
    await assert.rejects(stageWebAssets({...options, output}), /must not contain each other/)
    assert.equal(await readFile(join(options.source, "dist/index.html"), "utf8"), before)
  }
})
