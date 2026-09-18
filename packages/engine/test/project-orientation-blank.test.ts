import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { orientationBrief, orientProject } from "../src/project-orientation"

// قيس (سجلّ المالك 2026-09-06): مجلّدٌ فارغٌ أُنشئ للتوّ عومل كمشروعٍ ناقص («لا Git، لا README، اقترح فروعاً») فتوقّف الوكيل
// وسأل المالك «ليش ما سويت الملفات». الفارغُ يُقال فارغاً، والموجزُ يقول: ابنِ إن كان الطلبُ واضحاً.

describe("مجلّدٌ فارغ في التوجيه", () => {
  test("blank=true والموجزُ لا يطلب فروعاً بل يطلب البناء إن وُصف", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-orient-blank-"))
    try {
      const o = orientProject(dir)
      expect(o.blank).toBe(true)
      const brief = orientationBrief(o)
      expect(brief).toContain("The folder is empty")
      expect(brief).toContain("write ABDO-SPRINTS.md and start sprint 1")
      expect(brief).not.toContain("propose 3-5 ranked development branches")
      // ملفٌّ مخفيّ لا يُلغي الفراغ (مثل .DS_Store أو .git الفارغ)
      mkdirSync(join(dir, ".git"))
      expect(orientProject(dir).blank).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("التوأمُ السلبيّ: ملفٌّ واحدٌ ظاهرٌ يجعل المجلّد مشروعاً يُوجَّه إليه بفروع", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-orient-nonblank-"))
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }))
      const o = orientProject(dir)
      expect(o.blank).toBe(false)
      expect(orientationBrief(o)).toContain("propose 3-5 ranked development branches")
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
