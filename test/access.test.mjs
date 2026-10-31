import assert from "node:assert/strict"
import { test } from "node:test"
import { probeBackend } from "../scripts/check-backend.mjs"

test("Access redirects are reported without following them or exposing login data", async () => {
  /** @type {{url: string, init?: RequestInit}[]} */
  const requests = []
  const result = await probeBackend("https://api.example.com", {
    token: "test-token-do-not-print",
    fetch: async (input, init) => {
      requests.push({ url: String(input), init })
      assert.equal(init?.redirect, "manual")
      return new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/login?token=private" } })
    },
  })
  assert.equal(requests.length, 2)
  assert.ok(requests.every((request) => new URL(request.url).origin === "https://api.example.com"))
  assert.equal(result.accessRequired, true)
  assert.equal(result.reachable, false)
  assert.doesNotMatch(JSON.stringify(result), /private|test-token-do-not-print/)
})

test("passing Access does not claim an OpenBot session", async () => {
  const result = await probeBackend("https://api.example.com", {
    service: { id: "test-id", secret: "test-secret" },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      assert.equal(headers.get("CF-Access-Client-Id"), "test-id")
      assert.equal(headers.get("CF-Access-Client-Secret"), "test-secret")
      return Response.json({}, { status: String(input).endsWith("/health") ? 200 : 401 })
    },
  })
  assert.equal(result.reachable, true)
  assert.equal(result.openbotSignedIn, false)
  assert.doesNotMatch(JSON.stringify(result), /test-secret|test-id/)
})

test("partial or mixed Access credentials cannot make a request", async () => {
  await assert.rejects(probeBackend("https://api.example.com", { token: "test", service: { id: "id", secret: "secret" } }))
  await assert.rejects(probeBackend("https://api.example.com", { service: { id: "id", secret: "" } }))
})

test("an OpenBot sign-in redirect is not a Cloudflare Access challenge", async () => {
  const result = await probeBackend("https://api.example.com", {
    fetch: async (input) => String(input).endsWith("/health")
      ? Response.json({})
      : new Response(null, { status: 302, headers: { location: "/sign-in" } }),
  })
  assert.equal(result.accessRequired, false)
  assert.equal(result.reachable, true)
  assert.equal(result.openbotSignedIn, false)
})

test("HTML challenges and JSON errors cannot count as successful authentication", async () => {
  const html = await probeBackend("https://api.example.com", {
    fetch: async () => new Response("Sign in", { headers: { "Content-Type": "text/html" } }),
  })
  assert.equal(html.reachable, false)
  const error = await probeBackend("https://api.example.com", { fetch: async () => Response.json({ error: "Not signed in" }) })
  assert.equal(error.openbotSignedIn, false)
  const signedIn = await probeBackend("https://api.example.com", {
    fetch: async () => Response.json({ userId: "test", memberships: [], platformAdmin: false, expiresAt: "2099-01-01T00:00:00Z" }),
  })
  assert.equal(signedIn.openbotSignedIn, true)
})
