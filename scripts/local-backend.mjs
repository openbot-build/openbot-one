import { spawn, execFileSync } from "node:child_process"
import { constants } from "node:fs"
import { mkdir, access, copyFile, chmod } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const backend = join(root, ".cache/backend-0.1.5")
const revision = "770126bda4c0cb5f737c42f54078ee9d67400d5d"

/** @param {string} command @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} env */
function run(command, args, cwd = root, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", shell: false })
    const stop = /** @param {NodeJS.Signals} signal */ (signal) => child.kill(signal)
    const interrupt = () => stop("SIGINT")
    const terminate = () => stop("SIGTERM")
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", terminate)
    child.on("error", reject)
    child.on("exit", (code) => {
      process.off("SIGINT", interrupt)
      process.off("SIGTERM", terminate)
      code === 0 ? resolve(undefined) : reject(new Error(`${command} exited before the local backend was ready.`))
    })
  })
}

async function main() {
  await mkdir(join(root, ".cache"), { recursive: true })
  try { await access(join(backend, ".git")) }
  catch { await run("git", ["clone", "--depth", "1", "--branch", "v0.1.5", "https://github.com/openbot-build/openbot.git", backend]) }
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: backend, encoding: "utf8" }).trim()
  if (actual !== revision) throw new Error("The local backend checkout does not match the pinned client release.")
  // This version uses the same isolated database as the first development
  // checkout. Keep its encryption keys when making the new checkout.
  try {
    await copyFile(join(root, ".cache/backend/.env.development"), join(backend, ".env.development"), constants.COPYFILE_EXCL)
    await chmod(join(backend, ".env.development"), 0o600)
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || !["ENOENT", "EEXIST"].includes(String(error.code))) throw error
  }
  await run("docker", ["compose", "-f", "dev/compose.yaml", "up", "--detach", "--wait"])
  // Each backend command uses its own required project environment. The local
  // clone keeps this task separate from any edits in the user's main checkout.
  await run("devenv", ["shell", "--", "pnpm", "install", "--frozen-lockfile"], backend)
  await run("devenv", ["shell", "--", "pnpm", "dev:setup"], backend)
  await run("devenv", ["shell", "--", "pnpm", "--filter-prod", "@openbot-build/openbot...", "build"], backend)
  const env = {
    ...process.env,
    OPENBOT_DATABASE_URL: "postgres://openbot_dev:openbot_dev@127.0.0.1:19332/openbot",
    OPENBOT_HOST: "127.0.0.1",
    OPENBOT_PORT: "19380",
    OPENBOT_DEV_PUBLIC_ORIGIN: "http://localhost:19380",
    OPENBOT_DEV_S3_ENDPOINT: "http://127.0.0.1:19300",
    OPENBOT_DEV_S3_BUCKET: "openbot",
    OPENBOT_DEV_S3_ACCESS_KEY_ID: "openbot_dev",
    OPENBOT_DEV_S3_SECRET_ACCESS_KEY: "openbot_dev_secret",
  }
  await run("devenv", ["shell", "--", "pnpm", "--filter", "@openbot-build/openbot", "migrate"], backend, env)
  process.stdout.write("Starting the local development backend at http://localhost:19380\n")
  await run("devenv", ["shell", "--", "pnpm", "--filter", "@openbot-build/openbot", "start:development"], backend, env)
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "The local backend failed."}\n`); process.exitCode = 1 })
