import { describe, expect, test } from "bun:test"
import { dismissReceipt, flattenTree, normalizeLabel, overlayPresent, parseRenderedTree, pickDismissTarget } from "../src/overlay-dismiss"
import { renderTree } from "../src/mind/surface"

// مقيس 09-14: نافذةُ Google «Looking for results in English?» فوق نتائج البحث — الإغلاقُ الأسلم إبقاءُ اللغة الحاليّة.
const googleLanguagePrompt = [
  { ref: "r1", role: "combobox", name: "بحث" },
  { ref: "r2", role: "button", name: "بحث Google" },
  { ref: "r3", role: "dialog", name: "Looking for results in English?", children: [
    { ref: "r4", role: "link", name: "Change to English" },
    { ref: "r5", role: "link", name: "الاستمرار باللغة العربية" },
    { ref: "r6", role: "link", name: "إعدادات اللغة" },
    { ref: "r7", role: "button", name: "×" },
  ] },
  { ref: "r8", role: "link", name: "The Background Blender Python Script (render.py)" },
]

describe("overlay dismiss — pure", () => {
  test("normalizeLabel folds diacritics, tatweel, hamza forms and case", () => {
    expect(normalizeLabel("لا شُكـراً")).toBe("لا شكرا")
    expect(normalizeLabel("  Accept   ALL  ")).toBe("accept all")
    expect(normalizeLabel("إغلاق")).toBe("اغلاق")
    expect(normalizeLabel("الاستمرار باللغة العربية")).toBe("الاستمرار باللغه العربيه")
  })

  test("Google language prompt: keeps the current language instead of switching or closing blindly", () => {
    const flat = flattenTree(googleLanguagePrompt)
    expect(flat.find((n) => n.ref === "r5")?.inDialog).toBe(true)
    expect(flat.find((n) => n.ref === "r8")?.inDialog).toBe(false)
    const choice = pickDismissTarget(flat)
    expect(choice?.ref).toBe("r5")
    expect(choice?.group).toBe("keep-language")
    expect(overlayPresent(flat)).toBe(true)
    expect(dismissReceipt(choice!)).toContain("الاستمرار باللغة العربية")
  })

  test("cookie banner without a dialog role: reject beats accept; accept is never chosen outside a dialog", () => {
    const banner = flattenTree([
      { ref: "r1", role: "region", name: "Cookie consent", children: [
        { ref: "r2", role: "button", name: "Accept all" },
        { ref: "r3", role: "button", name: "Reject all" },
      ] },
      { ref: "r4", role: "button", name: "Sign in" },
    ])
    expect(pickDismissTarget(banner)?.ref).toBe("r3")
    const acceptOnly = flattenTree([{ ref: "r1", role: "button", name: "Accept all" }, { ref: "r2", role: "button", name: "Search" }])
    expect(pickDismissTarget(acceptOnly)).toBeUndefined()
    expect(overlayPresent(acceptOnly)).toBe(false)
    // داخلَ حوارٍ صريح، «قبول الكلّ» آخرُ الخيارات لكنّه مقبول حين لا بديل.
    const acceptInDialog = flattenTree([{ ref: "r1", role: "dialog", name: "Privacy", children: [{ ref: "r2", role: "button", name: "قبول الكل" }] }])
    expect(pickDismissTarget(acceptInDialog)?.group).toBe("accept")
  })

  test("no overlay: a plain page with a search box and links yields nothing (negative twin)", () => {
    const plain = flattenTree([{ ref: "r1", role: "combobox", name: "Search" }, { ref: "r2", role: "link", name: "Results 1" }, { ref: "r3", role: "button", name: "Search" }])
    expect(pickDismissTarget(plain)).toBeUndefined()
    expect(overlayPresent(plain)).toBe(false)
  })

  test("close-word outside a dialog is refused when a dialog exists, and fields are never candidates", () => {
    const tree = flattenTree([
      { ref: "r1", role: "button", name: "Close" },
      { ref: "r2", role: "dialog", name: "Tips", children: [{ ref: "r3", role: "textbox", name: "Got it" }, { ref: "r4", role: "button", name: "Got it" }] },
    ])
    expect(pickDismissTarget(tree)?.ref).toBe("r4")
  })

  test("parseRenderedTree reads the text the page tool renders (owned and extension backends) with dialog depth", () => {
    const text = `جيل 3 — 8 عنصراً:\n${renderTree(googleLanguagePrompt as never)}`
    const flat = parseRenderedTree(text)
    expect(flat).toHaveLength(8)
    expect(flat.find((n) => n.ref === "r5")).toEqual({ ref: "r5", role: "link", name: "الاستمرار باللغة العربية", inDialog: true })
    expect(flat.find((n) => n.ref === "r8")?.inDialog).toBe(false)
    expect(pickDismissTarget(flat)?.ref).toBe("r5")
    expect(parseRenderedTree("صفحةٌ بلا عناصر قابلة للقيادة")).toEqual([])
  })
})
