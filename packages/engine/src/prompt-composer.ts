/**
 * مُركِّبُ رسالة النظام — طبقاتٌ مسمّاة بميزانيّة (S1 من برنامج 2026-09-17).
 *
 * ما كان قبله: سلسلةٌ واحدة `baseSystem` في `cli.ts` تُسبك بشرطيّات متداخلة
 * (وضعُ الدردشة / الأدوات الأصيلة / النصّيّة، مرحلةُ التخطيط، خطّةُ السبرنتات،
 * `rails.coaching`) + سطرُ لهجة الطرفيّة + تعليمةُ النيّة + مفرداتُ الأدوات +
 * سطرُ السياسة + `{{tool-catalogue}}`. كلُّ سطرٍ فيها مقيسٌ بدرسٍ مدفوع الثمن،
 * فالهجرةُ **بايتاً بايت أوّلاً**: `legacyBaseSystem` هي السلسلةُ القديمة حرفيّاً
 * بمدخلاتٍ صريحة، ومسمارُها الذهبيّ في `test/prompt-composer.test.ts` يثبت أنّ
 * الناتج يساوي ما كانت `cli.ts` تُنتجه. ثمّ `composeSystem` يعيد **ترتيبَ الأسطر
 * نفسِها** في طبقاتٍ مسمّاة بترتيبٍ ثابت (الرأسُ الثابت أوّلاً لكاش المزوّد) مع
 * ميزانيّةِ بايتٍ لكلّ طبقة وإيصالٍ يقول حجمَ كلٍّ منها — بلا كلمةٍ تُغيَّر إلا
 * ما يُسمّى تحسيناً بمسماره.
 *
 * الأسطرُ العربيّة القديمة كلُّها من `prompt-legacy-lines.ts` المولَّد من بايتات
 * الإيداع السابق — لا حرفَ منها منقولٌ باليد (النقلُ اليدويّ يعيد ترتيبَ التشكيل).
 *
 * الوحدة خالصةٌ من الأثر: لا بيئةَ ولا قرص — كلُّ ما يتغيّر يصل مدخلاً.
 */
import { intentInstruction } from "./intent-field"
import { nativeAgentLayers, nativeAgentSystem } from "./native-agent-tools"
import { LEGACY_LINES as L } from "./prompt-legacy-lines"
import { terminalDialectLine, toolVocabulary } from "./tool-vocabulary"

/** حالُ خطّة السبرنتات كما تقرؤها `cli.ts` من القرص — تصل هنا قيماً لا دوالّ. */
export interface SprintPlanState {
  /** `ABDO_REQUIRE_SPRINT_PLAN === "1"` */
  readonly required: boolean
  /** `sprintPlanReady(PROJECT_DIR, true)` — لا معنى له حين لا تكون الخطّةُ مطلوبة. */
  readonly ready: boolean
  /** `planApproved(PROJECT_DIR, true)` */
  readonly approved: boolean
}

