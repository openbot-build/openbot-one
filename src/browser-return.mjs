/** @typedef {{currentOrigin:string,runtimeId:string}} Binding */
/** @typedef {(command:string,args?:Record<string,unknown>)=>Promise<unknown>} Invoke */
/** @typedef {{onmessage:(message:unknown)=>void}} ReturnChannel */

/** Only a typed notification crosses IPC. The OS URL and proof stay in Rust.
 * @param {Binding} binding
 * @param {Invoke} invoke
 * @param {()=>ReturnChannel} makeChannel
 * @param {(result:"complete"|"failed")=>void} finished
 */
export async function watchBrowserReturn(binding,invoke,makeChannel,finished) {
  const channel=makeChannel()
  let closed=false,running=false,queued=false
  const resume=async()=>{
    if(closed||running)return
    running=true
    try {
      do {
        queued=false
        const result=await invoke("browser_sign_in_resume",{
          expectedOrigin:binding.currentOrigin,runtimeId:binding.runtimeId,
        })
        if(closed)return
        if(result==="complete"||result==="failed") {
          closed=true
          finished(result)
          return
        }
      } while(queued&&!closed)
    } catch {
      // A completed warm sign-in or a replaced document retires this binding.
      // The command never returns an OS URL or grant material.
      closed=true
    } finally { running=false }
  }
  channel.onmessage=message=>{
    if(closed||!message||typeof message!=="object"||!("runtimeId"in message)||!("returned"in message))return
    if(message.runtimeId!==binding.runtimeId||message.returned!==true)return
    queued=true
    void resume()
  }
  try {
    await invoke("browser_sign_in_watch",{
      expectedOrigin:binding.currentOrigin,runtimeId:binding.runtimeId,onReturn:channel,
    })
  } catch(error) {
    closed=true
    channel.onmessage=()=>{}
    throw new Error(String(error))
  }
  return ()=>{closed=true;channel.onmessage=()=>{}}
}
