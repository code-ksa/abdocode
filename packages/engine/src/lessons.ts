/**
 * ذ3 — الخبرةُ تصير قدرة: فشلٌ ⇦ سببٌ مسمّى ⇦ درسٌ **مقيَّدٌ بالمشروع** ⇦ يُستدعى قبل الفعل نفسه.
 *
 * الدرسُ هنا **قياسٌ لا رأي**: أمرٌ حقيقيّ فشل بإيصالٍ حقيقيّ، بصمتُه مطبَّعة (المسارات
 * والأعداد والمقتبس تُطوى — `normalizeErrorSignature`) فتتطابق الحادثةُ نفسُها عبر أدوارٍ
 * وجلسات. لا حقلَ لروايةٍ يكتبها النموذج عن نفسه؛ ذلك أقلُّ ما ينتجه موثوقيةً.
 *
 * ما يصير درساً: الفشلُ الذاتيّ والمجهول. الجدارُ الخارجيّ له `WallTracker` والعابرُ ليس
 * من فعل النموذج — تسجيلُهما درساً يعلّم النموذجَ أن يتجنّب أمراً سليماً.
 *
 * القيدُ بالمشروع هو الميزة: الدرسُ حقيقةٌ بلا `sessionId` تحت `projectId` المشروع، فيراها
 * كلُّ دورٍ فيه ولا يراها مشروعٌ آخر — حارسُ التسرّب في `lessons.test.ts` و`lessons-live.test.ts`.
 *
 * القاعدةُ ذاتُ الأسنان من `@abdo/memory` (`chooseStrategy`): بصمةٌ فشلت `REPEAT_LIMIT` مرّاتٍ
 * بالأمر نفسه تجعل الأمرَ نفسَه محظوراً **بالاسم** في الإيصال — «محاولةٌ ثالثة ليست مثابرة،
 * هي المحاولةُ نفسُها». الوحدةُ نقيّة: التخزينُ والبثُّ عند المحرّك.
 */
import { createHash } from "node:crypto"
import { chooseStrategy, REPEAT_LIMIT, type FailureRecord, type StrategyDecision } from "@abdo/memory"
import { classifyFailureTier, normalizeErrorSignature, type FailureTier } from "./failure-tiering"

export const LESSON_PREFIX = "lesson:"
export type LessonTaskKind = "build" | "typecheck" | "test" | "audit" | "run"
const TASK_KINDS: ReadonlySet<string> = new Set<LessonTaskKind>(["build", "typecheck", "test", "audit", "run"])

export interface Lesson {
  readonly taskKind: LessonTaskKind
  /** البصمةُ المطبَّعة لذيل الإيصال — هويّةُ الفشل. */
  readonly signature: string
  /** الأمرُ كما نُفّذ — «الاستراتيجية» التي فشلت. */
  readonly command: string
  readonly hits: number
  readonly firstTurn: string
  readonly lastTurn: string
  /** ذيلُ الإيصال كما جاء — للإنسان، لا للمطابقة. */
  readonly sample: string
}

export interface LessonFailure {
  readonly taskKind: LessonTaskKind
  readonly signature: string
  readonly tier: FailureTier
  readonly command: string
}

/** الفشلُ الذي يستحقّ درساً: ذاتيٌّ أو مجهول، وببصمةٍ غيرِ فارغة. الجدارُ والعابرُ لا. */
export function lessonWorthy(tier: FailureTier): boolean {
  return tier === "self_inflicted" || tier === "unclassified"
}

export function failureOf(command: string, output: string, taskKind: LessonTaskKind): LessonFailure | undefined {
  const tier = classifyFailureTier(output)
  if (!lessonWorthy(tier)) return undefined
  const signature = normalizeErrorSignature(output)
  if (signature.length === 0) return undefined
  return Object.freeze({ taskKind, signature, tier, command })
}

/** مفتاحُ الحقيقة: النوعُ + هاشُ البصمة — ثابتٌ للحادثة نفسها، قصيرٌ للمفتاح. */
export function lessonKey(taskKind: LessonTaskKind, signature: string): string {
  return `${LESSON_PREFIX}${taskKind}:${createHash("sha256").update(signature).digest("hex").slice(0, 16)}`
}

