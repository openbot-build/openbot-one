import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mailReceiver } from './mail-receiver.mjs'
import { mailProxy } from './mail-proxy.mjs'

const root=resolve('.'),backend=resolve('.cache/backend-0.1.5')
const revision='770126bda4c0cb5f737c42f54078ee9d67400d5d'
const exec=promisify(execFile)
const compose=['compose','-f',join(root,'dev/compose.yaml'),'exec','-T','postgres','psql','-U','openbot_dev','-d','postgres','-v','ON_ERROR_STOP=1','-c']

async function freePort() {
  const server=createServer().listen(0,'127.0.0.1')
  await once(server,'listening')
  const port=server.address().port
  await new Promise(resolve=>server.close(resolve))
  return port
}

/** Run the exact official server and its mail adapter in a new test database.
 * The normal development server, database, and trust store are never changed. */
export async function backendMailChecks({call,execute,button,input,waitFor,screenshot,restart}) {
  const head=(await exec('devenv',['shell','--','git','rev-parse','HEAD'],{cwd:backend})).stdout.trim()
  assert.equal(head,revision,'The mail check needs the pinned official backend.')
  if(!process.env.OPENBOT_MAIL_TLS_DIR)throw new Error('Use pnpm mail:check to give the test processes a private CA.')
  const directory=resolve(process.env.OPENBOT_MAIL_TLS_DIR)
  const database='openbot_one_mail_'+randomBytes(8).toString('hex')
  const recipient='native-'+randomBytes(6).toString('hex')+'@openbot-one.test'
  const port=await freePort()
  const log=createWriteStream(join(directory,'backend.log'),{flags:'a',mode:0o600})
  let server,receiver,proxy,untrustedProxy,evidence,created=false,interrupted=false
  const onInterrupt=()=>{interrupted=true;if(server?.pid)try{process.kill(-server.pid,'SIGTERM')}catch{}}
  process.once('SIGINT',onInterrupt)
  process.once('SIGTERM',onInterrupt)
  const run=async(command,args,cwd=root)=>{
    const child=spawn(command,args,{cwd,stdio:['ignore','pipe','pipe']})
    child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false})
    const [code]=await once(child,'exit')
    if(code!==0 || interrupted)throw new Error('A local mail check command failed. Read the private backend log.')
  }
  const browser=script=>call('/execute/async',{script:`const done=arguments[0];(async()=>{${script}})().then(done,error=>done({error:String(error)}));`,args:[]})
  try {
    const ca=join(directory,'ca.pem'),key=join(directory,'server.key'),cert=join(directory,'server.pem')
    receiver=await mailReceiver({key:await readFile(key),cert:await readFile(cert),ca:await readFile(ca),recipient})
    proxy=await mailProxy({key:await readFile(key),cert:await readFile(cert),backendPort:port})
    untrustedProxy=await mailProxy({key:await readFile(join(directory,'untrusted.key')),cert:await readFile(join(directory,'untrusted.pem')),backendPort:port})
    const origin=proxy.origin
    await assert.rejects(receiver.probe(false),/certificate|issuer|self.signed/i)
    assert.equal(await receiver.probe(true),true)
    const env=['OPENBOT_DATABASE_URL=postgres://openbot_dev:openbot_dev@127.0.0.1:19332/'+database,'OPENBOT_HOST=127.0.0.1',`OPENBOT_PORT=${port}`,`NODE_EXTRA_CA_CERTS=${ca}`]
    const args=command=>['shell','--','env',...env,'pnpm','--filter','@openbot-build/openbot','run',...command]
    await run('docker',[...compose,`CREATE DATABASE "${database}"`]);created=true
    await run('devenv',args(['migrate']),backend)
    const config=join(directory,'setup.json')
    await writeFile(config,JSON.stringify({publicOrigin:origin,identityProvider:null,adminEmails:[recipient],adminProvider:'email',registration:{selfService:'closed',emailSignIn:true,invitations:'allow',sso:'closed',trustedSsoProviders:[],allowedEmailDomains:['openbot-one.test'],allowExternalInvitations:false,provider:{trusted:false,scopes:[],groupsClaim:null,requiredGroups:[],mappings:[]}},mail:{host:'localhost',port:receiver.port,security:'tls',from:'noreply@openbot-one.test',fromName:'OpenBot One check',username:null,password:null,invitationUrl:origin}}),{mode:0o600})
    await run('devenv',args(['setup','--config',config]),backend)
    server=spawn('devenv',args(['start']),{cwd:backend,detached:true,stdio:['ignore','pipe','pipe']})
    server.stdout.pipe(log,{end:false});server.stderr.pipe(log,{end:false})
    server.on('error',()=>{})
    await waitFor(async()=>{
      if(server.exitCode!==null || interrupted)throw new Error('The official mail test backend stopped. Read the private backend log.')
      try{return(await fetch(origin+'/health',{signal:AbortSignal.timeout(1000)})).ok}catch{return false}
    },'The official mail test backend did not start.')
    assert.equal((await fetch(origin+'/auth/development/sign-in',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}',redirect:'manual'})).status,404,'This check must use the official production auth entry.')
    await button('Service settings');await input('input[type=url]',untrustedProxy.origin);await button('Save and connect')
    await waitFor(()=>execute(`return globalThis.__OPENBOT_RUNTIME__?.apiOrigin===${JSON.stringify(untrustedProxy.origin)}`),'The untrusted certificate check service did not load.')
    assert.equal(await browser('const n=globalThis.__OPENBOT_RUNTIME__;try {const r=await n.fetch(n.apiOrigin+"/health");await r.body?.cancel();return false}catch{return true}'),true,'The native client must reject a certificate from an untrusted issuer.')
    await button('Service settings');await input('input[type=url]',origin);await button('Save and connect')
    await waitFor(()=>execute(`return globalThis.__OPENBOT_RUNTIME__?.apiOrigin===${JSON.stringify(origin)} && !!document.querySelector('#email')`),'The real email service did not load.')
    const status=()=>browser('const n=globalThis.__OPENBOT_RUNTIME__;return (await n.fetch(n.apiOrigin+"/auth/session")).status')
    assert.equal(await status(),401)
    await input('#email',recipient);await button('Send email code')
    await waitFor(()=>receiver.count()===1,'The real backend did not deliver one local TLS email.')
    const code=receiver.code(),wrong=((Number(code[0])+1)%10)+code.slice(1)
    assert.ok(['TLSv1.2','TLSv1.3'].includes(receiver.protocol()))
    await input('#code',wrong);await button('Sign in')
    await waitFor(()=>execute("return document.body.innerText.includes('The code or identity could not be checked')"),'The real backend did not reject the wrong email code.')
    assert.equal(await status(),401)
    await input('#code',code)
    await button('Sign in')
    await waitFor(()=>execute("return location.pathname==='/' && document.body.innerText.includes('Your organization access')"),'The real email code did not sign the packaged app in.')
    const account=await browser('const n=globalThis.__OPENBOT_RUNTIME__,r=await n.fetch(n.apiOrigin+"/auth/session"),a=await r.json();return {status:r.status,email:a.profile.email,verified:a.profile.emailVerified,admin:a.platformAdmin,cookieHidden:!r.headers.has("set-cookie")&&!document.cookie.includes("__Host-openbot-session")}')
    assert.deepEqual(account,{status:200,email:recipient,verified:true,admin:true,cookieHidden:true})
    if(process.env.OPENBOT_CHECK_CREDENTIALS==='1') {
      assert.equal(await execute('return globalThis.__OPENBOT_RUNTIME__.session.persistence'),'saved')
      await button('Service settings');await button('Use default')
      await waitFor(()=>execute("return globalThis.__OPENBOT_RUNTIME__?.apiOrigin==='http://localhost:19380' && location.pathname==='/sign-in' && document.body.innerText.includes('Sign in to the test account')"),'The default service did not become ready.')
      await button('Service settings');await input('input[type=url]',origin);await button('Save and connect')
      await waitFor(()=>execute("return document.body.innerText.includes('Your organization access')"),'Returning to the remembered service must not ask for another code.')
      assert.equal(await status(),200)
      await restart(JSON.stringify({version:1,origin}))
      await waitFor(()=>execute("return document.body.innerText.includes('Your organization access')"),'A process restart did not restore the saved account.')
      assert.equal(await status(),200)
      assert.equal(await execute('return globalThis.__OPENBOT_RUNTIME__.session.persistence'),'saved')
    }
    const sessionCount=async()=>Number((await exec('docker',['compose','-f',join(root,'dev/compose.yaml'),'exec','-T','postgres','psql','-U','openbot_dev','-d',database,'-Atc','SELECT count(*) FROM openbot_auth_session'])).stdout.trim())
    assert.equal(await sessionCount(),1,'The real server must have one session before sign-out.')
    await screenshot('real-email-signed-in')
    await button('Sign out')
    await waitFor(()=>execute("return location.pathname==='/sign-in' && !!document.querySelector('#email')"),'Sign-out from the first account screen did not return to sign-in.')
    assert.equal(await status(),401)
    assert.equal(await sessionCount(),0,'Sign-out must remove the real server session.')
    if(process.env.OPENBOT_CHECK_CREDENTIALS==='1') {
      await restart(JSON.stringify({version:1,origin}))
      await waitFor(()=>execute("return location.pathname==='/sign-in' && !!document.querySelector('#email')"),'A restart after sign-out must stay signed out.')
      assert.equal(await status(),401)
      assert.equal(await execute('return globalThis.__OPENBOT_RUNTIME__.session.persistence'),'none')
    }
    await button('Service settings');await button('Use default')
    await waitFor(()=>execute("return globalThis.__OPENBOT_RUNTIME__?.apiOrigin==='http://localhost:19380'"),'The development backend was not restored after the mail check.')
    evidence={passed:true,backendRevision:revision,entry:'official production server',databaseIsolated:true,apiTls:{validCertificateAccepted:true,untrustedCertificateRejected:true},smtp:{tls:receiver.protocol(),messages:receiver.count(),certificateVerification:true,externalRecipients:false},checks:['wrong code rejected','real delivered code accepted','verified account and bootstrap role','private native cookie','shared first account screen sign-out','remote session count changed from one to zero']}
  } finally {
    process.off('SIGINT',onInterrupt);process.off('SIGTERM',onInterrupt)
    if(server?.pid && server.exitCode===null && server.signalCode===null) {
      const exit=once(server,'exit').catch(()=>{})
      try{process.kill(-server.pid,'SIGTERM')}catch{}
      await Promise.race([exit,delay(5000)])
      if(server.exitCode===null && server.signalCode===null) {try{process.kill(-server.pid,'SIGKILL')}catch{};await Promise.race([exit,delay(1000)])}
    }
    await receiver?.close()
    await proxy?.close()
    await untrustedProxy?.close()
    if(created)await run('docker',[...compose,`DROP DATABASE "${database}" WITH (FORCE)`])
    log.end()
  }
  await writeFile(join(directory,'result.json'),JSON.stringify({...evidence,cleanup:{serverStopped:true,receiverStopped:true,proxyStopped:true,untrustedProxyStopped:true,databaseRemoved:true}},null,2)+'\n',{mode:0o600})
  console.log('PASS: real backend, verified TLS mail delivery, email code, private native session, and shared sign-out; test services and database removed.')
}
