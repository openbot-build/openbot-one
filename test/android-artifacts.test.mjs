import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { checkAndroidArtifacts } from "../scripts/check-android-artifacts.mjs"

/** @param {import("node:test").TestContext} t */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "openbot-apk-integrity-"))
  t.after(() => rm(root, {recursive:true, force:true}))
  const records = []
  for (const name of ["openbot-one-arm64-debug.apk", "openbot-one-current-debug.apk"]) {
    const body = Buffer.from("saved artifact " + name)
    await writeFile(join(root, name), body)
    records.push({path:"C:\\old-host\\archives\\" + name, bytes:body.length,
      sha256:createHash("sha256").update(body).digest("hex")})
  }
  const manifest = join(root, "verified.json")
  await writeFile(manifest, JSON.stringify(records))
  return {root, records, manifest}
}

test("saved APKs can move with either build manifest without reading old host paths", async t => {
  const {root, records, manifest} = await fixture(t)
  const results = await checkAndroidArtifacts(manifest)
  assert.equal(results.length, 2)
  assert.equal(results[0].path, join(root, "openbot-one-arm64-debug.apk"))
  assert.ok(results.every(result => result.device === "not accepted"))
  await writeFile(manifest, JSON.stringify({artifacts:records}))
  assert.deepEqual(await checkAndroidArtifacts(manifest), results)
})

test("same-size corruption, truncation and duplicate build records fail integrity", async t => {
  const {root, records, manifest} = await fixture(t)
  const path = join(root, "openbot-one-arm64-debug.apk")
  const body = await readFile(path)
  const changed = Buffer.from(body)
  changed[0] ^= 1
  await writeFile(path, changed)
  await assert.rejects(checkAndroidArtifacts(manifest), /checksum changed/)
  await writeFile(path, body.subarray(1))
  await assert.rejects(checkAndroidArtifacts(manifest), /size changed/)
  await writeFile(path, body)
  await writeFile(manifest, JSON.stringify([...records, records[0]]))
  await assert.rejects(checkAndroidArtifacts(manifest), /ambiguous/)
})
