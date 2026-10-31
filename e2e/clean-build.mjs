import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { cp, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createHash } from "node:crypto"

if(process.platform!=="linux")throw new Error("Use this check in the pinned Linux devenv shell. Hosted native checks run from GitHub checkouts.")
const root=fileURLToPath(new URL("../",import.meta.url))
await mkdir(join(root,".cache/clean-build"),{recursive:true})
const directory=await mkdtemp(join(root,".cache/clean-build/run "))
const exec=promisify(execFile)
const {stdout}=await exec("git",["ls-files","--cached","--others","--exclude-standard","-z"],{cwd:root})
for(const path of stdout.split("\0").filter(Boolean)) {
  if(path.startsWith(".cache/")||path.startsWith("node_modules/")||path===".env")throw new Error("The clean source list contains local state.")
  const from=join(root,path),to=join(directory,path)
  if(!(await lstat(from)).isFile())throw new Error("The clean source list must contain regular files.")
  await mkdir(resolve(to,".."),{recursive:true})
  await cp(from,to)
}
const env={...process.env,OPENBOT_DEFAULT_API_ORIGIN:"http://localhost:19380",
  OPENBOT_NATIVE_CLIENT_ID:"openbot-one",NPM_CONFIG_USERCONFIG:"/dev/null",
  // Sharing only Cargo compilation output is the same as a CI build cache.
  // JavaScript installation and frontend outputs start empty.
  CARGO_TARGET_DIR:join(root,"src-tauri/target"),
}
for(const name of ["OPENBOT_WEB_PACKAGE_DIR","OPENBOT_NATIVE_BOOTSTRAP","NODE_AUTH_TOKEN","NPM_TOKEN"])delete env[name]
let child
const stop=()=>child?.kill("SIGTERM")
process.once("SIGINT",stop);process.once("SIGTERM",stop)
async function run(args) {
  child=spawn("pnpm",args,{cwd:directory,env,stdio:"inherit"})
  const [code,signal]=await once(child,"exit")
  child=undefined
  if(code!==0||signal)throw new Error("The clean build failed: pnpm "+args.join(" "))
}
try {
  await run(["install","--frozen-lockfile"])
  await run(["typecheck"])
  await run(["test"])
  await run(["build"])
  await run(["desktop:build","--debug","--no-bundle","--ci"])
  const binary=join(directory,"openbot-one-linux-debug")
  await cp(join(env.CARGO_TARGET_DIR,"debug/openbot-one"),binary)
  const manifest=JSON.parse(await readFile(join(directory,"dist/openbot-build.json"),"utf8"))
  const packagePath=join(directory,"node_modules/@openbot-build/web/package.json")
  const web=JSON.parse(await readFile(packagePath,"utf8"))
  if(web.name!=="@openbot-build/web"||manifest.runtime!==1||manifest.web!==web.version)throw new Error("The clean build did not stage the locked Web package.")
  const hash=createHash("sha256").update(await readFile(binary)).digest("hex")
  const result={passed:true,directory,defaultService:env.OPENBOT_DEFAULT_API_ORIGIN,
    webPackage:{name:web.name,version:web.version,source:"locked local package dependency"},
    emptyJavaScriptInstall:true,noSiblingUi:true,noDotEnv:true,noRegistryTokenPassed:true,
    cargoCompilationCache:env.CARGO_TARGET_DIR,binary:{path:binary,sha256:hash},
    scope:"Linux clean source copy, real Web package and packaged debug binary; not an OS UI acceptance"}
  await writeFile(join(directory,"result.json"),JSON.stringify(result,null,2)+"\n")
  console.log("PASS: clean source copy installs, checks and builds the real Linux app.")
  console.log("Evidence: "+join(directory,"result.json"))
} finally {
  process.off("SIGINT",stop);process.off("SIGTERM",stop)
  if(child&&child.exitCode===null&&child.signalCode===null)child.kill("SIGTERM")
}
