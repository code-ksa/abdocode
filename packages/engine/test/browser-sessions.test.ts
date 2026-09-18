// S6 (09-18) — جلساتُ المتصفّح المملوك وتاريخُ تبويباته: المخزنُ يُقاس بالقرص (ملفٌّ يُكتب ويُحذف باسمه)، وحكمُ
// «صفحةُ دخول» بالرابط وبحقل كلمة السرّ، وسقفُ التاريخ ٢٠٠، والأسلاكُ مساميرُ في كلّ طبقة (المُوزِّع، الكتالوج،
// التعريض، عقدُ النقل، القشرة، المطلِقُ الأصليّ) كي لا تعود أداةٌ «مسجَّلةً غيرَ قابلةٍ للاستدعاء».
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runInNewContext } from "node:vm"
import { validateShellFrame } from "../../transport-contracts/src/shell-protocol"
import {
  BrowserHistory, BrowserSessionStore, HISTORY_CAP, historyCommand, isLoginUrl, loginPageVerdict, loginReceipt, originHash, originOf,
  passwordFieldInTree, sessionsCommand,
} from "../src/browser-sessions"
import { TOOL_FAMILIES, exposedByIntent } from "../src/tool-exposure"

const read = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", ...parts), "utf8")
const dirs: string[] = []
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "abdo-browser-sessions-")); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const state = (origin: string, n = 2) => ({
  origin,
  cookies: Array.from({ length: n }, (_, i) => ({ name: `c${i}`, value: `v${i}`, domain: new URL(origin).hostname, path: "/", secure: true })),
  storage: { token: "abc" },
})

describe("login-page detection", () => {
  test("by URL: paths, return-to queries and identity hosts; ordinary pages are not login pages", () => {
    for (const url of [
      "https://app.example.test/login", "https://app.example.test/signin?x=1", "https://app.example.test/auth/callback",
      "https://app.example.test/dashboard?callbackUrl=%2Fhome", "https://accounts.google.com/v3/signin/identifier", "https://auth.openai.com/authorize",
      "https://x.test/session/new", "https://x.test/sso/",
    ]) expect({ url, login: isLoginUrl(url) }).toEqual({ url, login: true })
    for (const url of ["https://app.example.test/", "https://app.example.test/dashboard", "https://chatgpt.com/c/123", "https://labs.google/fx/tools/whisk", "https://accounts.google.company.test/", "about:blank", "not a url"])
      expect({ url, login: isLoginUrl(url) }).toEqual({ url, login: false })
  })
  test("by page tree: a sensitive textbox marks a login page; the verdict names its reason", () => {
    expect(passwordFieldInTree([{ role: "textbox", sensitive: true }])).toBe(true)
    expect(passwordFieldInTree([{ role: "main", children: [{ role: "form", children: [{ role: "textbox", sensitive: true }] }] }])).toBe(true)
    expect(passwordFieldInTree([{ role: "textbox" }, { role: "button", sensitive: true }])).toBe(false)
    expect(loginPageVerdict({ url: "https://x.test/login" })).toEqual({ login: true, why: "url" })
    expect(loginPageVerdict({ url: "https://x.test/home", passwordField: true })).toEqual({ login: true, why: "password-field" })
    expect(loginPageVerdict({ url: "https://x.test/home", passwordField: false })).toEqual({ login: false })
  })
  test("origins and hashes: only http(s) has an origin; the hash never carries the origin text", () => {
    expect(originOf("https://ChatGPT.com/c/1?x=2")).toBe("https://chatgpt.com")
    expect(originOf("http://127.0.0.1:4475/dashboard")).toBe("http://127.0.0.1:4475")
    expect(originOf("about:blank")).toBeUndefined()
    expect(originOf("file:///C:/x.html")).toBeUndefined()
    expect(originHash("https://chatgpt.com")).toMatch(/^[0-9a-f]{24}$/u)
    expect(originHash("https://chatgpt.com")).toBe(originHash("HTTPS://CHATGPT.COM"))
    expect(originHash("https://chatgpt.com")).not.toBe(originHash("https://chatgpt.com:8443"))
  })
  test("receipt lines the model sees on a login page", () => {
    expect(loginReceipt("https://chatgpt.com", true)).toBe("جلسةٌ محفوظة لـ https://chatgpt.com استُعيدت ⇦ أعد التحميل")
    expect(loginReceipt("https://chatgpt.com", false)).toBe("لا جلسةَ محفوظة — اطلب من المستخدم الدخول مرّةً واحدة ثمّ `sessions save`")
  })
})

