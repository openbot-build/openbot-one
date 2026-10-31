import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

const directory=process.env.OPENBOT_CREDENTIALS_TEST_DIR
if(!directory || !process.env.DBUS_SESSION_BUS_ADDRESS)throw new Error('Run this check through pnpm credentials:check.')
const exec=promisify(execFile)
const data=join(directory,'data'),config=join(directory,'config'),control=join(directory,'control')
await Promise.all([data,config,control].map(path=>mkdir(path,{recursive:true,mode:0o700})))
process.env.XDG_DATA_HOME=data;process.env.XDG_CONFIG_HOME=config
const log=createWriteStream(join(directory,'keyring.log'),{mode:0o600})
const daemon=spawn('gnome-keyring-daemon',['--foreground','--components=secrets','--unlock','--control-directory',control],{stdio:['pipe','pipe','pipe']})
daemon.stdout.pipe(log,{end:false});daemon.stderr.pipe(log,{end:false})
// A fresh encrypted test keyring; no empty password or user keyring is used.
daemon.stdin.end(randomBytes(32).toString('hex'))
let child
const interrupt=()=>{child?.kill('SIGTERM');daemon.kill('SIGTERM')}
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt)
const run=async(args,extra={})=>{
  child=spawn(args[0],args.slice(1),{stdio:'inherit',env:{...process.env,OPENBOT_CHECK_CREDENTIALS:'1',...extra}})
  const [code]=await once(child,'exit');child=undefined
  if(code!==0)throw new Error('The private native credential check failed.')
}
try {
  let ready=false
  for(let count=0;count<50;count++) {
    if(daemon.exitCode!==null)throw new Error('The private Secret Service stopped.')
    const reply=await exec('dbus-send',['--session','--dest=org.freedesktop.DBus','--type=method_call','--print-reply','/org/freedesktop/DBus','org.freedesktop.DBus.NameHasOwner','string:org.freedesktop.secrets'])
    if(reply.stdout.includes('boolean true')){ready=true;break}
    await delay(100)
  }
  if(!ready)throw new Error('The private Secret Service did not start.')
  await run(['cargo','test','--locked','--manifest-path','src-tauri/Cargo.toml','native_vault_round_trip','--','--ignored'])
  if(process.env.OPENBOT_CREDENTIALS_NATIVE_ONLY==='1') {
    await writeFile(join(directory,'result.json'),JSON.stringify({passed:true,store:'private D-Bus Secret Service with encrypted GNOME keyring',nativeSessionRoundTrip:true,nativePendingRoundTrip:true,purposeIsolation:true,scope:'native Rust credential checks only'},null,2)+'\n',{mode:0o600})
  } else {
  await run([process.execPath,new URL('./mail.mjs',import.meta.url).pathname])
  await run([process.execPath,new URL('./desktop.mjs',import.meta.url).pathname],{OPENBOT_CHECK_CREDENTIALS:'',OPENBOT_CHECK_LOCAL_MAIL:'',OPENBOT_CHECK_MEMORY_ONLY:'1',DBUS_SESSION_BUS_ADDRESS:'unix:path='+join(directory,'missing-bus')})
  await writeFile(join(directory,'result.json'),JSON.stringify({passed:true,store:'private D-Bus Secret Service with encrypted GNOME keyring',nativeRoundTrip:true,packagedRestart:true,logoutRestart:true,unavailableStoreMemoryOnly:true,noPlainFileRestoration:true},null,2)+'\n',{mode:0o600})
  }
} finally {
  process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt)
  if(daemon.exitCode===null && daemon.signalCode===null) {
    const exited=once(daemon,'exit');daemon.kill('SIGTERM')
    await Promise.race([exited,delay(5000)])
    if(daemon.exitCode===null && daemon.signalCode===null)daemon.kill('SIGKILL')
  }
  log.end()
}
