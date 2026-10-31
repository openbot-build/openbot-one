import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { mailTls } from './mail-tls.mjs'

// Trust this run's CA only in the test processes. Node reads extra roots at
// startup; Linux's native verifier reads SSL_CERT_FILE. No system store changes.
const directory=await mailTls()
const child=spawn(process.execPath,[new URL('./desktop.mjs',import.meta.url).pathname],{stdio:'inherit',env:{...process.env,OPENBOT_CHECK_LOCAL_MAIL:'1',OPENBOT_MAIL_TLS_DIR:directory,NODE_EXTRA_CA_CERTS:join(directory,'ca.pem'),SSL_CERT_FILE:join(directory,'ca.pem')}})
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal))
const [code]=await once(child,'exit')
process.exitCode=code??1
