import { createServer } from "node:http"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { WebSocketServer } from "ws"

/** A test-only peer proves native cookie isolation and binary IPC. It is not a
 * Live model, an API proxy, or part of the application bundle. */
export async function socketFixture({port=0,originHost="127.0.0.1"}={}) {
  const cookie = `__Host-openbot-session=${randomUUID()}`
  let origin
  let storageOrigin
  let accepted = 0
  let apiRequests = 0
  let storageRequests = 0
  let storagePrivateHeaders = false
  let emailMode = 'disabled'
  let emailUsed = false
  let emailInput
  let finishEmailSession
  let emailSessionPending = false
  const storage = createServer((request, response) => {
    storageRequests++
    storagePrivateHeaders ||= Boolean(request.headers.cookie || request.headers.authorization || request.headers.origin || request.headers['openbot-organization'])
    let bytes = 0
    request.on('data', (chunk) => { bytes += chunk.length })
    request.on('end', () => {
      response.writeHead(request.method === 'PUT' && bytes === 3 && !storagePrivateHeaders ? 204 : 400).end()
    })
  })
  storage.listen(0, '127.0.0.1')
  await once(storage, 'listening')
  storageOrigin = `http://127.0.0.1:${storage.address().port}`
  const server = createServer(async (request, response) => {
    apiRequests++
    response.setHeader("content-type", "application/json")
    if (request.headers.origin !== origin) { response.writeHead(403).end("{}"); return }
    if (request.url === '/auth/options' && request.method === 'GET') {
      response.end(JSON.stringify({emailSignIn:emailMode !== 'disabled',oidc:false,selfService:'allow',invitations:'allow'}))
    } else if (request.url === '/auth/email/send' && request.method === 'POST') {
      let body = ''
      for await (const chunk of request) body += chunk
      emailInput = JSON.parse(body)
      response.end(JSON.stringify({challenge:'native-email-fixture'}))
    } else if (request.url === '/auth/email/verify' && request.method === 'POST') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      if (input.code === '11111111') response.writeHead(403).end(JSON.stringify({_tag:'AccessDenied',reason:'pending'}))
      else if (input.challenge !== 'native-email-fixture' || input.code !== '12345678' || emailUsed) response.writeHead(403).end(JSON.stringify({_tag:'AccessDenied',reason:'identity'}))
      else if (emailMode === 'redirect') response.writeHead(302,{location:storageOrigin + '/must-not-be-visited'}).end()
      else {
        if (emailMode !== 'missing-cookie') response.setHeader('set-cookie',`${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict`)
        if (emailMode === 'success') emailUsed = true
        response.writeHead(204).end()
      }
    } else if (request.url === "/auth/development/sign-in" && request.method === "POST") {
      response.setHeader("set-cookie", `${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict`)
      response.end("{}")
    } else if (request.url === "/auth/session" && request.headers.cookie === cookie) {
      if (emailMode === 'deferred') {
        emailSessionPending = true
        await new Promise(resolve => { finishEmailSession = resolve })
        emailSessionPending = false
      }
      if (emailMode === 'bad-session') response.end(JSON.stringify({error:'No account'}))
      else if (emailMode === 'large-session') response.end(JSON.stringify({padding:'x'.repeat(70000),userId:'native-socket-fixture'}))
      else response.end(JSON.stringify({ userId: "native-socket-fixture",profile:{},memberships:[],platformAdmin:false,canCreateOrganization:false,expiresAt:'2030-01-01T00:00:00Z' }))
    } else if (request.url === '/v1/invitations' && request.headers.cookie === cookie) {
      response.end(JSON.stringify({items:[],next:null}))
    } else if (request.url === '/v1/cookie-probe') {
      response.setHeader('set-cookie',`${cookie}; Path=/; Secure; HttpOnly`)
      response.end('{}')
    } else if (request.url === '/auth/sign-out' && request.method === 'POST') {
      response.writeHead(204).end()
    } else if (request.url === '/v1/files/uploads' && request.method === 'POST' && request.headers.cookie === cookie) {
      response.writeHead(201).end(JSON.stringify({file:{id:'fixture-upload',bytes:3,status:'pending'},url:storageOrigin + '/object?signature=fixture',method:'PUT',
        headers:{'content-type':'text/plain','content-length':'3'}, expiresAt:Date.now()+60000}))
    } else response.writeHead(401).end("{}")
  })
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.cookie !== cookie || request.headers.origin !== origin) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      accepted++
      ws.on("error", () => {})
      if (request.url?.startsWith("/v1/chats/stopped/")) return
      let messages = 0
      ws.on("message", (data, binary) => {
        ws.send(data, { binary })
        if (++messages === 2) ws.close(1000, "Done")
      })
    })
  })
  server.listen(port, "127.0.0.1")
  await once(server, "listening")
  origin = `http://${originHost}:${server.address().port}`
  return {
    origin,
    accepted: () => accepted,
    apiRequests: () => apiRequests,
    storageStatus: () => ({requests:storageRequests, privateHeaders:storagePrivateHeaders}),
    setEmailMode: mode => { emailMode = mode; emailUsed = false },
    emailInput: () => emailInput,
    emailSessionPending: () => emailSessionPending,
    finishEmailSession: () => finishEmailSession?.(),
    close: async () => {
      finishEmailSession?.()
      for (const socket of sockets.clients) socket.terminate()
      sockets.close()
      await new Promise((resolve) => server.close(resolve))
      await new Promise((resolve) => storage.close(resolve))
    },
  }
}