/** طبقةُ البيئة — حتميّةٌ وقصيرة: ما يعرفه المحرّك يقيناً، لا ما يخمّنه النموذج. */
export interface EnvironmentInput {
  /** اسمُ النظام كما يُقال للنموذج (Windows / Linux / macOS). */
  readonly os: string
  /** الصدفةُ التي تشغّل `run` (Windows PowerShell 5.1 على ويندوز). */
  readonly shell: string
  /** اسمُ مجلّد المشروع المختار — لا مسارُه (المسارُ في طبقة المشروع). */
  readonly projectName?: string
  /** لغةُ الطلب من الإطار الدلاليّ (`ar`/`en`/`mixed`) حين تُقاس. */
  readonly language?: string
  /** لهجةُ الطلب من الإطار الدلاليّ حين تُقاس وتُعرف. */
  readonly dialect?: string
  /**
   * تاريخُ اليوم بصيغة ISO (`YYYY-MM-DD`) من ساعة المحرّك — مقيس 2026-09-18: النموذجُ كتب
   * تاريخاً خاطئاً (2026-02-23) في تقريرٍ لأنّ رسالةَ النظام لم تحمل اليوم. غيرُ الصالح لا يُذكر.
   */
  readonly today?: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u

/** تاريخُ الجهاز المحلّيّ (لا UTC — المستخدمُ يعمل بساعته) بصيغة `YYYY-MM-DD`. */
export const isoDate = (now: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export interface ComposeInput {
  /** `native` = استدعاءُ أدواتٍ منظّم (نموذجُنا المحلّيّ)؛ `text` = عقدُ «نفّذ:». */
  readonly mode: "text" | "native"
  readonly planningPhase: boolean
  /** `rails.coaching` — المواعظُ التدريبيّة تحته وحده (أمر 09-06). */
  readonly coaching: boolean
  /** `plugins.intentField` */
  readonly intentField: boolean
  /** أسماءُ الأدوات المُعلَنة فعلاً بعد قصّ السقف — منها تُشتقّ المفردات. */
  readonly advertised: readonly string[]
  /** سطرُ السياسة (`policyLine` + `browserBridgeHint`) مشتقٌّ في `cli.ts` من النمط النافذ. */
  readonly policy: string
  readonly sprintPlan: SprintPlanState
  /** غيابُها = لا طبقةَ بيئة (صفرُ بايت) — لا سطرٌ مخمَّن. */
  readonly environment?: EnvironmentInput
  /** سطرُ الإطار الدلاليّ (`describeFrame`) حين يُقاس. */
  readonly semanticFrame?: string
  /** دليلُ العمليّة: عمليّةُ تشغيلٍ مسمّاة وأداةُ `*_intent` التي تملك دليلَها. */
  readonly playbookHint?: string
  /** كتلةُ المهارة المختارة + إعلانُ المهارات + موجزُ الخطّة (كما يبنيها `cli.ts`). */
  readonly skill?: string
  /** تعليمةُ جذر المشروع + تعليماتُ المشروع (كما يبنيها `cli.ts`). */
  readonly project?: string
}

/**
 * السلسلةُ القديمة حرفيّاً (cli.ts ≈ 1796–1828 قبل S1) بالشرطيّات نفسها وترتيبها
 * نفسه. لا تُعدَّل كلمةٌ هنا: هذا هو المرجعُ الذي يُقاس عليه كلُّ تحسينٍ لاحق.
 */
export const legacyBaseSystem = (input: ComposeInput): string => {
  if (input.mode === "native") return nativeAgentSystem(input.planningPhase, input.sprintPlan.required, input.intentField, input.policy)
  const planningPhase = input.planningPhase
  const coaching = input.coaching
  const plan = input.sprintPlan
  return L.identityWho +
    L.identityNotClient +
    (coaching ? L.coachNoCompany + L.coachLocateProject + L.coachStaleContext : "") +
    (planningPhase ? L.planningOnly : L.rootIsFinal) +
    (plan.required && !plan.ready ? L.sprintPlanWrite : plan.required && !plan.approved ? L.sprintPlanUnapproved : plan.required ? L.sprintPlanApproved : "") +
    terminalDialectLine(input.advertised) +
    (planningPhase || !coaching ? "" : L.coachNextMinimal + L.coachNextLatest) +
    (coaching ? L.coachNoFabrication + L.coachComputeExpectation : "") +
    L.contractOneTool +
    // ذ٩و — حزمةُ القراءة: السطرُ أعلاه مثبّتٌ بايتاً في مسمارَين، فالقاعدةُ تُلحق سطراً مستقلّاً لا تُسبك فيه.
    L.contractReadBundle +
    (input.intentField ? intentInstruction() : "") +
    toolVocabulary(input.advertised, planningPhase) +
    L.readInChunks +
    (coaching ? L.coachKeepGoal : "") +
    (planningPhase ? L.donePlanning : L.doneExecution) +
    (coaching ? L.coachSuggestNext : "") + L.replyLanguage +
    input.policy +
    L.catalogue
}

// ───────────────────────────── الطبقات ─────────────────────────────

/**
 * الترتيبُ الثابت. الرأسُ (هويّة، بيئة، عقدُ الأدوات، سياسة) لا يتغيّر داخل الجلسة
 * إلا بتبديل النمط أو المرحلة، فكاشُ المزوّد يصيبه؛ والمتغيّرُ بالدور (الإطار،
 * الدليل، المهارة، المشروع) بعده. صيغةُ الخرج والتدريب في الذيل: أقربُ ما يكون
 * إلى الطلب هو آخرُ ما يقرؤه النموذج قبل أن يجيب.
 */
export const LAYER_ORDER = Object.freeze([
  "identity",
  "environment",
  "tool-contract",
  "policy",
  "semantic-frame",
  "playbook-hint",
  "skill",
  "project",
  "output-format",
  "coaching",
] as const)
export type LayerName = (typeof LAYER_ORDER)[number]

/**
 * ميزانيّةُ كلّ طبقة بالبايت (UTF-8: الحرفُ العربيّ بايتان). المقيسُ اليوم على
 * المثبّتات: هويّة ≈ 0.4k، عقدُ الأدوات ≈ 1.5k، سياسة ≤ 2.5k، صيغةُ الخرج ≤ 1.1k،
 * تدريب ≈ 2.4k — فالسقوفُ فوقها بهامش، لا لتقصّ ما قِيس بل لتصرخ حين يتضخّم
 * ما يأتي من القرص (تعليماتُ المشروع، أجسادُ المهارات).
 */
export const LAYER_BUDGETS: Readonly<Record<LayerName, number>> = Object.freeze({
  identity: 1_024,
  environment: 512,
  "tool-contract": 8_192,
  policy: 4_096,
  "semantic-frame": 512,
  "playbook-hint": 1_024,
  skill: 16_384,
  project: 16_384,
  "output-format": 2_048,
  coaching: 4_096,
})

export interface LayerReceipt {
  readonly name: LayerName
  /** البايتاتُ المبثوثة فعلاً (بعد القصّ إن وقع، وبسطر العلامة). */
  readonly bytes: number
  readonly budget: number
  readonly truncated: boolean
  /** نصُّ الطبقة كما دخل الرسالة — للاختبار واللوحة. */
  readonly text: string
}

export interface ComposedSystem {
  readonly text: string
  readonly layers: readonly LayerReceipt[]
}

const utf8 = (text: string): number => Buffer.byteLength(text, "utf8")

/** سطرُ العلامة حين تُقصّ طبقة — صريحٌ في الرسالة نفسها، لا قصٌّ صامت. */
export const truncationMarker = (name: LayerName, kept: number, total: number, budget: number): string =>
  `⚠ طبقة «${name}» قُصّت عند حدّ سطر: أُبقي ${kept} من ${total} بايت (الميزانيّة ${budget}).\n`

/**
 * القصُّ عند حدّ سطر: تُبقى الأسطرُ الكاملة التي تدخل الميزانيّة مع سطر العلامة،
 * ولا يُقطع سطرٌ من وسطه. سطرٌ أوّل أكبرُ من الميزانيّة = لا شيءَ سوى العلامة.
 */
const fit = (name: LayerName, body: string): LayerReceipt => {
  const budget = LAYER_BUDGETS[name]
  const total = utf8(body)
  if (total <= budget) return Object.freeze({ name, bytes: total, budget, truncated: false, text: body })
  const lines = body.split(/(?<=\n)/u)
  let kept = ""
  let keptBytes = 0
  const room = budget - utf8(truncationMarker(name, total, total, budget))
  for (const line of lines) {
    const next = keptBytes + utf8(line)
    if (next > room) break
    kept += line
    keptBytes = next
  }
  const text = kept + truncationMarker(name, keptBytes, total, budget)
  return Object.freeze({ name, bytes: utf8(text), budget, truncated: true, text })
}

const OS_LABEL = "البيئة:"

/** سطرُ البيئة — حتميٌّ: ما غاب لا يُذكر، ولا يُخمَّن. */
export const environmentLine = (env: EnvironmentInput | undefined): string => {
  if (env === undefined) return ""
  const parts = [`النظام ${env.os}`, `الصدفة ${env.shell}`]
  if (env.projectName !== undefined && env.projectName.length > 0) parts.push(`المشروع «${env.projectName}»`)
  if (env.language !== undefined && env.language !== "unknown") parts.push(`لغة الطلب ${env.language}`)
  if (env.dialect !== undefined && env.dialect !== "unknown") parts.push(`اللهجة ${env.dialect}`)
  if (env.today !== undefined && ISO_DATE.test(env.today)) parts.push(`تاريخ اليوم ${env.today}`)
  return `${OS_LABEL} ${parts.join("؛ ")}.\n`
}

/** أسطرٌ منفصلة بـ"\n" تُسبك طبقةً منتهيةً بسطرٍ جديد؛ الفارغُ يبقى فارغاً. */
const joined = (lines: readonly string[]): string => {
  const kept = lines.filter((line) => line.length > 0)
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`
}

type Bodies = Readonly<Record<LayerName, string>>

const textBodies = (input: ComposeInput): Bodies => {
  const planningPhase = input.planningPhase
  const coaching = input.coaching
  const plan = input.sprintPlan
  return {
    identity: L.identityWho + L.identityNotClient,
    environment: environmentLine(input.environment),
    "tool-contract": terminalDialectLine(input.advertised) + toolVocabulary(input.advertised, planningPhase) + L.readInChunks + L.catalogue + "\n",
    policy: (planningPhase ? L.planningOnly : L.rootIsFinal) +
      (plan.required && !plan.ready ? L.sprintPlanWrite : plan.required && !plan.approved ? L.sprintPlanUnapproved : plan.required ? L.sprintPlanApproved : "") +
      input.policy,
    "semantic-frame": input.semanticFrame === undefined || input.semanticFrame.length === 0 ? "" : `الإطارُ الدلاليّ للطلب (حتميّ): ${input.semanticFrame}\n`,
    "playbook-hint": input.playbookHint === undefined || input.playbookHint.length === 0 ? "" : `${input.playbookHint}\n`,
    skill: input.skill ?? "",
    project: input.project ?? "",
    // (ب) عقدُ «نفّذ:» — أداةٌ واحدة لكلّ ردّ — في موضعٍ واحد مع صيغة النيّة وقاعدةِ «تمّ» وسطرِ اللغة.
    "output-format": L.contractOneTool + L.contractReadBundle + (input.intentField ? intentInstruction() : "") +
      (planningPhase ? L.donePlanning : L.doneExecution) + L.replyLanguage,
    // (ج) كلُّ سطرِ تدريبٍ تحت rails.coaching وحده — ولا سطرَ تدريبٍ خارج هذه الطبقة.
    coaching: coaching
      ? L.coachNoCompany + L.coachLocateProject + L.coachStaleContext +
        (planningPhase ? "" : L.coachNextMinimal + L.coachNextLatest) +
        L.coachNoFabrication + L.coachComputeExpectation + L.coachKeepGoal + `${L.coachSuggestNext.trimEnd()}\n`
      : "",
  }
}

const nativeBodies = (input: ComposeInput): Bodies => {
  const N = nativeAgentLayers(input.planningPhase, input.sprintPlan.required, input.intentField, input.policy)
  return {
    identity: joined(N.identity),
    environment: environmentLine(input.environment),
    "tool-contract": joined(N.toolContract),
    policy: joined(N.policy),
    "semantic-frame": input.semanticFrame === undefined || input.semanticFrame.length === 0 ? "" : `الإطارُ الدلاليّ للطلب (حتميّ): ${input.semanticFrame}\n`,
    "playbook-hint": input.playbookHint === undefined || input.playbookHint.length === 0 ? "" : `${input.playbookHint}\n`,
    skill: input.skill ?? "",
    project: input.project ?? "",
    "output-format": joined(N.outputFormat),
    // المسارُ الأصيل لا يعرف القضبان (كما كان): سطرُه التدريبيّ الوحيد يبقى بلا شرط.
    coaching: joined(N.coaching),
  }
}

/** التركيب: الطبقاتُ بترتيبها الثابت، كلٌّ في ميزانيّتها، والإيصالُ معها. */
export const composeSystem = (input: ComposeInput): ComposedSystem => {
  const bodies = input.mode === "native" ? nativeBodies(input) : textBodies(input)
  const layers = LAYER_ORDER.map((name) => fit(name, bodies[name]))
  return Object.freeze({ text: layers.map((layer) => layer.text).join(""), layers: Object.freeze(layers) })
}

/** 412b / 1.2k / 12k — ما يُقرأ في سطرٍ واحد. */
export const humanBytes = (bytes: number): string => {
  if (bytes < 1_000) return `${bytes}b`
  const k = bytes / 1_000
  return `${k >= 10 ? Math.round(k).toString() : k.toFixed(1).replace(/\.0$/u, "")}k`
}

/**
 * سطرُ الإيصال 🧾 (بلا الرمز؛ `cli.ts` يضعه): الطبقاتُ غيرُ الفارغة بأحجامها، وعلامةُ
 * قصٍّ إن وقع، وحجمُ الكتالوج الذي يحلّ محلّ `{{tool-catalogue}}` بعد التركيب إن
 * قِيس — والمجموعُ يحسبه. طبقةٌ صفرُ بايت لا تُذكر: الغيابُ معلَنٌ بالحذف لا بالصفر.
 */
export const systemReceiptLine = (layers: readonly LayerReceipt[], catalogueBytes?: number): string => {
  const parts = layers.filter((layer) => layer.bytes > 0).map((layer) => `${layer.name} ${humanBytes(layer.bytes)}${layer.truncated ? " ⚠قُصّت" : ""}`)
  let total = layers.reduce((sum, layer) => sum + layer.bytes, 0)
  if (catalogueBytes !== undefined && catalogueBytes > 0) { parts.push(`كتالوج ${humanBytes(catalogueBytes)}`); total += catalogueBytes }
  return `نظام: ${parts.join(" · ")} = ${humanBytes(total)}`
}
