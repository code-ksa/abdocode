import { expect, test } from "bun:test"
import { mountWorkspaceSettings } from "../../desktop/ui/native-workspace-settings.js"

// ن9 (09-16) — معالجُ القشرة الحقيقيّ لإطار site-policy: allow يزيل النطاقَ (والنطاقُ الأعلى يبقى حاجباً فلا يُزال عبثاً)، block يضيف بلا تكرار،
// الشكلُ المشوَّه يُتجاهل بإشعارٍ بلا حفظ، والحفظُ يمرّ بـsaveStore (الطريقُ الأصيل نفسُه) لا بكتابة ملفّ.

// الوحدةُ تسجّل مستمعاً على document عند التركيب — عقدةٌ زائفة تكفي (لا تصيير في هذا المسار).
Object.assign(globalThis, { document: { createElement: () => ({ append() {}, replaceChildren() {}, setAttribute() {}, dataset: {}, children: [] }), querySelector: () => null, addEventListener() {}, removeEventListener() {} } })

const harness = (blockedSites: string[], defaultPermission = "allow") => {
  const saves: unknown[] = [], notices: string[] = []
  const api: any = {
    L: (en: string) => en,
    state: { metadata: { projects: [], preferences: { browserDefaultPermission: defaultPermission, blockedSites } } },
    saveStore: async () => { saves.push(structuredClone(api.state.metadata.preferences)) },
    applyWorkspacePreferences: () => {},
    reportError: (e: unknown) => { throw e },
    bridge: { snapshot: () => ({ working: false, settings: {} }), invoke: async () => ({}), submit: () => {}, notice: (t: string) => { notices.push(t) } },
  }
  const mounted = mountWorkspaceSettings(api)
  return { api, mounted, saves, notices }
}
const settle = () => new Promise((r) => setTimeout(r, 20))

test("allow removes the site (not its parent domain), block adds once, malformed requests are ignored without saving", async () => {
  const h = harness(["ads.net", "example.com", "tracker.io"])
  h.mounted.frame({ kind: "site-policy", op: "allow", site: "example.com" }); await settle()
  expect(h.api.state.metadata.preferences.blockedSites).toEqual(["ads.net", "tracker.io"])
  expect(h.saves).toHaveLength(1)
  // نطاقٌ فرعيّ محجوبٌ بأبيه: لا قائمةَ سماحٍ في المحرّك، فالسماحُ به يزيل الأبَ الحاجب — ويُسمّى المزالُ في الإشعار (لا سماحٌ اسميّ كاذب)
  h.mounted.frame({ kind: "site-policy", op: "allow", site: "sub.ads.net" }); await settle()
  expect(h.api.state.metadata.preferences.blockedSites).toEqual(["tracker.io"])
  expect(h.notices.some((n) => n.startsWith("Site allowed: sub.ads.net") && n.includes("also unblocked: ads.net"))).toBe(true)
  h.mounted.frame({ kind: "site-policy", op: "block", site: "Evil.Example" }); await settle()
  h.mounted.frame({ kind: "site-policy", op: "block", site: "evil.example" }); await settle()
  expect(h.api.state.metadata.preferences.blockedSites).toEqual(["tracker.io", "evil.example"])
  const before = h.saves.length
  h.mounted.frame({ kind: "site-policy", op: "allow", site: "not a host" }); await settle()
  h.mounted.frame({ kind: "site-policy", op: "zap", site: "example.com" }); await settle()
  expect(h.saves).toHaveLength(before)
  expect(h.notices.some((n) => n.includes("invalid site policy"))).toBe(true)
  expect(h.notices.some((n) => n.startsWith("Site allowed: example.com"))).toBe(true)
  expect(h.notices.some((n) => n.startsWith("Site blocked: evil.example"))).toBe(true)
})

test("with a deny-all default permission, allow still edits the list but says the default blocks everything", async () => {
  const h = harness(["example.com"], "deny")
  h.mounted.frame({ kind: "site-policy", op: "allow", site: "example.com" }); await settle()
  expect(h.api.state.metadata.preferences.blockedSites).toEqual([])
  expect(h.notices.some((n) => n.includes("default site permission blocks every site"))).toBe(true)
})
