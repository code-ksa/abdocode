/**
 * 10-01 — صياغةُ CSS قبل الكتابة الذرّية، كحارس tsx. مقيس حيّاً: كتب النموذجُ globals.css وفيه «.search-shortcut:» بلا «{» فأجاب الخادمُ
 * 500 على كلّ صفحة، ولم يُكتشف إلا بعد إقلاع خادمٍ وaudit كامل. محلّلُ CSS في Bun يرفضه في ~25ms.
 *
 * مقيس قبل الحارس على 460 ملفَّ CSS حقيقيّاً (مصادرُ Tailwind 4 وNext وكلُّ مشاريع الجهاز): قُبل 456، ورُفضت 4 كلُّها توابعُ قديمة أو
 * أمثلةُ اختبارٍ تالفةٌ عمداً داخل node_modules. التوجيهاتُ غيرُ المعروفة (@theme، @utility، @apply…) تحذيرٌ عنده لا خطأ — تمرّ.
 *
 * تحليلٌ فقط: لا استيرادَ يُحلّ (external كلُّه) ولا شيءَ يُنفَّذ؛ نسخةٌ في مجلّدٍ مؤقّتٍ فريد تُحذف دائماً.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProjectIdentityWrite } from "./project-identity-guard"

/** أوّلُ خطأ صياغةٍ في CSS بسطره وعموده، أو undefined حين يُقبل. ملفّاتُ CSS وحدها (لا scss/less — لهما صياغتُهما). */
export async function cssSourceViolation(input: Pick<ProjectIdentityWrite, "normalizedTarget" | "after">): Promise<string | undefined> {
  if (!/\.css$/iu.test(input.normalizedTarget)) return undefined
  const dir = mkdtempSync(join(tmpdir(), "abdo-css-"))
  try {
    const file = join(dir, "check.css")
    writeFileSync(file, input.after)
    const result = await Bun.build({ entrypoints: [file], throw: false, external: ["*"] })
    const error = result.logs.find((log) => log.level === "error")
    if (error === undefined) return undefined
    const at = error.position === null || error.position === undefined ? "" : ` (سطر ${error.position.line}، عمود ${error.position.column}${error.position.lineText ? `: «${error.position.lineText.trim().slice(0, 80)}»` : ""})`
    return `صياغة CSS غير صالحة: ${String(error.message).slice(0, 200)}${at}`
  } catch (cause) {
    // المحلّلُ نفسُه تعذّر — لا نحجب الكتابةَ بعطلٍ فينا (الصياغةُ تُقاس بالبناء بعدها).
    void cause
    return undefined
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* مؤقّتٌ يُنظَّف لاحقاً */ }
  }
}
