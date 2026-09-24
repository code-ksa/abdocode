import { describe, expect, test } from "bun:test"
import { projectPrecedence } from "../src/project-locator"

/**
 * 🔴 الخطرُ ليس في الترتيب بل في **الصمت**.
 *
 * قيس حيّاً: أُطلق المحرّكُ بمشروعٍ صريح في البيئة، فتجاهله وفتح المشروعَ المحفوظ في
 * الإعدادات — شجرةً أخرى تماماً. والدورُ مضى أربعين دقيقةً يستكشف المستودعَ الخطأ،
 * ولو حملت المهمّةُ أمرَ دفعٍ لأصابت فرعاً لا يخصّها.
 *
 * فالمسمارُ يحرس شيئين: أنّ الصريحَ يفوز، وأنّ الاختلافَ **يُقال**.
 */
describe("the project you started the engine with beats the one it remembers", () => {
  test("explicit wins over stored, and the difference is announced", () => {
    const r = projectPrecedence({ explicit: "C:\\work\\alpha", stored: "C:\\work\\beta" })
    expect(r.project).toBe("C:\\work\\alpha")
    expect(r.notice).toBeDefined()
    // الإشعارُ يسمّي الاثنين — رسالةٌ لا تقول المتروكَ لا تُغني عن الصمت.
    expect(r.notice).toContain("alpha")
    expect(r.notice).toContain("beta")
  })

  test("no notice when they agree, however they are spelled", () => {
    expect(projectPrecedence({ explicit: "C:\\work\\alpha", stored: "c:\\work\\alpha\\" }).notice).toBeUndefined()
    expect(projectPrecedence({ explicit: "C:\\work\\alpha", stored: "C:\\work\\alpha" }).project).toBe("C:\\work\\alpha")
  })

  test("either one alone is simply used, and neither is an empty choice", () => {
    expect(projectPrecedence({ stored: "C:\\work\\beta" })).toEqual({ project: "C:\\work\\beta" })
    expect(projectPrecedence({ explicit: "C:\\work\\alpha" })).toEqual({ project: "C:\\work\\alpha" })
    expect(projectPrecedence({})).toEqual({})
    // فراغٌ أو مسافاتٌ ليست اختياراً — وإلّا صار سطرٌ فارغٌ في الإعدادات مشروعاً.
    expect(projectPrecedence({ explicit: "   ", stored: "  " })).toEqual({})
    expect(projectPrecedence({ explicit: "  ", stored: "C:\\work\\beta" })).toEqual({ project: "C:\\work\\beta" })
  })
})
