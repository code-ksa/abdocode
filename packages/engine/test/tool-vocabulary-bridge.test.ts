import { describe, expect, test } from "bun:test"
import { browserBridgeHint } from "../src/tool-vocabulary"
import { classifyFailureTier } from "../src/failure-tiering"

// قيس (سجلّ المالك 2026-09-06): «اتصل بإضافتك على كروم» ⇦ «لا أملك أداةً». السطرُ يقول للنموذج ما يطلبه من المستخدم،
// ولا يعلن أداةً غيرَ معلَنة؛ ويصمت حين تكون الأدوات معلَنةً فعلاً.

describe("browserBridgeHint", () => {
  const chrome = [{ id: "chrome", command: ["C:/app/abdocode.exe", "mcp-chrome-bridge"] }]
  test("محفوظةٌ غير موصولة ⇦ سطرٌ يسمّي المعرّف والطريق", () => {
    const hint = browserBridgeHint(chrome, ["read", "open"])
    expect(hint).toContain("«chrome»")
    expect(hint).toContain("chrome.page/open/look/tap/fill/key/scroll/shot")
    expect(hint).toContain("الإعدادات ← الاتصالات")
    expect(hint).toContain("ولا تقل إنّ الإضافة غير موجودة")
  })
  test("معرّفٌ مختلف (chrome-2) يُسمّى بمعرّفه؛ والمعلَنُ فعلاً يُسكِت السطر", () => {
    const saved = [{ id: "chrome-2", command: ["x", "mcp-chrome-bridge", "C:/state"] }]
    expect(browserBridgeHint(saved, [])).toContain("chrome-2.page")
    expect(browserBridgeHint(saved, ["chrome-2.page", "chrome-2.tap"])).toBe("")
    expect(browserBridgeHint(chrome, ["chrome.page"])).toBe("")
  })
  test("لا شيءَ محفوظ ⇦ سطرُ «كيف تُضاف» لا الصمت (كي لا يقول النموذج إنّها غير موجودة)", () => {
    const hint = browserBridgeHint([{ id: "db", command: ["x", "mcp-sqlite", "a.db"] }], [])
    expect(hint).toContain("«إضافة المتصفّح»")
    expect(hint).toContain("ولا تقل إنّ الإضافة غير موجودة")
  })
})

describe("علمٌ غير مسجَّل عيبُ النموذج لا جدارٌ", () => {
  test("stricli وغلافُ JSON لبريزما يُصنَّفان self_inflicted", () => {
    expect(classifyFailureTier("No flag registered for --datasource-provider")).toBe("self_inflicted")
    expect(classifyFailureTier('{"kind":"result","envelope":{"ok":false,"error":{"code":"CLI.INVALID_ARGUMENTS"}}}')).toBe("self_inflicted")
    // التوأم: جدارُ البيئة يبقى جداراً
    expect(classifyFailureTier("'prisma' is not recognized as an internal or external command")).toBe("external_wall")
  })
})
