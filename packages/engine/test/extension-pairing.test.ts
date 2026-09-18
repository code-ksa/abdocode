import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTENSION_INSTALL_URL, ensureExtensionPaired, installGuidance } from "../src/extension-pairing"

// ب8 — «browser extension/pair»: كلُّ حالةٍ تُسمّى (متّصلة / لا جسر / انتظارٌ ثمّ اتّصال / غيرُ مثبّتة برابط)، والإقلاعُ لا يقع إلا حين لا متصفّح.

const stateWith = (pairing: object | undefined) => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-pairing-flow-"))
  if (pairing !== undefined) writeFileSync(join(dir, "chrome-bridge.json"), JSON.stringify(pairing))
  return dir
}
const PAIRING = { version: 1, port: 9377, token: "board-Ab12Cd34Ef56Gh78Ij90Kl12Mn", pid: 1, startedAt: "2026-09-14T00:00:00Z" }
const fakeFetch = (script: { health: Array<{ connected: boolean; pairing: boolean } | "down">; calls: string[] }): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    script.calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}${init?.headers && "x-abdo-bridge-token" in (init.headers as Record<string, string>) ? " +token" : ""}`)
    if (url.endsWith("/pair/open")) return new Response(JSON.stringify({ ok: true }), { status: 200 })
    const next = script.health.length > 1 ? script.health.shift()! : script.health[0]!
    if (next === "down") throw new Error("ECONNREFUSED")
    return new Response(JSON.stringify({ ok: true, ...next }), { status: 200 })
  }) as unknown as typeof fetch
const noSleep = async () => {}

describe("ensureExtensionPaired", () => {
  test("لا ملفَّ اقتران ⇦ no-bridge بلا نداء", async () => {
    const dir = stateWith(undefined)
    const script = { health: [], calls: [] as string[] }
    const r = await ensureExtensionPaired({ stateDir: dir, fetchFn: fakeFetch(script), sleep: noSleep })
    expect(r.status).toBe("no-bridge")
    expect(script.calls).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
  test("الملفُّ موجود والخادمُ لا يردّ ⇦ no-bridge يسمّي المنفذ", async () => {
    const dir = stateWith(PAIRING)
    const r = await ensureExtensionPaired({ stateDir: dir, fetchFn: fakeFetch({ health: ["down"], calls: [] }), sleep: noSleep })
    expect(r.status).toBe("no-bridge")
    expect(r.text).toContain("9377")
    rmSync(dir, { recursive: true, force: true })
  })
  test("متّصلةٌ أصلاً ⇦ connected بلا فتح نافذةٍ ولا إقلاع", async () => {
    const dir = stateWith(PAIRING)
    const script = { health: [{ connected: true, pairing: false }], calls: [] as string[] }
    let launched = 0
    const r = await ensureExtensionPaired({ stateDir: dir, fetchFn: fakeFetch(script), sleep: noSleep, launchBrowser: async () => { launched += 1; return "msedge" } })
    expect(r.status).toBe("connected")
    expect(launched).toBe(0)
    expect(script.calls).toEqual(["GET /health"])
    rmSync(dir, { recursive: true, force: true })
  })
  test("غيرُ متّصلة ولا متصفّح ⇦ يفتح النافذةَ بالرمز، يُقلع Edge، ثمّ تتّصل ⇦ connected (أُقلع msedge)", async () => {
    const dir = stateWith(PAIRING)
    const script = { health: [{ connected: false, pairing: false }, { connected: false, pairing: true }, { connected: true, pairing: true }], calls: [] as string[] }
    const r = await ensureExtensionPaired({ stateDir: dir, fetchFn: fakeFetch(script), sleep: noSleep, runningBrowsers: async () => [], launchBrowser: async () => "msedge", waitMs: 10_000, pollMs: 1 })
    expect(r.status).toBe("connected")
    expect(r.launched).toBe("msedge")
    expect(script.calls.slice(0, 2)).toEqual(["GET /health", "POST /pair/open +token"])
    expect(r.text).toContain("أُقلع msedge")
    rmSync(dir, { recursive: true, force: true })
  })
  test("المتصفّحُ يعمل ولم تتّصل الإضافةُ خلال المهلة ⇦ not-installed برابط التثبيت وبلا إقلاع", async () => {
    const dir = stateWith(PAIRING)
    const script = { health: [{ connected: false, pairing: true }], calls: [] as string[] }
    let launched = 0
    const r = await ensureExtensionPaired({ stateDir: dir, fetchFn: fakeFetch(script), sleep: noSleep, runningBrowsers: async () => ["msedge"], launchBrowser: async () => { launched += 1; return "chrome" }, waitMs: 5, pollMs: 1 })
    expect(r.status).toBe("not-installed")
    expect(launched).toBe(0)
    expect(r.text).toContain(EXTENSION_INSTALL_URL)
    expect(r.text).toContain("msedge")
    expect(installGuidance(9377)).toContain("9377")
    rmSync(dir, { recursive: true, force: true })
  })
})
