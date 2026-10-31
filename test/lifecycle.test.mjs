import assert from "node:assert/strict"
import {test} from "node:test"
import {createAppStateSubscription} from "../src/lifecycle.mjs"

test("only typed current-document activity reaches the shared UI",async()=>{
  const channel={onmessage:/** @param {unknown} _message */ _message=>{}}
  /** @type {unknown[]} */const states=[]
  /** @type {{command:string,args?:Record<string,unknown>}[]} */const calls=[]
  const subscribe=createAppStateSubscription({currentOrigin:"https://api.example.com",runtimeId:"2"},async(command,args)=>{
    calls.push({command,args});return "subscription"
  },()=>channel)
  const stop=await subscribe(state=>states.push(state))
  for(const message of [null,"private-url",{runtimeId:"1",state:"inactive"},{runtimeId:"2",state:"unexpected"}])channel.onmessage(message)
  channel.onmessage({runtimeId:"2",state:"inactive"})
  channel.onmessage({runtimeId:"2",state:"active"})
  assert.deepEqual(states,["inactive","active"])
  stop();stop()
  channel.onmessage({runtimeId:"2",state:"inactive"})
  await new Promise(resolve=>setImmediate(resolve))
  assert.deepEqual(states,["inactive","active"])
  assert.deepEqual(calls.map(call=>call.command),["lifecycle_subscribe","lifecycle_unsubscribe"])
  assert.equal(calls[0].args?.runtimeId,"2")
  assert.equal(calls[0].args?.onState,channel)
})
test("subscription failure closes the callback and unsubscription cannot throw into teardown",async()=>{
  const channel={onmessage:/** @param {unknown} _message */ _message=>{}}
  let fail=true
  const subscribe=createAppStateSubscription({currentOrigin:"https://api.example.com",runtimeId:"2"},command=>{
    if(command==="lifecycle_unsubscribe")throw new Error("The document ended.")
    return fail?Promise.reject(new Error("The document changed.")):Promise.resolve("subscription")
  },()=>channel)
  let count=0
  await assert.rejects(subscribe(()=>count++),/document changed/)
  channel.onmessage({runtimeId:"2",state:"active"})
  assert.equal(count,0)
  fail=false
  const stop=await subscribe(()=>count++)
  assert.doesNotThrow(stop)
  await new Promise(resolve=>setImmediate(resolve))
})