describe("BrowserSessionStore — asks the disk", () => {
  test("save writes <hash>.json under browser-sessions, the index names counts not values, and stateFor reads it back", () => {
    const root = temp()
    let now = 1_000_000
    const store = new BrowserSessionStore(root, () => now)
    expect(store.list()).toEqual([])
    const file = store.save("https://chatgpt.com", state("https://chatgpt.com"), { loginOk: true, loginUrl: "https://auth.openai.com/authorize" })
    expect(file).toBe(join(root, "browser-sessions", `${originHash("https://chatgpt.com")}.json`))
    expect(existsSync(file)).toBe(true)
    const onDisk = JSON.parse(readFileSync(file, "utf8"))
    expect(onDisk.cookies).toHaveLength(2)
    expect(onDisk.storage).toEqual({ token: "abc" })
    const index = readFileSync(join(root, "browser-sessions", "index.json"), "utf8")
    expect(index).not.toContain("v0") // قيمُ الكعكات لا تدخل الفهرس
    expect(index).toContain('"cookies": 2')
    expect(store.get("https://chatgpt.com")).toMatchObject({ origin: "https://chatgpt.com", lastLoginOk: true, lastSeen: 1_000_000, loginUrl: "https://auth.openai.com/authorize", cookies: 2 })
    expect(store.stateFor("https://chatgpt.com")).toEqual(state("https://chatgpt.com"))
    expect(store.stateFor("https://other.test")).toBeUndefined()
    now += 3_600_000
    store.markSeen("https://chatgpt.com", false)
    expect(store.get("https://chatgpt.com")).toMatchObject({ lastLoginOk: false, lastSeen: 4_600_000 })
    const rendered = store.render(now + 120_000)
    expect(rendered).toContain("1. https://chatgpt.com · يحتاج دخولاً · 2 كعكة · منذ 2 د")
    expect(rendered).not.toContain("v0")
    // إعادةُ الحفظ تستبدل لا تكرّر
    store.save("https://chatgpt.com", state("https://chatgpt.com", 5), { loginOk: true })
    expect(store.list()).toHaveLength(1)
    expect(store.get("https://chatgpt.com")!.cookies).toBe(5)
    expect(readdirSync(join(root, "browser-sessions")).sort()).toEqual([`${originHash("https://chatgpt.com")}.json`, "index.json"])
  })

  test("an empty state is not a restorable state", () => {
    const root = temp()
    const store = new BrowserSessionStore(root)
    store.save("https://empty.test", { origin: "https://empty.test", cookies: [], storage: {} }, { loginOk: false })
    expect(store.stateFor("https://empty.test")).toBeUndefined()
  })

  test("forget deletes the file and names it; forgetting the unknown says so and deletes nothing", () => {
    const root = temp()
    const store = new BrowserSessionStore(root)
    const file = store.save("https://chatgpt.com", state("https://chatgpt.com"), { loginOk: true })
    store.save("https://mail.google.com", state("https://mail.google.com"), { loginOk: true })
    const gone = store.forget("https://chatgpt.com")
    expect(gone).toEqual({ ok: true, deleted: [file] })
    expect(existsSync(file)).toBe(false)
    expect(store.list().map((r) => r.origin)).toEqual(["https://mail.google.com"])
    expect(store.stateFor("https://chatgpt.com")).toBeUndefined()
    expect(store.forget("https://never.test")).toEqual({ ok: false, deleted: [], why: "لا جلسةَ محفوظة لـ https://never.test" })
    // الطفرة: ملفٌّ حُذف بيدٍ أخرى والفهرسُ ما زال يذكره — الحالةُ غائبة لا فارغة، والنسيانُ ينظّف الفهرس ويسمّي لا شيء
    const other = store.get("https://mail.google.com")!.storageStateFile
    rmSync(other)
    expect(store.stateFor("https://mail.google.com")).toBeUndefined()
    expect(store.forget("https://mail.google.com")).toEqual({ ok: true, deleted: [] })
    expect(store.list()).toEqual([])
  })

  test("noteLanding: save exactly when the previous landing was a login page and this one is not — across origins", () => {
    const store = new BrowserSessionStore(temp())
    expect(store.noteLanding("https://chatgpt.com", false).save).toBe(false)
    expect(store.noteLanding("https://auth.openai.com", true).save).toBe(false)
    expect(store.noteLanding("https://auth.openai.com", true).save).toBe(false) // صفحةُ دخولٍ تليها أخرى (كلمةُ السرّ بعد البريد)
    expect(store.noteLanding("https://chatgpt.com", false).save).toBe(true) // الدخولُ تمّ للتوّ
    expect(store.noteLanding("https://chatgpt.com", false).save).toBe(false) // مرّةً واحدة
    store.noteLanding("https://x.test/login", true)
    store.save("https://x.test", state("https://x.test"), { loginOk: true }) // حفظٌ صريح يطفئ العلامة
    expect(store.noteLanding("https://x.test", false).save).toBe(false)
  })
})

