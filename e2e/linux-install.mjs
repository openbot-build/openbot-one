import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import { spawn,execFile } from "node:child_process"
import { once } from "node:events"
import { promisify } from "node:util"
import { mkdir,readFile,writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import WebSocket from "ws"
import {socketFixture} from "./socket-fixture.mjs"

const exec=promisify(execFile),output="/results"
await Promise.all(["config","data","cache"].map(name=>mkdir(join(output,name),{recursive:true,mode:0o700})))
const packageName=(await readFile("/check/deb-name.txt","utf8")).trim()
const format=process.env.OPENBOT_INSTALL_FORMAT??"deb"
let desktopEntry=false
let systemWebKitVersion
if(format==="deb") {
  systemWebKitVersion=(await exec("dpkg-query",["-W","-f=${Version}","libwebkit2gtk-4.1-0"])).stdout.trim()
  await exec("dpkg",["--compare-versions",systemWebKitVersion,"ge","2.40"])
  const listing=(await exec("dpkg-query",["-L",packageName])).stdout.trim().split("\n")
  assert.ok(listing.includes("/usr/bin/openbot-one"))
  const desktop=listing.filter(path=>path.endsWith(".desktop"))
  assert.equal(desktop.length,1)
  await exec("desktop-file-validate",desktop)
  const entry=await readFile(desktop[0],"utf8")
  assert.match(entry,/^Name=OpenBot$/m)
  assert.match(entry,/^Exec=.*openbot-one/m)
  desktopEntry=true
} else {
  await assert.rejects(exec("test",["-e","/usr/bin/openbot-one"]))
  await assert.rejects(exec("dpkg-query",["-W","libwebkit2gtk-4.1-0"]))
  await assert.rejects(exec("dpkg-query",["-W","libgtk-3-0"]))
}
const elf=(await exec("readelf",["-l",format==="deb"?"/usr/bin/openbot-one":"/packages/openbot.AppImage"])).stdout
assert.ok(!elf.includes("/nix/store"))
if(format==="deb")assert.match(elf,/\/lib64\/ld-linux-x86-64\.so\.2/)
const base="http://127.0.0.1:19844"
const env={...process.env,DISPLAY:":198",LIBGL_ALWAYS_SOFTWARE:"1",WEBKIT_DISABLE_COMPOSITING_MODE:"1",
  WEBKIT_INSPECTOR_HTTP_SERVER:"127.0.0.1:19844",DBUS_SESSION_BUS_ADDRESS:"unix:path=/results/missing-bus",
  XDG_CONFIG_HOME:join(output,"config"),XDG_DATA_HOME:join(output,"data"),XDG_CACHE_HOME:join(output,"cache"),
  APPIMAGE_EXTRACT_AND_RUN:"1"}
const children=[]
function start(command,args) {
  const child=spawn(command,args,{env,stdio:["ignore","pipe","pipe"]})
  children.push(child)
  child.stdout.on("data",data=>process.stderr.write(data))
  child.stderr.on("data",data=>process.stderr.write(data))
  child.on("error",error=>process.stderr.write(error.message+"\n"))
  return child
}
async function waitFor(check,message) {
  const end=Date.now()+20000
  while(Date.now()<end){try{if(await check())return}catch{}await delay(100)}
  throw new Error(message)
}
let inspector,targetId,nextId=0,signedIn=false,fixture
const calls=new Map()
async function protocol(method,params={}) {
  const id=++nextId
  return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{calls.delete(id);reject(new Error("Inspector call timed out: "+method))},15000)
    calls.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}})
    const command={id,method,params}
    inspector.send(JSON.stringify(targetId?{id:1_000_000_000+id,method:"Target.sendMessageToTarget",params:{targetId,message:JSON.stringify(command)}}:command))
  })
}
async function evaluate(script) {
  const result=await protocol("Runtime.evaluate",{expression:"(()=>{"+script+"})()",returnByValue:true,emulateUserGesture:true})
  if(result.wasThrown)throw new Error(result.result?.description??"The installed app script failed.")
  return result.result?.value
}
async function browser(script) {
  const key="__installCheck"+nextId
  await evaluate("globalThis["+JSON.stringify(key)+"]=undefined;(async()=>{"+script+"})().then(value=>{globalThis["+JSON.stringify(key)+"]={value}},error=>{globalThis["+JSON.stringify(key)+"]={error:String(error)}});return true")
  await waitFor(()=>evaluate("return !!globalThis["+JSON.stringify(key)+"]"),"The installed app action did not finish.")
  const result=await evaluate("return globalThis["+JSON.stringify(key)+"]")
  if(result.error)throw new Error(result.error)
  return result.value
}
const artifactBytes=await readFile(format==="deb"?"/packages/openbot.deb":"/packages/openbot.AppImage")
const artifact={bytes:artifactBytes.length,sha256:createHash("sha256").update(artifactBytes).digest("hex")}
const result={passed:false,packageName,format,artifact,backend:process.env.OPENBOT_INSTALL_FIXTURE==="1"?"controlled test peer":"running local backend 0.1.5",
  sandboxOverride:env.WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS==="1",
  desktopEntry,nonNixInterpreter:true,systemWebKit:format==="deb",systemWebKitVersion,notes:["Container Xvfb and WebKit Inspector; no WebDriver permission override.","Not a physical display, microphone or release-signing acceptance."]}
