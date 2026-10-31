/** @typedef {'active'|'inactive'} Activity */
/** @typedef {{currentOrigin:string,runtimeId:string}} Binding */
/** @typedef {(command:string,args?:Record<string,unknown>)=>Promise<unknown>} Invoke */
/** @typedef {{onmessage:(message:unknown)=>void}} Channel */

/** No global event permission: this channel carries only activity and its lease.
 * @param {Binding} binding
 * @param {Invoke} invoke
 * @param {()=>Channel} makeChannel
 */
export function createAppStateSubscription(binding,invoke,makeChannel) {
  /** @param {(state:Activity)=>void} handler */
  return async handler=>{
    const channel=makeChannel()
    let closed=false
    channel.onmessage=message=>{
      if(closed||!message||typeof message!=="object"||!("runtimeId"in message)||!("state"in message))return
      if(message.runtimeId!==binding.runtimeId)return
      if(message.state==="active"||message.state==="inactive")handler(message.state)
    }
    let id
    try {
      id=await invoke("lifecycle_subscribe",{expectedOrigin:binding.currentOrigin,runtimeId:binding.runtimeId,onState:channel})
      if(typeof id!=="string"||!id||id.length>128)throw new Error("The activity listener did not start.")
    } catch(error) {
      closed=true
      channel.onmessage=()=>{}
      throw new Error(String(error))
    }
    return ()=>{
      if(closed)return
      closed=true
      channel.onmessage=()=>{}
      // Cleanup owns only this random handle; a late unsubscription cannot
      // remove a newer document's channel.
      void Promise.resolve().then(()=>invoke("lifecycle_unsubscribe",{id})).catch(()=>{})
    }
  }
}