describe("BrowserHistory — 200 newest first", () => {
  test("records to browser-history.json, skips non-http, folds a repeated latest URL, caps at 200, picks by number", () => {
    const root = temp()
    const history = new BrowserHistory(root)
    history.record({ url: "about:blank", title: "", at: 1 })
    expect(existsSync(join(root, "browser-history.json"))).toBe(false)
    for (let i = 1; i <= 205; i++) history.record({ url: `https://site.test/p${i}`, title: `Page ${i}`, at: i * 1000, sessionOrigin: "https://site.test" })
    const entries = history.entries()
    expect(entries).toHaveLength(HISTORY_CAP)
    expect(entries[0]).toEqual({ url: "https://site.test/p205", title: "Page 205", at: 205_000, sessionOrigin: "https://site.test" })
    expect(entries[199]!.url).toBe("https://site.test/p6")
    // تكرارُ آخر رابط يحدّث لا يضيف
    history.record({ url: "https://site.test/p205", title: "Page 205 (loaded)", at: 300_000 })
    expect(history.entries()).toHaveLength(HISTORY_CAP)
    expect(history.entries()[0]).toMatchObject({ title: "Page 205 (loaded)", at: 300_000 })
    // القرصُ هو الحَكَم: قارئٌ جديد يرى الشيءَ نفسَه
    const again = new BrowserHistory(root)
    expect(again.entries()).toHaveLength(HISTORY_CAP)
    expect(JSON.parse(readFileSync(join(root, "browser-history.json"), "utf8")).entries).toHaveLength(HISTORY_CAP)
    expect(again.pick(1)!.url).toBe("https://site.test/p205")
    expect(again.pick(2)!.url).toBe("https://site.test/p204")
    expect(again.pick(0)).toBeUndefined()
    expect(again.pick(201)).toBeUndefined()
    const rendered = again.render(3, 300_000 + 90_000)
    expect(rendered.split("\n")[0]).toBe("200 زيارة (الأحدث أوّلاً):")
    expect(rendered).toContain("1. Page 205 (loaded) — https://site.test/p205 · منذ 1 د")
    expect(rendered).toContain("3. Page 203 — https://site.test/p203")
    expect(rendered).toContain("… و197 غيرها")
    expect(rendered).toContain("history open <رقم>")
    expect(new BrowserHistory(temp()).render()).toContain("لا تاريخَ بعد")
  })
})

