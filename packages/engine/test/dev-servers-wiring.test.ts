// خوادمُ التطوير (S2) — الأسلاك: المحرّكُ يبثّ `dev-servers` ويجيب `dev-server-start/stop`؛ العقدُ يعرفها؛
// والقشرةُ ترسم الصفوفَ أزراراً في الحالة الفارغة وتوقف الخادمَ حين يُغلق تبويبُه.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { validateShellFrame } from "../../transport-contracts/src/shell-protocol"

const cli = readFileSync(resolve(import.meta.dir, "../src/cli.ts"), "utf8")
const html = readFileSync(resolve(import.meta.dir, "../../desktop/ui/index.html"), "utf8")

describe("engine wiring", () => {
  test("cli.ts: مالكٌ مستقلّ للخوادم، يُقرأ الملفُّ لحظةَ الضغط، ويُبثّ الجواب المقيس", () => {
    expect(cli).toContain('import { LAUNCH_CONFIG_PATH, effectivePort, mergeDevServerRows, readLaunchConfig } from "./dev-servers"')
    expect(cli).toContain("const devServers = new ManagedServers()")
    expect(cli).toContain('if (frame.kind === "dev-servers") {')
    expect(cli).toContain('if (frame.kind === "dev-server-start") {')
    expect(cli).toContain('if (frame.kind === "dev-server-stop") {')
    expect(cli).toContain("readLaunchConfig(PROJECT_DIR).configs.find((c) => c.name === name)")
    expect(cli).toContain("await devServers.start({ launch: config.launch, port: config.port }, PROJECT_DIR)")
    expect(cli).toContain("const said = devServers.stop(port)")
    expect(cli).toContain('emit({ kind: "dev-servers", rows, ...(problems.length > 0 ? { problems } : {}), ...extra })')
    // الحالةُ الثالثة من المحرّك لا من القشرة وحدها: الطلبُ يُسجَّل قبل الإقلاع ويُبثّ فوراً.
    expect(cli).toMatch(/devServerStarting\.add\(config\.name\)\r?\n\s+await emitDevServers\(\)/u)
    // الخارجيُّ يُسبَر لا يُخفى.
    expect(cli).toContain("if (await portListening(port)) external.add(port)")
  })

  test("cli.ts: يُبثّ عند الجاهزيّة واختيار المشروع والإعدادات؛ ويُوقَف عند خروج المحرّك لا عند ختام الدور", () => {
    expect(cli).toMatch(/if \(desktopProjectRequired && projectSelected\) emit\(\{kind: "project"[^\n]*\r?\n\s+void emitDevServers\(\)/u)
    expect(cli).toMatch(/emit\(\{ kind: "trust-request", path: dir \}\)\r?\n[^\n]*\r?\n[^\n]*\r?\n\s+void emitDevServers\(\)/u)
    expect(cli).toMatch(/emit\(\{ kind: "project", path: dir, trusted: true \}\)\r?\n\s+void emitDevServers\(\)\r?\n\s+continue/u)
    expect(cli).toMatch(/emit\(\{ kind: "settings", settings: current, \.\.\.pluginFrameFields\(current\), \.\.\.reply \}\)\r?\n\s+void emitDevServers\(\)/u)
    // خروجُ المحرّك (الخمول/غياب المالك) يوقفها؛ ختامُ الدور لا يعرفها — عمرُها التبويب.
    expect(cli.match(/devServers\.stopAll\(\)/gu)?.length).toBe(2)
    for (const line of cli.split("\n").filter((l) => l.includes("modeAtTurn==='chat' || pluginOnNow(\"serversPanel\")"))) {
      expect(line).toContain("turnServers.stopAll()")
      expect(line).not.toContain("devServers")
    }
  })

  test("إطارُ servers القديم لم يُمَسّ", () => {
    expect(cli).toContain('if (frame.kind === "servers") {')
    expect(cli).toContain('const rows = pluginOnNow("serversPanel") ? await turnServers.measure() : []')
    expect(cli).toContain('emit({ kind: "servers", rows })')
    expect(cli).toContain('if (frame.kind === "server-stop") {')
  })

  test("العقد: الأُطرُ الثلاثةُ الواردةُ تُقبل بحقولها، والمجهولُ يُرفض", () => {
    expect(validateShellFrame({ kind: "dev-servers" })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "dev-server-start", name: "web-app" })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "dev-server-start", name: "../x" }).ok).toBe(false)
    expect(validateShellFrame({ kind: "dev-server-stop", port: 3210 })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "dev-server-stop", port: -1 }).ok).toBe(false)
    expect(validateShellFrame({ kind: "dev-servers", rows: [] }).ok).toBe(false)
  })
})

