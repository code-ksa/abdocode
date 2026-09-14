import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChromeBridge, persistedToken, readBridgePairing } from "../src/mcp-servers/chrome-bridge"

// ب7 — الاقترانُ مرّةً واحدة: الرمزُ يُقرأ من ملفّ الحالة إن كان صالحاً فلا يُعاد لصقُه في الإضافة كلَّ جلسة؛ والملفُّ الفاسد
// أو الرمزُ القصير يُهمَل فيُولَّد رمزٌ جديد. ولوحةُ الإعدادات تقرأ المنفذَ والرمزَ من الملفّ نفسه (readBridgePairing).

const withState = (content: string | undefined) => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-pairing-"))
  if (content !== undefined) writeFileSync(join(dir, "chrome-bridge.json"), content)
  return dir
}

describe("رمزُ اقتران إضافة المتصفّح ثابتٌ عبر التشغيلات", () => {
  test("رمزٌ صالحٌ محفوظ يُعاد استعمالُه، ويبقى في الملفّ بعد start()", () => {
    const token = "board-Ab12Cd34Ef56Gh78Ij90Kl12Mn"
    const dir = withState(JSON.stringify({ version: 1, port: 9367, token, pid: 1, startedAt: "2026-09-06T00:00:00Z" }))
    try {
      expect(persistedToken(dir)).toBe(token)
      const bridge = new ChromeBridge({ stateDir: dir, port: 0 })
      expect(bridge.token).toBe(token)
      const port = bridge.start()
      try {
        const written = JSON.parse(readFileSync(join(dir, "chrome-bridge.json"), "utf8")) as { token: string; port: number }
        expect(written.token).toBe(token)
        expect(written.port).toBe(port)
        const pairing = readBridgePairing(dir)
        expect(pairing?.token).toBe(token)
        expect(pairing?.port).toBe(port)
      } finally { bridge.stop() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("ملفٌّ غائبٌ أو فاسدٌ أو رمزٌ قصير ⇒ رمزٌ جديدٌ عشوائيّ، ولا اقترانَ يُقرأ", () => {
    for (const content of [undefined, "{not json", JSON.stringify({ token: "short" }), JSON.stringify({ token: 12345 })]) {
      const dir = withState(content)
      try {
        expect(persistedToken(dir)).toBeUndefined()
        const a = new ChromeBridge({ stateDir: dir })
        const b = new ChromeBridge({ stateDir: dir })
        expect(a.token.length).toBeGreaterThanOrEqual(24)
        expect(a.token).not.toBe(b.token)
        if (content === undefined || content.startsWith("{not")) expect(readBridgePairing(dir)).toBeUndefined()
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  })

  test("الخيارُ الصريح token يغلب الملفّ", () => {
    const dir = withState(JSON.stringify({ token: "board-Ab12Cd34Ef56Gh78Ij90Kl12Mn", port: 1 }))
    try { expect(new ChromeBridge({ stateDir: dir, token: "explicit-token-value-0000000000" }).token).toBe("explicit-token-value-0000000000") }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
