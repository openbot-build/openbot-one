import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createServer } from "node:http"
import { loadEnvFile } from "node:process"
import { buildNative } from "./build-native.mjs"
import { verifyRustNotices } from "./rust-notices.mjs"

const root = fileURLToPath(new URL("../", import.meta.url))

/** @param {string} directory */
async function checkFiles(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error("The Web package must not contain symbolic links.")
    if (stat.isDirectory()) await checkFiles(path)
    else if (!stat.isFile()) throw new Error("The Web package has an unsupported file.")
  }
}

/**
 * Stage the shared UI without rewriting its code or importing private source.
 * The bootstrap must install the native runtime before the UI module runs.
 * @param {{ source: string, bootstrap: string, output: string, licenses?: Array<{source:string,name:string}> }} options
 */
export async function stageWebAssets({ source, bootstrap, output, licenses = [] }) {
  source = resolve(source)
  output = resolve(output)
  const contains = (/** @type {string} */ parent, /** @type {string} */ child) => {
    const path = relative(parent, child)
    return !path || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  }
  if (contains(source, output) || contains(output, source))
    throw new Error("The build output and Web package must not contain each other.")
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"))
  const contract = JSON.parse(await readFile(join(source, "dist/openbot-runtime.json"), "utf8"))
  if (manifest.name !== "@openbot-build/web" || contract.version !== 1 || contract.entry !== "index.html" || contract.packageVersion !== manifest.version)
    throw new Error("The Web package does not support native runtime version 1. Build and release the shared runtime entry first.")
  await checkFiles(join(source, "dist"))
  const runtime = await readFile(join(source, "runtime/runtime.js"), "utf8")
  const adapter = await readFile(bootstrap, "utf8")
  const html = await readFile(join(source, "dist/index.html"), "utf8")
  // Vite produces one module entry. Fail on another shape instead of silently
  // starting an app before its native transport and login adapter are ready.
  const entries = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*>[\s\S]*?<\/script>/gi)]
  const entry = entries[0]
  const src = entry?.[0].match(/\bsrc=["']([^"']+)["']/)?.[1]
  if (entries.length !== 1 || !entry || !src || !/^\/assets\/[a-zA-Z0-9_.-]+\.js$/.test(src))
    throw new Error("The Web build needs one local Vite module entry.")
  await mkdir(dirname(output), { recursive: true })
  const staging = await mkdtemp(join(dirname(output), ".one-web-"))
  try {
    await cp(join(source, "dist"), staging, { recursive: true })
    await mkdir(join(staging, "native"), { recursive: true })
    await writeFile(join(staging, "native/runtime.js"), runtime)
    await writeFile(join(staging, "native/bootstrap.js"), adapter)
    await writeFile(join(staging, "native/loader.js"), `await import("./bootstrap.js");\nif (globalThis.__OPENBOT_RUNTIME__?.version !== 1) throw new Error("The native app runtime is not ready.");\nawait import(${JSON.stringify(src)});\n`)
    await writeFile(join(staging, "index.html"), html.replace(entry[0], '<script type="module" src="/native/loader.js"></script>'))
    await mkdir(join(staging, "licenses"), { recursive: true })
    await cp(join(source, "LICENSE"), join(staging, "licenses/openbot-web.txt"))
    for (const license of licenses) {
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(license.name)) throw new Error("The notice file name must be local.")
      await cp(license.source, join(staging, "licenses", license.name))
    }
    await writeFile(join(staging, "openbot-build.json"), JSON.stringify({ runtime: 1, web: manifest.version }, null, 2) + "\n")
    await rm(output, { recursive: true, force: true })
    await rename(staging, output)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

const mime = new Map([
  ["html", "text/html; charset=utf-8"], ["js", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"], ["json", "application/json"],
  ["svg", "image/svg+xml"], ["png", "image/png"], ["ico", "image/x-icon"],
  ["woff2", "font/woff2"],
  ["woff", "font/woff"],
])

/** Local static asset server; it is not an API proxy. @param {string} directory */
export function webServer(directory) {
  directory = resolve(directory)
  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end()
      return
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname)
      if (pathname.includes("\\") || pathname.includes("\0")) throw new Error("Invalid path")
      let path = resolve(directory, `.${pathname}`)
      if (path !== directory && !path.startsWith(directory + sep)) throw new Error("Invalid path")
      if (pathname === "/" || !pathname.split("/").at(-1)?.includes(".")) path = join(directory, "index.html")
      const body = await readFile(path)
      const type = mime.get(path.split(".").at(-1) ?? "") ?? "application/octet-stream"
      response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
      response.end(request.method === "HEAD" ? undefined : body)
    } catch {
      response.writeHead(404).end()
    }
  })
}

async function main() {
  try { loadEnvFile(join(root, ".env")) }
  catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error }
  const require = createRequire(import.meta.url)
  let source = process.env.OPENBOT_WEB_PACKAGE_DIR
  if (!source) {
    try { source = dirname(require.resolve("@openbot-build/web/package.json")) }
    catch { throw new Error("Install a shared Web package with runtime version 1, or set OPENBOT_WEB_PACKAGE_DIR to a locally built package for development.") }
  }
  const rustNotices = await verifyRustNotices()
  const bootstrap = process.env.OPENBOT_NATIVE_BOOTSTRAP ?? await buildNative()
  await stageWebAssets({ source, bootstrap, output: join(root, "dist"), licenses: [
    {source:rustNotices, name:"rust.html"},
    {source:join(dirname(bootstrap), "dependencies.md"), name:"native-dependencies.md"},
  ] })
  if (process.argv[2] === "dev") {
    const server = webServer(join(root, "dist"))
    server.on("error", (error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
    server.listen(1420, process.env.TAURI_DEV_HOST || "localhost", () => {
      process.stdout.write("OpenBot assets are ready on port 1420. Rebuild shared assets to see changes.\n")
    })
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => server.close())
  } else if (process.argv[2] !== "build") {
    throw new Error("Use build or dev.")
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
