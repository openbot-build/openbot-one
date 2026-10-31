import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { socketFixture } from './socket-fixture.mjs'
import WebSocket from 'ws'

// Real packaged WebKit, native consent, and synthetic audio on a private server.
// No host microphone, speaker, user keyring, or external Live provider is used.
if (process.platform !== 'linux') throw new Error('This check needs the Linux test profile.')
await mkdir(resolve('.cache/media-e2e'), {recursive:true,mode:0o700})
const output = await mkdtemp(resolve('.cache/media-e2e/run-'))
const display = process.env.E2E_DISPLAY ?? ':196'
const pulseSocket = join(output,'pulse.sock')
const env = {...process.env, WEBKIT_INSPECTOR_HTTP_SERVER:'127.0.0.1:19644', DISPLAY:display, LIBGL_ALWAYS_SOFTWARE:'1', WEBKIT_DISABLE_COMPOSITING_MODE:'1',
  XDG_CONFIG_HOME:join(output,'config'),XDG_DATA_HOME:join(output,'data'),XDG_CACHE_HOME:join(output,'cache'),
  DBUS_SESSION_BUS_ADDRESS:'unix:path='+join(output,'missing-bus'),PULSE_SERVER:'unix:'+pulseSocket,PULSE_SOURCE:'one_input',PULSE_SINK:'one_output',
  PULSE_COOKIE:join(output,'pulse-cookie'),PULSE_RUNTIME_PATH:join(output,'pulse-runtime'),PULSE_STATE_PATH:join(output,'pulse-state')}
