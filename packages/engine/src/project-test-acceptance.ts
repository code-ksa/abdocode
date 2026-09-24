import type { ToolVerdict } from "@abdo/engine-host"
import { exitZero } from "./failure-tiering"

/**
 * A successful process with no tests is not a verified test suite.
 *
 * 🔴 **وعدّاءُ نود المدمج (`node --test`) لم يكن معروفاً هنا قطّ** (قِيس 2026-09-24).
 * الصيغُ المقبولة كانت تطلب **العددَ قبل الكلمة** («3 passed») أو بادئةَ TAP («# pass 3»)،
 * ونودُ يطبع الكلمةَ قبل العدد بغلافٍ معلوماتيّ: `ℹ pass 1` و`ℹ fail 0`. فكان خرجُه
 * «لا ناجحاً ولا فاشلاً» ⇦ يُعَدُّ **غيرَ ناجح**. والأثرُ لم يكن في سوبر عبده وحده:
 * بوّابةُ `gateTracks.tests` تنادي هذه الدالّةَ نفسَها — فكلُّ مشروعٍ يختبر بـ`node --test`
 * **لم يُعتمد له اختبارٌ ناجحٌ أبداً**، ويبقى دورُه «مرصوداً» ولو كانت سويتتُه خضراء.
 *
 * والنمطُ يقرأ الاتجاهين بحذر: `fail 0` ليس فشلاً، و`pass 0` ليس نجاحاً — وإلّا
 * صار الحارسُ يقلب الحكمَ في كلّ جولةٍ فارغة.
 */
export function projectTestPassed(output: string, verdict?: ToolVerdict): boolean {
  if (!exitZero(output, verdict)) return false
  // فشلٌ صريح: «N failed» أو «# fail N» أو صيغةُ نود «fail N» (N ≥ 1).
  if (/no tests? (?:found|collected)|\b[1-9]\d*\s+(?:failed|fail)\b|(?:#[ \t]*)?\bfail(?:ed)?[ \t]+[1-9]\d*\b/iu.test(output)) return false
  // نجاحٌ صريح: «N passed» أو «# pass N» أو صيغةُ نود «pass N» (N ≥ 1).
  return /(?:\b[1-9]\d*\s+(?:passed|pass)\b|(?:#[ \t]*)?\bpass(?:ed)?[ \t]+[1-9]\d*\b)/iu.test(output)
}

/** Project facts are schema-projected, not JSON cut off behind a long goal. */
export function recallExecutionFact(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value).slice(0, 500)
  const fact = value as Record<string, unknown>
  const receipts = Array.isArray(fact.receipts) ? fact.receipts.slice(-4).map((raw) => {
    const receipt = raw as { command?: unknown; output?: unknown }
    return { command: String(receipt.command ?? "").split("\n", 1)[0].slice(0, 180), output: String(receipt.output ?? "").slice(0, 900) }
  }) : undefined
  return JSON.stringify({ goal: String(fact.goal ?? "").slice(0, 700), status: fact.status,
    stopReason: fact.stopReason, receipts,
    ...(receipts === undefined ? { detail: JSON.stringify(value).slice(0, 700) } : {}),
  })
}