describe("command parsers", () => {
  test("sessions: list by default; save/forget/restore need an origin and normalise a URL to its origin; unknown verbs show usage", () => {
    expect(sessionsCommand("")).toEqual({ ok: true, verb: "list" })
    expect(sessionsCommand("list")).toEqual({ ok: true, verb: "list" })
    expect(sessionsCommand("save https://chatgpt.com/c/1")).toEqual({ ok: true, verb: "save", origin: "https://chatgpt.com" })
    expect(sessionsCommand("forget chatgpt.com")).toEqual({ ok: true, verb: "forget", origin: "https://chatgpt.com" })
    expect(sessionsCommand("restore http://127.0.0.1:4475/x")).toEqual({ ok: true, verb: "restore", origin: "http://127.0.0.1:4475" })
    expect(String((sessionsCommand("save") as { why: string }).why)).toContain("الصيغة: sessions")
    expect(String((sessionsCommand("zap x") as { why: string }).why)).toContain("الصيغة: sessions")
  })
  test("history: list by default; open needs a positive number", () => {
    expect(historyCommand("")).toEqual({ ok: true, verb: "list" })
    expect(historyCommand("open 3")).toEqual({ ok: true, verb: "open", n: 3 })
    expect(String((historyCommand("open") as { why: string }).why)).toContain("history open <رقم")
    expect(String((historyCommand("open 0") as { why: string }).why)).toContain("history open <رقم")
    expect(String((historyCommand("x") as { why: string }).why)).toContain("الصيغة: history")
  })
})

