import assert from "node:assert/strict"
import {spawn} from "node:child_process"
import {once} from "node:events"
import {createServer as httpServer,request as httpRequest} from "node:http"
import {createServer as httpsServer} from "node:https"
import {readFile,writeFile,mkdir,mkdtemp,rm} from "node:fs/promises"
import {createWriteStream} from "node:fs"
import {resolve,join} from "node:path"
import {tmpdir} from "node:os"
import {randomUUID,createHash} from "node:crypto"
import {setTimeout as delay} from "node:timers/promises"
import {promisify} from "node:util"
import {execFile} from "node:child_process"
import {chromium} from "playwright-core"
import WebSocket from "ws"
import {mailTls} from "./mail-tls.mjs"

if(process.platform!=="linux")throw new Error("This check needs the Linux test profile.")
const output=await mkdtemp(join(tmpdir(),"openbot-browser-qa-"))
const tls=await mailTls()
const backend=resolve(process.env.OPENBOT_NATIVE_AUTH_WORKTREE??"../.worktrees/openbot-native-auth")
const helperPath=join(backend,"packages/openbot/.cache","native-desktop-"+randomUUID()+".ts")
const readyPath=join(output,"backend-ready.json")
const display=process.env.E2E_DISPLAY??":197"
const inspectorPort=19744
const env={...process.env,DISPLAY:display,LIBGL_ALWAYS_SOFTWARE:"1",WEBKIT_DISABLE_COMPOSITING_MODE:"1",
 WEBKIT_INSPECTOR_HTTP_SERVER:"127.0.0.1:"+inspectorPort,
 XDG_CONFIG_HOME:join(output,"config"),XDG_DATA_HOME:join(output,"data"),XDG_CACHE_HOME:join(output,"cache"),
 DBUS_SESSION_BUS_ADDRESS:"unix:path="+join(output,"missing-bus"),SSL_CERT_FILE:join(tls,"ca.pem")}
