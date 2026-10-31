import assert from "node:assert/strict"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { createNativeWebSocket } from "../src/socket.mjs"

const origin = "https://service.test"
const url = "wss://service.test/v1/chats/chat/live?organization=one"
/** @param {WebSocket} socket @param {string} type */
function event(socket, type) {
  return new Promise((resolve) => socket.addEventListener(type, resolve, { once: true }))
}

test("native sockets keep message order, binary views, and close events", async () => {
  /** @type {Uint8Array[]} */ const writes = []
  /** @type {string[]} */ const commands = []
  let reading = 0
  const socket = createNativeWebSocket(origin, "document-1", async (command, args) => {
    commands.push(command)
    if (command === "socket_prepare") {
      assert.deepEqual(args, { url, expectedOrigin: origin, runtimeId: "document-1" })
      return "socket"
    }
    if (command === "socket_open") return
    if (command === "socket_write") { assert.ok(args instanceof Uint8Array); writes.push(args.slice()); return }
    if (command === "socket_read") {
      // Wait for the test to install the next listener after each message.
      await delay(5)
      return [new Uint8Array([0, ...new TextEncoder().encode("Hello 世界")]), new Uint8Array([1, 0, 255]), new Uint8Array([2, 3, 232, 1])][reading++].buffer
    }
    if (command === "socket_close") return
    assert.fail(command)
  })(url)
  socket.binaryType = "arraybuffer"
  assert.equal(socket.readyState, WebSocket.CONNECTING)
  assert.throws(() => socket.send("early"), { name: "InvalidStateError" })
  await event(socket, "open")
  socket.send("first")
  const view = new Uint8Array([9, 1, 2, 9]).subarray(1, 3)
  socket.send(view)
  view[0] = 99
  const text = /** @type {MessageEvent} */ (await event(socket, "message"))
  assert.equal(text.data, "Hello 世界")
  assert.equal(text.origin, "wss://service.test")
  const binary = /** @type {MessageEvent} */ (await event(socket, "message"))
  assert.deepEqual(new Uint8Array(binary.data), new Uint8Array([0, 255]))
  const close = /** @type {CloseEvent} */ (await event(socket, "close"))
  assert.equal(close.code, 1000)
  assert.equal(close.wasClean, true)
  assert.equal(socket.readyState, WebSocket.CLOSED)
  assert.deepEqual(writes, [new Uint8Array([0, ...new TextEncoder().encode("first")]), new Uint8Array([1, 1, 2])])
  assert.equal(socket.bufferedAmount, 0)
  assert.equal(commands.filter((name) => name === "socket_read").length, 3)
})

test("closing while preparation is pending releases the native socket", async () => {
  /** @type {() => void} */ let ready = () => {}
  const prepared = new Promise((resolve) => { ready = () => resolve("socket") })
  let opened = false
  let closed = false
  const socket = createNativeWebSocket(origin, "document-1", async (command) => {
    if (command === "socket_prepare") return prepared
    if (command === "socket_open") { opened = true; return }
    if (command === "socket_close") { closed = true; return }
    assert.fail(command)
  })(url)
  const done = event(socket, "close")
  socket.close()
  ready()
  await done
  assert.equal(opened, false)
  assert.equal(closed, true)
})

test("native socket failures close once and output queues stay bounded", async () => {
  /** @type {() => void} */ let cancel = () => {}
  const cancelled = new Promise((resolve) => { cancel = () => resolve([2, 3, 238, 0]) })
  let errors = 0
  const socket = createNativeWebSocket(origin, "document-1", async (command) => {
    if (command === "socket_prepare") return "socket"
    if (command === "socket_open") return
    if (command === "socket_read") return cancelled
    if (command === "socket_close") { cancel(); return }
    assert.fail(command)
  })(url)
  socket.onerror = () => { errors++ }
  await event(socket, "open")
  const closed = event(socket, "close")
  socket.send(new Uint8Array(1024 * 1024 + 1))
  await closed
  assert.equal(errors, 1)
  assert.equal(socket.bufferedAmount, 0)
  assert.throws(() => socket.close(1001), { name: "InvalidAccessError" })
  assert.throws(() => socket.close(1000, "长".repeat(42)), { name: "SyntaxError" })
})
