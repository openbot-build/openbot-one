import { spawn } from 'node:child_process'
import { access, copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Keep a verified copy before the next architecture's Gradle clean.
const root = fileURLToPath(new URL('../', import.meta.url))
const android = join(root,'src-tauri/gen/android')
const output = join(root,process.env.OPENBOT_ANDROID_ARTIFACT_DIR ?? '.cache/emulator')
const sdk = process.env.ANDROID_HOME
if(!sdk)throw new Error('Use the android devenv profile for packaging.')
const targets = new Map([
  ['aarch64',{abi:'arm64-v8a',file:'openbot-one-arm64-debug.apk'}],
  ['x86_64',{abi:'x86_64',file:'openbot-one-current-debug.apk'}],
])
const selected = process.argv.slice(2)
if(!selected.length || selected.some(target=>!targets.has(target)))throw new Error('Choose aarch64, x86_64, or both.')
/** @param {string} command @param {string[]} args @param {string} cwd @param {boolean} [capture] */
function run(command,args,cwd,capture=false) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env:{...process.env,CARGO_PROFILE_DEV_DEBUG:'0'},stdio:['ignore',capture?'pipe':'inherit','inherit']})
    let result=''
    child.stdout?.on('data',data=>{result+=data})
    child.on('error',reject)
    child.on('close',code=>code===0?resolve(result):reject(new Error(command+' failed. The next architecture was not started.')))
  })
}
await mkdir(output,{recursive:true})
for(const target of selected) {
  const options=targets.get(target)
  if(!options)throw new Error('The Android target is not supported.')
  // Tauri writes machine-specific Gradle settings on the first native build.
  // Gradle cannot evaluate a clean task until those settings exist.
  let initialized=true
  try { await access(join(android,'tauri.settings.gradle')) }
  catch(error) {
    if(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT')initialized=false
    else throw error
  }
  if(initialized)await run(join(android,'gradlew'),[':app:clean'],android)
  else for(const path of ['app/build','app/src/main/jniLibs']) {
    let files=[]
    try { files=await readdir(join(android,path)) }
    catch(error) {
      if(!(error&&typeof error==='object'&&'code' in error&&error.code==='ENOENT'))throw error
    }
    if(files.length)throw new Error('Generated Android settings are missing but build outputs remain. Run pnpm android:build once before packaging.')
  }
  await run('pnpm',['android:build','--debug','--target',target,'--apk','--ci'],root)
  const source=join(android,'app/build/outputs/apk/universal/debug/app-universal-debug.apk')
  await run(join(sdk,'build-tools/36.0.0/apksigner'),['verify','--verbose',source],root)
  const badging=await run(join(sdk,'build-tools/36.0.0/aapt2'),['dump','badging',source],root,true)
  if(!String(badging).split('\n').includes("native-code: '"+options.abi+"'"))throw new Error('The APK does not contain only the selected ABI.')
  const bytes=await readFile(source)
  const sha256=createHash('sha256').update(bytes).digest('hex')
  const destination=join(output,options.file),temporary=destination+'.'+randomUUID()+'.tmp'
  await copyFile(source,temporary)
  if(createHash('sha256').update(await readFile(temporary)).digest('hex')!==sha256)throw new Error('The saved APK does not match its verified source.')
  await rename(temporary,destination)
  const record={target,abi:options.abi,path:destination,bytes:bytes.length,sha256,signature:'debug APK verified',device:'not accepted'}
  const recordPath=join(dirname(destination),target+'-build.json')
  await writeFile(recordPath,JSON.stringify(record,null,2)+'\n')
  console.log(JSON.stringify(record))
}
