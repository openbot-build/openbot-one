import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'

/** Check damaged settings in the real packaged app before normal API screens mount. */
export async function recoveryChecks({call,execute,button,waitFor,screenshot,path,invalid,restart}) {
  await waitFor(()=>execute("return globalThis.__OPENBOT_RUNTIME__?.connection?.recovery === 'invalid-settings' && document.body.innerText.includes('Check your service settings')"),'Damaged settings must open the recovery page.')
  assert.equal(await execute("return document.body.innerText.includes('Sign in to the test account')"),false)
  assert.equal(await execute('return globalThis.__OPENBOT_RUNTIME__.developmentSignIn'),false)
  const blocked = await call('/execute/async',{script:`
    const done = arguments[0], native = globalThis.__OPENBOT_RUNTIME__;
    const blocked = async action => {
      try { const value = await action(); await value?.body?.cancel(); return false; }
      catch (error) { return String(error).includes('Choose a service'); }
    };
    Promise.all([
      blocked(() => native.fetch(native.apiOrigin + '/health')),
      blocked(() => native.signIn({})),
      blocked(async () => { const c=await globalThis.__TAURI_INTERNALS__.invoke('connection_get'); return globalThis.__TAURI_INTERNALS__.invoke('socket_prepare',{
        url:native.apiOrigin.replace('http:','ws:') + '/v1/chats/recovery/live',expectedOrigin:native.apiOrigin,runtimeId:c.runtimeId
      })})
    ]).then(done);
  `,args:[]})
  assert.deepEqual(blocked,[true,true,true],'Settings recovery must block HTTP, sign-in, and sockets.')
  assert.equal(await readFile(path,'utf8'),invalid)
  await screenshot('settings-recovery')
  await execute('globalThis.__recoveryDocument = true; return true')
  await button('Retry saved settings')
  await waitFor(()=>execute("return !globalThis.__recoveryDocument && globalThis.__OPENBOT_RUNTIME__?.connection?.recovery === 'invalid-settings' && !!document.querySelector('input[type=url]')"),'A failed retry must keep the recovery form available.')
  assert.equal(await readFile(path,'utf8'),invalid)
  const repaired = JSON.stringify({version:1,origin:'http://localhost:19380'})
  await writeFile(path,repaired)
  await execute('globalThis.__recoveryDocument = true; return true')
  await button('Retry saved settings')
  await waitFor(()=>execute("return !globalThis.__recoveryDocument && !globalThis.__OPENBOT_RUNTIME__?.connection?.recovery && document.body.innerText.includes('Sign in to the test account')"),'Repaired settings must be re-read without replacing the file.')
  assert.equal(await readFile(path,'utf8'),repaired)
  const future = JSON.stringify({version:2,origin:'https://saved-service.invalid',extra:true})
  await restart(future)
  await waitFor(()=>execute("return globalThis.__OPENBOT_RUNTIME__?.connection?.recovery === 'unsupported-version' && document.body.innerText.includes('another app version')"),'A different settings version must have a recovery page.')
  assert.equal(await readFile(path,'utf8'),future)
  await button('Use default')
  await waitFor(()=>execute("return !globalThis.__OPENBOT_RUNTIME__?.connection?.recovery && document.body.innerText.includes('Sign in to the test account')"),'Explicitly choosing the default must save valid settings.')
  assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{version:1,origin:null})
}
