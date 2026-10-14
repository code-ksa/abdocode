import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { decodeProviderServeReply, encodeModelProviderWorkerRequest, providerServeFingerprint } from "../src/provider"

// 10-14 — the resident provider worker: measured on Windows, each one-shot call paid ~0.35 s for powershell.exe (the vault read) and a
// worker start — about 0.85 s over a direct HTTPS call, at 15–60 calls per agent turn. The key stays in Rust; these pin the wire.

const frame = (magic: string, status: number | undefined, body: string): Uint8Array => {
  const text = new TextEncoder().encode(body)
  const head = status === undefined ? 9 : 11
  const out = new Uint8Array(head + text.byteLength)
  out.set(new TextEncoder().encode(magic))
  const view = new DataView(out.buffer)
  if (status === undefined) view.setUint32(5, text.byteLength, false)
  else { view.setUint16(5, status, false); view.setUint32(7, text.byteLength, false) }
  out.set(text, head)
  return out
}

describe("provider-serve replies", () => {
  test("ABPR1 decodes like the one-shot path; ABPE1 is a named refusal the gateway classifies (credential stays credential)", () => {
    expect(decodeProviderServeReply(frame("ABPR1", 200, '{"ok":1}'))).toEqual({ status: 200, body: '{"ok":1}' })
    expect(() => decodeProviderServeReply(frame("ABPE1", undefined, "provider credential unavailable"))).toThrow("provider_worker_refused: provider credential unavailable")
  })
  test("the twin: a truncated refusal frame is invalid, not a silent success", () => {
    const bad = frame("ABPE1", undefined, "x").subarray(0, 8)
    expect(() => decodeProviderServeReply(bad)).toThrow("provider_worker_response_invalid")
  })
  test("the fingerprint follows ABDO_* only — a changed provider declaration restarts the resident worker", () => {
    const a = providerServeFingerprint({ ABDO_CUSTOM_PROVIDERS: "[]", PATH: "x" })
    expect(providerServeFingerprint({ ABDO_CUSTOM_PROVIDERS: "[]", PATH: "y" })).toBe(a)
    expect(providerServeFingerprint({ ABDO_CUSTOM_PROVIDERS: '[{"id":"z"}]', PATH: "x" })).not.toBe(a)
  })
})

const WORKER = resolve(import.meta.dir, "..", "..", "kernel", "target", "release", "abdo-tool-worker.exe")
describe.skipIf(!existsSync(WORKER))("provider-serve process (no network: refusals only)", () => {
  test("one process answers several framed requests in order, refuses a bad one by name, and exits on EOF", async () => {
    const child = Bun.spawn([WORKER, "provider-serve"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, ABDO_VAULT_SCRIPT: "" } })
    const send = (bytes: Uint8Array) => { const h = new Uint8Array(4); new DataView(h.buffer).setUint32(0, bytes.byteLength, false); child.stdin.write(h); child.stdin.write(bytes); void child.stdin.flush() }
    // an endpoint the worker does not own: refused before any vault read or network
    send(encodeModelProviderWorkerRequest({ provider: "anthropic", url: "https://evil.example/v1/messages", body: "{}", timeoutMs: 5_000 }))
    send(encodeModelProviderWorkerRequest({ provider: "nobody", url: "https://api.anthropic.com/v1/messages", body: "{}", timeoutMs: 5_000 }))
    child.stdin.end()
    const out = new Uint8Array(await new Response(child.stdout).arrayBuffer())
    expect(await child.exited).toBe(0)
    const replies: Uint8Array[] = []
    for (let at = 0; at < out.byteLength;) { const n = new DataView(out.buffer, at, 4).getUint32(0, false); replies.push(out.slice(at + 4, at + 4 + n)); at += 4 + n }
    expect(replies).toHaveLength(2)
    for (const reply of replies) expect(() => decodeProviderServeReply(reply)).toThrow(/provider_worker_refused: provider identity or endpoint/u)
  })
})
