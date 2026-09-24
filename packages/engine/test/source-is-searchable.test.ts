/**
 * مسمارٌ صغيرٌ ثمنُه مدفوع: **مصدرُنا يجب أن يبقى نصّاً**.
 *
 * كان في `cli.ts` بايتا NUL داخل تعليق (كُتب `\x00` في مثالٍ عن UTF-16LE فصار
 * بايتاتٍ خامّة — الفخُّ المسجَّل عندنا: أداةُ الكتابة تحوّل الهروب إلى بايتات).
 * وأثرُه لم يكن في المترجم بل في **البحث**: ripgrep يعدّ الملفَّ ثنائيّاً، فكلُّ
 * `grep` بلا `-a` يفوّت مطابقاتٍ **صامتاً** في أكبر ملفّاتنا وأكثرِها قراءةً.
 * صنفٌ كاملٌ من الأخطاء الصامتة، ثمنُه سطرُ اختبار.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "src")

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sources(full)
    return name.endsWith(".ts") ? [full] : []
  })

describe("المصدرُ نصٌّ لا ثنائيّ", () => {
  test("لا بايتَ NUL في أيّ ملفّ مصدر — البحثُ الصامتُ الناقص أخطرُ من خطأ ترجمة", () => {
    const files = sources(SRC)
    expect(files.length).toBeGreaterThan(100)   // التوأمُ الإيجابيّ: المسحُ وجد ملفّاتٍ فعلاً
    const dirty = files.filter((f) => readFileSync(f).includes(0x00))
    expect(dirty.map((f) => f.slice(SRC.length + 1))).toEqual([])
  })
})
