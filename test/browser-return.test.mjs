import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate } from "node:timers/promises"
import { watchBrowserReturn } from "../src/browser-return.mjs"

const binding={currentOrigin:"https://service.example.com",runtimeId:"7"}
const notice={runtimeId:"7",returned:true}
test("mobile return sends only the bound notice through IPC and replaces the runtime after native commit",async()=>{
  const channel={onmessage:/** @param {unknown} _message */ _message=>{}}
  /** @type {{command:string,args?:Record<string,unknown>}[]} */ const calls=[]
  /** @type {string[]} */ const finished=[]
  const stop=await watchBrowserReturn(binding,async(command,args)=>{
    calls.push({command,args})
    return command==="browser_sign_in_resume"?"complete":undefined
  },()=>channel,result=>finished.push(result))
  for(const message of [null,{}, {runtimeId:"6",returned:true}, {runtimeId:"7",returned:false}, "private-code"])
    channel.onmessage(message)
  assert.equal(calls.length,1)
  channel.onmessage(notice)
  await setImmediate()
  assert.deepEqual(finished,["complete"])
  assert.deepEqual(calls[1],{command:"browser_sign_in_resume",args:{expectedOrigin:binding.currentOrigin,runtimeId:"7"}})
  channel.onmessage(notice)
  assert.equal(calls.length,2)
  stop()
})
test("notifications coalesce during resume and a return arriving in flight is checked afterwards",async()=>{
  const channel={onmessage:/** @param {unknown} _message */ _message=>{}}
  /** @type {(value:unknown)=>void} */ let release=()=>assert.fail("No recovery is pending")
  /** @type {string[]} */ const finished=[]
  let resumes=0
  const stop=await watchBrowserReturn(binding,async command=>{
    if(command!=="browser_sign_in_resume")return
    resumes++
    if(resumes===1)return await new Promise(resolve=>release=resolve)
    return "failed"
  },()=>channel,result=>finished.push(result))
  channel.onmessage(notice)
  channel.onmessage(notice)
  channel.onmessage(notice)
  assert.equal(resumes,1)
  release("no-return")
  await setImmediate()
  assert.equal(resumes,2)
  assert.deepEqual(finished,["failed"])
  stop()
})
test("disposing a document drops a late recovery result and failed subscription closes its callback",async()=>{
  const channel={onmessage:/** @param {unknown} _message */ _message=>{}}
  /** @type {(value:unknown)=>void} */ let release=()=>assert.fail("No recovery is pending")
  /** @type {string[]} */ const finished=[]
  const stop=await watchBrowserReturn(binding,async command=>{
    if(command==="browser_sign_in_resume")return await new Promise(resolve=>release=resolve)
  },()=>channel,result=>finished.push(result))
  channel.onmessage(notice)
  stop()
  release("complete")
  await setImmediate()
  assert.deepEqual(finished,[])
  await assert.rejects(watchBrowserReturn(binding,async()=>{throw new Error("denied")},
    ()=>channel,()=>assert.fail("A failed listener must stay closed")),/denied/)
  channel.onmessage(notice)
})
