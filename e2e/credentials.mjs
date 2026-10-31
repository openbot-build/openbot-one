import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const args=process.argv.slice(2)
if(args.some(arg=>arg!=='--native-only')||args.length>1)throw new Error('Choose --native-only or the full credential check.')
const nativeOnly=args.includes('--native-only')

if(process.platform!=='linux')throw new Error('This runner uses a private Linux Secret Service. Other systems need their own native acceptance.')
await mkdir(resolve('.cache/credentials-e2e'),{recursive:true,mode:0o700})
const directory=await mkdtemp(resolve('.cache/credentials-e2e/run-'))
await Promise.all(['data','config'].map(name=>mkdir(join(directory,name),{recursive:true,mode:0o700})))
const child=spawn('dbus-run-session',['--',process.execPath,new URL('./credentials-worker.mjs',import.meta.url).pathname],{stdio:'inherit',env:{...process.env,OPENBOT_CREDENTIALS_TEST_DIR:directory,OPENBOT_CREDENTIALS_NATIVE_ONLY:nativeOnly?'1':'',XDG_DATA_HOME:join(directory,'data'),XDG_CONFIG_HOME:join(directory,'config')}})
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal))
const [code]=await once(child,'exit');process.exitCode=code??1
