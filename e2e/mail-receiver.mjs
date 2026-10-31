import { createServer, connect } from 'node:tls'
import { once } from 'node:events'

/** A test-only TLS mail sink. It accepts one local test address and never
 * relays or writes mail. Keys, message bodies, and codes stay out of logs. */
export async function mailReceiver({key,cert,ca,recipient}) {
  const peers = new Set()
  const messages = []
  const server = createServer({key,cert,minVersion:'TLSv1.2'},socket => {
    peers.add(socket)
    socket.once('close',()=>peers.delete(socket))
    socket.on('error',()=>{})
    socket.setTimeout(15000,()=>socket.destroy())
    socket.setEncoding('utf8')
    let buffer='',data=false,body='',from=false,to=false
    socket.write('220 localhost OpenBot One mail check\r\n')
    socket.on('data',chunk=>{
      buffer+=chunk
      if (buffer.length+body.length>128*1024) {socket.destroy();return}
      while (buffer.includes('\r\n')) {
        const end=buffer.indexOf('\r\n'),line=buffer.slice(0,end)
        buffer=buffer.slice(end+2)
        if (data) {
          if (line==='.') {
            messages.push({body,protocol:socket.getProtocol()})
            data=false;body='';from=false;to=false
            socket.write('250 Message accepted\r\n')
          } else body+=line.replace(/^\.\./,'.')+'\r\n'
        } else if (/^(EHLO|HELO) /i.test(line)) socket.write('250-localhost\r\n250 SIZE 131072\r\n')
        else if (/^MAIL FROM:/i.test(line)) {from=true;to=false;socket.write('250 Sender accepted\r\n')}
        else if (/^RCPT TO:/i.test(line)) {
          to=from && line.match(/^RCPT TO:<([^>]+)>$/i)?.[1].toLowerCase()===recipient
          socket.write(to?'250 Recipient accepted\r\n':'550 Only the local test address is accepted\r\n')
        } else if (line.toUpperCase()==='DATA' && from && to) {data=true;socket.write('354 End with a dot\r\n')}
        else if (line.toUpperCase()==='QUIT') socket.end('221 Bye\r\n')
        else if (line.toUpperCase()==='RSET') {from=false;to=false;socket.write('250 Reset\r\n')}
        else socket.write('502 Command not supported\r\n')
      }
    })
  })
  // A deliberate untrusted-client probe must fail before any SMTP command.
  server.on('tlsClientError',()=>{})
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  const port=server.address().port
  const probe=trust=>new Promise((resolve,reject)=>{
    const peer=connect({host:'127.0.0.1',port,servername:'localhost',ca:trust?ca:[]})
    peer.once('error',reject)
    peer.once('secureConnect',()=>{const authorized=peer.authorized;peer.destroy();resolve(authorized)})
  })
  return {
    port,probe,
    count:()=>messages.length,
    code:()=>{
      const text=messages.at(-1)?.body ?? ''
      const values=[...text.matchAll(/(?:^|[\s>])(\d{8})(?=[\s<.]|$)/g)].map(match=>match[1])
      const codes=[...new Set(values)]
      if (codes.length!==1) throw new Error('The real email did not contain one eight-digit code.')
      return codes[0]
    },
    protocol:()=>messages.at(-1)?.protocol,
    close:async()=>{for(const peer of peers)peer.destroy();await new Promise(resolve=>server.close(resolve))},
  }
}
