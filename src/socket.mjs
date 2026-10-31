/** @typedef {import('./transport.mjs').Invoke} Invoke */
const MAX_MESSAGE = 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/** A WebSocket surface backed by a credential-free, pull-based IPC bridge.
 * @param {string} origin @param {string} runtimeId @param {Invoke} invoke
 * @returns {(url:string) => WebSocket}
 */
export function createNativeWebSocket(origin, runtimeId, invoke) {
  return (url) => /** @type {WebSocket} */ (/** @type {unknown} */ (new NativeSocket(url, origin, runtimeId, invoke)))
}

class NativeSocket extends EventTarget {
  CONNECTING = 0
  OPEN = 1
  CLOSING = 2
  CLOSED = 3
  readyState = 0
  bufferedAmount = 0
  extensions = ""
  protocol = ""
  /** @type {BinaryType} */ binaryType = "blob"
  /** @type {((event:Event) => void) | null} */ onopen = null
  /** @type {((event:Event) => void) | null} */ onerror = null
  /** @type {((event:MessageEvent) => void) | null} */ onmessage = null
  /** @type {((event:CloseEvent) => void) | null} */ onclose = null
  /** @type {string | undefined} */ #id
  /** @type {Invoke} */ #invoke
  #writes = Promise.resolve()
  #closeCode = 1000
  #closeReason = ""

  /** @param {string} input @param {string} origin @param {string} runtimeId @param {Invoke} invoke */
  constructor(input, origin, runtimeId, invoke) {
    super()
    const url = new URL(input)
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash)
      throw new DOMException("The live address is not valid.", "SyntaxError")
    this.url = url.href
    this.#invoke = invoke
    void this.#connect(origin, runtimeId)
  }

  /** @param {string} origin @param {string} runtimeId */
  async #connect(origin, runtimeId) {
    try {
      this.#id = /** @type {string} */ (await this.#invoke("socket_prepare", { url: this.url, expectedOrigin: origin, runtimeId }))
      if (this.readyState !== this.CONNECTING) {
        await this.#invoke("socket_close", { id: this.#id, code: this.#closeCode, reason: this.#closeReason })
        this.#finish(1006, false, "The live connection was cancelled.")
        return
      }
      await this.#invoke("socket_open", { id: this.#id })
      if (this.readyState === this.CONNECTING) {
        this.readyState = this.OPEN
        const event = new Event("open")
        this.#emit(event, this.onopen)
      }
      while (this.readyState !== this.CLOSED) {
        const raw = /** @type {ArrayBuffer | number[]} */ (await this.#invoke("socket_read", { id: this.#id }))
        const packet = new Uint8Array(raw)
        if (this.readyState === this.CLOSED) return
        if (packet[0] === 2 && packet.length >= 4) {
          this.#finish((packet[1] << 8) | packet[2], packet[3] === 1, decoder.decode(packet.subarray(4)))
          return
        }
        if (this.readyState !== this.OPEN) continue
        if (packet[0] !== 0 && packet[0] !== 1) throw new Error("The live message is not valid.")
        const data = packet[0] === 0 ? decoder.decode(packet.subarray(1))
          : this.binaryType === "arraybuffer" ? packet.slice(1).buffer : new Blob([packet.slice(1)])
        const event = new MessageEvent("message", { data, origin: new URL(this.url).origin })
        this.#emit(event, this.onmessage)
      }
    } catch { this.#fail() }
  }

  /** @param {string | ArrayBufferLike | Blob | ArrayBufferView} data */
  send(data) {
    if (this.readyState === this.CONNECTING) throw new DOMException("The live connection is not open.", "InvalidStateError")
    if (this.readyState !== this.OPEN) return
    const value = typeof data === "string" ? encoder.encode(data) : data instanceof Blob ? data
      : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data).slice()
    const size = value instanceof Blob ? value.size : value.byteLength
    if (size > MAX_MESSAGE || this.bufferedAmount + size > MAX_MESSAGE) { this.#fail(); return }
    const kind = typeof data === "string" ? 0 : 1
    this.bufferedAmount += size
    this.#writes = this.#writes.then(async () => {
      if (this.readyState === this.CLOSED) return
      const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value
      const packet = new Uint8Array(bytes.length + 1)
      packet[0] = kind
      packet.set(bytes, 1)
      await this.#invoke("socket_write", packet, { headers: { "x-openbot-socket-id": /** @type {string} */ (this.#id) } })
    }).catch(() => this.#fail()).finally(() => { this.bufferedAmount -= size })
  }

  /** @param {number} code @param {string} reason */
  close(code = 1000, reason = "") {
    if (code !== 1000 && (code < 3000 || code > 4999 || !Number.isInteger(code)))
      throw new DOMException("The close code is not allowed.", "InvalidAccessError")
    if (encoder.encode(reason).byteLength > 123) throw new DOMException("The close reason is too long.", "SyntaxError")
    if (this.readyState === this.CLOSING || this.readyState === this.CLOSED) return
    this.#closeCode = code
    this.#closeReason = reason
    this.readyState = this.CLOSING
    if (this.#id) void this.#writes.then(() => this.#invoke("socket_close", { id: this.#id, code, reason })).catch(() => this.#fail())
  }

  #fail() {
    if (this.readyState === this.CLOSED) return
    if (this.#id) void this.#invoke("socket_close", { id: this.#id, code: 1000, reason: "The native connection ended." }).catch(() => {})
    const event = new Event("error")
    this.#emit(event, this.onerror)
    this.#finish(1006, false, "The live connection ended.")
  }

  /** @param {number} code @param {boolean} wasClean @param {string} reason */
  #finish(code, wasClean, reason) {
    if (this.readyState === this.CLOSED) return
    this.readyState = this.CLOSED
    const event = new CloseEvent("close", { code, wasClean, reason })
    this.#emit(event, this.onclose)
  }

  /** User event handlers cannot turn a working transport into a network error.
   * @template {Event} E @param {E} event @param {((event:E) => void) | null} handler
   */
  #emit(event, handler) {
    this.dispatchEvent(event)
    try { handler?.call(this, event) }
    catch (error) { queueMicrotask(() => { throw error }) }
  }
}
