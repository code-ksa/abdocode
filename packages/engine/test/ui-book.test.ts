import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { UI_BOOK_CAP, UI_BOOK_DIR, UI_BOOK_TREE_CAP, UI_BOOK_USAGE, appSlug, codeHints, listBook, parseUiBookCommand, recordScreen, relatedCodePaths, renderBookList, renderScreen, screenSlug, showScreen, slugify, treeFromDesk, treeFromPage, type UiBookEntry } from "../src/ui-book"

// S8 (09-18) — دفترُ الواجهات: تدوينٌ لكلّ شاشةٍ عُمل عليها، مسقوفٌ (٥٠٠ لكلّ تطبيق، الأقدمُ يُطرد)، وقراءةٌ بالاسم.

let root = ""
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ui-book-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const entry = (over: Partial<UiBookEntry> = {}): UiBookEntry => ({
  capturedAt: "2026-09-18T10:00:00.000Z", source: "browser", app: "https://shop.example.test:4475", title: "لوحة التحكّم — Dashboard", route: "/dashboard/orders", slug: screenSlug("لوحة التحكّم — Dashboard", "/dashboard/orders"),
  rect: { x: 0, y: 0, width: 1280, height: 960 }, mode: "normal", tree: treeFromPage([{ ref: "r1", role: "button", name: "حفظ" }]), codePaths: ["src/app/dashboard/orders/page.tsx"], ...over,
})

describe("S8 — المعرّفات والملخّصات", () => {
  test("slugify/appSlug/screenSlug: آمنةٌ للمسار، عربيّةٌ بلا تشكيل، والأصلُ host:port، والجذرُ home", () => {
    expect(slugify("Extensions - Google Chrome")).toBe("extensions-google-chrome")
    expect(slugify("لوحةُ التحكّم / الطلبات")).toBe("لوحة-التحكم-الطلبات")
    expect(slugify("../../x")).toBe("x")
    expect(slugify("")).toBe("untitled")
    expect(appSlug("https://shop.example.test:4475/a/b")).toBe("shop-example-test-4475")
    expect(appSlug("C:\\Program Files\\Google\\Chrome\\chrome.exe")).toBe("chrome")
    expect(appSlug("notepad")).toBe("notepad")
    expect(screenSlug("Home", "/")).toBe("home")
    expect(screenSlug("x", "/dashboard/orders?tab=2#top")).toBe("dashboard-orders")
    expect(screenSlug("Untitled - Notepad")).toBe("untitled-notepad")
  })
  test("ملخّصُ شجرة desk ui: الأدوارُ تُعدّ كلُّها، والعقدُ تُسقف", () => {
    const elements = Array.from({ length: UI_BOOK_TREE_CAP + 20 }, (_, i) => ({ ref: i + 1, type: i % 2 === 0 ? "Button" : "Edit", name: `n${i}`, x: i, y: 0, w: 10, h: 5 }))
    const t = treeFromDesk([...elements, { ref: 999, type: "Pane", name: "", x: -1, y: -1, w: 0, h: 0 }])
    expect(t.total).toBe(UI_BOOK_TREE_CAP + 21)
    expect(t.roles).toEqual({ Button: 85, Edit: 85, Pane: 1 })
    expect(t.nodes).toHaveLength(UI_BOOK_TREE_CAP)
    expect(t.nodes[0]).toEqual({ role: "Button", name: "n0", ref: "u1", box: { x: 0, y: 0, width: 10, height: 5 } })
  })
  test("ملخّصُ شجرة page: مسطَّحةٌ بالعمق أوّلاً، بلا صناديق", () => {
    const t = treeFromPage([{ ref: "r1", role: "nav", name: "", children: [{ ref: "r2", role: "link", name: "الطلبات" }] }, { ref: "r3", role: "button", name: "حفظ" }])
    expect(t.total).toBe(3)
    expect(t.roles).toEqual({ nav: 1, link: 1, button: 1 })
    expect(t.nodes.map((n) => n.ref)).toEqual(["r1", "r2", "r3"])
  })
  test("كلماتُ الكود من العنوان والمسار بلا الشائع، والمرشّحون حتميّون من قائمة ملفّات: اسمُ الملفّ أوّلاً ثمّ المسار", () => {
    expect(codeHints("Orders — Shop Dashboard (2)", "/dashboard/orders")).toEqual(["orders", "shop", "dashboard"])
    const files = ["src/app/dashboard/orders/page.tsx", "src/components/orders-table.tsx", "src/lib/db.ts", "src/app/dashboard/layout.tsx", "src/app/orders.ts", "README.md"]
    // orders.ts: اسمُ الملفّ = الكلمة (فهرسُ المسار) ⇦ الأعلى؛ orders-table: الكلمةُ في اسم الملفّ؛ page.tsx: كلمتان في المجلّدات؛ layout.tsx: كلمةٌ في المجلّد
    expect(relatedCodePaths(files, ["orders", "dashboard"])).toEqual(["src/app/orders.ts", "src/components/orders-table.tsx", "src/app/dashboard/orders/page.tsx", "src/app/dashboard/layout.tsx"])
    expect(relatedCodePaths(files, [])).toEqual([])
    expect(relatedCodePaths([], ["orders"])).toEqual([])
    expect(relatedCodePaths(Array.from({ length: 30 }, (_, i) => `src/orders${i}.ts`), ["orders"])).toHaveLength(10)
  })
})