try {
  if(process.env.OPENBOT_INSTALL_FIXTURE==="1")fixture=await socketFixture({port:19380,originHost:"localhost"})
  start("Xvfb",[":198","-screen","0","1200x800x24","-dpi","96","-nolisten","tcp"])
  await delay(400)
  start(process.env.OPENBOT_INSTALL_FORMAT==="appimage"?"/packages/openbot.AppImage":"/usr/bin/openbot-one",[])
  let socket
  await waitFor(async()=>{const html=await(await fetch(base)).text();socket=html.match(/\/socket\/\d+\/\d+\/[a-zA-Z0-9_-]+/)?.[0];return !!socket},"The installed app did not expose its local inspector.")
  inspector=new WebSocket(base.replace("http:","ws:")+socket)
  function dispatch(message) {
    if(message.method==="Target.targetCreated"&&!message.params.targetInfo.isProvisional)targetId=message.params.targetInfo.targetId
    if(message.method==="Target.dispatchMessageFromTarget"){dispatch(JSON.parse(message.params.message));return}
    const pending=calls.get(message.id)
    if(!pending)return
    calls.delete(message.id)
    if(message.error)pending.reject(new Error(message.error.message));else pending.resolve(message.result)
  }
  inspector.on("message",bytes=>dispatch(JSON.parse(bytes.toString())))
  inspector.on("close",()=>{for(const pending of calls.values())pending.reject(new Error("The installed app inspector closed."));calls.clear()})
  await once(inspector,"open")
  await waitFor(()=>!!targetId,"The installed WebView target did not appear.")
  await protocol("Runtime.enable")
  await waitFor(()=>evaluate("return !!globalThis.__OPENBOT_RUNTIME__ && document.body.innerText.includes('Sign in to the test account')"),"The installed app did not show the real default-service sign-in.")
  result.identity=await evaluate("return {title:document.title,protocol:location.protocol,secure:isSecureContext,webdriver:navigator.webdriver,kind:globalThis.__OPENBOT_RUNTIME__.kind,origin:globalThis.__OPENBOT_RUNTIME__.apiOrigin}")
  assert.deepEqual(result.identity,{title:"OpenBot",protocol:"tauri:",secure:true,webdriver:false,kind:"native",origin:"http://localhost:19380"})
  const noticeFiles=["dependencies.md","openbot-web.txt","dm-sans.txt","dm-mono.txt","fonts.json","native-dependencies.md","rust.html"]
  for(const name of noticeFiles) {
    const expected=await readFile(join("/check/notices",name),"utf8")
    const html=name==="rust.html"
    // The generated HTML escapes only these four characters. Hash the rendered
    // pre bodies, allowing Tauri's HTML/CSP processing without a large Inspector message.
    const bodies=html?[...expected.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map(match=>match[1]
      .replaceAll("&quot;",'"').replaceAll("&lt;","<").replaceAll("&gt;",">").replaceAll("&amp;","&").trim()):undefined
    if(html)assert.ok(bodies.length>0)
    const digest=createHash("sha256").update(html?JSON.stringify(bodies):expected).digest("hex")
    const actual=await browser("const response=await fetch("+JSON.stringify("/licenses/"+name)+"); if(response.status!==200)return {status:response.status}; const text=await response.text(); "
      +(html
        ? "const bodies=[...new DOMParser().parseFromString(text,'text/html').querySelectorAll('pre')].map(node=>node.textContent.trim()); const data=JSON.stringify(bodies);"
        : "const data=text;")
      +"const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data)); return {status:response.status,sha256:[...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('')};")
    assert.equal(actual.sha256,digest,"The installed package must preserve its notice: "+name)
  }
  result.noticeAssets=noticeFiles.length
  assert.equal(await browser("return (await globalThis.__OPENBOT_RUNTIME__.fetch('http://localhost:19380/auth/session')).status"),401)
  const anonymous=await evaluate("return globalThis.__OPENBOT_RUNTIME__.storageNamespace")
  await browser("await globalThis.__OPENBOT_RUNTIME__.signIn();return true")
  signedIn=true
  await evaluate("location.replace('/');return true")
  await waitFor(()=>evaluate("return !!globalThis.__OPENBOT_RUNTIME__ && globalThis.__OPENBOT_RUNTIME__.storageNamespace!=="+JSON.stringify(anonymous)),"The installed app did not get a new checked account namespace.")
  assert.equal(await browser("return (await globalThis.__OPENBOT_RUNTIME__.fetch('http://localhost:19380/auth/session')).status"),200)
  assert.equal(await evaluate("return document.cookie"),"")
  result.privateNativeLogin=true
  result.sessionPersistence=await evaluate("return globalThis.__OPENBOT_RUNTIME__.session.persistence")
  await browser("await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return true")
  const image=await protocol("Page.snapshotRect",{x:0,y:0,width:1000,height:700,coordinateSystem:"Viewport"})
  assert.ok(image.dataURL?.startsWith("data:image/png;base64,"))
  await writeFile(join(output,"installed-signed-in.png"),Buffer.from(image.dataURL.split(",")[1],"base64"))
  await browser("await globalThis.__OPENBOT_RUNTIME__.signOut();return true")
  signedIn=false
  await evaluate("location.replace('/sign-in');return true")
  await waitFor(()=>evaluate("return !!globalThis.__OPENBOT_RUNTIME__ && document.body.innerText.includes('Sign in to the test account')"),"The installed app did not return to sign-in.")
  assert.equal(await browser("return (await globalThis.__OPENBOT_RUNTIME__.fetch('http://localhost:19380/auth/session')).status"),401)
  result.logout=true
  result.passed=true
  console.log("PASS: installed "+result.format+" real UI, default local service, private login and logout.")
} catch(error) {result.error=error.message;throw error}
finally {
  if(signedIn&&inspector?.readyState===WebSocket.OPEN)await browser("const current=await globalThis.__TAURI_INTERNALS__.invoke('connection_get');await globalThis.__TAURI_INTERNALS__.invoke('session_sign_out',{expectedOrigin:current.currentOrigin,runtimeId:current.runtimeId});return true").catch(()=>{})
  inspector?.close()
  for(const child of children.reverse())if(child.exitCode===null&&child.signalCode===null){
    const ended=once(child,"exit");child.kill("SIGTERM");await Promise.race([ended,delay(3000)])
    if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL")
  }
  await fixture?.close()
  await writeFile(join(output,"result.json"),JSON.stringify(result,null,2)+"\n")
}
