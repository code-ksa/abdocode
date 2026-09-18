import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ChromeBridge } from "../src/mcp-servers/chrome-bridge"

// ب8 — الاقترانُ الآليّ: `GET /pair` يعطي المنفذَ والرمزَ داخل نافذة الاقتران وحدها (423 خارجَها)، `POST /pair/open` بالرمز يفتحها،
// و/health يقول إن كانت مفتوحة. التوأمان: النافذةُ المغلقة لا تسرّب (423 بلا رمز في الجسد)، والمفتوحةُ تسلّم الرمزَ الصحيح.

const withBridge = async (pairingWindowMs: number, run: (bridge: ChromeBridge, base: string) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-autopair-"))
  const lines: string[] = []
  const bridge = new ChromeBridge({ stateDir: dir, port: 0, pairingWindowMs, announce: (l) => lines.push(l) })
  const port = bridge.start()
  try { await run(bridge, `http://127.0.0.1:${port}`); (bridge as unknown as { lines: string[] }).lines = lines } finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }) }
  return lines
}

describe("نافذةُ الاقتران", () => {
  test("مغلقةٌ افتراضاً حين pairingWindowMs=0: /pair يعيد 423 بلا رمز، و/health يقول pairing=false", async () => {
    await withBridge(0, async (bridge, base) => {
      expect(bridge.pairingOpen).toBe(false)
      const pair = await fetch(`${base}/pair`)
      expect(pair.status).toBe(423)
      expect(await pair.text()).not.toContain(bridge.token)
      const health = (await (await fetch(`${base}/health`)).json()) as { pairing: boolean; connected: boolean }
      expect(health).toEqual({ ok: true, connected: false, pairing: false } as never)
    })
  })
  test("تُفتح عند الإقلاع (الافتراض دقيقتان): /pair يسلّم المنفذَ والرمزَ الصحيحين ويُعلن التسليمَ باسم السائل", async () => {
    const lines = await withBridge(120_000, async (bridge, base) => {
      expect(bridge.pairingOpen).toBe(true)
      const pair = await fetch(`${base}/pair`, { headers: { "user-agent": "AbdoTestExtension/0.4.0" } })
      expect(pair.status).toBe(200)
      const body = (await pair.json()) as { port: number; token: string }
      expect(body.token).toBe(bridge.token)
      expect(`http://127.0.0.1:${body.port}`).toBe(base)
    })
    expect(lines.some((l) => l.includes("pairing window open for 120s"))).toBe(true)
    expect(lines.some((l) => l.includes("pairing token handed to AbdoTestExtension/0.4.0"))).toBe(true)
  })
  test("POST /pair/open بلا رمز 403 ولا يفتح؛ بالرمز يفتح فيصير /pair 200", async () => {
    await withBridge(0, async (bridge, base) => {
      expect((await fetch(`${base}/pair/open`, { method: "POST" })).status).toBe(403)
      expect((await fetch(`${base}/pair`)).status).toBe(423)
      const opened = await fetch(`${base}/pair/open`, { method: "POST", headers: { "x-abdo-bridge-token": bridge.token } })
      expect(opened.status).toBe(200)
      expect(bridge.pairingOpen).toBe(true)
      expect((await fetch(`${base}/pair`)).status).toBe(200)
    })
  })
  test("الرمزُ المسلَّم يفتح المقبسَ فعلاً (الاقترانُ كاملاً بلا لصق)", async () => {
    await withBridge(120_000, async (bridge, base) => {
      const body = (await (await fetch(`${base}/pair`)).json()) as { port: number; token: string }
      const socket = new WebSocket(`${base.replace("http", "ws")}/?token=${encodeURIComponent(body.token)}`)
      await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("socket refused")) })
      await Bun.sleep(50)
      expect(bridge.connected).toBe(true)
      socket.close()
    })
  })
})
