/** @typedef {{status:number,statusText:string,headers:[string,string][],url:string}} ResponseHead */
/** @typedef {(command:string,args?:Record<string,unknown>|Uint8Array,options?:{headers:Record<string,string>})=>Promise<unknown>} Invoke */

/** @param {BodyInit | null | undefined} body */
function bodyLength(body) {
  if (typeof body === "string" || body instanceof URLSearchParams) return new TextEncoder().encode(String(body)).byteLength
  if (body instanceof Blob) return body.size
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength
  return undefined
}

/** A pull-based body bridge keeps streaming uploads and SSE responses bounded.
 * @param {string} apiOrigin @param {string} runtimeId @param {Invoke} invoke
 * @returns {typeof globalThis.fetch}
 */
export function createNativeFetch(apiOrigin, runtimeId, invoke) {
  return async (input, init) => {
    // Safari can read a stream even when its Request constructor cannot accept
    // one as a body. The native process owns the actual network upload.
    const sourceBody = init?.body instanceof ReadableStream ? init.body : undefined
    const request = new Request(input, sourceBody ? { ...init, body: null } : init)
    if (sourceBody && ["GET", "HEAD"].includes(request.method)) throw new TypeError("This request method cannot have a body.")
    if (request.signal.aborted) throw request.signal.reason
    const reader = (sourceBody ?? request.body)?.getReader()
    const knownLength = bodyLength(init?.body)
    const declared = request.headers.get("content-length")
    const declaredLength = declared === null ? undefined : Number(declared)
    if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(declaredLength)
      || (knownLength !== undefined && declaredLength !== knownLength) || (!reader && declaredLength !== 0))) {
      await reader?.cancel()
      throw new TypeError("The upload length does not match its body.")
    }
    const contentLength = reader ? knownLength ?? declaredLength : undefined
    /** @type {string} */ let id
    try {
      id = /** @type {string} */ (await invoke("http_prepare", { input: {
        url: request.url, method: request.method, headers: [...request.headers].filter(([name]) => name !== "content-length"),
        hasBody: Boolean(reader), expectedOrigin: apiOrigin, runtimeId,
        ...(contentLength === undefined ? {} : { contentLength }),
      } }))
    } catch (error) {
      await reader?.cancel().catch(() => {})
      throw error instanceof Error ? error : new Error(String(error))
    }
    let ended = false
    let hasHead = false
    /** @type {unknown} */ let uploadError
    /** @type {ReadableStreamDefaultController<Uint8Array> | undefined} */ let controller
    const cleanup = () => {
      ended = true
      request.signal.removeEventListener("abort", abort)
      void invoke("http_cancel", { id }).catch(() => {})
    }
    const abort = () => {
      controller?.error(request.signal.reason ?? new DOMException("The request was cancelled.", "AbortError"))
      void reader?.cancel().catch(() => {})
      cleanup()
    }
    request.signal.addEventListener("abort", abort, { once: true })
    if (request.signal.aborted) { abort(); throw request.signal.reason }
    const opening = invoke("http_open", { id })
    if (reader) void (async () => {
      try {
        while (!ended) {
          const chunk = await reader.read()
          if (chunk.done) break
          const bytes = chunk.value instanceof Uint8Array ? chunk.value : new Uint8Array(chunk.value)
          for (let offset = 0; offset < bytes.length; offset += 65536) {
            const accepted = await invoke("http_write", bytes.subarray(offset, offset + 65536), { headers: { "x-openbot-request-id": id } })
            if (!accepted) { await reader.cancel(); return }
          }
        }
        if (!ended) await invoke("http_finish", { id })
      } catch (error) {
        if (!hasHead && !ended) { uploadError = error; cleanup() }
      }
    })()
    /** @type {ResponseHead} */ let head
    try { head = /** @type {ResponseHead} */ (await opening) }
    catch (error) { cleanup(); await reader?.cancel().catch(() => {}); throw uploadError ?? new Error(String(error)) }
    hasHead = true
    void reader?.cancel().catch(() => {})
    if (request.signal.aborted) { cleanup(); throw request.signal.reason }
    if (head.status >= 300 && head.status < 400 && request.redirect !== "manual") {
      cleanup()
      throw new TypeError("The service redirected this request. Check whether a gateway sign-in is required.")
    }
    const noBody = request.method === "HEAD" || [204, 205, 304].includes(head.status)
    const body = noBody ? null : new ReadableStream({
      start(value) { controller = value },
      async pull(value) {
        try {
          const buffer = /** @type {ArrayBuffer | number[]} */ (await invoke("http_read", { id }))
          if (ended) return
          const bytes = new Uint8Array(buffer)
          if (bytes.byteLength === 0) { value.close(); cleanup() }
          else value.enqueue(bytes)
        } catch (error) {
          if (!ended) { value.error(new Error(String(error))); cleanup() }
        }
      },
      cancel() { cleanup() },
    })
    if (noBody) cleanup()
    const response = new Response(body, { status: head.status, statusText: head.statusText, headers: head.headers })
    Object.defineProperty(response, "url", { value: head.url })
    return response
  }
}
