import assert from "node:assert/strict"
import { test } from "node:test"
import { createNativeFetch } from "../src/transport.mjs"

const origin = "https://service.test"
const head = { status: 200, statusText: "OK", url: origin + "/v1/events", headers: [["content-type", "text/event-stream"]] }

test("native fetch uploads large bodies in bounded binary chunks and reads a stream", async () => {
  /** @type {Uint8Array[]} */ const uploaded = []
  const chunks = [new TextEncoder().encode("data: first\n\n").buffer, new TextEncoder().encode("data: last\n\n").buffer, new ArrayBuffer(0)]
  /** @type {() => void} */ let finish = () => {}
  const finished = new Promise((resolve) => { finish = () => resolve(undefined) })
  let cancelled = 0
  const fetch = createNativeFetch(origin, "document-1", async (command, args) => {
    if (command === "http_prepare") {
      const input = /** @type {{input:Record<string, unknown>}} */ (args).input
      assert.equal(input.expectedOrigin, origin)
      assert.equal(input.runtimeId, "document-1")
      return "request"
    }
    if (command === "http_open") { await finished; return head }
    if (command === "http_write") { assert.ok(args instanceof Uint8Array); uploaded.push(args.slice()); return true }
    if (command === "http_finish") { finish(); return }
    if (command === "http_read") return chunks.shift()
    if (command === "http_cancel") { cancelled++; return }
    assert.fail(command)
  })
  const bytes = new Uint8Array(150000).map((_, index) => index % 251)
  const response = await fetch(origin + "/v1/events", { method: "POST", body: bytes })
  assert.deepEqual(uploaded.map((chunk) => chunk.length), [65536, 65536, 18928])
  assert.deepEqual(Buffer.concat(uploaded), Buffer.from(bytes))
  assert.equal(await response.text(), "data: first\n\ndata: last\n\n")
  assert.equal(response.url, head.url)
  assert.equal(cancelled, 1)
})

test("native response cancellation stops a blocked reader without buffering the response", async () => {
  let reads = 0
  /** @type {() => void} */ let stop = () => {}
  const stopped = new Promise((resolve) => { stop = () => resolve(undefined) })
  const fetch = createNativeFetch(origin, "document-1", async (command) => {
    if (command === "http_prepare") return "request"
    if (command === "http_open") return head
    if (command === "http_read") { reads++; await stopped; throw new Error("cancelled") }
    if (command === "http_cancel") { stop(); return }
    assert.fail(command)
  })
  const controller = new AbortController()
  const response = await fetch(head.url, { signal: controller.signal })
  assert.ok(response.body)
  const read = response.body.getReader().read()
  controller.abort()
  await assert.rejects(read, { name: "AbortError" })
  assert.ok(reads <= 1)
})

test("native fetch rejects redirects and preserves HTTP error responses", async () => {
  /** @type {string[]} */ const calls = []
  let status = 302
  const fetch = createNativeFetch(origin, "document-1", async (command) => {
    calls.push(command)
    if (command === "http_prepare") return "request"
    if (command === "http_open") return { ...head, status, statusText: "" }
    if (command === "http_read") return []
  })
  await assert.rejects(fetch(head.url), /redirected/)
  assert.ok(calls.includes("http_cancel"))
  status = 401
  const response = await fetch(head.url)
  assert.equal(response.status, 401)
  assert.equal(response.ok, false)
  assert.equal(await response.text(), "")
})

test("a request aborted before preparation performs no IPC", async () => {
  const controller = new AbortController()
  controller.abort()
  const fetch = createNativeFetch(origin, "document-1", async () => assert.fail("IPC must not run"))
  await assert.rejects(fetch(head.url, { signal: controller.signal }), { name: "AbortError" })
})

test("signed file upload lengths become verified metadata without forbidden headers", async () => {
  /** @type {Record<string, unknown> | undefined} */ let input
  /** @type {() => void} */ let finish = () => {}
  const finished = new Promise((resolve) => { finish = () => resolve(undefined) })
  const fetch = createNativeFetch(origin, "document-1", async (command, args) => {
    if (command === "http_prepare") { input = /** @type {{input:Record<string, unknown>}} */ (args).input; return "request" }
    if (command === "http_open") { await finished; return { ...head, status: 204, statusText: "No Content" } }
    if (command === "http_write") return true
    if (command === "http_finish") { finish(); return }
    if (command === "http_cancel") return
    assert.fail(command)
  })
  const body = new Blob(["Hello 世界"])
  const response = await fetch("https://storage.test/object?signed=value", { method: "PUT", headers: { "content-length": String(body.size) }, body })
  assert.equal(response.status, 204)
  assert.equal(input?.contentLength, body.size)
  assert.deepEqual(input?.headers, [])
  await assert.rejects(fetch(head.url, { method: "PUT", headers: { "content-length": "1" }, body }), /length/)
})

test("a denied storage request releases its source stream before any upload", async () => {
  let cancelled = false
  const stream = new ReadableStream({ cancel() { cancelled = true } })
  const fetch = createNativeFetch(origin, "document-1", async (command) => {
    assert.equal(command, "http_prepare")
    throw new Error("This signed upload is not allowed.")
  })
  await assert.rejects(fetch("https://storage.test/object", { method: "PUT", body: stream }), /not allowed/)
  assert.equal(cancelled, true)
})
