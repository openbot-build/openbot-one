import assert from "node:assert/strict"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { verifyRustNotices } from "../scripts/rust-notices.mjs"

test("a changed dependency lock or notice body cannot reuse a checked notice record", async t => {
  const source = fileURLToPath(new URL("../", import.meta.url))
  const root = await mkdtemp(join(tmpdir(), "openbot-notice-check-"))
  t.after(() => rm(root, {recursive:true, force:true}))
  /** @type {{inputs:Array<{path:string}>}} */
  const record = JSON.parse(await readFile(join(source, "vendor/third-party/rust.json"), "utf8"))
  for (const path of [...record.inputs.map(item => item.path), "vendor/third-party/rust.html", "vendor/third-party/rust.json"]) {
    await mkdir(dirname(join(root, path)), {recursive:true})
    await copyFile(join(source, path), join(root, path))
  }
  assert.equal(await verifyRustNotices(root), join(root, "vendor/third-party/rust.html"))
  const lock = await readFile(join(root, "src-tauri/Cargo.lock"))
  await writeFile(join(root, "src-tauri/Cargo.lock"), Buffer.concat([lock, Buffer.from("\n# changed dependency\n")]))
  await assert.rejects(verifyRustNotices(root), /stale for src-tauri\/Cargo.lock/)
  await writeFile(join(root, "src-tauri/Cargo.lock"), lock)
  const upstream = record.inputs.find(item => item.path.startsWith("vendor/third-party/upstream/"))
  assert.ok(upstream, "The collection must carry original upstream notice files.")
  const original = await readFile(join(root, upstream.path))
  await writeFile(join(root, upstream.path), "changed upstream notice")
  await assert.rejects(verifyRustNotices(root), /original upstream notice changed/i)
  await writeFile(join(root, upstream.path), original)
  await writeFile(join(root, "vendor/third-party/rust.html"), "incomplete notices")
  await assert.rejects(verifyRustNotices(root), /generated Rust notices changed/)
})