await Promise.all(['pulse-runtime','pulse-state','config/build.openbot.one'].map(path=>mkdir(join(output,path),{recursive:true,mode:0o700})))
const exec = promisify(execFile)
const run = (command,args) => exec(command,args,{env,timeout:15000})
const children = []
function start(command,args,binary=false) {
  const child=spawn(command,args,{env,stdio:['ignore','pipe','pipe']})
  children.push(child)
  child.on('error',error=>process.stderr.write(error.message+'\n'))
  if(!binary)child.stdout.on('data',data=>process.stderr.write(data))
  child.stderr.on('data',data=>process.stderr.write(data))
  return child
}
async function waitFor(check,message) {
  const deadline=Date.now()+15000
  while(Date.now()<deadline){if(await check())return;await delay(100)}
  throw new Error(message)
}
const base='http://127.0.0.1:19644'
let fixture,monitor,inspector,targetId
let nextId=0
const pendingCalls=new Map()
async function protocol(method,params={}) {
  const id=++nextId
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pendingCalls.delete(id);reject(new Error('Inspector call timed out: '+method))},15000)
    pendingCalls.set(id,{resolve:value=>{clearTimeout(timer);resolve(value)},reject:error=>{clearTimeout(timer);reject(error)}})
    const command={id,method,params}
    inspector.send(JSON.stringify(targetId?{id:1_000_000_000+id,method:'Target.sendMessageToTarget',params:{targetId,message:JSON.stringify(command)}}:command))
  })
}
async function execute(script) {
  const response=await protocol('Runtime.evaluate',{expression:'(()=>{'+script+'})()',returnByValue:true,emulateUserGesture:true})
  if(response.wasThrown)throw new Error(response.result?.description??'The inspected script failed.')
  return response.result?.value
}
const browser=async script=>{
  const key='__nativeCheck'+nextId
  await execute(`globalThis[${JSON.stringify(key)}]=undefined;(async()=>{${script}})().then(value=>{globalThis[${JSON.stringify(key)}]={value}},error=>{globalThis[${JSON.stringify(key)}]={value:{error:String(error)}}});return true`)
  await waitFor(()=>execute(`return !!globalThis[${JSON.stringify(key)}]`),'The inspected async action did not finish.')
  return execute(`return globalThis[${JSON.stringify(key)}].value`)
}
const click=id=>execute(`document.getElementById(${JSON.stringify(id)}).click();return true`)
const screenshot=path=>run('gst-launch-1.0',['-q','ximagesrc','num-buffers=1','use-damage=false','!','videoconvert','!','pngenc','!','filesink','location='+path])
async function microphone(choice,stale=false) {
  await execute(`globalThis.__micResult=undefined;
    let button=document.querySelector('#native-mic-check');if(!button){button=document.createElement('button');button.id='native-mic-check';button.textContent='Check microphone';document.body.append(button)}
    button.onclick=()=>navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false}}).then(stream=>{globalThis.__micStream=stream;globalThis.__micResult={allowed:true}},error=>{globalThis.__micResult={allowed:false,name:error.name}});return true`)
  await click('native-mic-check')
  let dialog
  await waitFor(async()=>{
    const outcome=await execute('return globalThis.__micResult ?? null')
    if(outcome)throw new Error('Microphone finished before consent: '+JSON.stringify(outcome))
    try{dialog=(await run('xdotool',['search','--onlyvisible','--name','^Microphone access$'])).stdout.trim().split('\n')[0];return !!dialog}catch{return false}
  },'The native microphone consent dialog did not appear.')
  await screenshot(join(output,stale?'stale-consent.png':choice+'-consent.png'))
  if(stale)assert.equal(await browser('await globalThis.__OPENBOT_RUNTIME__.signOut();return true'),true)
  const geometry=Object.fromEntries((await run('xdotool',['getwindowgeometry','--shell',dialog])).stdout.trim().split('\n').map(line=>line.split('=')))
  const x=Number(geometry.X)+Math.round(Number(geometry.WIDTH)*(choice==='allow'?0.75:0.25))
  const y=Number(geometry.Y)+Number(geometry.HEIGHT)-18
  await run('xdotool',['mousemove','--sync',String(x),String(y)])
  await run('xdotool',['click','1'])
  await waitFor(()=>execute('return !!globalThis.__micResult'),'The microphone choice did not finish.')
  return execute('return globalThis.__micResult')
}
async function signIn() {
  assert.equal(await browser('await globalThis.__OPENBOT_RUNTIME__.signIn({});return true'),true)
  await execute("location.replace('/');return true")
  await waitFor(()=>execute("return !!globalThis.__OPENBOT_RUNTIME__ && document.body.innerText.includes('Your organization access')"),'The checked fixture account did not load.')
}
try {
  await writeFile(join(output,'pulse-cookie'),randomBytes(256),{mode:0o600})
  const pulseConfig=join(output,'pulse.pa')
  await writeFile(pulseConfig,`load-module module-native-protocol-unix socket=${pulseSocket} auth-cookie=${join(output,'pulse-cookie')}
load-module module-null-sink sink_name=one_output rate=48000 channels=1
load-module module-sine-source source_name=one_input frequency=440 rate=48000
set-default-sink one_output
set-default-source one_input
`,{mode:0o600})
  start('pulseaudio',['-n','--daemonize=no','--use-pid-file=no','--exit-idle-time=-1','--realtime=no','--high-priority=no','--file',pulseConfig])
  await waitFor(async()=>{try{return (await run('pactl',['get-default-source'])).stdout.trim()==='one_input'}catch{return false}},'The private synthetic audio server did not start.')
  const sources=JSON.parse((await run('pactl',['--format=json','list','sources'])).stdout)
  assert.deepEqual(sources.map(source=>source.name).sort(),['one_input','one_output.monitor'])
  fixture=await socketFixture()
  await writeFile(join(output,'config/build.openbot.one/connection.json'),JSON.stringify({version:1,origin:fixture.origin}))
  start('Xvfb',[display,'-screen','0','1365x900x24','-dpi','96','-nolisten','tcp'])
  await delay(400)
  start(resolve('src-tauri/target/debug/openbot-one'),[])
  let socketPath
  await waitFor(async()=>{try{const html=await(await fetch(base)).text();socketPath=html.match(/\/socket\/\d+\/\d+\/[a-zA-Z0-9_-]+/)?.[0];return !!socketPath}catch{return false}},'The local WebKit inspector did not expose the app.')
  inspector=new WebSocket(base.replace('http:','ws:')+socketPath)
  const dispatch=message=>{
    if(message.method==='Target.targetCreated'&&!message.params.targetInfo.isProvisional)targetId=message.params.targetInfo.targetId
    if(message.method==='Target.didCommitProvisionalTarget')targetId=message.params.newTargetId
    if(message.method==='Target.dispatchMessageFromTarget'){dispatch(JSON.parse(message.params.message));return}
    const pending=pendingCalls.get(message.id);if(!pending)return;pendingCalls.delete(message.id)
    if(message.error)pending.reject(new Error(message.error.message));else pending.resolve(message.result)
  }
  inspector.on('message',bytes=>dispatch(JSON.parse(bytes.toString())))
  inspector.on('close',()=>{for(const pending of pendingCalls.values())pending.reject(new Error('The local inspector closed.'));pendingCalls.clear()})
  await once(inspector,'open')
  await waitFor(()=>!!targetId,'The inspector did not expose the page target.')
  await protocol('Runtime.enable')
  await waitFor(()=>execute("return !!globalThis.__OPENBOT_RUNTIME__ && document.body.innerText.includes('Sign in to the test account')"),'The packaged app did not show sign-in.')
  const identity=await execute('return {title:document.title,protocol:location.protocol,secure:isSecureContext,microphone:typeof navigator.mediaDevices?.getUserMedia,worklet:typeof AudioWorkletNode,webdriver:navigator.webdriver}')
  assert.equal(identity.webdriver,false);assert.equal(identity.title,'OpenBot');assert.equal(identity.protocol,'tauri:');assert.equal(identity.secure,true)
  assert.equal(identity.microphone,'function');assert.equal(identity.worklet,'function')
  await signIn()
  await execute("globalThis.__mediaErrors=[];addEventListener('error',event=>globalThis.__mediaErrors.push(event.message));return true")
  const blockedBlob=await browser(`const context=new AudioContext(),url=URL.createObjectURL(new Blob(["registerProcessor('blocked',class extends AudioWorkletProcessor{process(){return true}})"],{type:'text/javascript'}));try{await context.audioWorklet.addModule(url);return false}catch{return true}finally{URL.revokeObjectURL(url);await context.close()}`)
  assert.equal(blockedBlob,true,'The packaged CSP must keep Blob scripts blocked.')
  assert.deepEqual(await microphone('deny'),{allowed:false,name:'NotAllowedError'})
  assert.deepEqual(await microphone('allow',true),{allowed:false,name:'NotAllowedError'},'A late consent result must not authorize a signed-out document.')
  await execute("location.replace('/sign-in');return true")
  await waitFor(()=>execute("return !!globalThis.__OPENBOT_RUNTIME__ && document.body.innerText.includes('Sign in to the test account')"),'The signed-out document did not load.')
  await signIn()
  assert.deepEqual(await microphone('allow'),{allowed:true})
  const worklet=(await readdir(resolve('dist/assets'))).filter(name=>/^capture-worklet-.*\.js$/.test(name))
  assert.equal(worklet.length,1,'The shared Web package must emit one local capture worklet.')
  const recorded=[]
  monitor=start('parec',['--device=one_output.monitor','--format=s16le','--rate=48000','--channels=1'],true)
  monitor.stdout.on('data',chunk=>{if(recorded.reduce((size,part)=>size+part.length,0)<2_000_000)recorded.push(chunk)})
  await execute(`globalThis.__mediaErrors=[];addEventListener('error',event=>globalThis.__mediaErrors.push(event.message));
    const button=document.createElement('button');button.id='native-audio-check';button.textContent='Check audio capture';document.body.append(button);
    button.onclick=()=>{globalThis.__audioDone=false;const context=new AudioContext();void context.resume();
      (async()=>{
        let node,source,tone,socket,activeChunks=0;const sent=[],received=[];
        try{
          await context.audioWorklet.addModule(${JSON.stringify('/assets/'+worklet[0])});
          socket=globalThis.__OPENBOT_RUNTIME__.createWebSocket(${JSON.stringify(fixture.origin.replace('http:','ws:')+'/v1/chats/audio-check/live')});socket.binaryType='arraybuffer';
          await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
          const echoed=new Promise((resolve,reject)=>{socket.onmessage=event=>{received.push([...new Uint8Array(event.data)]);if(received.length===2)resolve()};socket.onerror=reject;setTimeout(()=>reject(new Error('Audio frames timed out.')),8000)});
          node=new AudioWorkletNode(context,'openbot-capture',{numberOfInputs:1,numberOfOutputs:1,channelCount:1,channelCountMode:'explicit',processorOptions:{targetRate:24000}});
          node.port.onmessage=event=>{if(sent.length<2){const pcm=new DataView(event.data);let peak=0;for(let i=0;i<pcm.byteLength;i+=2)peak=Math.max(peak,Math.abs(pcm.getInt16(i,true)));if(peak>100&&++activeChunks>3){sent.push([...new Uint8Array(event.data)]);socket.send(event.data)}}};
          source=context.createMediaStreamSource(globalThis.__micStream);source.connect(node);node.connect(context.destination);
          const buffer=context.createBuffer(1,Math.round(context.sampleRate),context.sampleRate),data=buffer.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=0.15*Math.sin(2*Math.PI*220*i/context.sampleRate);
          tone=context.createBufferSource();tone.buffer=buffer;tone.loop=true;tone.connect(context.destination);tone.start();
          await echoed;await new Promise(resolve=>setTimeout(resolve,800));
          globalThis.__audioResult={sent,received,state:context.state,sampleRate:context.sampleRate,activeChunks,cookieHidden:!document.cookie.includes('__Host-openbot-session')};
        }catch(error){globalThis.__audioResult={error:String(error)}}
        finally{socket?.close();tone?.stop();source?.disconnect();node?.port.close();node?.disconnect();for(const track of globalThis.__micStream.getTracks())track.stop();await context.close();globalThis.__audioResult.closed=context.state==='closed';globalThis.__audioResult.tracksEnded=globalThis.__micStream.getTracks().every(track=>track.readyState==='ended');globalThis.__audioDone=true}
      })();};return true`)
  await click('native-audio-check')
  await waitFor(()=>execute('return globalThis.__audioDone'),'The real audio graph did not complete.')
  const audio=await execute('return globalThis.__audioResult')
  assert.equal(audio.error,undefined);assert.equal(audio.state,'running');assert.equal(audio.closed,true);assert.equal(audio.tracksEnded,true);assert.equal(audio.cookieHidden,true)
  assert.deepEqual(audio.received,audio.sent)
  assert.deepEqual(audio.sent.map(chunk=>chunk.length),[1920,1920])
  const pcm=Buffer.concat(audio.sent.map(chunk=>Buffer.from(chunk)))
  let peak=0;for(let index=0;index<pcm.length;index+=2)peak=Math.max(peak,Math.abs(pcm.readInt16LE(index)))
  assert.ok(peak>100,'The synthetic microphone must produce actual PCM samples.')
  let crossings=0;for(let index=2;index<pcm.length;index+=2)if(pcm.readInt16LE(index-2)<=0&&pcm.readInt16LE(index)>0)crossings++
  const frequency=crossings*24000/(pcm.length/2)
  assert.ok(frequency>400&&frequency<480,`The worklet must preserve the 440 Hz source when resampling to 24 kHz (got ${frequency} Hz from a ${audio.sampleRate} Hz context).`)
  const monitorExit=once(monitor,'exit');monitor.kill('SIGTERM');await monitorExit
  const playback=Buffer.concat(recorded)
  let outputPeak=0;for(let index=0;index+1<playback.length;index+=2)outputPeak=Math.max(outputPeak,Math.abs(playback.readInt16LE(index)))
  assert.ok(outputPeak>100,'The private output monitor must receive actual playback samples.')
  await waitFor(async()=>JSON.parse((await run('pactl',['--format=json','list','source-outputs'])).stdout).length===0,'Microphone tracks were not released from the private audio server.')
  assert.deepEqual(await execute('return globalThis.__mediaErrors'),[])
  await execute("document.querySelector('#native-mic-check')?.remove();document.querySelector('#native-audio-check')?.remove();return true")
  await screenshot(join(output,'app.png'))
  const result={passed:true,identity,browserPlugin:'not available; native WebKit Inspector is used without WebDriver permission overrides',audioServer:'private PulseAudio with synthetic input and null output only',denial:true,lateConsentRejected:true,localWorklet:true,blobScriptsBlocked:true,authenticatedNativeBinaryEcho:true,inputPcm:{rate:24000,channels:1,chunkBytes:1920,peak,frequency,sha256:createHash('sha256').update(pcm).digest('hex')},playback:{bytes:playback.length,peak:outputPeak},tracksEnded:true,contextClosed:true,errors:[],captureProcessing:'echo cancellation, noise suppression, and gain control disabled for the synthetic signal; voice quality not tested',externalLiveProvider:'not tested',mobile:'not device tested'}
  await writeFile(join(output,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600})
  console.log('PASS: packaged microphone consent, stale consent rejection, local worklet, actual PCM over native sockets, playback, and audio cleanup.')
  console.log('Evidence: '+output)
} finally {
  inspector?.close()
  for(const child of children.reverse())if(child.exitCode===null)child.kill('SIGTERM')
  await fixture?.close()
}
