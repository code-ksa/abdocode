import { describe, expect, test } from "bun:test"
import {
  ModelProviderWorker,
  decodeModelProviderWorkerResponse,
  encodeGoogleSearchWorkerRequest,
  encodeModelProviderWorkerRequest,
} from "../src"

describe("Rust model provider worker protocol", () => {
  test("encodes a bounded self-describing request without a credential field", () => {
    const frame = encodeModelProviderWorkerRequest({
      provider: "openai",
      url: "https://api.openai.com/v1/chat/completions",
      body: '{"model":"gpt-4o"}',
      timeoutMs: 30_000,
    })
    expect(new TextDecoder().decode(frame)).not.toContain("api-key")
    expect(frame.slice(0, 5)).toEqual(new TextEncoder().encode("ABPM1"))
    expect(() => encodeModelProviderWorkerRequest({ provider: "x", url: "https://x", body: "", timeoutMs: 30_000 })).toThrow("body_invalid")
  })

  test("decodes only exact bounded response frames", () => {
    const body = new TextEncoder().encode('{"ok":true}')
    const frame = new Uint8Array(11 + body.length)
    frame.set(new TextEncoder().encode("ABPR1"))
    const view = new DataView(frame.buffer)
    view.setUint16(5, 200, false)
    view.setUint32(7, body.length, false)
    frame.set(body, 11)
    expect(decodeModelProviderWorkerResponse(frame)).toEqual({ status: 200, body: '{"ok":true}' })
    expect(() => decodeModelProviderWorkerResponse(frame.slice(0, -1))).toThrow("response_invalid")
  })

  test("encodes Google search inputs without either credential", () => {
    const frame = encodeGoogleSearchWorkerRequest({ query: "نواة Rust", count: 5, site: "example.com", language: "ar", country: "sa", safe: "active", timeoutMs: 15_000 })
    expect(frame.slice(0, 5)).toEqual(new TextEncoder().encode("ABGS2"))
    // بايتُ النوع يسبق المهلة مباشرةً: ويب افتراضاً، صورٌ عند الطلب، وغيرُهما يُرفض قبل أيّ بايتٍ يُكتب
    expect(frame[frame.length - 5]).toBe(0)
    const images = encodeGoogleSearchWorkerRequest({ query: "x", count: 5, language: "ar", country: "sa", safe: "active", kind: "image", timeoutMs: 15_000 })
    expect(images[images.length - 5]).toBe(1)
    expect(() => encodeGoogleSearchWorkerRequest({ query: "x", count: 5, language: "ar", country: "sa", safe: "active", kind: "video" as never, timeoutMs: 15_000 })).toThrow("kind_invalid")
    expect(new TextDecoder().decode(frame)).not.toContain("api-key")
    expect(() => encodeGoogleSearchWorkerRequest({ query: "x", count: 11, language: "ar", country: "sa", safe: "active", timeoutMs: 15_000 })).toThrow("count_invalid")
  })

  test("fails closed when the compiled worker is absent", async () => {
    await expect(new ModelProviderWorker("Z:\\missing\\abdo-tool-worker.exe").request({
      provider: "openai", url: "https://api.openai.com/v1/chat/completions", body: "{}", timeoutMs: 1_000,
    })).rejects.toThrow("provider_worker_unavailable")
  })
})
