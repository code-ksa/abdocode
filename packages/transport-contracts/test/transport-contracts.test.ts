import { describe, expect, test } from "bun:test"
import {
  LocalFrameDecoder,
  LocalJsonFrameDecoder,
  TRANSPORT_CONTRACT_VERSION,
  TransportContractError,
  decodeTransportFrame,
  encodeTransportFrame,
  encodeLocalJsonFrame,
  SHELL_FRAMES,
  validateShellFrame,
  validateTransportRequest,
  type TransportRequest,
} from "../src/index"

const base = {
  version: TRANSPORT_CONTRACT_VERSION,
  requestId: "req-1",
  sessionId: "session-1",
} as const

const requests: readonly TransportRequest[] = [
  { ...base, kind: "submit", input: "ابدأ المهمة" },
  { ...base, kind: "steer", instruction: "استخدم المسار المحلي" },
  { ...base, kind: "interrupt", reason: "طلب المستخدم" },
  { ...base, kind: "events", afterSequence: 41 },
]

describe("R9 transport contracts", () => {
  test("owns and validates every current product shell frame", () => {
    // العددُ يُثبَّت كي لا يدخل إطارٌ صامتاً خارج عقد النقل.
    expect(SHELL_FRAMES.filter((frame) => frame.dir === "in")).toHaveLength(37) // 09-14: background-list, remote-control-get/regenerate
    // لوحُ الخوادم: طلبُ قياسٍ وإيقافٌ بيد المشغّل — والحقولُ مقنَّنةٌ كغيرها،
    // فمنفذٌ ليس عدداً صحيحاً يُرفض بالاسم لا يُمرَّر إلى قتلِ شجرة.
    expect(validateShellFrame({ kind: "servers" })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "server-stop", port: 3000 })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "server-stop" }).ok).toBe(false)
    expect(validateShellFrame({ kind: "servers", rows: [] }).ok).toBe(false)
    expect(validateShellFrame({ kind: "submit", turn: { id: "turn-1", body: "ابدأ" }, mode: "read-only" })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "resume", seen: 0 })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "hello", shell: "desktop", token: "secret-session-token" })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "external-connect", id: "local-tools", command: ["local-helper", "--stdio"] })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "steer", turnId: "turn-1", instruction: "ركّز على الدليل" })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "usage-get", requestId: "usage-refresh-1" })).toEqual({ ok: true })
    // ذ5: العدّادُ المحلي إطارٌ منفصل بالقيود نفسها.
    expect(validateShellFrame({ kind: "meter-get", requestId: "meter-refresh-1" })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "meter-get", requestId: "bad request id" }).ok).toBe(false)
  })

  test("product shell frames reject malformed values and undeclared fields", () => {
    expect(validateShellFrame({ kind: "submit", turn: { id: "", body: "x" } }).ok).toBe(false)
    expect(validateShellFrame({ kind: "resume", seen: -1 }).ok).toBe(false)
    expect(validateShellFrame({ kind: "mode-set", mode: "root" }).ok).toBe(false)
    expect(validateShellFrame({ kind: "settings-set", settings: [] }).ok).toBe(false)
    // سياج مراجعة فضاء plugins: عددٌ صحيحٌ آمن غير سالب، وغيابه كتابةٌ غير مشروطة.
    expect(validateShellFrame({ kind: "settings-set", settings: {}, expectedPluginsRevision: 3 })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "settings-set", settings: {}, expectedPluginsRevision: 0 })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "settings-set", settings: {}, expectedPluginsRevision: -1 }).ok).toBe(false)
    expect(validateShellFrame({ kind: "settings-set", settings: {}, expectedPluginsRevision: 1.5 }).ok).toBe(false)
    expect(validateShellFrame({ kind: "settings-set", settings: {}, expectedPluginsRevision: "3" }).ok).toBe(false)
    const wrongName = validateShellFrame({ kind: "settings-set", settings: {}, expectedRevision: 3 })
    expect(wrongName.ok).toBe(false)
    expect(wrongName.ok === false ? wrongName.why : "").toContain("غير معروف")
    expect(validateShellFrame({ kind: "history", endpoint: "https://example.invalid" }).ok).toBe(false)
    expect(validateShellFrame({ kind: "hello", shell: "desktop", token: "" }).ok).toBe(false)
    expect(validateShellFrame({ kind: "steer", turnId: "turn-1", instruction: "" }).ok).toBe(false)
    expect(validateShellFrame({ kind: "steer", turnId: "turn-1", instruction: "x".repeat(16 * 1024 + 1) }).ok).toBe(false)
    expect(validateShellFrame({ kind: "usage-get", requestId: "bad request id" }).ok).toBe(false)
    expect(validateShellFrame({ kind: "usage-get", path: "ledger.json" }).ok).toBe(false)
  })

  test("v1 remains compatible for every request kind", () => {
    for (const request of requests) {
      expect(decodeTransportFrame(encodeTransportFrame(request))).toEqual(request)
    }
  })

  test("incremental local framing accepts split bytes", () => {
    const request = requests[0]!
    const frame = encodeTransportFrame(request)
    const decoder = new LocalFrameDecoder()
    expect(decoder.push(frame.subarray(0, 2))).toEqual([])
    expect(decoder.pendingBytes).toBe(2)
    expect(decoder.push(frame.subarray(2, 9))).toEqual([])
    expect(decoder.push(frame.subarray(9))).toEqual([request])
    expect(decoder.pendingBytes).toBe(0)
  })

  test("unsupported versions fail closed", () => {
    const result = validateTransportRequest({ ...requests[0], version: 2 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("unsupported_version")
  })

  test("unknown kinds and fields fail closed", () => {
    const unknownKind = validateTransportRequest({ ...base, kind: "execute" })
    expect(unknownKind.ok).toBe(false)
    if (!unknownKind.ok) expect(unknownKind.error.code).toBe("invalid_kind")

    const unknownField = validateTransportRequest({ ...requests[0], endpoint: "remote" })
    expect(unknownField.ok).toBe(false)
    if (!unknownField.ok) {
      expect(unknownField.error.code).toBe("unknown_field")
      expect(unknownField.error.path).toBe("$.endpoint")
    }
  })

  test("oversized declarations fail before a payload is buffered", () => {
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, 65, false)
    const decoder = new LocalFrameDecoder(64)

    expect(() => decoder.push(header)).toThrow(TransportContractError)
    try {
      decoder.push(header)
    } catch (error) {
      expect(error).toBeInstanceOf(TransportContractError)
      expect((error as TransportContractError).code).toBe("oversize_frame")
    }
  })

  test("encoding and decoding enforce their byte budget", () => {
    expect(() => encodeTransportFrame(requests[0], 8)).toThrow(TransportContractError)

    const frame = encodeTransportFrame(requests[0])
    const trailing = new Uint8Array(frame.byteLength + 1)
    trailing.set(frame)
    expect(() => decodeTransportFrame(trailing)).toThrow(TransportContractError)
  })

  test("desktop shell JSON survives split and joined length-prefixed frames", () => {
    const first = encodeLocalJsonFrame({ kind: "hello", shell: "desktop", token: "private" })
    const second = encodeLocalJsonFrame({ kind: "models" })
    const joined = new Uint8Array(first.byteLength + second.byteLength)
    joined.set(first)
    joined.set(second, first.byteLength)
    const decoder = new LocalJsonFrameDecoder()
    expect(decoder.push(joined.slice(0, 3))).toEqual([])
    expect(decoder.push(joined.slice(3))).toEqual([
      { kind: "hello", shell: "desktop", token: "private" },
      { kind: "models" },
    ])
    expect(decoder.pendingBytes).toBe(0)
  })
})
