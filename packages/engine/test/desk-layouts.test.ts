import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LAYOUTS_CAP, LAYOUTS_FILE, LAYOUT_USAGE, alreadyReceipt, findLayout, forgetLayout, layoutFromMeasure, layoutMatches, loadLayouts, parseLayoutCommand, processKey, renderLayoutList, restoreReceipt, saveLayouts, saveReceipt, upsertLayout, type SavedLayout } from "../src/desk-layouts"

// S8 (09-18) — ذاكرةُ اللاياوت: مفتاحُها العمليّةُ (+ عنوانٌ اختياريّ)، حفظُها صريحٌ وحده، وقراءتُها صارمةُ الشكل.

let dir = ""
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "desk-layouts-")) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const NOW = new Date("2026-09-18T10:00:00.000Z")
const chrome = (over: Partial<Parameters<typeof layoutFromMeasure>[0]> = {}) => layoutFromMeasure({ process: "chrome.exe", title: "Extensions - Google Chrome", rect: { left: 0, top: 0, right: 1176, bottom: 1530 }, monitor: "\\\\.\\DISPLAY1", now: NOW, ...over })

describe("S8 — المُحلِّل والمفتاح", () => {
  test("save بلا اسمٍ وباسم، list، forget — والمرفوضُ بسببٍ مسمّى", () => {
    expect(parseLayoutCommand("save")).toEqual({ op: "save" })
    expect(parseLayoutCommand("save chrome-ext")).toEqual({ op: "save", name: "chrome-ext" })
    expect(parseLayoutCommand('save "منصّةُ المواقع_1"')).toEqual({ op: "save", name: "منصّةُ المواقع_1" })
    expect(parseLayoutCommand("")).toEqual({ op: "list" })
    expect(parseLayoutCommand("list")).toEqual({ op: "list" })
    expect(parseLayoutCommand("forget chrome")).toEqual({ op: "forget", name: "chrome" })
    expect((parseLayoutCommand("forget") as { error: string }).error).toContain("desk layout forget <اسم>")
    expect((parseLayoutCommand("save a/b") as { error: string }).error).toContain("غيرُ صالح")
    expect((parseLayoutCommand("dance") as { error: string }).error).toBe(LAYOUT_USAGE)
  })
  test("مفتاحُ العمليّة: بلا مسارٍ ولا .exe وبأحرفٍ صغيرة", () => {
    expect(processKey("Chrome.EXE")).toBe("chrome")
    expect(processKey("C:\\Program Files\\Notepad++\\notepad++.exe")).toBe("notepad++")
    expect(processKey("code")).toBe("code")
  })
})

