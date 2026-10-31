import { createServer } from 'node:https'
import { request as requestHttp } from 'node:http'
import { once } from 'node:events'

/** A local TLS edge for the unchanged official HTTP server. Authentication
 * cookies and Origin headers pass through as sent by the native client. */
export async function mailProxy({key,cert,backendPort}) {
  let authority
  const server=createServer({key,cert,minVersion:'TLSv1.2'},(request,response)=>{
    if(request.headers.host!==authority) {response.writeHead(421).end();return}
    const upstream=requestHttp({hostname:'127.0.0.1',port:backendPort,path:request.url,method:request.method,headers:{...request.headers,'x-forwarded-proto':'https'}},reply=>{
      response.writeHead(reply.statusCode,reply.headers)
      reply.pipe(response)
    })
    upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end()})
    request.once('aborted',()=>upstream.destroy())
    response.once('close',()=>upstream.destroy())
    request.pipe(upstream)
  })
  server.listen(0,'127.0.0.1')
  await once(server,'listening')
  authority=`localhost:${server.address().port}`
  return {origin:`https://${authority}`,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}}
}
