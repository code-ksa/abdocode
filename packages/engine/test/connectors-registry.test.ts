import { describe, expect, test } from "bun:test"
import { grantableEnvName } from "@abdo/tools/env-strip"
import { VAULT_HANDLE_RE } from "../src/secret-intake"
import { CONNECTORS, connectorById, connectorCommand, connectorGrants, connectorHandles, connectorServerId } from "../src/connectors/registry"

// سجلُّ الموصّلات: كلُّ مقبضٍ يعبر حارسَ الخزنة (custom-)، وكلُّ اسمِ بيئةٍ قابلٌ للمنح، وكلُّ موردٍ https، ولا سرَّ في أمر الخادم.

describe("سجلُّ الموصّلات", () => {
  test("كلُّ موصّلٍ سليمُ التعريف: https، معرّفٌ فريد، أدواتٌ معلَنة، وما يحتاج المالكَ يقول كيف", () => {
    const ids = new Set<string>()
    for (const c of CONNECTORS) {
      expect(`${c.id}: dup=${ids.has(c.id)}`).toBe(`${c.id}: dup=false`); ids.add(c.id)
      expect(/^[a-z][a-z0-9-]{1,20}$/.test(c.id)).toBe(true)
      if (c.kind === "remote") expect(c.resource?.startsWith("https://")).toBe(true)
      if (c.kind === "google") expect(c.authServer?.token_endpoint.startsWith("https://")).toBe(true)
      expect(c.tools.length).toBeGreaterThan(0)
      expect(c.scope.length).toBeGreaterThan(0)
      if (c.ownerClient !== undefined) expect(c.ownerClient.howTo.length).toBeGreaterThan(20)
    }
    expect(connectorById("google")?.kind).toBe("google")
    expect(connectorById("slack")?.callbackPort).toBe(9371)
    expect(connectorById("nope")).toBeUndefined()
    // 09-14: Granola وGamma بعيدان بتسجيلٍ ديناميكيّ (بلا عميلِ مالك) — النطاقُ من PRM المقيس حيّاً
    expect(connectorById("granola")?.resource).toBe("https://mcp.granola.ai/mcp")
    expect(connectorById("gamma")?.scope).toBe("generate gamma:read")
    expect(connectorById("granola")?.ownerClient).toBeUndefined(); expect(connectorById("gamma")?.ownerClient).toBeUndefined()
    expect(CONNECTORS.map((c) => c.id)).toEqual(["google", "slack", "linear", "notion", "asana", "atlassian", "figma", "intercom", "granola", "gamma", "github"])
  })

  test("المقابضُ والمنحُ تعبر حرّاسَ الخزنة والبيئة؛ والسرُّ يُمنح للخدمات ذات السرّ وحدها", () => {
    for (const c of CONNECTORS) {
      for (const handle of Object.values(connectorHandles(c.id))) { expect(VAULT_HANDLE_RE.test(handle)).toBe(true); expect(handle.startsWith("custom-")).toBe(true) }
      const grants = connectorGrants(c.id, c.ownerClient?.secret === true)
      for (const g of grants) expect(`${g.env}: ${grantableEnvName(g.env)}`).toBe(`${g.env}: true`)
      expect(grants.some((g) => g.env === "ABDO_CONNECTOR_CLIENT_SECRET")).toBe(c.ownerClient?.secret === true)
      expect(grants.length).toBeLessThanOrEqual(8)
    }
  })

  test("أمرُ الخادم بلا سرّ: جوجل ⇦ mcp-google، البعيد ⇦ mcp-remote <url>؛ ورأسُ المحرّك الغائب رفض", () => {
    const prefix = ["C:/app/abdocode.exe"]
    expect(connectorCommand(connectorById("google")!, prefix)).toEqual(["C:/app/abdocode.exe", "mcp-google"])
    expect(connectorCommand(connectorById("linear")!, prefix)).toEqual(["C:/app/abdocode.exe", "mcp-remote", "https://mcp.linear.app/mcp"])
    expect(() => connectorCommand(connectorById("linear")!, [])).toThrow()
    for (const c of CONNECTORS) expect(connectorCommand(c, prefix).join(" ")).not.toMatch(/secret|token/i)
    expect(connectorServerId("slack")).toBe("connector-slack")
  })
})
