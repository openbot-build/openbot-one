import { spawn } from "node:child_process"
import { access, mkdir } from "node:fs/promises"
import { constants } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const directory = fileURLToPath(new URL("../.cache/emulator", import.meta.url))
const name = "openbot-one-api36"
/** @type {NodeJS.ProcessEnv & {ANDROID_USER_HOME:string, ANDROID_AVD_HOME:string}} */
const env = { ...process.env, ANDROID_USER_HOME: join(directory, "user"), ANDROID_EMULATOR_HOME: join(directory, "user"),
  ANDROID_AVD_HOME: join(directory, "avd"), ADB_SERVER_SOCKET: "tcp:127.0.0.1:19373", ANDROID_ADB_SERVER_PORT: "19373" }
// Desktop WebKit libraries conflict with the emulator's bundled C++ runtime.
delete env.LD_LIBRARY_PATH

/** @param {string} command @param {string[]} args @param {string | undefined} input */
function run(command, args, input = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: false, stdio: ["pipe", "inherit", "inherit"] })
    child.stdin.end(input)
    const interrupt = () => child.kill("SIGINT")
    const terminate = () => child.kill("SIGTERM")
    process.on("SIGINT", interrupt)
    process.on("SIGTERM", terminate)
    child.on("error", reject)
    child.on("exit", (code, signal) => {
      process.off("SIGINT", interrupt)
      process.off("SIGTERM", terminate)
      code === 0 || signal === "SIGINT" || signal === "SIGTERM" ? resolve(undefined) : reject(new Error(`${command} stopped with code ${code}.`))
    })
  })
}

async function main() {
  await Promise.all([mkdir(env.ANDROID_AVD_HOME, { recursive: true }), mkdir(env.ANDROID_USER_HOME, { recursive: true })])
  try { await access(join(env.ANDROID_AVD_HOME, name + ".avd/config.ini")) }
  catch { await run("avdmanager", ["create", "avd", "--name", name, "--package", "system-images;android-36;google_apis;x86_64", "--device", "pixel_7"], "no\n") }
  await run("adb", ["-P", "19373", "start-server"])
  let acceleration = "off"
  try { await access("/dev/kvm", constants.R_OK | constants.W_OK); acceleration = "auto" }
  catch { process.stdout.write("KVM is unavailable. Starting the software CPU emulator.\n") }
  process.stdout.write("Starting emulator-5558. Use adb -P 19373 for this isolated test device.\n")
  await run("emulator", ["-avd", name, "-port", "5558", "-no-window", "-no-snapshot", "-no-audio", "-no-boot-anim", "-gpu", "swiftshader", "-accel", acceleration, "-cores", "2", "-memory", "2048"])
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : "The Android emulator could not start."}\n`); process.exitCode = 1 })