describe("S8 — الحفظُ والقراءةُ والبحث", () => {
  test("لاياوتٌ من قياسٍ حيّ: بلا اسمٍ يُفتح للبرنامج كلِّه، وباسمٍ يُقيَّد بالعنوان", () => {
    const wide = chrome()
    expect(wide).toEqual({ name: "chrome", process: "chrome", x: 0, y: 0, width: 1176, height: 1530, monitor: "\\\\.\\DISPLAY1", state: "normal", savedAt: NOW.toISOString() })
    const named = chrome({ name: "ext" })
    expect(named.name).toBe("ext")
    expect(named.titlePattern).toBe("Extensions - Google Chrome")
    expect(chrome({ rect: { left: -8, top: -8, right: 1928, bottom: 1088, maximized: true } }).state).toBe("maximized")
  })
  test("الملفُّ يُكتب ويُقرأ كما هو؛ الغائبُ فارغ؛ الفاسدُ فارغ؛ والسطرُ الناقصُ يُسقَط وحده", () => {
    const file = join(dir, LAYOUTS_FILE)
    expect(loadLayouts(file)).toEqual({ version: 1, layouts: [] })
    const store = upsertLayout(upsertLayout(loadLayouts(file), chrome()), chrome({ name: "ext", rect: { left: 10, top: 20, right: 830, bottom: 1550 } }))
    saveLayouts(file, store)
    expect(existsSync(file)).toBe(true)
    expect(loadLayouts(file)).toEqual(store)
    expect(readFileSync(file, "utf8")).toContain('"titlePattern": "Extensions - Google Chrome"')
    writeFileSync(file, "{ not json", "utf8")
    expect(loadLayouts(file)).toEqual({ version: 1, layouts: [] })
    writeFileSync(file, JSON.stringify({ version: 1, layouts: [{ name: "ok", process: "x", x: 1, y: 2, width: 3, height: 4 }, { name: "bad", process: "x", x: "1", y: 2, width: 3, height: 4 }, { name: "zero", process: "x", x: 1, y: 2, width: 0, height: 4 }, 7] }), "utf8")
    const loaded = loadLayouts(file)
    expect(loaded.layouts.map((l) => l.name)).toEqual(["ok"])
    expect(loaded.layouts[0]).toEqual({ name: "ok", process: "x", x: 1, y: 2, width: 3, height: 4, monitor: "", state: "normal", savedAt: "" })
  })
  test("upsert يستبدل بالاسم، forget يزيل ويسمّي، والسقفُ يُسقط الأقدمَ حفظاً", () => {
    let store = upsertLayout(loadLayouts(join(dir, "none.json")), chrome())
    store = upsertLayout(store, chrome({ rect: { left: 5, top: 5, right: 105, bottom: 105 } }))
    expect(store.layouts).toHaveLength(1)
    expect(store.layouts[0]!.width).toBe(100)
    const gone = forgetLayout(store, "chrome")
    expect(gone.removed?.name).toBe("chrome")
    expect(gone.store.layouts).toHaveLength(0)
    expect(forgetLayout(store, "nope").removed).toBeUndefined()
    let big = { version: 1 as const, layouts: [] as readonly SavedLayout[] }
    for (let i = 0; i < LAYOUTS_CAP + 3; i += 1) big = upsertLayout(big, chrome({ name: `l${i}`, now: new Date(NOW.getTime() + i * 1000) }))
    expect(big.layouts).toHaveLength(LAYOUTS_CAP)
    expect(big.layouts.some((l) => l.name === "l0")).toBe(false)
    expect(big.layouts.some((l) => l.name === `l${LAYOUTS_CAP + 2}`)).toBe(true)
  })
  test("البحث: العمليّةُ تطابق، والمقيَّدُ بالعنوان يُفضَّل على العامّ، وعنوانٌ لا يطابق يسقط إلى العامّ أو لا شيء", () => {
    const store = upsertLayout(upsertLayout(loadLayouts(join(dir, "none.json")), chrome()), chrome({ name: "ext", rect: { left: 10, top: 20, right: 830, bottom: 1550 } }))
    expect(findLayout(store, "chrome.exe", "extensions - google chrome")?.name).toBe("ext")
    expect(findLayout(store, "Chrome", "Shop Dashboard - Google Chrome")?.name).toBe("chrome")
    expect(findLayout(store, "notepad", "Untitled - Notepad")).toBeUndefined()
    expect(findLayout(store, "", "anything")).toBeUndefined()
    const onlyNamed = { version: 1 as const, layouts: [chrome({ name: "ext" })] }
    expect(findLayout(onlyNamed, "chrome", "Some other page")).toBeUndefined()
  })
  test("المطابقة: تسامحُ بكسلين، والمكبَّرةُ بالحالة لا بالمستطيل", () => {
    const l = chrome()
    expect(layoutMatches(l, { left: 0, top: 0, right: 1176, bottom: 1530 })).toBe(true)
    expect(layoutMatches(l, { left: 2, top: -2, right: 1178, bottom: 1528 })).toBe(true)
    expect(layoutMatches(l, { left: 3, top: 0, right: 1179, bottom: 1530 })).toBe(false)
    expect(layoutMatches(l, { left: 0, top: 0, right: 1176, bottom: 1530, maximized: true })).toBe(false)
    const max = chrome({ rect: { left: -8, top: -8, right: 1928, bottom: 1088, maximized: true } })
    expect(layoutMatches(max, { left: 0, top: 0, right: 10, bottom: 10, maximized: true })).toBe(true)
    expect(layoutMatches(max, { left: -8, top: -8, right: 1928, bottom: 1088 })).toBe(false)
  })
  test("تغييرُ المستخدم للنافذة لا يمسّ المحفوظ: لا كتابةَ إلا من save/forget", () => {
    const file = join(dir, LAYOUTS_FILE)
    saveLayouts(file, upsertLayout(loadLayouts(file), chrome()))
    const before = readFileSync(file, "utf8")
    // النافذةُ الآن في مكانٍ آخر — القراءةُ والبحثُ والمطابقةُ كلُّها لا تكتب
    const store = loadLayouts(file)
    const found = findLayout(store, "chrome", "Extensions - Google Chrome")!
    expect(layoutMatches(found, { left: 300, top: 300, right: 900, bottom: 900 })).toBe(false)
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(loadLayouts(file).layouts[0]).toEqual(found)
  })
})

describe("S8 — الإيصالات", () => {
  test("القائمةُ والحفظُ والاستعادةُ بالعربيّة وبالأرقام", () => {
    const l = chrome()
    expect(renderLayoutList({ version: 1, layouts: [] })).toContain("لا لاياوتاتٍ محفوظة")
    const list = renderLayoutList({ version: 1, layouts: [l, chrome({ name: "ext", rect: { left: -8, top: -8, right: 1928, bottom: 1088, maximized: true } })] })
    expect(list).toContain("2 لاياوت محفوظ")
    expect(list).toContain("- chrome: chrome — 1176×1530 @ (0,0) على \\\\.\\DISPLAY1 (حُفظ 2026-09-18 10:00)")
    expect(list).toContain("- ext: chrome «Extensions - Google Chrome» — مكبَّرة على \\\\.\\DISPLAY1")
    expect(saveReceipt(l, "Extensions - Google Chrome")).toBe("حفظتُ لاياوت «chrome» لنافذة «Extensions - Google Chrome» (chrome): 1176×1530 @ (0,0) على \\\\.\\DISPLAY1 — يُستعاد عند desk open/focus حتى «desk layout forget chrome».")
    expect(restoreReceipt(l, "Extensions - Google Chrome")).toBe("أُعيدت نافذةُ «Extensions - Google Chrome» إلى اللاياوت المحفوظ «chrome» 1176×1530 @ (0,0) على \\\\.\\DISPLAY1.")
    expect(alreadyReceipt({ ...l, monitor: "" })).toBe("(على لاياوتها المحفوظ «chrome» 1176×1530 @ (0,0))")
  })
})