describe("S8 — التدوينُ والقراءةُ والسقف", () => {
  test("recordScreen يكتب <حالة>/ui-book/<تطبيق>/<شاشة>.json ويُثري عند التحديث ولا يمحو الأنماطَ واللقطة", () => {
    const first = recordScreen(root, entry({ screenshot: "C:/shots/desk-1.png" }))
    expect(first.path).toBe(join(root, UI_BOOK_DIR, "shop-example-test-4475", "dashboard-orders.json"))
    expect(first.evicted).toEqual([])
    const saved = JSON.parse(readFileSync(first.path, "utf8")) as UiBookEntry
    expect(saved.app).toBe("https://shop.example.test:4475")
    expect(saved.screenshot).toBe("C:/shots/desk-1.png")
    expect(saved.styles).toBeUndefined()
    // تحديثٌ بأنماطٍ وبشجرةٍ فارغة: الأنماطُ تُضاف، والشجرةُ السابقة تبقى، واللقطةُ تبقى
    recordScreen(root, entry({ capturedAt: "2026-09-18T11:00:00.000Z", tree: treeFromPage([]), styles: "x".repeat(5000), codePaths: [] }))
    const merged = JSON.parse(readFileSync(first.path, "utf8")) as UiBookEntry
    expect(merged.capturedAt).toBe("2026-09-18T11:00:00.000Z")
    expect(merged.styles).toHaveLength(4000)
    expect(merged.tree.total).toBe(1)
    expect(merged.screenshot).toBe("C:/shots/desk-1.png")
    expect(merged.codePaths).toEqual(["src/app/dashboard/orders/page.tsx"])
  })
  test("list/show: بالتطبيق والشاشة، أو بالشاشة وحدها إن كانت فريدة؛ الغامضُ والغائبُ يُسمّيان", () => {
    recordScreen(root, entry())
    recordScreen(root, entry({ source: "desk", app: "notepad", title: "Untitled - Notepad", route: undefined, slug: "untitled-notepad", mode: "windowed", rect: { x: 100, y: 50, width: 1176, height: 1530 } }))
    recordScreen(root, entry({ app: "https://other.test", title: "Orders", route: "/dashboard/orders" }))
    const apps = listBook(root)
    expect(apps.map((a) => a.app)).toEqual(["notepad", "other-test", "shop-example-test-4475"])
    expect(apps[0]!.screens).toEqual([{ slug: "untitled-notepad", title: "Untitled - Notepad", capturedAt: "2026-09-18T10:00:00.000Z", mode: "windowed" }])
    const shown = showScreen(root, "notepad/untitled-notepad")
    expect("error" in shown).toBe(false)
    expect((shown as UiBookEntry).rect).toEqual({ x: 100, y: 50, width: 1176, height: 1530 })
    expect("error" in showScreen(root, "untitled-notepad")).toBe(false)
    expect((showScreen(root, "dashboard-orders") as { error: string }).error).toContain("موجودةٌ في 2 تطبيقات")
    expect((showScreen(root, "nope/none") as { error: string }).error).toContain("لا شاشةَ")
    expect((showScreen(root, "../x") as { error: string }).error).toBe(UI_BOOK_USAGE)
    const rendered = renderBookList(apps)
    expect(rendered).toContain("notepad (1):")
    expect(rendered).toContain("- shop-example-test-4475/dashboard-orders: «لوحة التحكّم — Dashboard» [normal] 2026-09-18 10:00")
    const text = renderScreen(shown as UiBookEntry)
    expect(text).toContain("notepad / untitled-notepad — «Untitled - Notepad» (سطح المكتب)")
    expect(text).toContain("الوضع: windowed، الإطار 1176×1530 @ (100,50)")
    expect(text).toContain("r1 [button] «حفظ»")
    expect(text).toContain("الكود المرتبط: src/app/dashboard/orders/page.tsx")
    expect(renderBookList([])).toContain("فارغ")
  })
  test(`السقفُ ${UI_BOOK_CAP} شاشةً لكلّ تطبيق: الأقدمُ تدويناً يُطرد أوّلاً، والمدوَّنةُ الآن لا تُطرد`, () => {
    for (let i = 0; i < UI_BOOK_CAP; i += 1) recordScreen(root, entry({ app: "notepad", slug: `s${i}`, capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }))
    const dir = join(root, UI_BOOK_DIR, "notepad")
    expect(readdirSync(dir)).toHaveLength(UI_BOOK_CAP)
    const r = recordScreen(root, entry({ app: "notepad", slug: "newest", capturedAt: "2026-09-18T10:00:00.000Z" }))
    expect(r.evicted).toEqual(["s0"])
    expect(readdirSync(dir)).toHaveLength(UI_BOOK_CAP)
    expect(existsSync(join(dir, "s0.json"))).toBe(false)
    expect(existsSync(join(dir, "newest.json"))).toBe(true)
    // شاشةٌ قديمةٌ تُحدَّث لا تُطرد لأنّها الأحدثُ الآن
    const r2 = recordScreen(root, entry({ app: "notepad", slug: "s1", capturedAt: "2026-09-19T10:00:00.000Z" }))
    expect(r2.evicted).toEqual([])
    expect(readdirSync(dir)).toHaveLength(UI_BOOK_CAP)
  })
  test("المُحلِّل", () => {
    expect(parseUiBookCommand("")).toEqual({ op: "list" })
    expect(parseUiBookCommand("list")).toEqual({ op: "list" })
    expect(parseUiBookCommand("show notepad/untitled-notepad")).toEqual({ op: "show", ref: "notepad/untitled-notepad" })
    expect((parseUiBookCommand("show") as { error: string }).error).toContain("ui-book show")
    expect((parseUiBookCommand("zap") as { error: string }).error).toBe(UI_BOOK_USAGE)
  })
})
