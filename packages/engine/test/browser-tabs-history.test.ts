import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { bridgeCallArgs } from "../src/browser-actions-args"
import { BRIDGE_TOOLS } from "../src/mcp-servers/chrome-bridge"
import { classify, render } from "../src/mind/surface"
import { TOOL_FAMILIES, exposedByIntent } from "../src/tool-exposure"

// ن5 (09-16) — التبويبات والتاريخ: العقدُ يصنّف الرجوعَ تنقّلاً، ووسائطُ الجسر تُبنى كائناً بمفتاح op، والأسلاكُ في الطبقات الخمس
// (المُوزِّع، الكتالوج، الجسر، الإضافة، التعريض) مسمارٌ لكلّ طبقة كي لا تعود أداةٌ «مسجَّلةً غيرَ قابلةٍ للاستدعاء».

// S11: المسامير بـ"\n" والنسخةُ المسحوبة بـautocrlf تحمل "\r\n" — يُطبَّع كي لا يحمرّ المسمارُ بنهاية السطر لا بالشيفرة.
const read = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf8").replace(/\r\n/gu, "\n")

describe("ن5 — contract and bridge arguments", () => {
  test("history is a navigation for the mode gate and is described by direction", () => {
    expect(classify({ kind: "history", direction: "back" })).toBe("network")
    expect(classify({ kind: "history", direction: "forward" })).toBe("network")
    expect(render([{ kind: "history", direction: "back" }, { kind: "history", direction: "forward" }])).toBe("1. ارجع صفحةً\n2. تقدّم صفحةً")
  })
  test("bridge args: tabs builds {op,…} and refuses malformed forms; back/forward carry an empty object", () => {
    const parse = (r: ReturnType<typeof bridgeCallArgs>) => (r.ok ? JSON.parse(r.args) : r.why)
    expect(parse(bridgeCallArgs("tabs", "", "/p"))).toEqual({ op: "list" })
    expect(parse(bridgeCallArgs("tabs", "list", "/p"))).toEqual({ op: "list" })
    expect(parse(bridgeCallArgs("tabs", "switch 2", "/p"))).toEqual({ op: "switch", target: "2" })
    expect(parse(bridgeCallArgs("tabs", "close 3", "/p"))).toEqual({ op: "close", target: "3" })
    expect(parse(bridgeCallArgs("tabs", "new https://x.test/a", "/p"))).toEqual({ op: "new", url: "https://x.test/a" })
    expect(String(parse(bridgeCallArgs("tabs", "switch", "/p")))).toContain("الصيغة: tabs switch")
    expect(String(parse(bridgeCallArgs("tabs", "new ftp://x", "/p")))).toContain("http/https")
    expect(String(parse(bridgeCallArgs("tabs", "zap 1", "/p")))).toContain("الصيغة: tabs [list")
    expect(parse(bridgeCallArgs("back", "", "/p"))).toEqual({})
    expect(parse(bridgeCallArgs("forward", "", "/p"))).toEqual({})
    // the bridge schema accepts exactly what the engine builds
    const tabs = BRIDGE_TOOLS.find((t) => t.name === "tabs")!
    expect(tabs.inputSchema.required).toEqual(["op"])
    expect(Object.keys(tabs.inputSchema.properties)).toEqual(["op", "target", "url"])
    for (const name of ["back", "forward"]) expect(BRIDGE_TOOLS.find((t) => t.name === name)!.inputSchema.properties).toEqual({})
  })
  test("exposure: the three verbs belong to the browser family — hidden until the goal names the browser", () => {
    for (const verb of ["tabs", "back", "forward"]) {
      expect(TOOL_FAMILIES.browser).toContain(verb)
      expect(exposedByIntent(verb, new Set())).toBe(false)
      expect(exposedByIntent(verb, new Set(["browser"]))).toBe(true)
    }
  })
})

describe("ن5 — wiring pins across the five layers", () => {
  test("owned route, extension route, catalogue, bridge, extension, MCP catalogue, manifest", () => {
    const cli = read("src", "cli.ts")
    expect(cli).toContain('if (name === "tabs") {')
    expect(cli).toContain('if (name === "back" || name === "forward") {')
    expect(cli).toContain("const moved = await surface.goHistory(name)")
    expect(cli).toContain("try { await surface.switchTab(tab.id) }")
    expect(cli).toContain('if (tabs.length <= 1) return "لم أغلق: آخرُ تبويبٍ لا يُغلق')
    // the close of a tab asks first; a new tab passes the site policy before the contract and the gate
    expect(cli.indexOf('`إغلاقُ التبويب «${tab.title || tab.url}»`')).toBeLessThan(cli.indexOf("await surface.closeTab(tab.id)"))
    expect(cli.indexOf('if (!browserSiteAllowed(SETTINGS_FILE, url)) return "Navigation blocked by saved site permissions — المشغّل: browser allow <نطاق>"\n        const verdict = Surface.judge({ generation: surfaceGeneration }, { kind: "navigate", url, origin: "operator" })')).toBeGreaterThan(0)
    expect(cli).toContain('const navTarget = target === "open" ? rest.trim() : target === "tabs" && /^new\\s+\\S/u.test(rest.trim()) ? rest.trim().split(/\\s+/u)[1]! : undefined')
    expect(cli).toContain("|network|console|tabs)|dismiss|desk)")
    const catalogue = read("..", "tools", "src", "catalogue.ts")
    expect(catalogue).toContain('{ name: "tabs", effect: "read", usage: "tabs [list | switch <رقم> | close <رقم> | new <رابط>]"')
    expect(catalogue).toContain('{ name: "back", effect: "network", usage: "back"')
    expect(catalogue).toContain('{ name: "forward", effect: "network", usage: "forward"')
    for (const name of ["tabs", "back", "forward"]) expect(BRIDGE_TOOLS.some((t) => t.name === name)).toBe(true)
    const bridge = read("src", "mcp-servers", "chrome-bridge.ts").replace(/\r\n/gu, "\n") // الملفُّ LF في الفهرس وCRLF على سحب autocrlf — المسمارُ على المحتوى لا على نهاية السطر
    expect(bridge).toContain('case "tabs": {')
    expect(bridge).toContain('case "back":\n      case "forward": {')
    const background = read("..", "browser-bridge", "extension", "background.js")
    expect(background).toContain('case "tabs": {')
    expect(background).toContain("api.tabs.goBack(tab.id) : api.tabs.goForward(tab.id)")
    expect(background).toContain("if (op === \"close\") { if (tabs.length <= 1) return { last: true }")
    expect(background).toContain('if (!/^https?:\\/\\//i.test(String(args.url))) throw new Error("http/https only")')
    const mcp = read("src", "shells", "mcp-catalogue.ts")
    expect(mcp).toContain('"select", "upload", "drag", "tabs", "back", "forward"]')
    expect(JSON.parse(read("..", "browser-bridge", "extension", "manifest.json")).version).toBe("0.6.5") // S9: inspect spec
  })
})
