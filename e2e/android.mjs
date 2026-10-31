import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { _android as android } from "playwright-core"

// Defaults to the private emulator; a device must be selected by serial.
const output = resolve('.cache/emulator')
await mkdir(output, {recursive:true})
const serial = process.env.OPENBOT_ANDROID_SERIAL ?? 'emulator-5558'
const port = Number(process.env.OPENBOT_ADB_PORT ?? 19373)
if (!serial || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a device serial and a valid local ADB port.')
const devices = await android.devices({host:'127.0.0.1',port,omitDriverInstall:true})
const device = devices.find(device => device.serial() === serial)
for (const other of devices) if (other !== device) await other.close()
if (!device) throw new Error('The selected Android device is not connected to the local ADB server.')
device.setDefaultTimeout(180000)
let page
const errors = []
try {
  await device.shell('input keyevent KEYCODE_WAKEUP')
  await device.shell('wm dismiss-keyguard')
  console.log((await device.shell('am start -n build.openbot.one/.MainActivity')).toString().trim())
  const webview = await device.webView({pkg:'build.openbot.one'},{timeout:300000})
  console.log('Android WebView debug socket is available.')
  let timer
  let onClose
  try {
    page = await Promise.race([
      webview.page(),
      new Promise((_,reject) => {
        onClose = () => reject(new Error('The Android WebView closed before its debug connection was ready.'))
        webview.once('close',onClose)
        timer = setTimeout(() => reject(new Error('The Android WebView debug connection did not become ready.')),180000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onClose) webview.off('close',onClose)
  }
  page.setDefaultTimeout(180000)
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => globalThis.__OPENBOT_RUNTIME__?.apiOrigin === 'http://localhost:19380')
  await page.getByRole('button',{name:'Sign in to the test account',exact:true}).waitFor()
  await device.screenshot({path:resolve(output,'android-sign-in.png')})
  const version = await page.evaluate(() => ({agent:navigator.userAgent,width:innerWidth,height:innerHeight,visualHeight:visualViewport?.height}))
  await writeFile(resolve(output,'android-version.json'),JSON.stringify(version,null,2))
  console.log('PASS: Android WebView started with the local native runtime.')

  if(process.env.OPENBOT_ANDROID_BROWSER_PRIVACY_CHECK==='1') {
    const denials=await page.evaluate(async()=>{
      const invoke=globalThis.__TAURI_INTERNALS__.invoke
      if(typeof globalThis.__OPENBOT_RUNTIME__.browserSignIn!=='function')throw new Error('Install the mobile-browser APK for this optional check.')
      const results=[]
      for(const command of ['plugin:deep-link|get_current','plugin:deep-link|getCurrent',
        'plugin:deep-link|setEventHandler','plugin:deep-link|set_event_handler',
        'plugin:event|listen','plugin:event|unlisten']) {
        try {
          await invoke(command,{event:'deep-link://new-url',target:{kind:'Any'},handler:0,eventId:0})
          results.push({command,denied:false})
        } catch(error) {
          results.push({command,denied:/not allowed|not permitted|denied/i.test(String(error))})
        }
      }
      return results
    })
    assert.ok(denials.every(result=>result.denied),'Raw deep-link and general event IPC must be denied before argument handling.')
    const before=await page.evaluate(async()=>(await globalThis.__OPENBOT_RUNTIME__.fetch('http://localhost:19380/auth/session')).status)
    assert.equal(before,401)
    // Public synthetic values only. There is no matching native verifier/proof.
    await device.shell("am start -W -a android.intent.action.VIEW -d 'build.openbot.one:/auth/callback?code=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&iss=http%3A%2F%2Flocalhost%3A19380' build.openbot.one")
    const recovered=await page.evaluate(async()=>{
      const invoke=globalThis.__TAURI_INTERNALS__.invoke
      const current=await invoke('connection_get')
      return await invoke('browser_sign_in_resume',{expectedOrigin:current.currentOrigin,runtimeId:current.runtimeId})
    })
    assert.equal(recovered,'no-return')
    const after=await page.evaluate(async()=>(await globalThis.__OPENBOT_RUNTIME__.fetch('http://localhost:19380/auth/session')).status)
    assert.equal(after,401)
    await writeFile(resolve(output,'android-browser-privacy.json'),JSON.stringify({
      passed:true,denials,unsolicitedReturnNoSession:true,sessionStatus:{before,after},
      providerSignIn:'not checked by this local-development flow',
    },null,2))
    console.log('PASS: raw deep-link IPC denied and an unsolicited OS return cannot sign in.')
  }

  await page.getByRole('button',{name:'Service settings',exact:true}).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  const fullHeight = await page.evaluate(() => visualViewport?.height ?? innerHeight)
  const field = page.locator('input[type=url]')
  await field.click()
  await page.waitForFunction(height => (visualViewport?.height ?? innerHeight) < height - 80, fullHeight)
  await page.waitForFunction(() => {
    const rect = document.querySelector('[role=dialog]')?.getBoundingClientRect()
    const viewport = visualViewport
    return rect && viewport && rect.top >= viewport.offsetTop && rect.bottom <= viewport.offsetTop + viewport.height + 1
  })
  assert.equal(await field.evaluate(element => document.activeElement === element),true)
  await device.screenshot({path:resolve(output,'android-keyboard.png')})
  await device.shell('input keyevent KEYCODE_BACK')
  await page.waitForFunction(height => (visualViewport?.height ?? innerHeight) > height - 20,fullHeight)
  assert.equal(await dialog.isVisible(),true,'The first Back must dismiss the keyboard before the dialog.')
  await device.shell('input keyevent KEYCODE_BACK')
  await dialog.waitFor({state:'hidden'})
  console.log('PASS: Android keyboard height, dialog focus, and Back dismissal.')
  await page.getByRole('button',{name:'Sign in to the test account',exact:true}).click()
  await page.waitForURL(url => url.pathname === '/', {timeout:180000})
  await page.waitForFunction(() => !!document.querySelector('[data-slot=sidebar]'))
  const status = await page.evaluate(async () => (await globalThis.__OPENBOT_RUNTIME__.fetch('http://localhost:19380/auth/session')).status)
  assert.equal(status,200)
  await device.screenshot({path:resolve(output,'android-signed-in.png')})
  assert.deepEqual(errors,[])
  console.log('PASS: Android native development sign-in and authenticated REST.')
} catch (error) {
  await device.screenshot({path:resolve(output,'android-failure.png')}).catch(()=>{})
  await writeFile(resolve(output,'android-failure.log'),JSON.stringify({errors,text:await page?.locator('body').innerText().catch(()=>undefined)},null,2))
  throw error
} finally {
  await device.close()
}
