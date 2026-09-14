/**
 * مواضع الأثر من إيصالٍ محكوم — أساسُ صفّ «المسلَّمات» (IDEA 9).
 *
 * لوحةُ النشاط اليوم تسجّل المخرج من **نيّة** الأداة: إطار `tool` يصل قبل أن
 * يُنفَّذ شيء، فأداةٌ رُفضت أو فشلت تظهر «مخرجاً». هذه الوحدة تقلب الاتجاه:
 * لا موضع إلا من **حكمٍ صريحٍ يقول ok**. غيابُ الحكم رفضٌ لا إذن — إيصالٌ بلا
 * حكم (أو `plugins.toolVerdict` مطفأ) يعطي `[]`، لا استنتاجاً من النصّ.
 *
 * ومفرداتُ «أين» واحدةٌ لا اثنتان: هدفُ الكتابة وتعبيرُ الخادم المُدار
 * يُستوردان من `turn-memory` نفسه — تعبيرٌ ثانٍ مكتوبٌ بيدٍ هنا كان سيفترق
 * عنه أوّلَ مرّةٍ يتغيّر نصّ الخادم (اختبارُ الهويّة يمنع ذلك).
 */

import type { ToolVerdict } from "@abdo/engine-host"
import { SERVED_URL_RE, writeTargetOf } from "./turn-memory"

/** بادئةُ «لم أكتب: المحتوى نفسه» كما يكتبها `cli.ts` حرفاً بحرف. */
export const SKIPPED_WRITE_PREFIX = "⏭ "

export type ToolLocation =
  | { readonly kind: "file"; readonly path: string; readonly op: "write" | "edit" | "skipped" }
  | { readonly kind: "server"; readonly url: string }

const WRITE_VERB = /^(write|edit)\s/iu

/**
 * خالصةٌ وتامّة: تُقرأ على الناتج **الكامل** قبل قصّه إلى ٥٠٠ محرف في الإطار
 * (سطر الخادم قد يقع بعد القصّ)، ولا ترمي أبداً.
 */
export function locationsFromReceipt(
  command: string,
  output: string,
  verdict?: ToolVerdict,
): ToolLocation[] {
  // الغياب رفضٌ لا إذن: بلا حكمٍ صريحٍ ok لا مُسلَّم — ولا استنتاج من النصّ.
  if (verdict === undefined || verdict.ok !== true) return []
  const locations: ToolLocation[] = []
  const verb = WRITE_VERB.exec(command)?.[1]?.toLowerCase()
  if (verb === "write" || verb === "edit") {
    const path = writeTargetOf(command)
    if (path.length > 0) {
      const op = output.startsWith(SKIPPED_WRITE_PREFIX) ? "skipped" : verb
      locations.push({ kind: "file", path, op })
    }
  }
  const served = SERVED_URL_RE.exec(output)
  if (served !== null && typeof served[1] === "string") locations.push({ kind: "server", url: served[1] })
  return locations
}
