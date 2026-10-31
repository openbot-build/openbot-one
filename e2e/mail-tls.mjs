import { mkdir, mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** A fresh, private, one-day CA. Call only in the local mail test runner. */
export async function mailTls() {
  await mkdir(resolve('.cache/mail-e2e'),{recursive:true,mode:0o700})
  const directory=await mkdtemp(resolve('.cache/mail-e2e/run-'))
  const exec=promisify(execFile)
  const ca=join(directory,'ca.pem'),caKey=join(directory,'ca.key'),key=join(directory,'server.key'),csr=join(directory,'server.csr'),cert=join(directory,'server.pem')
  const openssl=async args=>{
    try {await exec('openssl',args)}
    catch {throw new Error('The local mail test certificate could not be made.')}
  }
  await openssl(['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=OpenBot One local mail check','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-keyout',caKey,'-out',ca])
  await openssl(['req','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',key,'-out',csr])
  const extensions=join(directory,'server.ext')
  await writeFile(extensions,'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n',{mode:0o600})
  await openssl(['x509','-req','-in',csr,'-CA',ca,'-CAkey',caKey,'-CAcreateserial','-days','1','-extfile',extensions,'-out',cert])
  // A different issuer must fail even with the correct localhost name.
  const untrustedKey=join(directory,'untrusted.key')
  await openssl(['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','basicConstraints=critical,CA:FALSE','-addext','subjectAltName=DNS:localhost','-keyout',untrustedKey,'-out',join(directory,'untrusted.pem')])
  await chmod(untrustedKey,0o600)
  await chmod(key,0o600);await chmod(caKey,0o600)
  return directory
}
