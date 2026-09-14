/** معدِّن الكتيّبات — فكرة ممتصة من Anton ‏ACC (أفكار لا fork): كواشف
 * حتمية فوق مجرى الإيصالات، صفر تكلفة نموذج. سجل كتيّباتنا (error-playbooks)
 * مؤلَّف يدوياً من الحوادث؛ هذا يرصد **الفشل المتكرر الذي لا يعرفه السجل**
 * ويرشّحه كتيّباً جديداً — ترشيحاً لا حفظاً: المؤلَّف آلياً يُعرَض على
 * المشرف بدليله ولا يدخل السجل بنفسه (درس anton: «staged, NOT saved»).
 *
 * الكشف بالبصمة المطبَّعة (المسارات/الأرقام/المقتبس تُطوى) فتتطابق
 * الحادثة نفسها عبر ملفات ومحاولات مختلفة — العتبة 3 تكرارات في الدور.
 */

import type { ToolVerdict } from "@abdo/engine-host"
import { errorPlaybookHints } from "./error-playbooks"
import { normalizeErrorSignature, receiptFailed } from "./failure-tiering"

export interface PlaybookCandidate {
  readonly signature: string
  readonly hits: number
  readonly sample: string
}

const CANDIDATE_THRESHOLD = 3

export class PlaybookMiner {
  readonly #hits = new Map<string, { hits: number; sample: string; reported: boolean }>()

  /** يستهلك إيصالاً؛ يعيد مرشّحاً واحداً عند بلوغ فشلٍ مجهول العتبة —
   * مرةً واحدة لكل بصمة في الدور. المعروف للسجل لا يُرشَّح (له كتيّب). */
  observe(output: string, verdict?: ToolVerdict): PlaybookCandidate | undefined {
    if (!receiptFailed(output, verdict)) return undefined
    if (errorPlaybookHints(output).length > 0) return undefined
    const signature = normalizeErrorSignature(output)
    const entry = this.#hits.get(signature) ?? { hits: 0, sample: output.slice(-400), reported: false }
    entry.hits += 1
    this.#hits.set(signature, entry)
    if (entry.hits < CANDIDATE_THRESHOLD || entry.reported) return undefined
    entry.reported = true
    return Object.freeze({ signature, hits: entry.hits, sample: entry.sample })
  }
}
