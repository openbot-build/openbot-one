import assert from "node:assert/strict"
import { test } from "node:test"
import { defaultServiceOrigin, isDevelopmentCommand, needsDefaultService, nativeClientId } from "../scripts/tauri.mjs"

test("a default backend is required for running and packaging, not tool setup", () => {
  for (const args of [["dev"], ["build"], ["android", "dev"], ["ios", "build"]])
    assert.equal(needsDefaultService(args), true)
  for (const args of [["info"], ["icon", "source.svg"], ["android", "init"], ["build", "--help"]])
    assert.equal(needsDefaultService(args), false)
  assert.throws(() => defaultServiceOrigin(undefined), /OPENBOT_DEFAULT_API_ORIGIN/)
})

test("HTTP is limited to loopback in development commands", () => {
  assert.equal(isDevelopmentCommand(["dev"]), true)
  assert.equal(isDevelopmentCommand(["android", "build", "--debug"]), true)
  assert.equal(isDevelopmentCommand(["build"]), false)
  for (const input of ["http://localhost:19380", "http://127.0.0.1:19380", "http://[::1]:19380"])
    assert.equal(defaultServiceOrigin(input, { allowLocalHttp: true }), input)
  for (const input of ["http://localhost.evil.test", "http://192.168.1.10:19380"])
    assert.throws(() => defaultServiceOrigin(input, { allowLocalHttp: true }))
  assert.throws(() => defaultServiceOrigin("http://localhost:19380"))
})

test("the default service is canonical HTTPS with no credentials or route", () => {
  assert.equal(defaultServiceOrigin(" https://EXAMPLE.com:443/ "), "https://example.com")
  assert.equal(defaultServiceOrigin("https://example.com:8443"), "https://example.com:8443")
  for (const value of ["http://example.com", "https://name:secret@example.com", "https://example.com/api", "https://example.com?token=secret", "https://example.com#other"])
    assert.throws(() => defaultServiceOrigin(value))
})

test("native client IDs are public bounded names", () => {
  assert.equal(nativeClientId(undefined), "openbot-one")
  assert.equal(nativeClientId("org.example-app"), "org.example-app")
  for (const input of ["", "bad name", "https://api.example.com", "-bad", "a".repeat(129)]) assert.throws(() => nativeClientId(input))
})
