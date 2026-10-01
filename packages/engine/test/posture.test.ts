/**
 * 10-01 — هيرمس 22 (جردُ الوضعيّة) و11 (تماسكُ الصلاحيات). لكلّ قاعدةٍ توأمان.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { POSTURE_PLUGINS, postureFindings, renderPosture, type PostureInput } from "../src/posture"

const safe: PostureInput = {
  mode: "auto", remoteControl: false, computerUse: false, desktopControl: false, updateCheck: true, sensitiveMemory: false,
  customProviders: [{ id: "nvidia2", baseUrl: "https://integrate.api.nvidia.com/v1" }, { id: "ollama", baseUrl: "http://127.0.0.1:11434", local: true }],
  mcpServers: 0, plugins: Object.fromEntries(POSTURE_PLUGINS.map((n) => [n, !["standingGrants", "mcpClient", "providerProbe", "delegation", "denialBreaker"].includes(n)])), trustedProjects: 2,
}
const risks = (p: Partial<PostureInput>) => postureFindings({ ...safe, ...p }).filter((f) => f.level === "risk").map((f) => f.text)
const notes = (p: Partial<PostureInput>) => postureFindings({ ...safe, ...p }).filter((f) => f.level === "note").map((f) => f.text)

describe("posture coherence", () => {
  test("a guarded setup has no risks and no notes", () => {
    expect(postureFindings(safe)).toEqual([])
  })
  test("full access is only a risk combined with what it amplifies", () => {
    expect(risks({ mode: "full-access" })).toEqual([])
    expect(risks({ mode: "full-access", plugins: { ...safe.plugins, unattendedDeny: false } })[0]).toContain("unattendedDeny")
    expect(risks({ mode: "auto", plugins: { ...safe.plugins, unattendedDeny: false } })).toEqual([])
    expect(risks({ mode: "full-access", remoteControl: true })[0]).toContain("التحكّمُ عن بُعد")
    expect(risks({ mode: "auto", remoteControl: true })).toEqual([])
    expect(risks({ mode: "full-access", desktopControl: true })[0]).toContain("سطح المكتب")
  })
  test("inbound and secret guards off are risks; a cloud provider over http is a risk, a local one is not", () => {
    expect(risks({ plugins: { ...safe.plugins, inboundGuard: false } })[0]).toContain("inboundGuard")
    expect(risks({ plugins: { ...safe.plugins, secretIntake: false } })[0]).toContain("secretIntake")
    expect(risks({ customProviders: [{ id: "x", baseUrl: "http://api.example.com/v1" }] })[0]).toContain("http بلا تشفير")
    expect(risks({ customProviders: [{ id: "x", baseUrl: "http://192.168.1.5:11434", local: true }] })[0]).toContain("http بلا تشفير")
    expect(risks({ customProviders: [{ id: "x", baseUrl: "not a url" }] })[0]).toContain("غير صالح")
  })
  test("incoherent but not dangerous settings are notes", () => {
    expect(notes({ mcpServers: 2 })[0]).toContain("عميلُ MCP مطفأ")
    expect(notes({ mcpServers: 2, plugins: { ...safe.plugins, mcpClient: true } })).toEqual([])
    expect(notes({ mode: "full-access", plugins: { ...safe.plugins, standingGrants: true } })[0]).toContain("المنحُ القائمة")
    expect(notes({ updateCheck: false })[0]).toContain("فحصُ التحديثات")
    expect(notes({ plugins: { ...safe.plugins, auditGate: false } })[0]).toContain("auditGate")
  })
})

describe("posture report", () => {
  test("facts, then risks, then notes — and no secret ever (only provider ids and hosts)", () => {
    const text = renderPosture({ ...safe, mode: "full-access", remoteControl: true, updateCheck: false })
    const lines = text.split("\n")
    expect(lines[0]).toBe("posture: 1 خطر · 1 ملاحظة")
    expect(text).toContain("nvidia2@integrate.api.nvidia.com")
    expect(text.indexOf("✕")).toBeLessThan(text.indexOf("△"))
    expect(text).not.toMatch(/nvapi-|sk-|api[_-]?key\s*[:=]/iu)
    expect(renderPosture(safe).split("\n")[0]).toBe("posture: لا مخاطر مسمّاة")
  })
  test("the engine builds the input from effective switches (pluginOnNow), not from the raw file", () => {
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
    expect(cli).toContain("plugins: Object.fromEntries(POSTURE_PLUGINS.map((name) => [name, pluginOnNow(name)])),")
    expect(cli).toContain('case "posture": return postureCommand()')
  })
})
