import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useLiveTalk } from '/src/hooks/use-live-talk'
import { installRuntime } from '/src/lib/runtime'

// Test only: mount the real hook with controlled audio and socket resources.
const sockets = [], contexts = [], grants = [], tracks = [], worklets = []
const listeners = new Set()
let talk, failSocket = false, holdResume = false
class TestSocket {
  readyState = WebSocket.CONNECTING
  onmessage = null
  onclose = null
  close() { this.readyState = WebSocket.CLOSED; this.closed = true }
  send() {}
  ready() {
    this.readyState = WebSocket.OPEN
    const format = { encoding: 'pcm16', sampleRate: 24000 }
    this.onmessage?.({data:JSON.stringify({type:'session.ready',provider:'fixture',model:'fixture',
      capabilities:{audio:{input:[format],output:[format]},turnDetection:['server'],
        inputTranscription:true,tools:false,interruption:true,truncate:true,
        inputs:{text:true,image:false},voices:[]},audio:{input:format,output:format},turnDetection:'server'})})
  }
}
globalThis.AudioContext = class {
  currentTime = 0
  destination = {}
  audioWorklet = { addModule: async () => {} }
  constructor() { contexts.push(this) }
  resume() {
    if (holdResume) { holdResume = false; return new Promise((_, reject) => { this.rejectResume = reject }) }
    return Promise.resolve()
  }
  close() { this.closed = true; return Promise.resolve() }
  createMediaStreamSource() { return {connect(){},disconnect(){}} }
}
globalThis.AudioWorkletNode = class {
  port = {onmessage:null,close:() => { this.portClosed = true }}
  constructor() { worklets.push(this) }
  connect() {}
  disconnect() { this.disconnected = true }
}
Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:() => new Promise(resolve => {
  grants.push(() => {
    const track = {stopped:false,stop(){this.stopped = true}}
    tracks.push(track)
    resolve({getTracks:() => [track]})
  })
})})
installRuntime({version:1,kind:'native',apiOrigin:'https://fixture.test',fetch:globalThis.fetch,
  signIn:async()=>{},signOut:async()=>{},writeClipboard:async()=>{},openExternal:async()=>{},
  createWebSocket:() => {
    if (failSocket) { failSocket = false; throw new Error('Socket fixture failure') }
    const socket = new TestSocket(); sockets.push(socket); return socket
  },
  onAppStateChange:async handler => { listeners.add(handler); return () => listeners.delete(handler) },
})
function Probe({chatId,organization}) {
  talk = useLiveTalk({chatId,organization,onTurnEnd:async()=>{}})
  useEffect(() => { globalThis.__scope = `${chatId}/${organization}` },[chatId,organization])
  return React.createElement('output',null,talk.state.status)
}
const root = createRoot(document.getElementById('probe'))
globalThis.__probe = {
  unmount() { root.unmount() },
  mount(chatId,organization) { root.render(React.createElement(React.StrictMode,null,React.createElement(Probe,{chatId,organization}))) },
  start() { talk.start() },
  ready() { sockets.at(-1).ready() },
  grant(index) { grants[index]() },
  state() { return talk.state },
  native(state) { for (const handler of listeners) handler(state) },
  holdResume() { holdResume = true },
  rejectResume(index) { contexts[index].rejectResume(new Error('Old resume failed')) },
  failSocket() { failSocket = true },
  stats() { return {sockets:sockets.map(s=>({closed:!!s.closed})),contexts:contexts.map(c=>({closed:!!c.closed})),
    grants:grants.length,tracks:tracks.map(t=>({stopped:t.stopped})),
    worklets:worklets.map(w=>({portClosed:!!w.portClosed,disconnected:!!w.disconnected})),listeners:listeners.size} },
}
