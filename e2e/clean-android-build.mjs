import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { cp, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createHash } from "node:crypto"

if(process.platform!=="linux"||!process.env.ANDROID_HOME||!process.env.JAVA_HOME)
  throw new Error("Run this check with the Linux android devenv profile.")
const root=fileURLToPath(new URL("../",import.meta.url))
const selected=process.argv.slice(2)
if(!selected.length)selected.push("aarch64")
if(selected.some(target=>!["aarch64","x86_64"].includes(target))||new Set(selected).size!==selected.length)
  throw new Error("Choose aarch64, x86_64, or both.")
await mkdir(join(root,".cache/android-clean-build"),{recursive:true})
const directory=await mkdtemp(join(root,".cache/android-clean-build/run "))
const exec=promisify(execFile)
const {stdout}=await exec("git",["ls-files","--cached","--others","--exclude-standard","-z"],{cwd:root})
const paths=stdout.split("\0").filter(Boolean)
const entry="src-tauri/gen/android/app/src/main/java/build/openbot/one/MainActivity.kt"
if(!paths.includes(entry))throw new Error("The Git source list omits the Android activity.")
for(const path of paths) {
  if(path.startsWith(".cache/")||path.startsWith("node_modules/")||path===".env")
    throw new Error("The clean source list contains local state.")
  const from=join(root,path),to=join(directory,path)
  if(!(await lstat(from)).isFile())throw new Error("The clean source list must contain regular files.")
  await mkdir(dirname(to),{recursive:true})
  await cp(from,to)
}
const android=join(directory,"src-tauri/gen/android")
for(const path of ["tauri.settings.gradle","app/tauri.build.gradle.kts","local.properties",
  "app/src/main/java/build/openbot/one/generated/WryActivity.kt"]) {
  let present=false
  try { await lstat(join(android,path));present=true }
  catch(error) { if(!(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT"))throw error }
  if(present)throw new Error("The source copy contains a machine-generated Android input: "+path)
}
const env={...process.env,OPENBOT_DEFAULT_API_ORIGIN:"http://localhost:19380",
  OPENBOT_NATIVE_CLIENT_ID:"openbot-one",OPENBOT_ANDROID_ARTIFACT_DIR:".cache/artifacts",
  // Android code generation writes into the app project. A different source
  // directory cannot safely reuse those side effects from a Cargo target cache.
  NPM_CONFIG_USERCONFIG:"/dev/null",CARGO_TARGET_DIR:join(directory,"src-tauri/target"),
}
for(const name of ["OPENBOT_WEB_PACKAGE_DIR","OPENBOT_NATIVE_BOOTSTRAP","NODE_AUTH_TOKEN","NPM_TOKEN"])delete env[name]
let child
const stop=()=>child?.kill("SIGTERM")
process.once("SIGINT",stop);process.once("SIGTERM",stop)
async function run(args) {
  child=spawn("pnpm",args,{cwd:directory,env,stdio:"inherit"})
  const [code,signal]=await once(child,"close")
  child=undefined
  if(code!==0||signal)throw new Error("The clean Android build failed: pnpm "+args.join(" "))
}
try {
  await run(["install","--frozen-lockfile"])
  await run(["typecheck"])
  await run(["test"])
  await run(["android:package",...selected])
  const artifacts=[]
  for(const target of selected) {
    const artifact=JSON.parse(await readFile(join(directory,".cache/artifacts",target+"-build.json"),"utf8"))
    const listing=(await exec("jar",["--list","--file",artifact.path],{env})).stdout
    const dex=listing.split(/\r?\n/).filter(name=>/^classes(?:[1-9]\d*)?\.dex$/.test(name))
    if(!dex.length)throw new Error("The clean APK has no DEX classes.")
    const unpack=join(directory,".cache/dex-check",target)
    await mkdir(unpack,{recursive:true})
    await exec("jar",["--extract","--file",artifact.path,...dex],{env,cwd:unpack})
    const classes=await Promise.all(dex.map(name=>readFile(join(unpack,name))))
    if(!classes.some(bytes=>bytes.includes(Buffer.from("Lbuild/openbot/one/MainActivity;"))))
      throw new Error("The clean APK omits MainActivity.")
    artifacts.push({...artifact,mainActivityInDex:true})
  }
  await writeFile(join(directory,".cache/artifacts/verified.json"),JSON.stringify(artifacts,null,2)+"\n")
  const result={passed:true,directory,defaultService:env.OPENBOT_DEFAULT_API_ORIGIN,
    emptyJavaScriptInstall:true,noSiblingUi:true,noDotEnv:true,noRegistryTokenPassed:true,
    generatedAndroidInputsAbsentAtStart:true,mainActivityInDex:true,
    sourceEntry:{path:entry,sha256:createHash("sha256").update(await readFile(join(directory,entry))).digest("hex")},
    freshCargoTarget:env.CARGO_TARGET_DIR,artifacts,
    scope:"Fresh Android source copy and selected real debug APKs; no emulator, device or runtime acceptance."}
  await writeFile(join(directory,"result.json"),JSON.stringify(result,null,2)+"\n")
  console.log("PASS: clean Android source builds signed single-ABI APKs containing MainActivity.")
  console.log("Evidence: "+join(directory,"result.json"))
} finally {
  process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop)
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill("SIGTERM")
}
