import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { loadEnvFile } from "node:process"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** The default service is public build configuration, never a credential.
 * @param {string | undefined} input
 * @param {{allowLocalHttp?: boolean}} options
 */
export function defaultServiceOrigin(input, options = {}) {
  if (!input) throw new Error("Set OPENBOT_DEFAULT_API_ORIGIN in the build environment or .env.")
  const url = new URL(input.trim())
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  const localHttp = options.allowLocalHttp && url.protocol === "http:" && loopback
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.href !== `${url.origin}/`)
    throw new Error("OPENBOT_DEFAULT_API_ORIGIN must be an HTTPS origin without a path, query, or credentials.")
  return url.origin
}

/** @param {string | undefined} input */
export function nativeClientId(input) {
  const value = input ?? "openbot-one"
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("OPENBOT_NATIVE_CLIENT_ID must be a public client name with 1 to 128 letters, digits, dots, underscores or hyphens.")
  return value
}

/** @param {string[]} args */
export function needsDefaultService(args) {
  return !args.some((value) => ["--help", "-h", "--version", "-V"].includes(value))
    && (args[0] === "dev" || args[0] === "build" || (["android", "ios"].includes(args[0] ?? "") && ["dev", "build"].includes(args[1] ?? "")))
}

/** @param {string[]} args */
export function isDevelopmentCommand(args) {
  return args[0] === "dev" || (["android", "ios"].includes(args[0] ?? "") && args[1] === "dev") || args.includes("--debug")
}

function main() {
  const root = fileURLToPath(new URL("../", import.meta.url))
  try { loadEnvFile(resolve(root, ".env")) }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error }
  const args = process.argv.slice(2)
  if (needsDefaultService(args)) process.env.OPENBOT_DEFAULT_API_ORIGIN = defaultServiceOrigin(process.env.OPENBOT_DEFAULT_API_ORIGIN, { allowLocalHttp: isDevelopmentCommand(args) })
  if (needsDefaultService(args)) process.env.OPENBOT_NATIVE_CLIENT_ID = nativeClientId(process.env.OPENBOT_NATIVE_CLIENT_ID)
  const cli = createRequire(import.meta.url).resolve("@tauri-apps/cli/tauri.js")
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: "inherit", env: process.env, shell: false })
  child.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1)
  })
  for (const signal of /** @type {NodeJS.Signals[]} */ (["SIGINT", "SIGTERM"]))
    process.on(signal, () => child.kill(signal))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "Could not start Tauri."}\n`); process.exitCode = 1 }
}
