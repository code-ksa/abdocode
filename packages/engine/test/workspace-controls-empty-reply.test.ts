import { expect, test } from "bun:test"
import { mountWorkspaceSettings } from "../../desktop/ui/native-workspace-settings.js"

// جوابٌ بلا حالةٍ من `workspace_controls_get` كان يُطلق حلقةً لا تنتهي في لوحة «العمل المشترك»:
// renderCowork يعيد التحميلَ ما دام `controls` فارغاً، وloadControls يرسم عند انتهائه — مقيسٌ
// بإيقاف CDP على معاينة الواجهة (2026-09-27)، والصفحةُ متجمّدة. المضيفُ الأصليّ يعيد كائناً،
// فهذا حارسٌ دفاعيّ: الفراغُ خطأٌ مسمّى، والإعادةُ بزرّ المستخدم لا بحلقة.

function node(): any {
  const n: any = {
    children: [], dataset: {}, isConnected: true, value: "", _text: "",
    append(...items: any[]) { this.children.push(...items) },
    replaceChildren(...items: any[]) { this.children = items },
    querySelector() { return null },
    querySelectorAll() { return [] },
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
  }
  Object.defineProperty(n, "textContent", { get() { return n._text + n.children.map((child: any) => child.textContent || "").join(" ") }, set(value) { n._text = String(value) } })
  return n
}

for (const reply of [undefined, null, "not-an-object"]) {
  test(`an empty workspace-controls reply (${String(reply)}) is one request and a named error, not a reload loop`, async () => {
    const originalDocument = (globalThis as any).document
    const calls: string[] = []
    const api: any = {
      L: (en: string) => en,
      state: { metadata: { projects: [], preferences: {} } },
      addProject() {},
      bridge: {
        snapshot: () => ({ working: false, settings: {} }),
        providers: { PROVIDERS: [] },
        invoke: async (command: string) => { calls.push(command); if (calls.length > 5) throw new Error("reload loop broken by the test"); return command === "workspace_controls_get" ? reply : { ownedProcessRunning: false, endpointReady: false } },
        send: async () => {},
      },
    }
    Object.assign(globalThis, { document: { createElement: () => node(), querySelector: () => null, addEventListener() {}, removeEventListener() {} } })
    try {
      const mounted = mountWorkspaceSettings(api)
      const host = node()
      mounted.renderCowork(host)
      for (let i = 0; i < 50; i++) await Bun.sleep(0)
      expect(calls.filter((c) => c === "workspace_controls_get")).toHaveLength(1)
      expect(host.textContent).toContain("The engine returned no folder state.")
      // الإعادةُ متاحةٌ بيد المستخدم: رسمٌ جديدٌ لا يطلق طلباً ثانياً وحده.
      mounted.renderCowork(host)
      for (let i = 0; i < 20; i++) await Bun.sleep(0)
      expect(calls.filter((c) => c === "workspace_controls_get")).toHaveLength(1)
      mounted.dispose?.()
    } finally {
      Object.assign(globalThis, { document: originalDocument })
    }
  })
}
