/** تصنيف طبقات الفشل وكاشف الجدران — فكرة ممتصة من Anton (mindsdb/anton،
 * root_cause.py + acc.py، أفكار لا fork، أعيدت كتابتها خلف عقودنا).
 *
 * الجوهر المقيس عندهم: قاطعٌ يُبنى على تكرار الفشل الخام «يبعد تصنيفاً
 * واحداً خاطئاً عن مقاطعة وكيلٍ يصلح عيبه بنجاح» — النموذج الذي يصلح
 * TypeError تلو أخرى **يعمل** لا يدور. لذلك تُصنَّف كل حادثة فشل إلى:
 * - self_inflicted: عيب من شيفرة النموذج نفسه (يُصلح بالتكرار — لا يُحتسب).
 * - transient: عابر شبكي/زمني (يُعاد — لا يُحتسب).
 * - external_wall: جدار بيئة لا يعالجه أي قدر من المحاولة (اعتماد غائب،
 *   أداة نظام غير منصّبة، رفض صلاحية) — **وحده** يعدّ نحو التوقف.
 * - unclassified: مجهول — لا يُحتسب (الحياد أأمن من قاطع كاذب).
 *
 * جدارٌ تكرر ببصمته المطبَّعة مرتين = STUCK: تسليمٌ صادق باسم الجدار بدل
 * حرق الحقب حتى السقف (حالة «done» الرباعية: كتالوج القبول).
 */

import { verdictIsBreakage, type ToolVerdict } from "@abdo/engine-host"

const WALL_PATTERNS: readonly RegExp[] = [
  /is not recognized as an internal or external command/iu,
  /command not found|no such file or directory.*(?:\/usr\/bin|\\system32)/iu,
  /credential unavailable|vault is not configured|api key (?:is )?(?:missing|not set|invalid)/iu,
  /\b(?:401 unauthorized|403 forbidden|invalid[_ ]api[_ ]key|quota exceeded|billing|payment required)\b/iu,
  /\bEACCES\b|permission denied/iu,
  /\bENOSPC\b|no space left on device/iu,
  /certificate (?:verify failed|has expired)|self[- ]signed certificate/iu,
  /\bENOTFOUND\b|getaddrinfo|could not resolve host/iu,
]

const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\bETIMEDOUT\b|\bECONNRESET\b|\bEAI_AGAIN\b|\bEPIPE\b/iu,
  /\b(?:429|503)\b.*(?:too many|unavailable)|too many requests|service unavailable/iu,
  /socket hang ?up|network is unreachable/iu,
]

