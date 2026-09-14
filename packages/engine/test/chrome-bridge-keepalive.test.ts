import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChromeBridge } from "../src/mcp-servers/chrome-bridge"

// ب8د (مقيس 09-15): مقبسٌ مفتوح وعاملُ الإضافة ميت ⇦ «connected» كان يكذب و`open` ينتظر ٢٠ ث. الآن: نبضٌ يُحدّث lastSeen ويُجاب بـpong؛
// بلا نبضٍ خلال staleMs يصير غيرَ متّصل، يُغلق المقبسُ، وsend يرفض باسمه فوراً. التوأمان: النابضُ يبقى متّصلاً؛ الصامتُ يسقط.

const withBridge = async (staleMs: number, run: (bridge: ChromeBridge, base: string, lines: string[]) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-keepalive-"))
  const lines: string[] = []
  const bridge = new ChromeBridge({ stateDir: dir, port: 0, pairingWindowMs: 0, staleMs, announce: (l) => lines.push(l) })
  const port = bridge.start()
  try { await run(bridge, `ws://127.0.0.1:${port}`, lines) } finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }) }
}
const open = (url: string) => new Promise<WebSocket>((resolve, reject) => { const s = new WebSocket(url); s.onopen = () => resolve(s); s.onerror = () => reject(new Error("refused")) })

describe("نبضُ الإضافة", () => {
  test("النابضُ يبقى متّصلاً ويُجاب بـpong", async () => {
    await withBridge(300, async (bridge, base) => {
      const s = await open(`${base}/?token=${encodeURIComponent(bridge.token)}`)
      const pong = new Promise<string>((resolve) => { s.onmessage = (e) => resolve(String(e.data)) })
      await Bun.sleep(150)
      s.send(JSON.stringify({ kind: "ping", at: Date.now() }))
      expect(JSON.parse(await pong).kind).toBe("pong")
      await Bun.sleep(200)
      s.send(JSON.stringify({ kind: "ping", at: Date.now() }))
      await Bun.sleep(150)
      expect(bridge.connected).toBe(true) // ٥٠٠ms منذ الفتح لكنّ آخرَ نبضٍ قبل ١٥٠ms
      s.close()
    })
  })
  test("الصامتُ يسقط: connected=false، المقبسُ يُغلق، وsend يرفض باسمه فوراً", async () => {
    await withBridge(250, async (bridge, base, lines) => {
      const s = await open(`${base}/?token=${encodeURIComponent(bridge.token)}`)
      const closed = new Promise<void>((resolve) => { s.onclose = () => resolve() })
      await Bun.sleep(50)
      expect(bridge.connected).toBe(true)
      await Bun.sleep(400)
      expect(bridge.connected).toBe(false)
      expect(lines.some((l) => l.includes("silent for") && l.includes("socket dropped"))).toBe(true)
      const started = Date.now()
      await expect(bridge.send("page", {}, 5000)).rejects.toThrow(/لا إضافةَ موصولة/u)
      expect(Date.now() - started).toBeLessThan(1000) // لا انتظارَ حتى المهلة
      await closed
    })
  })
})
