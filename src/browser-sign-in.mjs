/** @typedef {{currentOrigin:string,runtimeId:string}} Binding */
/** @typedef {(command:string,args?:Record<string,unknown>)=>Promise<unknown>} Invoke */
/** @typedef {{email?:string,invitation?:string,returnTo?:string,signal?:AbortSignal}} Input */

/** Only a non-secret operation ID crosses IPC. Rust owns every grant value.
 * @param {Binding} binding
 * @param {Invoke} invoke
 */
export function createBrowserSignIn(binding, invoke) {
  /** @param {Input} input */
  return async (input = {}) => {
    const {signal} = input
    const aborted = () => new DOMException("Sign-in was cancelled.", "AbortError")
    if (signal?.aborted) throw aborted()
    const args = {expectedOrigin:binding.currentOrigin,runtimeId:binding.runtimeId}
    const id = await invoke("browser_sign_in_prepare",args)
    if (typeof id !== "string" || !id || id.length > 128) throw new Error("The native sign-in attempt did not start.")
    /** @type {Promise<boolean> | undefined} */
    let cancelling
    const cancel = () => cancelling ??= Promise.resolve().then(()=>invoke("browser_sign_in_cancel",{...args,id})).then(()=>true,()=>false)
    const onAbort = () => { void cancel() }
    signal?.addEventListener("abort",onAbort,{once:true})
    try {
      if (signal?.aborted) {
        if (!await cancel()) throw new Error("The app could not confirm sign-in cancellation.")
        throw aborted()
      }
      try {
        await invoke("browser_sign_in_open",{...args,id,input:{email:input.email,invitation:input.invitation}})
      } catch (error) {
        if (signal?.aborted) {
          if (cancelling && !await cancelling) throw new Error("The app could not confirm sign-in cancellation.")
          throw aborted()
        }
        throw new Error(String(error))
      }
    } finally {
      signal?.removeEventListener("abort",onAbort)
      if (cancelling) await cancelling
    }
  }
}