await Promise.all(["config/build.openbot.one","data/applications","cache"].map(path=>mkdir(join(output,path),{recursive:true,mode:0o700})))
const children=[]
function start(command,args,options={}){
 const child=spawn(command,args,{env,stdio:["ignore","pipe","pipe"],...options})
 children.push(child)
 const log=createWriteStream(join(output,"process-"+children.length+".log"),{mode:0o600})
 child.stdout?.pipe(log,{end:false});child.stderr?.pipe(log,{end:false})
 child.once("exit",()=>log.end())
 child.on("error",error=>process.stderr.write(error.message+"\n"))
 return child
}
const exec=promisify(execFile)
async function run(command,args){return exec(command,args,{env,timeout:15000})}
async function waitFor(check,message,timeout=20000){
 const deadline=Date.now()+timeout
 while(Date.now()<deadline){if(proxyCheckError)throw proxyCheckError;if(await check())return;await delay(100)}
 throw new Error(message)
}
let backendAddress,backendPid,proxy,control,browser,context,page,inspector,targetId,appWindow
let mode="hold",providerReached=false,openCount=0
let proxyCheckError,wrongStateChecked=false
const navigationResults=[]
const requestFailures=[]
let navigation
const consoleErrors=[]
const pending=new Map()
let nextId=0
function protocol(method,params={}){
 const id=++nextId
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error("Inspector call timed out: "+method))},15000)
  pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}})
  const command={id,method,params}
  inspector.send(JSON.stringify(targetId?{id:1_000_000_000+id,method:"Target.sendMessageToTarget",params:{targetId,message:JSON.stringify(command)}}:command))
 })
}
async function execute(script){
 const reply=await protocol("Runtime.evaluate",{expression:"(()=>{"+script+"})()",returnByValue:true,emulateUserGesture:true})
 if(reply.wasThrown)throw new Error(reply.result?.description??"The inspected script failed.")
 return reply.result?.value
}
async function nativeAsync(script){
 const key="__browserCheck"+nextId
 await execute("globalThis["+JSON.stringify(key)+"]=undefined;(async()=>{"+script+"})().then(value=>{globalThis["+JSON.stringify(key)+"]={value}},error=>{globalThis["+JSON.stringify(key)+"]={error:String(error)}});return true")
 await waitFor(()=>execute("return !!globalThis["+JSON.stringify(key)+"]"),"The native async check did not finish.")
 const result=await execute("return globalThis["+JSON.stringify(key)+"]")
 if(result.error)throw new Error(result.error)
 return result.value
}
async function click(name){
 await execute("const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==="+JSON.stringify(name)+");if(!button||button.disabled)throw new Error('The button is not ready.');button.click();return true")
}
async function screenshot(name){
 await run("xdotool",["windowraise",appWindow])
 await run("xdotool",["windowfocus","--sync",appWindow])
 await nativeAsync("await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return true")
 await run("gst-launch-1.0",["-q","ximagesrc","xid="+appWindow,"num-buffers=1","use-damage=false","!","videoconvert","!","pngenc","!","filesink","location="+join(output,name+".png")])
}
const result={passed:false,browserPlugin:"Browser plugin not available; Playwright controls a private Chromium system-browser handler and WebKit Inspector controls the packaged app",checks:[],output}
let caught
try{
 proxy=httpsServer({cert:await readFile(join(tls,"server.pem")),key:await readFile(join(tls,"server.key"))},(request,response)=>{
  if(request.headers.host?.startsWith("id.example.com")){
   const authorization=new URL(request.url,"https://id.example.com")
   if(authorization.pathname!=="/authorize"){response.writeHead(404).end();return}
   providerReached=true
   response.setHeader("cache-control","no-store")
   response.setHeader("referrer-policy","no-referrer")
   if(mode==="hold"){response.writeHead(200,{"content-type":"text/html"}).end("<!doctype html><title>Test identity provider</title><p>Waiting for a sign-in choice.</p>");return}
   const callback=new URL(authorization.searchParams.get("redirect_uri"))
   assert.equal(callback.origin,origin)
   callback.searchParams.set("state",authorization.searchParams.get("state"))
   if(mode==="deny")callback.searchParams.set("error","access_denied")
   else{
    callback.searchParams.set("iss","https://id.example.com")
    callback.searchParams.set("code",JSON.stringify({subject:"native",nonce:authorization.searchParams.get("nonce")}))
   }
   response.writeHead(302,{location:callback.href}).end()
   return
  }
  if(!backendAddress){response.writeHead(503).end();return}
  const upstream=httpRequest(backendAddress+request.url,{method:request.method,headers:request.headers},reply=>{
   const forward=()=>{response.writeHead(reply.statusCode,reply.headers);reply.pipe(response)}
   if(mode==="allow" && request.url.startsWith("/auth/native/finish?") && reply.statusCode===302 && !wrongStateChecked){
    ;(async()=>{
     const target=new URL(reply.headers.location)
     target.searchParams.set("state","wrong-state")
     const refused=await fetch(target)
     assert.equal(refused.status,400)
     assert.equal(await nativeAsync("return (await globalThis.__OPENBOT_RUNTIME__.fetch("+JSON.stringify(origin+"/auth/session")+")).status"),401)
     wrongStateChecked=true
     forward()
    })().catch(error=>{proxyCheckError=error;response.writeHead(502).end()})
   }else forward()
  })
  upstream.on("error",()=>{if(!response.headersSent)response.writeHead(502);response.end()})
  request.pipe(upstream)
 })
 proxy.listen(0,"127.0.0.1");await once(proxy,"listening")
 const origin="https://localhost:"+proxy.address().port
 const helper="import {Effect,FileSystem} from 'effect'\nimport {NodeRuntime} from '@effect/platform-node'\nimport * as Host from "+JSON.stringify(join(backend,"packages/openbot/test/BrowserHost.ts"))+"\nimport * as Access from '@openbot-build/domain/Access'\nNodeRuntime.runMain(Effect.gen(function*(){const host=yield* Host.start({publicOrigin:process.env.OPENBOT_NATIVE_TEST_ORIGIN,registration:{...Access.defaults,selfService:'allow'},sharedDomain:false});yield* host.updatePlatform(document=>({...document,nativeClients:[{id:'openbot-one',name:'OpenBot desktop check',redirectUris:['http://127.0.0.1/auth/callback']}]}));const fs=yield* FileSystem.FileSystem;yield* fs.writeFileString(process.env.OPENBOT_NATIVE_READY_PATH,JSON.stringify({address:yield* host.address,pid:process.pid}));yield* Effect.never}).pipe(Effect.scoped,Effect.provide(Host.layerPlatform)))\n"
 await mkdir(join(backend,"packages/openbot/.cache"),{recursive:true});await writeFile(helperPath,helper,{mode:0o600})
 const backendChild=start("devenv",["shell","--","node","--disable-warning=ExperimentalWarning",helperPath],{cwd:backend,env:{...process.env,OPENBOT_NATIVE_TEST_ORIGIN:origin,OPENBOT_NATIVE_READY_PATH:readyPath}})
 await waitFor(async()=>{if(backendChild.exitCode!==null||backendChild.signalCode!==null)throw new Error("The isolated native backend stopped; see its process log.");try{const ready=JSON.parse(await readFile(readyPath,"utf8"));backendAddress=ready.address;backendPid=ready.pid;return true}catch{return false}},"The isolated native backend did not start.",45000)
 start("Xvfb",[display,"-screen","0","1365x900x24","-dpi","96","-nolisten","tcp"])
 await delay(400)
 browser=await chromium.launch({executablePath:process.env.E2E_CHROMIUM,headless:false,env,args:["--no-sandbox","--disable-background-networking","--host-resolver-rules=MAP id.example.com:443 127.0.0.1:"+proxy.address().port+", MAP localhost 127.0.0.1, EXCLUDE 127.0.0.1, MAP * ~NOTFOUND"]})
 context=await browser.newContext({ignoreHTTPSErrors:true})

 page=await context.newPage()
 page.on("requestfailed",request=>{const url=new URL(request.url());requestFailures.push({path:url.origin+url.pathname,reason:request.failure()?.errorText})})
 control=httpServer(async(request,response)=>{
  if(request.method!=="POST"||request.url!=="/"+controlKey){response.writeHead(404).end();return}
  let input="";for await(const chunk of request){input+=chunk;if(input.length>8192)throw new Error("The opener URL is too large.")}
  const target=new URL(input)
  assert.equal(target.origin,origin);assert.equal(target.pathname,"/auth/native/authorize")
  openCount++
  response.writeHead(204).end()
  const openedMode=mode
  navigation=page.goto(target.href,{waitUntil:"domcontentloaded",timeout:20000}).then(()=>{
   navigationResults.push({mode:openedMode,loaded:true})
  },error=>{
   const reason=error.message.includes("ERR_NAME_NOT_RESOLVED")?"NAME_NOT_RESOLVED":error.message.includes("ERR_FAILED")?"REQUEST_ABORTED":"NAVIGATION_ENDED"
   navigationResults.push({mode:openedMode,loaded:false,reason})
  })
 })
 const controlKey=randomUUID()
 control.listen(0,"127.0.0.1");await once(control,"listening")
 const controlUrl="http://127.0.0.1:"+control.address().port+"/"+controlKey
 const opener=join(output,"test-browser")
 await writeFile(opener,"#!"+process.execPath+"\nfetch("+JSON.stringify(controlUrl)+",{method:'POST',body:process.argv[2]}).then(response=>{process.exitCode=response.ok?0:1},()=>{process.exitCode=1})\n",{mode:0o700})
 env.BROWSER=opener
 const desktop="[Desktop Entry]\nType=Application\nName=OpenBot private test browser\nExec="+JSON.stringify(process.execPath)+" "+JSON.stringify(opener)+" %u\nMimeType=x-scheme-handler/https;x-scheme-handler/http;\nNoDisplay=true\n"
 await writeFile(join(output,"data/applications/openbot-native-test.desktop"),desktop)
 await writeFile(join(output,"config/mimeapps.list"),"[Default Applications]\nx-scheme-handler/https=openbot-native-test.desktop\nx-scheme-handler/http=openbot-native-test.desktop\n")
 await writeFile(join(output,"config/build.openbot.one/connection.json"),JSON.stringify({version:1,origin}))
 const app=start(resolve("src-tauri/target/debug/openbot-one"),[])
 const base="http://127.0.0.1:"+inspectorPort
 let socketPath
 await waitFor(async()=>{try{socketPath=(await(await fetch(base)).text()).match(/\/socket\/\d+\/\d+\/[a-zA-Z0-9_-]+/)?.[0];return !!socketPath}catch{return false}},"The packaged app did not expose its inspector.")
 inspector=new WebSocket(base.replace("http:","ws:")+socketPath)
 const dispatch=message=>{
  if(message.method==="Console.messageAdded" && message.params.message.level==="error")consoleErrors.push(message.params.message.text)
  if(message.method==="Target.targetCreated"&&!message.params.targetInfo.isProvisional)targetId=message.params.targetInfo.targetId
  if(message.method==="Target.didCommitProvisionalTarget")targetId=message.params.newTargetId
  if(message.method==="Target.dispatchMessageFromTarget"){dispatch(JSON.parse(message.params.message));return}
  const call=pending.get(message.id);if(!call)return;pending.delete(message.id)
  if(message.error)call.reject(new Error(message.error.message));else call.resolve(message.result)
 }
 inspector.on("message",bytes=>dispatch(JSON.parse(bytes.toString())))
 await once(inspector,"open");await waitFor(()=>!!targetId,"The inspector did not expose the page target.");await protocol("Console.enable");await protocol("Runtime.enable")
 await waitFor(()=>execute("return typeof globalThis.__OPENBOT_RUNTIME__?.browserSignIn==='function' && document.body.innerText.includes('Use company sign-in')"),"The company sign-in entry did not render.")
 appWindow=(await run("xdotool",["search","--onlyvisible","--pid",String(app.pid),"--name","^OpenBot$"])).stdout.trim().split("\n")[0]
 assert.ok(appWindow)
 assert.equal(await execute("return document.title"),"OpenBot")
 assert.equal(await execute("return location.protocol"),"tauri:")
 const oldSnapshot=await nativeAsync("return await globalThis.__TAURI_INTERNALS__.invoke('connection_get')")
 await screenshot("sign-in-desktop")
 await run("xdotool",["windowsize",appWindow,"390","800"])
 await waitFor(()=>execute("return innerWidth<=400 && document.documentElement.scrollWidth<=innerWidth"),"The narrow sign-in form overflowed.")
 await screenshot("sign-in-narrow")
 await run("xdotool",["windowsize",appWindow,"1200","800"])
 await click("Use company sign-in")
 await waitFor(()=>providerReached&&execute("return document.body.innerText.includes('Continue in your browser.')"),"The system browser did not reach the controlled provider.")
 await screenshot("browser-pending")
 await click("Cancel sign-in")
 await waitFor(()=>execute("return !document.body.innerText.includes('Canceling') && !document.body.innerText.includes('Continue in your browser.')"),"Cancellation did not return to the form.")
 result.checks.push("native system-browser handler, pending state, cancellation, and retry")
 mode="deny";providerReached=false
 await click("Use company sign-in")
 await waitFor(()=>execute("return document.body.innerText.includes('Sign-in was not allowed.')"),"Provider denial did not return to the app.")
 await navigation
 await screenshot("provider-denied")
 result.checks.push("provider denial returns a fixed error and permits retry")
 mode="allow";providerReached=false
 await click("Use company sign-in")
 await waitFor(()=>execute("return !!globalThis.__OPENBOT_RUNTIME__ && location.pathname==='/' && !!document.querySelector('[data-slot=sidebar]')"),"The native browser exchange did not reach the signed-in app.",30000)
 assert.equal(await nativeAsync("return (await globalThis.__OPENBOT_RUNTIME__.fetch("+JSON.stringify(origin+"/auth/session")+")).status"),200)
 assert.equal(await execute("return document.cookie"),"")
 assert.equal(wrongStateChecked,true)
 const stale=await nativeAsync("const old="+JSON.stringify({expectedOrigin:oldSnapshot.currentOrigin,runtimeId:oldSnapshot.runtimeId,id:"old-operation",input:{}})+";const rejected=[];for(const command of ['browser_sign_in_prepare','browser_sign_in_open','browser_sign_in_cancel']){try{await globalThis.__TAURI_INTERNALS__.invoke(command,old);rejected.push(false)}catch{rejected.push(true)}}return rejected")
 assert.deepEqual(stale,[true,true,true])
 await nativeAsync("const current=await globalThis.__TAURI_INTERNALS__.invoke('connection_get');const args={expectedOrigin:current.currentOrigin,runtimeId:current.runtimeId};const id=await globalThis.__TAURI_INTERNALS__.invoke('browser_sign_in_prepare',args);await globalThis.__TAURI_INTERNALS__.invoke('browser_sign_in_cancel',{...args,id});return true")
 assert.equal(await nativeAsync("return (await globalThis.__OPENBOT_RUNTIME__.fetch("+JSON.stringify(origin+"/auth/session")+")).status"),200)
 result.checks.push("wrong-state callback remains unauthenticated; stale prepare/open/cancel refused; current document still works")
 await navigation
 await waitFor(()=>execute("return !document.body.innerText.includes('Loading your Bots')"),"The signed-in bot list did not finish loading.")
 await screenshot("signed-in")
 const browserSession=await context.request.get(origin+"/auth/session")
 assert.equal(browserSession.status(),200)
 const browserLogout=await context.request.post(origin+"/auth/sign-out",{headers:{origin,"content-type":"application/json"},data:{}})
 assert.equal(browserLogout.status(),200)
 assert.equal(await nativeAsync("return (await globalThis.__OPENBOT_RUNTIME__.fetch("+JSON.stringify(origin+"/auth/session")+")).status"),200)
 await nativeAsync("await globalThis.__OPENBOT_RUNTIME__.signOut();return true")
 await execute("location.replace('/sign-in');return true")
 await waitFor(()=>execute("return document.body.innerText.includes('Use company sign-in')"),"Sign-out did not return to the native sign-in page.")
 result.checks.push("real OIDC signature/state/nonce callback, native private-cookie exchange, checked account, independent browser logout, native logout")
 assert.deepEqual(consoleErrors,[])
 assert.equal(await execute("return !!document.querySelector('vite-error-overlay')"),false)
 result.consoleErrors=consoleErrors
 result.identity={title:"OpenBot",protocol:"tauri:",desktop:true}
 assert.equal(openCount,3)
 result.navigationResults=navigationResults
 result.requestFailures=requestFailures
 result.browserVersion=browser.version()
 result.browserPageText=await page.locator("body").innerText()
 assert.equal(result.browserPageText,"Return to OpenBot.")
 assert.ok(navigationResults.filter(value=>value.mode!=="hold").every(value=>value.loaded))
 result.browserPagePath=new URL(page.url()).pathname
 result.openCount=openCount
 result.passed=true
 console.log("PASS: packaged native browser sign-in, cancel, denial, independent sessions and logout.")
}catch(error){caught=error;result.error=error.message;try{if(appWindow)await screenshot("failure")}catch{}}
finally{
 result.navigationResults=navigationResults
 result.requestFailures=requestFailures
 if(page)try{result.browserPageText=await page.locator("body").innerText()}catch{}
 inspector?.close()
 for(const call of pending.values())call.reject(new Error("The native check ended."))
 await browser?.close().catch(()=>{})
 if(backendPid)try{process.kill(backendPid,"SIGTERM")}catch{}
 for(const child of children.slice().reverse()){
  if(child.exitCode!==null||child.signalCode!==null)continue
  child.kill("SIGTERM")
  await Promise.race([once(child,"exit"),delay(8000)])
  if(child.exitCode===null&&child.signalCode===null){child.kill("SIGKILL");await Promise.race([once(child,"exit"),delay(2000)])}
 }
 control?.closeAllConnections();proxy?.closeAllConnections()
 if(control)await new Promise(resolve=>control.close(resolve))
 if(proxy)await new Promise(resolve=>proxy.close(resolve))
 await rm(helperPath,{force:true})
 await writeFile(join(output,"result.json"),JSON.stringify(result,null,2))
 console.log("Evidence: "+output)
}
if(caught)throw caught