const SELF_INFLICTED_PATTERNS: readonly RegExp[] = [
  /\b(?:SyntaxError|TypeError|ReferenceError|RangeError|NameError|AttributeError|IndentationError)\b/u,
  /\bTS\d{4,5}\b|\berror CS\d{4}\b|\berror C\d{4}\b/u,
  /cannot find module\s+["'`]\.{1,2}\//iu,
  /test(?:s)? failed|assertion(?:error| failed)|expected .+ (?:but )?(?:received|got|found)/iu,
  /build failed|compilation (?:error|failed)|failed to compile/iu,
  // أمرٌ بعلمٍ لا تعرفه الأداة الحيّة — عيبُ النموذج (يحفظ واجهةً قديمة) لا جدارُ بيئة (قيس 2026-09-06: prisma 8 وinit).
  /No flag registered for --|"code"\s*:\s*"CLI\.(?:INVALID_ARGUMENTS|UNKNOWN_COMMAND)"/iu,
]

export type FailureTier = "self_inflicted" | "transient" | "external_wall" | "unclassified"

/** الترتيب مقصود: جدار البيئة أولاً — «ENOENT على أداة نظام» أهم من كون
 * السطر يحمل أيضاً اسم استثناء؛ ثم العابر؛ ثم عيب الذات؛ ثم المجهول. */
export function classifyFailureTier(output: string): FailureTier {
  if (WALL_PATTERNS.some((p) => p.test(output))) return "external_wall"
  if (TRANSIENT_PATTERNS.some((p) => p.test(output))) return "transient"
  if (SELF_INFLICTED_PATTERNS.some((p) => p.test(output))) return "self_inflicted"
  return "unclassified"
}

/** بصمة مقارنة للخطأ (فكرة ACC): المسارات ← /P، الأعداد ← N، المقتبس ← 'X'
 * — فيتطابق «engine='a-1'» و«engine='a-2'» بصمةً. مقاطع المسار بحروف
 * يونيكود (\p{L}) لا \w — مشاريعنا العربية الأسماء تُطوى هي أيضاً.
 * الذيل هو الحُكم: آخر سطر في traceback هو الحامل للسبب — آخر 240 حرفاً. */
export function normalizeErrorSignature(output: string): string {
  const normalized = output
    .toLowerCase()
    .replace(/(?:[a-z]:)?[\\/](?:[\p{L}\p{N}_.-]+[\\/])+[\p{L}\p{N}_.-]+/gu, "/P")
    .replace(/(["'`])(?:(?!\1).)*\1/gu, "'X'")
    .replace(/\d+/gu, "N")
    .replace(/\s+/gu, " ")
    .trim()
  return normalized.slice(-240)
}

const EXIT_MARKER = /(?:انتهى الأمر برمز|exit(?:ed)?(?: with)?(?: code)?)\s*(\d+)\b/giu

/** رمز الخروج الحاكم هو **آخر** علامةٍ في الإيصال — نصُّ الخرج قد يقتبس
 * «exited with code 1» من سجلّ عمليةٍ فرعية، والعلامة الختامية التي
 * يذيّل بها منفّذنا الإيصال هي الحقيقة (صنف anton: substring يخطئ
 * في الاتجاهين). */
export function lastExitCode(output: string): number | undefined {
  let last: number | undefined
  for (const m of output.matchAll(EXIT_MARKER)) last = Number(m[1])
  return last
}

/** «صفرٌ في أيّ موضع» — الحرف نفسه الذي كان مكرَّراً حرفياً في بوابات
 * القبول والذاكرة (project-test/build-acceptance، turn-memory)؛ يبقى
 * احتياطَ النصّ حين لا يحمل الإيصال حكماً صريحاً من الأداة. */
export const ZERO_EXIT_ANYWHERE = /(?:انتهى الأمر برمز|exit(?:ed)?(?: with)?(?: code)?)\s*0\b/iu

/** الحكم الصريح يحكم إن وُجد؛ غيابه ليس نجاحاً — يعود إلى نصّ الإيصال. */
export const exitZero = (output: string, verdict?: ToolVerdict): boolean =>
  verdict !== undefined ? verdict.ok : ZERO_EXIT_ANYWHERE.test(output)

export function receiptSucceeded(output: string, verdict?: ToolVerdict): boolean {
  if (verdict !== undefined) return verdict.ok
  return lastExitCode(output) === 0
}

/** هل الإيصال فشلٌ؟ الحكم الصريح إن وُجد (رفض السياسة ليس عطباً — لا
 * يغذّي الجدران ولا المعدِّن)؛ وإلا آخر رمز خروج غير صفري؛ وبلا أي رمزٍ:
 * وسم خطأ أو مهلة/قتل (المهلة الصامتة فشلٌ لا نجاح — لا fail-open). */
export function receiptFailed(output: string, verdict?: ToolVerdict): boolean {
  if (verdict !== undefined) return verdictIsBreakage(verdict)
  const exit = lastExitCode(output)
  if (exit !== undefined) return exit !== 0
  return /\b(?:error|fatal|panic|exception|timed?[ -]?out|timeout|killed|SIGKILL|SIGTERM)\b|خطأ|فشل|مهلة|انتهت المهلة|قُتلت العملية/iu.test(output)
}

export interface WallVerdict {
  readonly signature: string
  readonly evidence: string
  readonly hits: number
}

/** حقيقة دائمة من جدارٍ مثبت (cerebellum-lite): الجدار حقيقة بيئةٍ لا
 * تخص المحاولة — «taskkill ليست في PATH» و«الاعتماد غائب» يجب ألا
 * تُعاد تكلفة اكتشافها في جلسةٍ تالية. تُخزَّن بمفتاح البصمة فتحلّ
 * الأحدث محل الأقدم، وتصل النموذج عبر استرجاع الحقبة الأولى. */
export function wallFact(verdict: WallVerdict): { readonly key: string; readonly value: string } {
  return Object.freeze({
    key: `wall:${verdict.signature.slice(-80)}`,
    value: `جدار بيئة مقيس (تكرر ${verdict.hits}×) — لا يعالجه التكرار، عالج سببه أولاً: ${verdict.evidence.slice(-160)}`,
  })
}

/** متتبّع جدرانٍ لدورٍ واحد: يستهلك إيصالات الأدوات، ويعيد حكماً عند
 * تكرار جدارٍ خارجيٍّ ببصمته مرتين. الفشل الذاتي والعابر والمجهول لا
 * يقترب من العدّاد مهما تكرر — النموذج المصلح لعيوبه لا يُقاطَع. */
export class WallTracker {
  readonly #hits = new Map<string, number>()

  observe(output: string, verdict?: ToolVerdict): WallVerdict | undefined {
    if (!receiptFailed(output, verdict)) return undefined
    if (classifyFailureTier(output) !== "external_wall") return undefined
    const signature = normalizeErrorSignature(output)
    const hits = (this.#hits.get(signature) ?? 0) + 1
    this.#hits.set(signature, hits)
    if (hits < 2) return undefined
    return Object.freeze({ signature, evidence: output.slice(-300), hits })
  }
}