export function recordLesson(previous: Lesson | undefined, failure: LessonFailure, turnId: string, output: string): Lesson {
  return Object.freeze({
    taskKind: failure.taskKind,
    signature: failure.signature,
    command: failure.command,
    hits: (previous?.hits ?? 0) + 1,
    firstTurn: previous?.firstTurn ?? turnId,
    lastTurn: turnId,
    sample: output.trim().slice(-200),
  })
}

const isLesson = (value: unknown): value is Lesson => {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.taskKind === "string" && TASK_KINDS.has(v.taskKind) && typeof v.signature === "string" && v.signature.length > 0
    && typeof v.command === "string" && typeof v.hits === "number" && Number.isInteger(v.hits) && v.hits > 0
    && typeof v.firstTurn === "string" && typeof v.lastTurn === "string" && typeof v.sample === "string"
}

/**
 * دروسُ المشروع من حقائقه: بادئةُ المفتاح، **بلا نطاق جلسة** (درسُ جلسةٍ ليس درسَ المشروع)،
 * وقيمةٌ بالشكل الصحيح — الحقيقةُ المشوَّهة تُسقَط لا تُصلَّح. الأحدثُ يفوز لكلّ مفتاح.
 */
export function lessonsOf(facts: ReadonlyArray<{ readonly key: string; readonly value: unknown; readonly sessionId?: string }>): readonly Lesson[] {
  const byKey = new Map<string, Lesson>()
  for (const fact of facts) {
    if (!fact.key.startsWith(LESSON_PREFIX) || fact.sessionId !== undefined || !isLesson(fact.value)) continue
    byKey.set(fact.key, fact.value)
  }
  return Object.freeze([...byKey.values()].sort((a, b) => b.hits - a.hits || a.command.localeCompare(b.command)))
}

/** حكمُ التكرار من القاعدة ذات الأسنان: الأمرُ نفسُه هو «الاستراتيجية» الوحيدة المتاحة. */
export function repeatVerdict(lesson: Lesson): StrategyDecision {
  const failures: FailureRecord[] = Array.from({ length: lesson.hits }, (_, i) => ({
    taskKind: lesson.taskKind, signature: lesson.signature, strategy: lesson.command, runId: `${lesson.lastTurn}:${i}`, at: i,
  }))
  return chooseStrategy(failures, { taskKind: lesson.taskKind, signature: lesson.signature, preferred: lesson.command, available: [lesson.command] })
}

export const confirmed = (lesson: Lesson): boolean => lesson.hits >= REPEAT_LIMIT

/** سطرُ الإيصال 📚 — للمشغّل، ويعود إلى النموذج حين يتأكّد الدرس. */
export function lessonEventLine(lesson: Lesson): string {
  const head = `📚 درسٌ مقيَّد بالمشروع (${lesson.taskKind}، ${lesson.hits}×): «${lesson.command}» — ${lesson.signature.slice(-100)}`
  if (!confirmed(lesson)) return head
  const verdict = repeatVerdict(lesson)
  return `${head}\n${verdict.kind === "proceed" ? "" : `الحكم: ${verdict.why}`}`.trimEnd()
}

/** الموجزُ الذي يُحقن قبل أوّل نداء: المؤكَّدُ أوّلاً، محدودُ العدد، وفارغٌ حين لا درس — بايتاً كما كان. */
export function lessonBrief(lessons: readonly Lesson[], max = 5): string {
  if (lessons.length === 0) return ""
  const ordered = [...lessons].sort((a, b) => b.hits - a.hits || a.command.localeCompare(b.command))
  const lines = ordered.slice(0, max).map((l) => {
    const rule = confirmed(l)
      ? `فشل ${l.hits}× بالبصمة نفسها — إعادتُه كما هو محاولةٌ رابعةٌ لا مثابرة: غيّر ما يسبقه (الشيفرة/الاعتماد/الإعداد) وأثبت التغيير قبل إعادته، أو اسأل.`
      : `فشل مرّةً — إن أعدته فأعده بعد تغييرٍ مسمّى.`
    return `  - «${l.command}» (${l.taskKind}) ${rule} آخرُ الإيصال: ${l.sample.slice(-120).replace(/\s+/gu, " ")}`
  })
  const dropped = lessons.length - lines.length
  return `دروسُ هذا المشروع — من إيصالاتٍ حقيقية لا من ذاكرة النموذج${dropped > 0 ? ` (أُظهر ${lines.length} من ${lessons.length})` : ""}:\n${lines.join("\n")}\n`
}
