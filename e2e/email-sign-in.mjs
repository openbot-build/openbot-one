import assert from 'node:assert/strict'

/** A controlled first-party peer checks the shared form and private native
 * session transition. It does not send mail or stand in for an SSO provider. */
export async function emailSignInChecks({call,execute,button,input,waitFor,screenshot,fixture,restart}) {
  const run = script => call('/execute/async',{script:`const done=arguments[0]; (async()=>{${script}})().then(done,error=>done({error:String(error)}));`,args:[]})
  const status = () => run("return (await globalThis.__OPENBOT_RUNTIME__.fetch(globalThis.__OPENBOT_RUNTIME__.apiOrigin+'/auth/session')).status")
  const reload = async (path='/') => {
    await execute(`globalThis.__oldEmailDocument=true;location.replace(${JSON.stringify(path)});return true`)
    await waitFor(()=>execute("return !globalThis.__oldEmailDocument && !!globalThis.__OPENBOT_RUNTIME__ && (!!document.querySelector('#email') || document.body.innerText.includes('Your organization access'))"),'The new email-check document did not settle.')
  }
  const verify = `globalThis.__OPENBOT_RUNTIME__.fetch(globalThis.__OPENBOT_RUNTIME__.apiOrigin+'/auth/email/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challenge:'native-email-fixture',code:'12345678'})})`
  const select = async origin => {
    await execute(`void globalThis.__OPENBOT_RUNTIME__.connection.change(${JSON.stringify(origin)});return true`)
    await waitFor(()=>execute(`return globalThis.__OPENBOT_RUNTIME__?.apiOrigin === ${JSON.stringify(origin ?? 'http://localhost:19380')} && (document.body.innerText.includes('Sign in to the test account') || !!document.querySelector('#email') || document.body.innerText.includes('Your organization access') || !!document.querySelector('[data-slot=sidebar]'))`),'The email check service did not load.')
  }
  fixture.setEmailMode('missing-cookie')
  await select(fixture.origin)
  assert.equal(await run('await globalThis.__OPENBOT_RUNTIME__.signOut();return true'),true)
  await reload('/sign-in')
  assert.equal(await status(),401)
  const ordinary = await run("const r=await globalThis.__OPENBOT_RUNTIME__.fetch(globalThis.__OPENBOT_RUNTIME__.apiOrigin+'/v1/cookie-probe');await r.body?.cancel();return {hidden:!r.headers.has('set-cookie'),status:r.status}")
  assert.deepEqual(ordinary,{hidden:true,status:200})
  assert.equal(await status(),401,'An ordinary API response must not establish a session.')
  for (const mode of ['missing-cookie','bad-session','large-session','redirect']) {
    fixture.setEmailMode(mode)
    const result=await run(`try {await ${verify};return false} catch {return true}`)
    assert.equal(result,true,mode)
    assert.equal(await status(),401,mode)
  }
  assert.equal(fixture.storageStatus().requests,1,'The native client must not follow a login redirect.')
  fixture.setEmailMode('success')
  await execute("location.replace('/sign-in?invitation=fixture-invite');return true")
  await input('#email','person@example.test')
  await button('Send email code')
  await waitFor(()=>execute("return !!document.querySelector('#code')"),'The shared email-code field did not appear.')
  assert.deepEqual(fixture.emailInput(),{email:'person@example.test',invitation:'fixture-invite'})
  await input('#code','00000000')
  await button('Sign in')
  await waitFor(()=>execute("return document.body.innerText.includes('The code or identity could not be checked')"),'An invalid code must show the shared identity error.')
  assert.equal(await status(),401)
  await input('#code','11111111')
  await button('Sign in')
  await waitFor(()=>execute("return document.body.innerText.includes('Your request is waiting for approval')"),'Admission denial must keep its reason.')
  assert.equal(await status(),401)
  await input('#code','12345678')
  await button('Sign in')
  await waitFor(()=>execute("return location.pathname==='/' && document.body.innerText.includes('Your organization access')"),'Email sign-in did not reach the signed-in shared page.')
  assert.equal(await status(),200)
  assert.equal(await execute("return document.cookie.includes('__Host-openbot-session')"),false)
  await screenshot('email-signed-in')
  if(process.env.OPENBOT_CHECK_MEMORY_ONLY==='1') {
    assert.equal(await execute('return globalThis.__OPENBOT_RUNTIME__.session.persistence'),'memory')
    assert.equal(await execute('return globalThis.__OPENBOT_RUNTIME__.session.issue'),'not-saved')
    await restart(JSON.stringify({version:1,origin:fixture.origin}))
    await waitFor(()=>execute("return location.pathname==='/sign-in' && !!document.querySelector('#email')"),'A memory-only sign-in must not survive a process restart.')
    assert.equal(await status(),401)
    assert.equal(await execute('return globalThis.__OPENBOT_RUNTIME__.session.persistence'),'none')
    fixture.setEmailMode('success')
    assert.equal(await run(`return (await ${verify}).status`),204)
    await execute("location.replace('/');return true")
    await waitFor(()=>execute("return document.body.innerText.includes('Your organization access')"),'The new memory-only sign-in did not open the app.')
    console.log('PASS: unavailable native storage shows a memory-only sign-in and cannot restore it from a plain file.')
  }
  const replay=await run(`const r=await ${verify};return {status:r.status,reason:(await r.json()).reason}`)
  assert.deepEqual(replay,{status:403,reason:'identity'})
  assert.equal(await status(),200,'A failed second sign-in must keep the current account.')
  console.log('PASS: shared email form, invitation, wrong code, admission denial, one-use code, and private checked session.')

  // A completed sign-in closes the old account's live channels and grants.
  fixture.setEmailMode('success')
  assert.equal(await run(`const n=globalThis.__OPENBOT_RUNTIME__;await n.fetch(n.apiOrigin+'/v1/files/uploads',{method:'POST',body:'{}'}).then(r=>r.json()).then(t=>globalThis.__emailGrant=t);await new Promise((resolve,reject)=>{globalThis.__emailSocket=n.createWebSocket(n.apiOrigin.replace('http:','ws:')+'/v1/chats/stopped/live');globalThis.__emailSocket.onopen=resolve;globalThis.__emailSocket.onerror=reject;globalThis.__emailSocket.onclose=e=>globalThis.__emailClose=e.code});return true`),true)
  assert.equal(await run(`return (await ${verify}).status`),204)
  await waitFor(()=>execute('return globalThis.__emailClose===1001'),'Email sign-in did not close the previous live socket.')
  assert.equal(await run("const n=globalThis.__OPENBOT_RUNTIME__,t=globalThis.__emailGrant;try {await n.fetch(t.url,{method:t.method,headers:t.headers,body:'new'});return false}catch{return true}"),true)

  // This document keeps its old binding after the successful sign-in.
  const requestCount=fixture.apiRequests(),socketCount=fixture.accepted()
  const blocked=await run(`
    const n=globalThis.__OPENBOT_RUNTIME__,rejects=async action=>{try{const r=await action();await r?.body?.cancel();return false}catch{return true}};
    return await Promise.all([
      rejects(()=>n.fetch(n.apiOrigin+'/auth/session')),
      rejects(()=>n.signIn({})),rejects(()=>n.signOut()),rejects(()=>n.session.retry()),
      rejects(()=>n.connection.change(null)),rejects(()=>n.connection.retry()),
      new Promise(resolve=>{const socket=n.createWebSocket(n.apiOrigin.replace('http:','ws:')+'/v1/chats/stopped/live');socket.onopen=()=>resolve(false);socket.onerror=()=>resolve(true)})
    ]);
  `)
  assert.deepEqual(blocked,Array(7).fill(true),'Old document actions must be rejected after a same-service sign-in.')
  assert.equal(fixture.apiRequests(),requestCount,'Stale document actions must not send another API request.')
  assert.equal(fixture.accepted(),socketCount,'Stale document actions must not open another channel.')
  await reload()
  assert.equal(await status(),200,'The new document must keep the checked account after stale operations.')
  console.log('PASS: stale same-service HTTP, sockets, auth, and settings actions are rejected before network effects.')

  // A service change during the account check cannot restore stale credentials.
  assert.equal(await run('await globalThis.__OPENBOT_RUNTIME__.signOut();return true'),true)
  await reload('/sign-in')
  fixture.setEmailMode('deferred')
  await execute(`const n=globalThis.__OPENBOT_RUNTIME__;globalThis.__emailAbort=new AbortController();globalThis.__emailPending=n.fetch(n.apiOrigin+'/auth/email/verify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challenge:'native-email-fixture',code:'12345678'}),signal:globalThis.__emailAbort.signal}).then(()=>true,()=>false);return true`)
  await waitFor(()=>fixture.emailSessionPending(),'The cancellable account check did not start.')
  await execute('globalThis.__emailAbort.abort();return true')
  assert.equal(await run('return await globalThis.__emailPending'),false)
  fixture.finishEmailSession()
  await waitFor(()=>!fixture.emailSessionPending(),'The cancelled account check did not finish.')
  assert.equal(await status(),401,'A cancelled account check must not establish a session.')
  fixture.setEmailMode('deferred')
  await execute(`globalThis.__emailPending=${verify}.then(()=>true,()=>false);return true`)
  await waitFor(()=>fixture.emailSessionPending(),'The deferred account check did not start.')
  await select(null)
  fixture.finishEmailSession()
  fixture.setEmailMode('success')
  await select(fixture.origin)
  assert.equal(await status(),401,'A late check from the old service must not restore credentials.')
  await select(null)
  console.log('PASS: email sign-in rejects unchecked sessions and redirects, revokes old resources, and ignores stale account checks.')
}
