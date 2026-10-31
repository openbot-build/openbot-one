import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'

// Browser component coverage with controlled media. This is not a Live provider.
try { loadEnvFile(resolve('.env')) }
catch(error) { if(error?.code!=='ENOENT')throw error }
const ui = resolve(process.env.OPENBOT_UI_CHECKOUT ?? process.env.OPENBOT_WEB_PACKAGE_DIR ?? '')
if(!existsSync(resolve(ui,'src/hooks/use-live-talk.ts')))throw new Error('Set OPENBOT_UI_CHECKOUT to the matching shared UI source checkout.')
const cache = resolve(ui,'.cache')
const output = resolve('.cache/lifecycle-e2e')
await Promise.all([mkdir(cache,{recursive:true}),mkdir(output,{recursive:true})])
const html = resolve(cache,'one-live-check.html'), entry = resolve(cache,'one-live-check.jsx')
await writeFile(entry,await readFile(new URL('./live-probe.jsx',import.meta.url)))
await writeFile(html,'<!doctype html><html lang="en"><div id="probe"></div><script type="module" src="./one-live-check.jsx"></script></html>')
const server = spawn('devenv',['shell','--','pnpm','exec','vite','--host','127.0.0.1','--port','19460','--strictPort'],{cwd:ui,stdio:['ignore','pipe','pipe']})
let serverOutput = ''
for (const stream of [server.stdout,server.stderr]) stream.on('data',data => { serverOutput += data; serverOutput = serverOutput.slice(-8000) })
let browser
try {
  let ready = false
  for (let count = 0; count < 100; count++) {
    if (server.exitCode !== null) throw new Error(serverOutput)
    try { ready = (await fetch('http://127.0.0.1:19460/.cache/one-live-check.html')).ok } catch {}
    if (ready) break
    await delay(100)
  }
  assert.ok(ready,'The shared UI test server did not start.')
  if (!process.env.E2E_CHROMIUM) throw new Error('Use the test devenv profile to provide Chromium.')
  const env = {...process.env}; delete env.LD_LIBRARY_PATH
  browser = await chromium.launch({executablePath:process.env.E2E_CHROMIUM,headless:true,env,args:['--no-sandbox']})
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror',error=>errors.push(error.message))
  await page.goto('http://127.0.0.1:19460/.cache/one-live-check.html')
  await page.waitForFunction(()=>!!globalThis.__probe)
  const stats = () => page.evaluate(()=>globalThis.__probe.stats())
  const mount = async (chat,org) => {
    await page.evaluate(([chat,org])=>globalThis.__probe.mount(chat,org),[chat,org])
    await page.waitForFunction(scope=>globalThis.__scope===scope,`${chat}/${org}`)
    await page.waitForFunction(()=>globalThis.__probe.state().status==='idle')
  }
  const start = async () => {
    await page.evaluate(()=>globalThis.__probe.start())
    await page.waitForFunction(()=>globalThis.__probe.state().status==='connecting')
  }
  await mount('one','org-one')
  await start()
  await page.evaluate(()=>{globalThis.__probe.ready();globalThis.__probe.ready()})
  await page.waitForFunction(()=>globalThis.__probe.stats().grants===1)
  await mount('two','org-one')
  assert.equal((await stats()).sockets[0].closed,true)
  assert.equal((await stats()).contexts[0].closed,true)
  await page.evaluate(()=>globalThis.__probe.grant(0))
  await page.waitForFunction(()=>globalThis.__probe.stats().tracks[0]?.stopped)
  await start()
  await page.evaluate(()=>globalThis.__probe.ready())
  await page.waitForFunction(()=>globalThis.__probe.stats().grants===2)
  await page.evaluate(()=>globalThis.__probe.grant(1))
  await page.waitForFunction(()=>globalThis.__probe.stats().worklets.length===1)
  await mount('two','org-two')
  let current = await stats()
  assert.ok(current.contexts.every(c=>c.closed) && current.sockets.every(s=>s.closed))
  assert.ok(current.tracks.every(t=>t.stopped))
  assert.deepEqual(current.worklets,[{portClosed:true,disconnected:true}])
  console.log('PASS: chat/organization changes close real hook resources, late microphone grants, and duplicate readiness.')
  await start()
  await page.evaluate(()=>globalThis.__probe.native('inactive'))
  await page.waitForFunction(()=>globalThis.__probe.state().status==='idle')
  const count = (await stats()).sockets.length
  await page.evaluate(()=>globalThis.__probe.native('active'))
  assert.equal((await stats()).sockets.length,count)
  await start()
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')))
  await page.waitForFunction(()=>globalThis.__probe.state().status==='idle')
  current = await stats()
  assert.ok(current.contexts.every(c=>c.closed) && current.sockets.every(s=>s.closed))
  console.log('PASS: native pause and page hide end the talk; resume does not start another.')
  await page.evaluate(()=>globalThis.__probe.holdResume())
  const old = (await stats()).contexts.length
  await start()
  await mount('three','org-two')
  await start()
  await page.evaluate(index=>globalThis.__probe.rejectResume(index),old)
  await delay(50)
  assert.equal(await page.evaluate(()=>globalThis.__probe.state().status),'connecting')
  assert.equal((await stats()).contexts.at(-1).closed,false)
  await mount('four','org-two')
  await page.evaluate(()=>{globalThis.__probe.failSocket();globalThis.__probe.start()})
  await page.waitForFunction(()=>!!globalThis.__probe.state().error)
  assert.equal((await stats()).contexts.at(-1).closed,true)
  await mount('five','org-three')
  await start()
  await page.evaluate(()=>globalThis.__probe.unmount())
  await page.waitForFunction(()=>globalThis.__probe.stats().listeners===0)
  current = await stats()
  assert.ok(current.contexts.every(c=>c.closed) && current.sockets.every(s=>s.closed))
  assert.deepEqual(errors,[])
  await writeFile(resolve(output,'result.json'),JSON.stringify({checks:'passed',uiCheckout:ui,resources:await stats(),errors},null,2))
  console.log('PASS: stale audio failures cannot stop a new talk; setup failure and unmount release resources.')
} finally {
  await browser?.close()
  server.kill('SIGTERM')
  await Promise.allSettled([unlink(html),unlink(entry)])
}
