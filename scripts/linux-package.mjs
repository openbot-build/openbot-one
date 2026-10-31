import { spawn } from "node:child_process"
import { once } from "node:events"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defaultServiceOrigin, nativeClientId } from "./tauri.mjs"

const root=fileURLToPath(new URL("../",import.meta.url))
const image="openbot-one-linux-build:local"
if(process.platform!=="linux"||process.arch!=="x64")throw new Error("This packaging recipe builds Linux x64 in a Docker Ubuntu baseline.")
const args=process.argv.slice(2)
if(args.length>1||args.some(arg=>arg!=="--reuse-image"))throw new Error("Use no option, or --reuse-image after a completed image build.")
const output=resolve(root,process.env.OPENBOT_LINUX_ARTIFACT_DIR??".cache/linux-packages")
const origin=defaultServiceOrigin(process.env.OPENBOT_DEFAULT_API_ORIGIN??"http://localhost:19380",{allowLocalHttp:true})
const clientId=nativeClientId(process.env.OPENBOT_NATIVE_CLIENT_ID)
const nodeVersion=(await readFile(join(root,".node-version"),"utf8")).trim()
const rustVersion=(await readFile(join(root,"rust-toolchain.toml"),"utf8")).match(/^channel = "(\d+\.\d+\.\d+)"$/m)?.[1]
if(!/^\d+\.\d+\.\d+$/.test(nodeVersion)||!rustVersion)throw new Error("The package tools must have exact versions.")
/** @type {import("node:child_process").ChildProcess | undefined} */
let activeChild
const stop=()=>activeChild?.kill("SIGTERM")
process.once("SIGINT",stop);process.once("SIGTERM",stop)
/** @param {string} command @param {string[]} args @param {boolean} [capture] */
async function run(command,args,capture=false) {
  const child=spawn(command,args,{cwd:root,stdio:["ignore",capture?"pipe":"inherit","inherit"]})
  activeChild=child
  let text=""
  child.stdout?.on("data",bytes=>{text+=bytes})
  const [code,signal]=await once(child,"close")
  activeChild=undefined
  if(code!==0||signal)throw new Error(command+" failed; no package record was published.")
  return text.trim()
}
await mkdir(output,{recursive:true})
const imageFile=join(output,".image-"+randomUUID()+".txt")
if(!args.includes("--reuse-image"))await run("docker",["build","--platform","linux/amd64","--iidfile",imageFile,"--progress","plain","-f","dev/linux/Dockerfile","-t",image,
  "--build-arg","NODE_VERSION="+nodeVersion,"--build-arg","RUST_VERSION="+rustVersion,
  "--build-arg","OPENBOT_DEFAULT_API_ORIGIN="+origin,"--build-arg","OPENBOT_NATIVE_CLIENT_ID="+clientId,"."])
const imageId=args.includes("--reuse-image")
  ? await run("docker",["image","inspect",image,"--format","{{.Id}}"],true)
  : (await readFile(imageFile,"utf8")).trim()
await rm(imageFile,{force:true})
if(!/^sha256:[a-f0-9]{64}$/.test(imageId))throw new Error("Docker did not return the built image identity.")
const config=JSON.parse(await run("docker",["image","inspect",imageId,"--format","{{json .Config.Env}}"],true))
if(!Array.isArray(config)||!config.includes("OPENBOT_DEFAULT_API_ORIGIN="+origin)||!config.includes("OPENBOT_NATIVE_CLIENT_ID="+clientId))throw new Error("The reused image has a different default service. Build it again.")
const actualNode=await run("docker",["run","--rm",imageId,"node","--version"],true)
const actualRust=await run("docker",["run","--rm",imageId,"rustc","--version"],true)
if(actualNode!=="v"+nodeVersion||!actualRust.startsWith("rustc "+rustVersion+" "))throw new Error("The reused image has different build tools.")
const container=await run("docker",["create",imageId],true)
if(!/^[a-f0-9]{64}$/.test(container))throw new Error("Docker did not return an owned container ID.")
const staging=join(output,".stage-"+randomUUID())
await mkdir(staging)
try {
  for(const type of ["deb","appimage"])await run("docker",["cp",container+":/src/src-tauri/target/debug/bundle/"+type,staging])
  const artifacts=[]
  for(const [type,extension] of [["deb",".deb"],["appimage",".AppImage"]]) {
    const directory=join(staging,type)
    const files=(await readdir(directory)).filter(name=>name.endsWith(extension))
    if(files.length!==1)throw new Error("The package build must produce exactly one "+type+" artifact.")
    const name=files[0],from=join(directory,name)
    const bytes=await readFile(from),sha256=createHash("sha256").update(bytes).digest("hex")
    const target=join(output,name)
    await rename(from,target)
    artifacts.push({path:target,bytes:bytes.length,sha256,format:type,architecture:"x86_64",profile:"debug",install:"not accepted"})
  }
  const packages=await run("docker",["run","--rm",imageId,"dpkg-query","-W"],true)
  await writeFile(join(output,"build-packages.txt"),packages+"\n")
  const record={builtAt:new Date().toISOString(),image:imageId,base:"Ubuntu 22.04; pinned base digest in dev/linux/Dockerfile",
    defaultService:origin,clientId,node:nodeVersion,rust:rustVersion,source:"real locked Web package; no local UI override",
    artifacts,limits:["Debug packages, not a signed release.","Installation and runtime tests are recorded separately."]}
  const recordPath=join(output,"build.json")
  await writeFile(recordPath+".tmp",JSON.stringify(record,null,2)+"\n")
  await rename(recordPath+".tmp",recordPath)
  console.log(JSON.stringify(record,null,2))
} finally {
  await run("docker",["rm",container]).catch(()=>{})
  await rm(staging,{recursive:true,force:true})
}
