import { describe, expect, test } from "bun:test"
import { BLANKET_ALLOW, windowAllowedByTask } from "../src/desktop-name-gate"

// أ2 — الإدخالُ في نافذةٍ لم يسمِّها المستخدم ولم يفتحها الوكيل ولم تظهر نتيجةَ فعله يُرفض باسمه. التوأمان: المسمّاةُ تمرّ (عنوان/اسمٌ عربيّ/pid/ثقة/إذنٌ عامّ)،
// وغيرُ المسمّاة تسقط — مقيس 09-14: النموذجُ ركّز «Claude» حين سُرقت المقدّمة إليها.

const trusted = new Set<number>()
const gate = (title: string, taskText: string, extra: Partial<{ pid: number; hwnd: number; trustedHwnds: ReadonlySet<number> }> = {}) =>
  windowAllowedByTask({ title, pid: extra.pid ?? 100, hwnd: extra.hwnd ?? 7, taskText, trustedHwnds: extra.trustedHwnds ?? trusted })

describe("بوّابةُ الاسم لإدخال سطح المكتب", () => {
  test("النافذةُ التي لم تُسمَّ تُرفض باسمها وبالتعليمة", () => {
    const v = gate("Claude", "افتح المفكرة واكتب فيها سطراً")
    expect(v.ok).toBe(false)
    expect(!v.ok && v.why).toContain("«Claude»")
    expect(!v.ok && v.why).toContain("desk open")
    expect(gate("Dashboard ‹ تكنولجيا سعودية — Google Chrome", "افتح المفكرة").ok).toBe(false) // «Google Chrome» عامّ، وباقي العنوان لم يُسمَّ
  })
  test("المسمّاةُ بعنوانها أو باسمها العربيّ أو بpid تمرّ", () => {
    expect(gate("Untitled - Notepad", "افتح notepad واكتب").why).toBe("named")
    expect(gate("notepad - Notepad", "افتح المفكرة واكتب فيها").why).toBe("alias")
    expect(gate("Untitled - Paint", "ارسم في الرسّام").why).toBe("alias")
    expect(gate("Extensions - Google Chrome", "في كروم افتح صفحة الإضافات").why).toBe("alias")
    expect(gate("AbdoDeskProbe", "اكتب في نافذة AbdoDeskProbe").why).toBe("named")
    expect(gate("Claude", "ركّز النافذة pid:4242 واكتب", { pid: 4242 }).why).toBe("pid")
    expect(gate("Dashboard ‹ تكنولجيا سعودية — Google Chrome", "افتح تبويب تكنولجيا سعودية").why).toBe("named") // العربيّةُ مطبَّعة
  })
  test("الثقةُ بالمقبض (فتحها الوكيل أو ظهرت نتيجةَ فعله) والإذنُ العامّ", () => {
    expect(gate("Claude", "افتح المفكرة", { hwnd: 9, trustedHwnds: new Set([9]) }).why).toBe("trusted")
    expect(gate("Claude", "اكتب في أيّ نافذة تجدها").why).toBe("blanket")
    expect(BLANKET_ALLOW.test("use any window")).toBe(true)
    expect(BLANKET_ALLOW.test("افتح المفكرة")).toBe(false)
  })
  test("الكلماتُ العامّة وحدها لا تُثبت التسمية", () => {
    expect(gate("New Tab - Google Chrome", "افتح متصفّح جوجل وابحث").ok).toBe(false) // «جوجل» بلا «كروم»: لا alias ولا عنوان
    expect(gate("New Tab - Google Chrome", "افتح كروم وابحث").why).toBe("alias")
  })
})
