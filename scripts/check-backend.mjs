import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { loadEnvFile } from "node:process"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { defaultServiceOrigin } from "./tauri.mjs"

class BackendCheckError extends Error {}

/** @typedef {{ id: string, secret: string }} ServiceCredentials */
/**
 * Diagnose the two authentication layers without following redirects or
 * printing credentials, cookies, response bodies, or signed login URLs.
 * @param {string} origin
 * @param {{ token?: string, service?: ServiceCredentials, fetch?: typeof fetch }} options
 */
export async function probeBackend(origin, options = {}) {
  origin = defaultServiceOrigin(origin, { allowLocalHttp: true })
  if (options.token && options.service) throw new Error("Choose one Access authentication method.")
  const headers = new Headers({ Accept: "application/json" })
  if (options.token) headers.set("Cf-Access-Token", options.token)
  if (options.service) {
    if (!options.service.id || !options.service.secret) throw new Error("Both Access service credentials are required.")
    headers.set("CF-Access-Client-Id", options.service.id)
    headers.set("CF-Access-Client-Secret", options.service.secret)
  }
  const send = options.fetch ?? globalThis.fetch
  const results = await Promise.all(["/health", "/auth/session"].map(async (path) => {
    const response = await send(origin + path, { headers, redirect: "manual", signal: AbortSignal.timeout(15000) })
    const location = response.headers.get("location")
    const redirect = location ? new URL(location, origin) : undefined
    const redirectOrigin = redirect?.origin
    const accessChallenge = Boolean(redirect && (
      redirect.hostname.endsWith(".cloudflareaccess.com") ||
      (redirect.origin === origin && redirect.pathname.startsWith("/cdn-cgi/access/"))
    ))
    const type = response.headers.get("content-type")?.split(";")[0] ?? ""
    let sessionValid = false
    if (path === "/auth/session" && response.status === 200 && type === "application/json") {
      try {
        const data = await response.json()
        sessionValid = typeof data?.userId === "string" && data.userId.length > 0
          && Array.isArray(data.memberships) && typeof data.platformAdmin === "boolean"
          && typeof data.expiresAt === "string" && Date.parse(data.expiresAt) > Date.now()
      } catch { /* A JSON error page is not a signed-in account. */ }
    } else await response.body?.cancel()
    return { path, status: response.status, type, accessChallenge, sessionValid, ...(redirectOrigin ? { redirectOrigin } : {}) }
  }))
  const accessRequired = results.some((result) => result.accessChallenge)
  const health = results.find((result) => result.path === "/health")
  const session = results.find((result) => result.path === "/auth/session")
  const reachable = !accessRequired && health?.status === 200 && health.type !== "text/html"
  const openbotSignedIn = reachable && session?.sessionValid === true
  return { origin, accessRequired, reachable, openbotSignedIn, results }
}

/** @param {string} origin */
async function login(origin) {
  await new Promise((resolve, reject) => {
    // --quiet prevents the JWT from entering terminal or chat output.
    const child = spawn("cloudflared", ["access", "login", "--quiet", origin], { stdio: "inherit", shell: false })
    child.on("error", () => reject(new BackendCheckError("cloudflared is not available. Run this command through the project devenv.")))
    child.on("exit", (code) => code === 0 ? resolve(undefined) : reject(new BackendCheckError("Cloudflare Access login did not finish.")))
  })
}

/** @param {string} origin */
async function cachedToken(origin) {
  try {
    const { stdout } = await promisify(execFile)("cloudflared", ["access", "token", "--app", origin], { maxBuffer: 32768, timeout: 10000 })
    const token = stdout.trim()
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error()
    return token
  } catch {
    throw new BackendCheckError("The Access token is not available. Run pnpm backend:login to complete browser authentication.")
  }
}

async function main() {
  try { loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url))) }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error }
  const origin = defaultServiceOrigin(process.env.OPENBOT_DEFAULT_API_ORIGIN, { allowLocalHttp: true })
  const args = process.argv.slice(2)
  if (args.some((arg) => !["--login", "--cached-access"].includes(arg))) throw new BackendCheckError("Use --login or --cached-access.")
  if (args.length && origin.startsWith("http:")) throw new BackendCheckError("The local backend needs no Cloudflare Access login. Run pnpm backend:check.")
  let token = process.env.CF_ACCESS_TOKEN
  const id = process.env.CF_ACCESS_CLIENT_ID
  const secret = process.env.CF_ACCESS_CLIENT_SECRET
  if (Boolean(id) !== Boolean(secret)) throw new BackendCheckError("Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET for service authentication.")
  const service = id && secret ? { id, secret } : undefined
  if (args.includes("--login")) {
    if (token || service) throw new BackendCheckError("Remove process Access credentials before starting a user login.")
    await login(origin)
    token = await cachedToken(origin)
  } else if (args.includes("--cached-access")) token = await cachedToken(origin)
  const result = await probeBackend(origin, { token, service })
  process.stdout.write(JSON.stringify(result, null, 2) + "\n")
  if (!result.reachable) process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => { process.stderr.write((error instanceof BackendCheckError ? error.message : "The backend check failed. Check the HTTPS origin, Access credentials, and network. No credential details are logged.") + "\n"); process.exitCode = 1 })
