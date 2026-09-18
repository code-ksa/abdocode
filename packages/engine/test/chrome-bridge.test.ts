import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BRIDGE_TOOLS, ChromeBridge, loginHint, lookReceipt, MASKED_VALUE, type PageNode } from "../src/mcp-servers/chrome-bridge"
import { Mcp } from "../src/mind/mcp"

// ب7 — جسرُ كروم: إضافةٌ مزيّفة تتّصل بالمقبس المحلّيّ بالرمز وتنفّذ الأفعال؛ الحارسُ والسياسةُ في الجسر لا في
// الإضافة؛ والرمزُ الخاطئ لا يصل رسالةً واحدة؛ وحلقةُ MCP عبر stdio تُشغَّل كطفلٍ حقيقيّ بعميل المحرّك نفسه.

const TREE = [{ ref: "r1", role: "textbox", name: "Email", state: "filled" }, { ref: "r2", role: "textbox:password", name: "Password", state: "empty" }, { ref: "r3", role: "button", name: "Sign up" }]

/** إضافةٌ مزيّفة: تسجّل ما وصلها وتجيب كما تجيب الإضافةُ الحقيقية. */
const fakeExtension = (port: number, token: string, oldExtension = false) => {
  const received: { action: string; args: Record<string, unknown> }[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`)
  const opened = new Promise<boolean>((resolve) => { ws.onopen = () => resolve(true); ws.onerror = () => resolve(false); ws.onclose = () => resolve(false) })
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data)) as { id: number; action: string; args: Record<string, unknown> }
    received.push({ action: m.action, args: m.args })
    const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, ok: true, result }))
    if (m.action === "page") reply(TREE)
    // S11: إضافةٌ مزيّفة تسرّب قيمةَ كلمة المرور في look (r2) — الجسرُ يحجبها بنفسه؛ وr1 بلا `value` (إضافةٌ قبل 0.6.5).
    else if (m.action === "look") reply(JSON.stringify({ title: "Fixture", url: "https://allowed.test/", focused: m.args.ref === "r2", text: "Email field", ...(m.args.ref === "r2" ? { value: "hunter2" } : {}), styles: { color: "rgb(0, 0, 0)" } }))
    else if (m.action === "shot") reply("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
    else if (m.action === "boom") ws.send(JSON.stringify({ id: m.id, ok: false, error: "element not found" }))
    else if (m.action === "reload" && oldExtension) ws.send(JSON.stringify({ id: m.id, ok: false, error: "unknown action" }))
    else if (m.action === "reload") reply({ ok: true, version: "0.6.3" })
    else reply(true)
  }
  return { received, opened, close: () => ws.close() }
}

describe("loginHint — صفحةُ الدخول المعبّأة تُضغط بالوكيل لا بالمستخدم (ملاحظة المالك 2026-09-17)", () => {
  test("معبّأة ⇦ اضغط الزرّ بمرجعه؛ فارغة ⇦ اطلب من المستخدم؛ بلا كلمة مرور ⇦ لا تلميح", () => {
    const filled: PageNode[] = [{ ref: "r1", role: "textbox", name: "البريد الإلكتروني", state: "filled" }, { ref: "r2", role: "textbox:password", name: "كلمة المرور", state: "filled" }, { ref: "r3", role: "button", name: "تسجيل الدخول" }]
    const hint = loginHint(filled)
    expect(hint).toContain("معبّأة")
    expect(hint).toContain("[r3] «تسجيل الدخول»")
    expect(hint).toContain("chrome.tap")
    expect(loginHint(filled.map((n) => n.ref === "r2" ? { ...n, state: "empty" as const } : n))).toContain("سجّل الدخول في هذا التبويب")
    expect(loginHint([{ ref: "r1", role: "button", name: "Login" }])).toBeUndefined()
    // زرٌّ إنجليزيّ يُلتقط أيضاً، وغيابُ الزرّ لا يُسقط التلميح.
    expect(loginHint([{ ref: "r2", role: "textbox:password", name: "Password", state: "filled" }, { ref: "r9", role: "button", name: "Sign in" }])).toContain("[r9] «Sign in»")
    expect(loginHint([{ ref: "r2", role: "textbox:password", name: "Password", state: "filled" }])).toContain("زرّ الدخول")
    // إضافةٌ قديمة بلا حالة: لا يُدّعى «فارغة» — يُسمّى الجهل ويُطلب التحديث.
    const unknown = loginHint([{ ref: "r2", role: "textbox:password", name: "Password" }])
    expect(unknown).toContain("غيرُ معروفة")
    expect(unknown).toContain("0.6.2")
    expect(unknown).not.toContain("فارغة")
  })
})

describe("S11 — chrome.look على حقل يعيد قيمتَه في `value`، وكلمةُ المرور «محجوب» أبداً (مقيس 2026-09-18: innerText لـ<input> فارغ)", () => {
  const styles = { color: "rgb(0, 0, 0)" }
  const password: PageNode = { ref: "r2", role: "textbox:password", name: "Password", state: "filled" }
  const email: PageNode = { ref: "r1", role: "textbox", name: "a@b.co", state: "filled" }
  const empty: PageNode = { ref: "r5", role: "textbox", name: "الاسم", state: "empty" }
  const button: PageNode = { ref: "r3", role: "button", name: "Sign up" }

  test("كلمةُ المرور تُحجب في الجسر ولو أرسلت الإضافةُ قيمتَها؛ ولو لم ترسل شيئاً", () => {
    expect(MASKED_VALUE).toBe("«محجوب»")
    const leaked = JSON.stringify({ title: "t", url: "u", focused: true, text: "", value: "hunter2", styles })
    const masked = lookReceipt(leaked, password)
    expect(JSON.parse(masked)).toMatchObject({ focused: true, value: "«محجوب»" })
    expect(masked).not.toContain("hunter2")
    expect(JSON.parse(lookReceipt(JSON.stringify({ title: "t", url: "u", focused: false, text: "", styles }), password)).value).toBe("«محجوب»")
  })

  test("الإضافةُ 0.6.5 ترسل `value` فيمرّ كما هو؛ وإضافةٌ أقدم بلا `value` ⇦ يُشتقّ من الشجرة (المعبّأ اسمُه قيمتُه، والفارغ \"\")", () => {
    const fresh = JSON.stringify({ title: "t", url: "u", focused: false, text: "", value: "typed by 0.6.5", styles })
    expect(lookReceipt(fresh, email)).toBe(fresh)
    const old = JSON.stringify({ title: "t", url: "u", focused: false, text: "", styles })
    expect(JSON.parse(lookReceipt(old, email)).value).toBe("a@b.co")
    expect(JSON.parse(lookReceipt(old, empty)).value).toBe("")
    // زرٌّ وصفحةٌ كاملة: لا `value` تُخترع.
    expect(lookReceipt(old, button)).toBe(old)
    expect(lookReceipt(old, undefined)).toBe(old)
    // نصٌّ ليس JSON (إضافةٌ قديمة تعيد نصّاً عارياً) يعود كما هو؛ وغيرُ النصّ يُسلسل.
    expect(lookReceipt("plain text", password)).toBe("plain text")
    expect(lookReceipt({ text: "x" }, undefined)).toBe('{"text":"x"}')
  })

  test("الإضافة 0.6.5 تقرأ القيمة في الصفحة وتحجب كلمةَ المرور فيها، والمانيفست 0.6.5", () => {
    const background = readFileSync(resolve(import.meta.dir, "../../browser-bridge/extension/background.js"), "utf8")
    expect(background).toContain('const field = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT"')
    expect(background).toContain(': tag === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password" ? "«محجوب»"')
    expect(background).toContain(': String(el.value || "").slice(0, 2000)')
    expect(background).toContain("...(value === undefined ? {} : { value }), styles })")
    expect(JSON.parse(readFileSync(resolve(import.meta.dir, "../../browser-bridge/extension/manifest.json"), "utf8")).version).toBe("0.6.5")
  })
})

describe("ChromeBridge — المقبسُ والحراسة", () => {
  test("الرمزُ الخاطئ يُرفض عند الترقية، والصحيحُ يوصل إضافةً واحدة، وبلا إضافةٍ يُسمّى الغياب", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-bridge-"))
    const bridge = new ChromeBridge({ port: 0, token: "secret-token", stateDir: dir, announce: () => {} })
    const port = bridge.start()
    try {
      await expect(bridge.run("page", {})).rejects.toThrow("لا إضافةَ موصولة")
      // الملفُّ على القرص يحمل المنفذَ والرمز — منه تأخذهما لوحةُ الإعدادات والمستخدم.
      const announced = JSON.parse(readFileSync(join(dir, "chrome-bridge.json"), "utf8")) as { port: number; token: string }
      expect(announced).toMatchObject({ port, token: "secret-token" })
      const wrong = fakeExtension(port, "wrong")
      expect(await wrong.opened).toBe(false)
      expect(bridge.connected).toBe(false)
      const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { connected: boolean }
      expect(health.connected).toBe(false)
      const ext = fakeExtension(port, "secret-token")
      expect(await ext.opened).toBe(true)
      expect(bridge.connected).toBe(true)
      // إضافةٌ ثانية لا تُقبل — مقبسٌ واحد لكروم واحد.
      const second = fakeExtension(port, "secret-token")
      expect(await second.opened).toBe(false)
      ext.close()
      await Bun.sleep(50)
      expect(bridge.connected).toBe(false)
    } finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }) }
  })

  test("page ثم tap/fill يمرّان إلى الإضافة؛ حقلُ كلمة المرور يُرفض قبل الإرسال؛ open يخضع لسياسة المواقع؛ shot تُحفظ ملفّاً", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-bridge-"))
    const settings = join(dir, "engine-settings.json")
    writeFileSync(settings, "{}")
    writeFileSync(join(dir, "workspace-v1.json"), JSON.stringify({ preferences: { browserDefaultPermission: "allow", blockedSites: ["blocked.test"] } }))
    const bridge = new ChromeBridge({ port: 0, token: "t", settingsFile: settings, stateDir: dir, shotsDir: join(dir, "shots"), announce: () => {} })
    const port = bridge.start()
    const ext = fakeExtension(port, "t")
    try {
      expect(await ext.opened).toBe(true)
      expect(await bridge.run("tap", { ref: "r3" })).toContain("مرجعٌ غير معروف")
      const page = await bridge.run("page", {})
      expect(page).toContain("[r3] button: Sign up")
      // حالةُ الحقول بلا قيمها، وصفحةُ الدخول الفارغة تُسلَّم للمستخدم (0.6.2).
      expect(page).toContain("[r1] textbox: Email (معبّأ)")
      expect(page).toContain("[r2] textbox:password: Password (فارغ)")
      expect(page).toContain("⚑ صفحةُ دخولٍ وكلمةُ المرور فارغة")
      expect(await bridge.run("tap", { ref: "r3" })).toContain("نقرتُ «Sign up»")
      expect(await bridge.run("fill", { ref: "r1", text: "user@example.com" })).toContain("كتبتُ في «Email»")
      const refused = await bridge.run("fill", { ref: "r2", text: "hunter2" })
      expect(refused).toContain("حقلٌ محظورٌ")
      expect(refused).toContain("يكتبه بيده")
      // لم يصل الإضافةَ أيُّ fill لكلمة المرور.
      expect(ext.received.filter((r) => r.action === "fill").map((r) => r.args.ref)).toEqual(["r1"])
      expect(await bridge.run("open", { url: "javascript:alert(1)" })).toContain("العقد رفض")
      expect(await bridge.run("open", { url: "https://blocked.test/x" })).toBe("Navigation blocked by saved site permissions")
      expect(await bridge.run("open", { url: "https://allowed.test/" })).toContain("انتقلتُ")
      expect(ext.received.filter((r) => r.action === "open")).toHaveLength(1)
      // بعد التنقّل تبطل المراجع.
      expect(await bridge.run("tap", { ref: "r3" })).toContain("مرجعٌ غير معروف")
      await bridge.run("page", {})
      const looked = await bridge.run("look", { ref: "r2" })
      expect(looked).toContain('"focused":true')
      // S11: كلمةُ المرور «محجوب» في إيصال الجسر ولو سرّبتها الإضافة؛ والحقلُ المعبّأ بلا `value` يُشتقّ من الشجرة.
      expect(looked).toContain('"value":"«محجوب»"')
      expect(looked).not.toContain("hunter2")
      expect(await bridge.run("look", { ref: "r1" })).toContain('"value":"Email"')
      expect(await bridge.run("key", { key: "Enter" })).toContain("ضغطتُ Enter")
      expect(await bridge.run("key", { key: "F13;rm" })).toContain("الصيغة")
      // 0.6.3 — إعادةُ تحميل الإضافة بأمر عبدو كود: الطلبُ يصل الإضافةَ، والمراجعُ تبطل بعده.
      const reloaded = await bridge.run("reload", {})
      expect(reloaded).toContain("(0.6.3)")
      expect(ext.received.filter((r) => r.action === "reload")).toHaveLength(1)
      // إضافةٌ قديمة تردّ «unknown action» ⇦ رفضٌ مسمّى بعمرها لا خطأٌ عارٍ (مقيس على 0.6.1).
      ext.close(); await Bun.sleep(50)
      const old = fakeExtension(port, "t", true)
      expect(await old.opened).toBe(true)
      expect(await bridge.run("reload", {})).toContain("أقدمُ من 0.6.3")
      old.close(); await Bun.sleep(50)
      const again = fakeExtension(port, "t")
      expect(await again.opened).toBe(true)
      expect(await bridge.run("tap", { ref: "r3" })).toContain("مرجعٌ غير معروف")
      await bridge.run("page", {})
      const shot = await bridge.run("shot", {})
      expect(shot).toContain("حُفظت لقطةُ التبويب")
      const file = shot.match(/: (.+\.png) /u)?.[1]
      expect(file !== undefined && existsSync(file)).toBe(true)
      expect(readFileSync(file!).subarray(0, 4).toString("hex")).toBe("89504e47")
      // خطأُ الإضافة يعود خطأً مسمّى لا صمتاً.
      // (بصيغة then/catch: مسبارٌ داخل الاختبار أثبت أن الرفضَ يصل، بينما `rejects` هنا انتظر المهلة كاملةً.)
      const verdict = await bridge.send("boom", {}, 3_000).then(() => "resolved", (error: Error) => error.message)
      expect(verdict).toBe("element not found")
    } finally { ext.close(); bridge.stop(); rmSync(dir, { recursive: true, force: true }) }
  })
})

describe("MCP عبر stdio — كما يطلقه المحرّك", () => {
  test("الطفلُ الحقيقيّ يعلن الأدوات باسم chrome.*، ويمرّر النداءَ إلى الإضافة، ويردّ نصّاً", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-bridge-mcp-"))
    // الطفلُ لا يرث بيئتنا (عميلُ MCP يجرّدها): مجلّدُ الحالة والمنفذُ وسيطان، والرمزُ يُقرأ من chrome-bridge.json كما يقرؤه المستخدم.
    const session = new Mcp.McpSession({ id: "chrome", command: [process.execPath, resolve(import.meta.dir, "../src/mcp-servers/chrome-bridge.ts"), dir, "0"] })
    try {
      const tools = await session.handshake(20_000)
      expect(tools.map((t) => t.name).sort()).toEqual(BRIDGE_TOOLS.map((t) => `chrome.${t.name}`).sort())
      let announced: { port: number; token: string } | undefined
      for (let i = 0; i < 50 && announced === undefined; i++) { try { announced = JSON.parse(readFileSync(join(dir, "chrome-bridge.json"), "utf8")) } catch { await Bun.sleep(100) } }
      expect(announced).toBeDefined()
      let ext: ReturnType<typeof fakeExtension> | undefined
      for (let i = 0; i < 40 && ext === undefined; i++) { const probe = fakeExtension(announced!.port, announced!.token); if (await probe.opened) ext = probe; else await Bun.sleep(100) }
      expect(ext).toBeDefined()
      // عميلُ المحرّك يأخذ المعطياتِ نصّاً (JSON أو خانةً واحدة) — كما يكتبها النموذج.
      const before = await session.call("chrome.tap", JSON.stringify({ ref: "r3" }), 10_000)
      expect(before.text).toContain("مرجعٌ غير معروف")
      const page = await session.call("chrome.page", "", 10_000)
      expect(page.text).toContain("Sign up")
      const tap = await session.call("chrome.tap", "r3", 10_000)
      expect(tap.text).toContain("نقرتُ")
      expect(ext!.received.map((r) => r.action)).toEqual(["page", "tap"])
      ext!.close()
    } finally { session.close(); rmSync(dir, { recursive: true, force: true }) }
  }, 60_000)
})