describe("wiring pins — every layer", () => {
  const cli = read("src", "cli.ts")
  test("cli.ts: store and history live under STATE_ROOT; every landing records history and judges login; restore precedes navigation", () => {
    expect(cli).toContain('import { BrowserHistory, BrowserSessionStore, PROFILE_DIR, historyCommand, loginPageVerdict, loginReceipt, originOf, sessionsCommand } from "./browser-sessions"')
    expect(cli).toContain("const browserSessions = new BrowserSessionStore(STATE_ROOT)")
    expect(cli).toContain("const browserHistory = new BrowserHistory(STATE_ROOT)")
    expect(cli).toContain('if (name === "history") {')
    expect(cli).toContain('if (name === "sessions") {')
    expect(cli).toContain('return runSurfaceTool("open", entry.url, turnId)')
    expect(cli).toContain("const gone = browserSessions.forget(cmd.origin)")
    expect(cli).toContain("gone.deleted.map((f) => basename(f))")
    // الحفظُ يعدّ ولا يعرض القيم
    expect(cli).toContain("القيمُ على قرصك لا في هذا الإيصال")
    // الاستعادةُ تمرّ بسياسة المواقع ثمّ العقد ثمّ البوّابة قبل التنقّل
    const restore = cli.indexOf("`استعادةُ جلسة ${cmd.origin} وفتحُه`")
    expect(restore).toBeGreaterThan(0)
    expect(cli.indexOf("if (!browserSiteAllowed(SETTINGS_FILE, target))")).toBeLessThan(restore)
    expect(restore).toBeLessThan(cli.indexOf("const cookies = await surface.importCookies(saved.cookies)"))
    // الهبوطُ بعد كلّ تنقّل: ui (ثلاثة مسارات) وopen وtabs new/switch وback/forward وtap الذي نقل الصفحة
    expect(cli.match(/const note = await landed\(/gu)?.length).toBe(8)
    expect(cli.match(/const restored = await restoreBeforeNavigation\(/gu)?.length).toBe(5)
    expect(cli).toContain("if (now.length > 0 && now !== surfaceUrl) { surfaceUrl = now; moved = await landed(now) }")
    // الاستعادةُ مرّةً ثمّ يُسأل المستخدمُ مرّةً: لا حلقةَ على جلسةٍ انتهت؛ الحفظُ والنسيانُ يصفّران المحاولة
    expect(cli).toContain("const sessionRestoreTried = new Set<string>()")
    expect(cli).toContain("if (saved === undefined || sessionRestoreTried.has(origin)) { browserSessions.markSeen(origin, false); return `\\n${loginReceipt(origin, false)}")
    expect(cli.match(/sessionRestoreTried\.add\(/gu)?.length).toBe(3)
    expect(cli.match(/sessionRestoreTried\.delete\(/gu)?.length).toBe(3)
    // الاستعادةُ قبل التنقّل لا بعده (المسارُ الحيّ في open)
    const openRestore = cli.indexOf("const restored = await restoreBeforeNavigation(rest)")
    expect(openRestore).toBeGreaterThan(0)
    expect(openRestore).toBeLessThan(cli.indexOf("await surface.navigate(rest)", openRestore))
    // الملفُّ الدائم للمسار غير المرئيّ تحت دليل الحالة لا المؤقّت ولا LOCALAPPDATA
    // ملفٌّ **دائم** لا مؤقّت: الخطُّ يحلّه بدليل حالة المحرّك، والنكهةُ ببيتها (ABDO_LOCAL_HOME) — كلاهما يبقى بعد إعادة التشغيل.
    expect(cli).toMatch(/const profile = (?:surfaceProfileDir\(process\.env, ROOT\) \?\? )?join\(STATE_ROOT, PROFILE_DIR\)/u)
    expect(cli).not.toContain("mkdtempSync(join(tmpdir()") // لا ملفَّ متصفّحٍ مؤقّتاً بعد اليوم
    expect(cli).not.toContain('"AbdoCode", "surface-profile"')
    // إطارُ اللوحة: طلبٌ يُقرأ من القرص لحظتَه، وبثٌّ بعد كلّ تنقّل
    expect(cli).toContain('if (frame.kind === "browser-history") {')
    expect(cli).toContain('emit({ kind: "browser-history", entries: new BrowserHistory(STATE_ROOT).entries().slice(0, 50) })')
    expect(cli).toContain('const emitBrowserHistory = (): void => { if (shellKind !== undefined) emit({ kind: "browser-history", entries: browserHistory.entries().slice(0, 50) }) }')
  })
  test("catalogue, exposure and transport contract", () => {
    const catalogue = read("..", "tools", "src", "catalogue.ts")
    expect(catalogue).toContain('{ name: "sessions", effect: "read", usage: "sessions [list | save <أصل> | forget <أصل> | restore <أصل>]"')
    expect(catalogue).toContain('{ name: "history", effect: "read", usage: "history [list | open <رقم>]"')
    for (const line of catalogue.split("\n").filter((l) => l.includes('name: "sessions"') || l.includes('name: "history"'))) expect(line).toContain('agentCallable: true, runner: "surface"')
    for (const verb of ["sessions", "history"]) {
      expect(TOOL_FAMILIES.browser).toContain(verb)
      expect(exposedByIntent(verb, new Set())).toBe(false)
      expect(exposedByIntent(verb, new Set(["browser"]))).toBe(true)
    }
    expect(validateShellFrame({ kind: "browser-history" })).toEqual({ ok: true })
    expect(validateShellFrame({ kind: "browser-history", entries: [] }).ok).toBe(false)
    expect(validateShellFrame({ kind: "history" })).toEqual({ ok: true }) // جلساتُ المحادثة — لم تُمَسّ
  })
  test("owned browser (CDP) exposes the session primitives; cookie values stay out of receipts by construction", () => {
    const cdp = read("..", "browser", "src", "cdp.ts")
    for (const method of ["async currentUrl(): Promise<string>", "async hasPasswordField(): Promise<boolean>", "async cookiesFor(origin: string): Promise<readonly CdpCookie[]>", "async originStorage(origin: string)", "async importCookies(cookies: readonly CdpCookie[]): Promise<number>", "async importOriginStorage(origin: string, storage: Readonly<Record<string, string>>): Promise<number>", "async reload(): Promise<void>"])
      expect(cdp).toContain(method)
    expect(cdp).toContain('await this.#send("Network.getCookies", { urls: [origin] })')
    expect(cdp).toContain('await this.#send("Network.setCookies", { cookies: cookies.map((c) => ({ ...c })) })')
    expect(cdp).toContain("String(!!document.querySelector('input[type=password]'))")
  })
  test("desktop owner: the controlled browser profile is persistent under the app profile, default persistence is shared", () => {
    const main = read("..", "desktop", "src-tauri", "src", "main.rs")
    expect(main).toContain("fn browser_profile_dir(profile_root: &Path, shared: bool) -> PathBuf")
    expect(main).toContain("let profile = browser_profile_dir(&profile::directory(&app)?, workspace::browser_profile_shared(&app));")
    expect(main).not.toContain('format!("abdocode-pane-session-{}", std::process::id())')
    expect(main).not.toContain('std::env::temp_dir().join(if workspace::browser_profile_shared(&app)')
    const workspace = read("..", "desktop", "src-tauri", "src", "workspace.rs")
    expect(workspace).toMatch(/fn default_browser_persistence\(\) -> String \{\r?\n[^\n]*\r?\n\s+"shared"\.into\(\)/u)
  })
})

// ---- القشرة: شريحةُ التاريخ في index.html تُشغَّل في سياقٍ معزول بوثيقةٍ مزيّفة ----
class FakeNode {
  readonly kids: FakeNode[] = []
  className = ""
  hidden = false
  title = ""
  onclick: (() => void) | undefined
  #text = ""
  constructor(readonly tag: string) {}
  get textContent(): string { return this.#text }
  set textContent(value: string) { this.#text = value; this.kids.length = 0 }
  appendChild(node: FakeNode): FakeNode { this.kids.push(node); return node }
  walk(): FakeNode[] { return [this, ...this.kids.flatMap((k) => k.walk())] }
  byClass(name: string): FakeNode[] { return this.walk().filter((n) => n.className.split(" ").includes(name)) }
}

describe("shell wiring — تاريخُ المتصفّح في الحالة الفارغة للّوحة", () => {
  const html = readFileSync(resolve(import.meta.dir, "../../desktop/ui/index.html"), "utf8")
  const sliceStart = html.indexOf("    const browserHistory = { entries: [] };")
  const sliceEnd = html.indexOf("    // ---- خوادمُ التطوير في لوحة المتصفّح (S2)", sliceStart)
  const slice = html.slice(sliceStart, sliceEnd)
  const harness = (paneOpen = true) => {
    const host = new FakeNode("div"); host.hidden = true
    const navigated: string[] = []; const newTabs: string[] = []; const toggles: boolean[] = []
    const pane = { tabs: [] as { label: string; url: string; created: boolean }[], active: null as string | null }
    const api = runInNewContext(slice + "\n;({ browserHistory, renderBrowserHistory, browserHistoryFrame })", {
      URL, Date, Number, Math, Array,
      el: (id: string) => (id === "panehistory" ? host : undefined),
      document: { createElement: (tag: string) => new FakeNode(tag), body: { classList: { contains: () => paneOpen } } },
      uiText: (_en: string, ar: string) => ar,
      pane, paneGo: (u: string) => { navigated.push(u) }, paneNewTab: (u: string) => { newTabs.push(u) }, paneToggle: (want: boolean) => { toggles.push(want) },
    }) as { browserHistory: { entries: unknown[] }; renderBrowserHistory: () => void; browserHistoryFrame: (f: Record<string, unknown>) => void }
    return { host, navigated, newTabs, toggles, pane, api }
  }

  test("الشريحةُ موجودةٌ ومربوطة: الإطارُ يُستقبل، والفتحُ يطلبه، والمضيفُ داخل الحالة الفارغة قبل خوادم التطوير، وبلا تخزينٍ في القشرة", () => {
    expect(sliceStart).toBeGreaterThan(0)
    expect(sliceEnd).toBeGreaterThan(sliceStart)
    expect(html).toContain('if (f.kind === "browser-history") { browserHistoryFrame(f); return; }')
    expect(html).toMatch(/sendFrame\(\{ kind: "dev-servers" \}\);\r?\n\s+sendFrame\(\{ kind: "browser-history" \}\);/u)
    const empty = html.slice(html.indexOf('<div id="paneempty">'), html.indexOf("</div></div></div>", html.indexOf('<div id="paneempty">')))
    expect(empty).toContain('<div id="panehistory" hidden></div><div id="paneservers" hidden>')
    expect(slice).not.toMatch(/\b(?:localStorage|sessionStorage)\b/u)
    const css = html.slice(html.indexOf("#panehistory {"), html.indexOf("</style>", html.indexOf("#panehistory {")))
    expect(css).toContain("var(--ns-card, var(--card))")
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/iu)
  })

  test("الصفوفُ تُرسم من الإطار الأحدثُ أوّلاً بعنوانٍ ومضيفٍ وعمر؛ غيرُ http لا يُرسم؛ والنقرُ يفتح في اللوحة", () => {
    const h = harness()
    expect(h.host.hidden).toBe(true)
    h.pane.tabs.push({ label: "t1", url: "", created: false }); h.pane.active = "t1"
    h.api.browserHistoryFrame({ kind: "browser-history", entries: [
      { url: "https://chatgpt.com/c/1", title: "ChatGPT", at: Date.now() - 120_000 },
      { url: "http://127.0.0.1:4475/dashboard", title: "", at: Date.now() - 7_200_000 },
      { url: "about:blank", title: "blank", at: Date.now() },
      { url: "javascript:alert(1)", title: "x", at: Date.now() },
    ] })
    expect(h.host.hidden).toBe(false)
    const rows = h.host.byClass("bh-row")
    expect(rows).toHaveLength(2)
    expect(rows[0]!.byClass("bh-title")[0]!.textContent).toBe("ChatGPT")
    expect(rows[0]!.byClass("bh-host")[0]!.textContent).toBe("chatgpt.com")
    expect(rows[0]!.byClass("bh-age")[0]!.textContent).toBe("2 د")
    expect(rows[1]!.byClass("bh-title")[0]!.textContent).toBe("http://127.0.0.1:4475/dashboard")
    expect(rows[1]!.byClass("bh-age")[0]!.textContent).toBe("2 س")
    rows[0]!.onclick!()
    expect(h.navigated).toEqual(["https://chatgpt.com/c/1"])
    // تبويبٌ مشغول ⇦ تبويبٌ جديد؛ لوحةٌ مغلقة ⇦ تُفتح أوّلاً
    h.pane.tabs[0]!.url = "https://x.test/"; h.pane.tabs[0]!.created = true
    rows[1]!.onclick!()
    expect(h.newTabs).toEqual(["http://127.0.0.1:4475/dashboard"])
    const closed = harness(false)
    closed.api.browserHistoryFrame({ kind: "browser-history", entries: [{ url: "https://a.test/", title: "A", at: Date.now() }] })
    closed.host.byClass("bh-row")[0]!.onclick!()
    expect(closed.toggles).toEqual([true])
    // الرسمُ من الجواب كلَّ مرّة
    h.api.browserHistoryFrame({ kind: "browser-history", entries: [] })
    expect(h.host.hidden).toBe(true)
  })
})