// ---- القشرة: شريحةُ index.html تُشغَّل في سياقٍ معزول بوثيقةٍ مزيّفة ----
class FakeNode {
  readonly kids: FakeNode[] = []
  className = ""
  hidden = false
  title = ""
  type = ""
  onclick: (() => void) | undefined
  #text = ""
  constructor(readonly tag: string) {}
  get textContent(): string { return this.#text }
  set textContent(value: string) { this.#text = value; this.kids.length = 0 }
  appendChild(node: FakeNode): FakeNode { this.kids.push(node); return node }
  walk(): FakeNode[] { return [this, ...this.kids.flatMap((k) => k.walk())] }
  byClass(name: string): FakeNode[] { return this.walk().filter((n) => n.className.split(" ").includes(name)) }
}

const sliceStart = html.indexOf("    const devServers = { rows: [], problems: [], pending: new Set() };")
const sliceEnd = html.indexOf("    // ---- الألواح: فتحٌ تسجيلٌ وإغلاقٌ تفكيك ----", sliceStart)
const slice = html.slice(sliceStart, sliceEnd)

interface Harness {
  readonly host: FakeNode
  readonly sent: Record<string, unknown>[]
  readonly notices: string[]
  readonly navigated: string[]
  readonly newTabs: string[]
  readonly toggles: boolean[]
  readonly pane: { tabs: { label: string; url: string; created: boolean }[]; active: string | null }
  readonly api: {
    devServers: { rows: unknown[]; problems: string[]; pending: Set<string> }
    renderDevServers: () => void
    devServersFrame: (f: Record<string, unknown>) => void
    devServerTabClosed: (url: string) => boolean
    devServerUrlPort: (url: string) => number | undefined
  }
}

const harness = (paneOpen = true): Harness => {
  const host = new FakeNode("div"); host.hidden = true
  const sent: Record<string, unknown>[] = []; const notices: string[] = []; const navigated: string[] = []; const newTabs: string[] = []; const toggles: boolean[] = []
  const pane = { tabs: [] as { label: string; url: string; created: boolean }[], active: null as string | null }
  const api = runInNewContext(slice + "\n;({ devServers, renderDevServers, devServersFrame, devServerTabClosed, devServerUrlPort })", {
    URL,
    el: (id: string) => (id === "paneservers" ? host : undefined),
    document: { createElement: (tag: string) => new FakeNode(tag), body: { classList: { contains: () => paneOpen } } },
    uiText: (_en: string, ar: string) => ar,
    sendFrame: (f: Record<string, unknown>) => { sent.push(f) },
    notice: (t: string) => { notices.push(t) },
    pane,
    paneGo: (u: string) => { navigated.push(u) },
    paneNewTab: (u: string) => { newTabs.push(u) },
    paneToggle: (want: boolean) => { toggles.push(want) },
  }) as Harness["api"]
  return { host, sent, notices, navigated, newTabs, toggles, pane, api }
}

describe("shell wiring — الحالةُ الفارغة للّوحة", () => {
  test("الشريحةُ موجودةٌ ومربوطة: الإطارُ يُستقبل، والإغلاقُ يمرّ بالخوادم، والفتحُ يطلب القياس، والمضيفُ داخل الحالة الفارغة", () => {
    expect(sliceStart).toBeGreaterThan(0)
    expect(sliceEnd).toBeGreaterThan(sliceStart)
    expect(html).toContain('if (f.kind === "dev-servers") { devServersFrame(f); return; }')
    expect(html).toMatch(/const closed = pane\.tabs\[i\];\r?\n\s+pane\.tabs\.splice\(i, 1\);\r?\n\s+devServerTabClosed\(closed\.url\);/u)
    expect(html).toMatch(/if \(pane\.tabs\.length === 0\) paneNewTab\(\);\r?\n[^\n]*\r?\n\s+sendFrame\(\{ kind: "dev-servers" \}\);/u)
    const empty = html.slice(html.indexOf('<div id="paneempty">'), html.indexOf("</div></div></div>", html.indexOf('<div id="paneempty">')))
    expect(empty).toContain('<div id="paneservers" hidden>')
    expect(empty.endsWith('<div id="paneservers" hidden>')).toBe(true)
    // الألوانُ من متغيّرات القشرة (الداكنُ يعمل)، لا قيمٌ مكتوبة.
    const css = html.slice(html.indexOf("#paneservers {"), html.indexOf(".dsv-problem {"))
    expect(css).toContain("var(--ns-fg, var(--fg))")
    expect(css).toContain("var(--ns-card, var(--card))")
    expect(css).toContain("var(--ns-muted, var(--dim))")
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/iu)
  })

  test("الصفوفُ تُرسم أزراراً: ▷ للمتوقّف، ↗ و■ للمُدار العامل، ↗ وحدها للخارجيّ", () => {
    const h = harness()
    expect(h.host.hidden).toBe(true)
    h.api.devServersFrame({ kind: "dev-servers", rows: [
      { name: "web", port: 3210, url: "http://127.0.0.1:3210", state: "down", managed: false },
      { name: "api", port: 4000, url: "http://127.0.0.1:4000", state: "up", managed: true },
      { name: "ext", port: 5000, url: "http://127.0.0.1:5000", state: "up", managed: false, why: "يعمل بيدٍ أخرى" },
    ] })
    expect(h.host.hidden).toBe(false)
    const rows = h.host.byClass("dsv-row")
    expect(rows.map((r) => r.className)).toEqual(["dsv-row dsv-down", "dsv-row dsv-up", "dsv-row dsv-up"])
    expect(rows[0]!.byClass("dsv-name")[0]!.textContent).toBe("web")
    expect(rows[0]!.byClass("dsv-port")[0]!.textContent).toBe(":3210")
    expect(rows[0]!.byClass("dsv-state")[0]!.textContent).toBe("متوقّف")
    expect(rows[0]!.byClass("dsv-start")).toHaveLength(1)
    expect(rows[0]!.byClass("dsv-stop")).toHaveLength(0)
    expect(rows[1]!.byClass("dsv-open")).toHaveLength(1)
    expect(rows[1]!.byClass("dsv-stop")).toHaveLength(1)
    expect(rows[2]!.byClass("dsv-open")).toHaveLength(1)
    expect(rows[2]!.byClass("dsv-stop")).toHaveLength(0)
    expect(rows[2]!.byClass("dsv-state")[0]!.textContent).toBe("يعمل — يعمل بيدٍ أخرى")
    expect(h.host.byClass("dsv-head")[0]!.textContent).toContain(".claude/launch.json")
    // الرسمُ من الجواب كلَّ مرّة: جوابٌ أقصر لا يترك صفّاً معلّقاً.
    h.api.devServersFrame({ kind: "dev-servers", rows: [{ name: "api", port: 4000, url: "http://127.0.0.1:4000", state: "up", managed: true }] })
    expect(h.host.byClass("dsv-row")).toHaveLength(1)
    h.api.devServersFrame({ kind: "dev-servers", rows: [] })
    expect(h.host.hidden).toBe(true)
  })

  test("▷ يرسل dev-server-start ويُرسم «يُقاس» بلا زرٍّ حتى يعود الجواب؛ و«يعمل» يفتح الرابطَ في اللوحة", () => {
    const h = harness()
    h.pane.tabs.push({ label: "t1", url: "", created: false }); h.pane.active = "t1"
    h.api.devServersFrame({ kind: "dev-servers", rows: [{ name: "web", port: 3210, url: "http://127.0.0.1:3210", state: "down", managed: false }] })
    h.host.byClass("dsv-start")[0]!.onclick!()
    expect(h.sent).toEqual([{ kind: "dev-server-start", name: "web" }])
    expect(h.host.byClass("dsv-row")[0]!.className).toBe("dsv-row dsv-measuring")
    expect(h.host.byClass("dsv-start")).toHaveLength(0)
    expect(h.host.byClass("dsv-state")[0]!.textContent).toBe("يُقاس…")
    // جوابُ المحرّك الفوريّ «يُقاس» لا يفتح شيئاً.
    h.api.devServersFrame({ kind: "dev-servers", rows: [{ name: "web", port: 3210, url: "http://127.0.0.1:3210", state: "measuring", managed: true }] })
    expect(h.navigated).toEqual([]); expect(h.newTabs).toEqual([])
    // «يعمل» (ولو على منفذٍ مؤجَّر) يفتح الرابطَ الذي قاسه المحرّك في التبويب الفارغ النشط.
    h.api.devServersFrame({ kind: "dev-servers", rows: [{ name: "web", port: 3211, url: "http://127.0.0.1:3211", state: "up", managed: true }], name: "web", said: "⚙ …" })
    expect(h.navigated).toEqual(["http://127.0.0.1:3211"])
    expect(h.api.devServers.pending.size).toBe(0)
    // ثانيةً لا يُفتح: المعلَّقُ صُفّي.
    h.api.devServersFrame({ kind: "dev-servers", rows: [{ name: "web", port: 3211, url: "http://127.0.0.1:3211", state: "up", managed: true }] })
    expect(h.navigated).toHaveLength(1)
  })

  test("اللوحةُ مغلقةٌ أو تبويبُها مشغول: يُفتح اللوحُ ثمّ تبويبٌ جديد؛ والفشلُ يُقال بنصّ الإيصال", () => {
    const h = harness(false)
    h.pane.tabs.push({ label: "t1", url: "https://example.test/", created: true }); h.pane.active = "t1"
    h.api.devServers.pending.add("web")
    h.api.devServersFrame({ kind: "dev-servers", rows: [{ name: "web", port: 3210, url: "http://127.0.0.1:3210", state: "up", managed: true }] })
    expect(h.toggles).toEqual([true])
    expect(h.newTabs).toEqual(["http://127.0.0.1:3210"])
    h.api.devServers.pending.add("api")
    h.api.devServersFrame({ kind: "dev-servers", rows: [{ name: "api", port: 4000, url: "http://127.0.0.1:4000", state: "down", managed: false }], name: "api", said: "فشل تشغيل الخادم «bun run start»: خرج برمز 1 قبل الإنصات على 4000." })
    expect(h.notices).toEqual(["فشل تشغيل الخادم «bun run start»: خرج برمز 1 قبل الإنصات على 4000."])
    expect(h.api.devServers.pending.size).toBe(0)
    // مشكلاتُ الملفّ تُعرض لا تُبتلع.
    h.api.devServersFrame({ kind: "dev-servers", rows: [], problems: [".claude/launch.json: JSON مشوَّه — Unexpected token"] })
    expect(h.host.hidden).toBe(false)
    expect(h.host.byClass("dsv-problem")[0]!.textContent).toContain("JSON مشوَّه")
  })

  test("■ وإغلاقُ التبويب يرسلان dev-server-stop لِما نديره وحده — تبويبٌ آخر يحمله يُبقيه، والخارجيُّ لا يُمَسّ", () => {
    const h = harness()
    h.api.devServersFrame({ kind: "dev-servers", rows: [
      { name: "api", port: 4000, url: "http://127.0.0.1:4000", state: "up", managed: true },
      { name: "ext", port: 5000, url: "http://127.0.0.1:5000", state: "up", managed: false },
    ] })
    h.host.byClass("dsv-stop")[0]!.onclick!()
    expect(h.sent).toEqual([{ kind: "dev-server-stop", port: 4000 }])
    h.sent.length = 0
    // التبويبُ المُغلق تنقّل داخل الموقع — المطابقةُ بالأصل (المضيف والمنفذ) لا بالرابط الحرفيّ.
    expect(h.api.devServerTabClosed("http://localhost:4000/dashboard?x=1")).toBe(true)
    expect(h.sent).toEqual([{ kind: "dev-server-stop", port: 4000 }])
    h.sent.length = 0
    h.pane.tabs.push({ label: "t2", url: "http://127.0.0.1:4000/", created: true })
    expect(h.api.devServerTabClosed("http://127.0.0.1:4000/other")).toBe(false)
    expect(h.api.devServerTabClosed("http://127.0.0.1:5000/")).toBe(false)
    expect(h.api.devServerTabClosed("https://127.0.0.1:4000/")).toBe(false)
    expect(h.api.devServerTabClosed("https://example.test:4000/")).toBe(false)
    expect(h.api.devServerTabClosed("")).toBe(false)
    expect(h.sent).toEqual([])
    expect(h.api.devServerUrlPort("http://[::1]:4000/")).toBe(4000)
  })
})
