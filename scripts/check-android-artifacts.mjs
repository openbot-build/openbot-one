import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { dirname, join, posix, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Integrity only. A matching hash does not establish signature or device acceptance.
// Resolve saved basenames beside the manifest so the archive can move between hosts.
/** @param {string} manifestPath */
export async function checkAndroidArtifacts(manifestPath) {
  const directory = dirname(resolve(manifestPath))
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const records = Array.isArray(manifest) ? manifest : manifest.artifacts
  if (!Array.isArray(records)) throw new Error("The saved artifact manifest has no records.")
  const results = []
  for (const name of ["openbot-one-arm64-debug.apk", "openbot-one-current-debug.apk"]) {
    const matches = records.filter(item => typeof item?.path === "string"
      && posix.basename(item.path.replaceAll("\\", "/")) === name)
    const record = matches[0]
    if (matches.length !== 1 || !Number.isSafeInteger(record.bytes) || record.bytes <= 0
      || !/^[a-f0-9]{64}$/.test(record.sha256 ?? ""))
      throw new Error("The saved artifact manifest is incomplete or ambiguous for " + name)
    const path = join(directory, name)
    const file = await stat(path)
    if (!file.isFile() || file.size !== record.bytes) throw new Error("The saved APK size changed: " + name)
    const hash = createHash("sha256")
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if (hash.digest("hex") !== record.sha256) throw new Error("The saved APK checksum changed: " + name)
    results.push({path, bytes:file.size, sha256:record.sha256, integrity:"passed", device:"not accepted"})
  }
  return results
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== "--manifest"))
    throw new Error("Use --manifest <saved build manifest>, or no arguments for the preserved baseline.")
  const path = args[1] ?? fileURLToPath(new URL("../.cache/emulator/artifacts.json", import.meta.url))
  for (const result of await checkAndroidArtifacts(path)) console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
