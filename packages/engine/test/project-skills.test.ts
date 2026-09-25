import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isProjectSkillRef, projectSkillBody, projectSkills } from "../src/project-skills"

/**
 * 🔴 الحلقةُ التي كانت مفتوحة: `skill save` يقطّر منذ 09-16 إلى
 * `.abdo/skills/<اسم>/SKILL.md`، و`skill list` يقرأ حزمَ الامتدادات وحدها —
 * فما قطّره الوكيلُ أمسِ لا يراه اليوم. **مهارةٌ تُكتب ولا تُقرأ ملفٌّ ميّت.**
 */
const seed = () => {
  const root = mkdtempSync(join(tmpdir(), "abdo-project-skills-"))
  const make = (name: string, body: string) => {
    mkdirSync(join(root, ".abdo", "skills", name), { recursive: true })
    writeFileSync(join(root, ".abdo", "skills", name, "SKILL.md"), body, "utf8")
  }
  return { root, make }
}

describe("a distilled skill is findable again", () => {
  test("skills written by `skill save` are listed, named by their source, and described", () => {
    const { root, make } = seed()
    make("login-flow", "# login-flow\n\n> يفتح الصفحةَ ويسجّل الدخول ثمّ يلتقط لقطة.\n\n1. open {{url_1}}\n")
    make("order-check", "# order-check\n\nيفتح لوحةَ الطلبات ويتحقّق من الحالة.\n")
    const found = projectSkills(root)
    expect(found.map((s) => s.ref)).toEqual(["project/login-flow", "project/order-check"])
    // الوصفُ من سطر الاقتباس إن وُجد، وإلّا من أوّل سطرٍ ليس عنواناً.
    expect(found[0].description).toBe("يفتح الصفحةَ ويسجّل الدخول ثمّ يلتقط لقطة.")
    expect(found[1].description).toBe("يفتح لوحةَ الطلبات ويتحقّق من الحالة.")
    // والمصدرُ مسمّىً في المرجع: مهارةُ مشروعٍ لا تختلط بحزمةٍ مُوقَّعة.
    for (const s of found) expect(s.ref.startsWith("project/")).toBe(true)
  })

  test("the body is returned by reference, and a bad reference is refused by name", () => {
    const { root, make } = seed()
    make("login-flow", "# login-flow\n\nخطوة\n")
    expect(projectSkillBody(root, "project/login-flow")).toContain("# login-flow")
    // 🔴 لا يخرج من مجلّد المهارات: مرجعٌ فيه صعودٌ أو فاصلُ مسارٍ يُرفض قبل لمس القرص.
    for (const bad of ["project/../../secrets", "project/a/b", "project/.env", "pkg/skill", "project/", "../x"]) {
      expect(isProjectSkillRef(bad)).toBe(false)
      expect(() => projectSkillBody(root, bad)).toThrow()
    }
  })

  test("AN EMPTY PROJECT IS EMPTY, not an error (the negative twin)", () => {
    const { root } = seed()
    expect(projectSkills(root)).toEqual([])
    expect(projectSkills(join(root, "nope"))).toEqual([])
    // ومجلّدٌ بلا SKILL.md يُتخطّى ولا يُسقط السرد كلَّه.
    mkdirSync(join(root, ".abdo", "skills", "half-made"), { recursive: true })
    expect(projectSkills(root)).toEqual([])
  })
})
