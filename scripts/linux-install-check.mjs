import { spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { mkdir,readFile,writeFile } from "node:fs/promises"
import { resolve,join } from "node:path"
import { fileURLToPath } from "node:url"

if(process.platform!=="linux"||process.arch!=="x64")throw new Error("Run Linux package checks on an x64 Docker host.")
const root=fileURLToPath(new URL("../",import.meta.url))
const args=process.argv.slice(2)
if(args.some(arg=>arg!=="--fixture")||args.length>1)throw new Error("Use --fixture for an isolated controlled API, or no option for the running local backend.")
const fixture=args.includes("--fixture")
const output=resolve(root,process.env.OPENBOT_LINUX_ARTIFACT_DIR??".cache/linux-packages")
await mkdir(output,{recursive:true})
/** @type {import("node:child_process").ChildProcess | undefined} */
let activeChild
const stop=()=>activeChild?.kill("SIGTERM")
process.once("SIGINT",stop);process.once("SIGTERM",stop)
/** @param {string[]} args @param {boolean} [capture] */
async function docker(args,capture=false) {
  const child=spawn("docker",args,{cwd:root,stdio:["ignore",capture?"pipe":"inherit","inherit"]})
  activeChild=child
  let text=""
  child.stdout?.on("data",chunk=>{text+=chunk})
  const [code,signal]=await once(child,"close")
  activeChild=undefined
  if(code!==0||signal)throw new Error("The Linux package check failed: docker "+args.slice(0,2).join(" "))
  return text.trim()
}
const manifest=JSON.parse(await readFile(join(output,"build.json"),"utf8"))
if(!/^sha256:[a-f0-9]{64}$/.test(manifest.image))throw new Error("The package record needs an immutable local builder image.")
const builderImage="openbot-one-linux-check-builder:"+manifest.image.slice(7)
await docker(["image","tag",manifest.image,builderImage])
const checks=[]
for(const [format,file,image] of [
  ["deb","Smoke.Dockerfile","openbot-one-linux-smoke:local"],
  ["appimage","AppImage.Dockerfile","openbot-one-linux-appimage-test:local"],
]) {
  await docker(["build","--platform","linux/amd64","--progress","plain","--build-arg","BUILDER_IMAGE="+builderImage,"-f","dev/linux/"+file,"-t",image,"."])
  const name="openbot-one-install-"+format+"-"+randomUUID()
  const directory=join(output,format+(fixture?"-fixture":"-local")+"-check")
  await mkdir(directory,{recursive:true})
  const container=await docker(["run","-d","--init","--name",name,"--network",fixture?"none":"host",image,"sleep","infinity"],true)
  if(!/^[a-f0-9]{64}$/.test(container))throw new Error("Docker did not return the owned test container.")
  try {
    if(format==="deb")await docker(["exec","-u","root",container,"node","/check/linux-package-policy.mjs"])
    await docker(["exec","-e","OPENBOT_INSTALL_FIXTURE="+(fixture?"1":"0"),container,"node","/check/linux-install.mjs"])
    for(const file of ["result.json","installed-signed-in.png"])await docker(["cp",container+":/results/"+file,join(directory,file)])
    const result=JSON.parse(await readFile(join(directory,"result.json"),"utf8"))
    if(format==="deb") {
      await docker(["cp",container+":/results/dependency-policy.json",join(directory,"dependency-policy.json")])
      result.dependencyPolicy=JSON.parse(await readFile(join(directory,"dependency-policy.json"),"utf8"))
      if(!result.dependencyPolicy.passed)throw new Error("The Deb dependency policy did not pass.")
    }
    if(!result.passed)throw new Error("The installed app did not pass its checks.")
    const artifact=manifest.artifacts.find((/** @type {{format:string}} */ item)=>item.format===format)
    if(!artifact||artifact.sha256!==result.artifact?.sha256||artifact.bytes!==result.artifact?.bytes)
      throw new Error("The tested package does not match its build record.")
    if(format==="deb") {
      await docker(["exec","-u","root",container,"sh","-c",[
        "mkdir -p /results/config/build.openbot.one /results/data/build.openbot.one",
        "touch /results/config/build.openbot.one/user-data-retained /results/data/build.openbot.one/user-data-retained",
        'package=$(cat /check/deb-name.txt)',
        'dpkg --purge "$package"',
        "test ! -e /usr/bin/openbot-one",
        "test -e /results/config/build.openbot.one/user-data-retained",
        "test -e /results/data/build.openbot.one/user-data-retained",
        'if dpkg-query -L "$package" >/dev/null 2>&1; then exit 1; fi',
      ].join("\n")])
      result.uninstall={passed:true,packageRemoved:true,appDirectoriesRetained:true,
        scope:"Marker files in the app's config and data directories survived. Account or draft restoration is not tested by this check."}
    }
    await writeFile(join(directory,"result.json"),JSON.stringify(result,null,2)+"\n")
    checks.push({format,path:join(directory,"result.json"),passed:true,backend:result.backend})
  } finally {
    // Copy a failed run's evidence too, without replacing a passed result file.
    if(!checks.some(check=>check.format===format))await docker(["cp",container+":/results/result.json",join(directory,"failed.json")]).catch(()=>{})
    await docker(["stop",container]).catch(()=>{})
    await docker(["rm",container]).catch(()=>{})
  }
}
await writeFile(join(output,fixture?"install-fixture.json":"install-local.json"),JSON.stringify({passed:true,checks,scope:"Ubuntu 22.04 container UI and package checks; physical hardware is not checked."},null,2)+"\n")
console.log("PASS: both Linux formats ran the real UI and private login/logout; Debian removal preserved app-directory markers.")
