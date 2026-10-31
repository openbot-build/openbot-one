import assert from "node:assert/strict"
import {test} from "node:test"
import {createBrowserSignIn} from "../src/browser-sign-in.mjs"

const binding={currentOrigin:"https://api.example.com",runtimeId:"7"}
test("browser sign-in sends only public input and a non-secret operation ID through IPC",async()=>{
  /** @type {{command:string,args?:Record<string,unknown>}[]} */
  const calls=[]
  const signal=new AbortController()
  const signIn=createBrowserSignIn(binding,async(command,args)=>{
    calls.push({command,args})
    return command==="browser_sign_in_prepare" ? "operation" : undefined
  })
  await signIn({email:"person@example.com",invitation:"invitation",returnTo:"/chat",signal:signal.signal})
  signal.abort()
  assert.deepEqual(calls.map(call=>call.command),["browser_sign_in_prepare","browser_sign_in_open"])
  assert.deepEqual(calls[1].args,{expectedOrigin:binding.currentOrigin,runtimeId:"7",id:"operation",input:{email:"person@example.com",invitation:"invitation"}})
})
test("an abort while preparation is pending cancels that ID and never opens the browser",async()=>{
  /** @type {(id:unknown)=>void} */
  let prepared=()=>{}
  /** @type {string[]} */
  const calls=[]
  const controller=new AbortController()
  const signIn=createBrowserSignIn(binding,async(command)=>{
    calls.push(command)
    if(command==="browser_sign_in_prepare")return new Promise(resolve=>{prepared=resolve})
  })
  const result=signIn({signal:controller.signal})
  controller.abort()
  prepared("operation")
  await assert.rejects(result,error=>error instanceof DOMException&&error.name==="AbortError")
  assert.deepEqual(calls,["browser_sign_in_prepare","browser_sign_in_cancel"])
})
test("an abort after open is owned through the native command and removes the abort listener",async()=>{
  /** @type {(error:Error)=>void} */
  let rejectOpen=()=>{}
  /** @type {()=>void} */
  let didOpen=()=>{}
  const opened=new Promise(resolve=>{didOpen=()=>resolve(undefined)})
  /** @type {string[]} */
  const calls=[]
  const controller=new AbortController()
  const signIn=createBrowserSignIn(binding,async(command)=>{
    calls.push(command)
    if(command==="browser_sign_in_prepare")return "operation"
    if(command==="browser_sign_in_open"){
      didOpen()
      return new Promise((_,reject)=>{rejectOpen=reject})
    }
    if(command==="browser_sign_in_cancel")rejectOpen(new Error("Sign-in was cancelled."))
  })
  const result=signIn({signal:controller.signal})
  await opened
  controller.abort()
  await assert.rejects(result,error=>error instanceof DOMException&&error.name==="AbortError")
  controller.abort()
  assert.deepEqual(calls,["browser_sign_in_prepare","browser_sign_in_open","browser_sign_in_cancel"])
})
test("an unconfirmed cancellation is reported instead of claiming that the attempt stopped",async()=>{
  const controller=new AbortController()
  /** @type {(id:unknown)=>void} */
  let prepared=()=>{}
  const signIn=createBrowserSignIn(binding,(command)=>{
    if(command==="browser_sign_in_prepare")return new Promise(resolve=>{prepared=resolve})
    throw new Error("IPC did not answer.")
  })
  const result=signIn({signal:controller.signal})
  controller.abort()
  prepared("operation")
  await assert.rejects(result,/could not confirm sign-in cancellation/)
})
