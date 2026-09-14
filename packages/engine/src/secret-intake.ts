/**
 * S14 — اعتمادٌ يصل في نصّ المحادثة: يُكشف قبل أن يُخزَّن، ويُعلَن محروقاً،
 * ويُفتح للمستخدم طريقٌ آليّ إلى الخزنة بدل العمل اليدويّ.
 *
 * أمر المالك 2026-09-02 بنصّه: «يجب عند اخبار المستخدم له الحساب كذا و
 * الباسورد كذا دخلهم في كذا يطلع تحذير تدوير الاسرار و يفتحلة ملف نوت باد
 * لادخال الاسرار في خزنة الاسرار بحيث لا نجعل المستخدم يضطر للعمل اليدوي».
 *
 * أربع قواعد تحكم هذه الوحدة:
 * 1. **الترتيب هو الميزة**: التصنيف والحجب يقعان **قبل** القبول في الدفتر،
 *    وقبل حقيقة الدور، وقبل المحادثة، وقبل أيّ نداء نموذج. حارسٌ يقع بعد
 *    التخزين ليس حارساً.
 * 2. **القيمة لا تُنسخ أبداً** — لا في رفض، ولا في تحذير، ولا في حدث. ما
 *    يُروى هو **الشكل** (كلمة مرور / مفتاح واجهة / رمز حامل / سلسلة اتصال).
 *    والسرّ الذي وصل في محادثة **محروق**: لا يُخزَّن أصلاً، بل يُدار.
 * 3. **مفردةٌ واحدة**: كلُّ ما يُكشف ويُحجب يأتي من `secret-command-guard`
 *    (`redactInboundBody` / `inboundSecretSpans`) — لا عائلةَ تعبيراتٍ ثانية.
 * 4. **الوحدة خالصة إلا منفذاً واحداً مسمّى**: كلُّ ما فوق `assistedIntake`
 *    خالصٌ يُختبر بلا قرصٍ ولا عمليّة؛ و`assistedIntake` وحدها تلمس القرص
 *    والمحرّر — والخزنةُ تُحقن إليها دالّةً، فلا تعرف هذه الوحدة الخزنة.
 */

import {
  REDACTED,
  SECRET_SHAPE_LABEL,
  handoverIntent,
  inboundSecretSpans,
  redactInboundBody,
  type SecretShape,
  type SecretSpan,
} from "./secret-command-guard"

export type { SecretShape, SecretSpan }
export { SECRET_SHAPE_LABEL }

/**
 * مقبضُ الخزنة — النمط نفسه الذي يقبله السكربت المشحون ويقرؤه عاملُ Rust:
 * حروفٌ صغيرة وأرقامٌ وشرطة، يبدأ بحرفٍ أو رقم، ‏121 محرفاً سقفاً. أيّ خروجٍ
 * عنه (مسار، نقطتان، شرطة مائلة، حرفٌ كبير) يُرفض بالاسم — لا تطبيعَ صامت،
 * لأن التطبيع يجعل مقبضين مختلفين يكتبان الملفّ نفسه.
 */
export const VAULT_HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,120}$/u

/** رفضٌ مسمّى — لا رفضَ مجهولٌ ولا رفضٌ يحمل قيمة. */
export const INTAKE_REFUSALS = Object.freeze({
  HANDLE_SHAPE: "رُفض المقبض: يقبل حروفاً صغيرة وأرقاماً وشرطة فقط، يبدأ بحرفٍ أو رقم، وطولُه ≤121 — لا مسار ولا نقطتان ولا حرفٌ كبير.",
  TEMPLATE_UNTOUCHED: "رُفض الإدخال: القالب أُغلق كما هو ولم تُكتب قيمة — لم يُخزَّن شيء ولم يبقَ ملفّ.",
  TEMPLATE_EMPTY: "رُفض الإدخال: الملفّ فارغ بعد نزع أسطر الشرح — لم يُخزَّن شيء ولم يبقَ ملفّ.",
  TEMPLATE_AMBIGUOUS: "رُفض الإدخال: أكثر من سطر قيمةٍ واحد في الملفّ — القيمة سطرٌ واحد، ولا تخمين أيُّها المقصود.",
  TEMPLATE_TOO_LONG: "رُفض الإدخال: القيمة تتجاوز 16384 بايتاً — سقفُ قارئ الخزنة نفسه.",
  TEMPLATE_UNREADABLE: "رُفض الإدخال: تعذّرت قراءة ملفّ القالب بعد إغلاق المحرّر — لا تخزين، والملفّ حُذف.",
  EDITOR_UNAVAILABLE: "رُفض الإدخال المُعان: تعذّر تشغيل محرّر النصوص. عيّن ABDO_INTAKE_EDITOR بمسار محرّرٍ تنفيذيّ، أو مرّر القيمة بالأنبوب: «abdocode secret set <مقبض>».",
  EDITOR_TIMEOUT: "رُفض الإدخال المُعان: مضت المهلة والمحرّر لم يُغلق — أُنهي المحرّر، وزُفّر القالب وحُذف، ولم يُخزَّن شيء.",
  TEMPLATE_WRITE_FAILED: "رُفض الإدخال المُعان: تعذّرت كتابة ملفّ القالب تحت ملفّ المستخدم — لا تخزين ولا ملفّ متروك.",
  STDIN_EMPTY: "رُفض الإدخال: لا قيمة على المدخل القياسيّ — القيمة تُمرَّر بالأنبوب لا في سطر الأمر (سطرُ الأمر تقرؤه كلُّ عمليّةٍ على الجهاز).",
  EDITOR_HEADLESS: "رُفض الإدخال المُعان: لا سطحَ مكتبٍ في هذه الجلسة (خدمة/مهمّة مجدولة/جلسة بلا واجهة)، ومحرّرٌ يُفتح فيها لا يُغلق أبداً فيعلّق الدور حتى المهلة. لا ملفّ كُتب ولا محرّر شُغّل — أدخل السرّ بنفسك: «abdocode secret set <مقبض>» والقيمة بالأنبوب.",
} as const)

export type IntakeRefusal = (typeof INTAKE_REFUSALS)[keyof typeof INTAKE_REFUSALS]

/** سقفُ القيمة — سقفُ `read_secret` في عامل Rust نفسه، لا رقمٌ ثانٍ. */
export const VAULT_VALUE_MAX_BYTES = 16_384

/** سطرُ الشرح في القالب — يُنزع عند القراءة فلا يصير قيمةً بالخطأ. */
export const INTAKE_COMMENT = "#"
/** القيمةُ الافتراضية في القالب: بقاؤها كما هي = «لم يُكتب شيء». */
export const INTAKE_PLACEHOLDER = "ضع-القيمة-هنا-ثم-احفظ-وأغلق"

// ---------------------------------------------------------------------------
// التصنيف — الفحص الذي يسبق كلّ تخزين
// ---------------------------------------------------------------------------

export interface InboundSecretScan {
  /** حَمَل الدورُ اعتماداً (قيمةً أو نيّةَ تسليم) — الفحص الذي يمنع التخزين. */
  readonly carriesSecret: boolean
  /** الأشكالُ التي رُئيت، مرتّبةً ومنزوعةَ التكرار. أسماءٌ لا قيم. */
  readonly kinds: readonly SecretShape[]
  /** «خذ هذا الاعتماد واستعمله» — نيّةٌ معلنة بالعربية أو الإنجليزية. */
  readonly handoverIntent: boolean
  /** الجسدُ كما يُخزَّن ويُرى: القيمُ مستبدَلةٌ بعلامة الحجب. */
  readonly redacted: string
  readonly redactions: number
  /** المواضع في النصّ الأصليّ — شكلٌ ومدى، بلا أيّ نصٍّ منقول. */
  readonly spans: readonly SecretSpan[]
  /** مقبضُ مزوّدٍ معروف إن دلّ الشكل عليه — يُستعمل في خطوة التدوير. */
  readonly providerHandle?: string
}

/** بادئاتٌ تدلّ على المزوّد بذاتها — تُقرأ من النصّ الأصليّ ولا تُنسخ منه. */
const PROVIDER_BY_PREFIX: readonly { readonly re: RegExp; readonly handle: string }[] = Object.freeze([
  Object.freeze({ re: /(?<![A-Za-z0-9_-])sk-ant-/u, handle: "abdocode-anthropic" }),
  Object.freeze({ re: /(?<![A-Za-z0-9_-])(?:ghp|gho|ghs|ghu)_/u, handle: "github-token" }),
  Object.freeze({ re: /(?<![A-Za-z0-9_-])xox[baprs]-/u, handle: "slack-token" }),
  Object.freeze({ re: /(?<![A-Za-z0-9_-])AKIA/u, handle: "aws-access-key" }),
  Object.freeze({ re: /(?<![A-Za-z0-9_-])AIza/u, handle: "abdocode-google" }),
  Object.freeze({ re: /(?<![A-Za-z0-9_-])gsk_/u, handle: "abdocode-groq" }),
  Object.freeze({ re: /(?<![A-Za-z0-9_-])sk-(?!ant-)/u, handle: "abdocode-openai" }),
])

/**
 * يصنّف الجسدَ الواردَ **قبل** أيّ كتابة. خالصةٌ وتامّة: لا ترمي، ولا تحتفظ
 * بالقيمة، ولا تعيدها في أيّ حقل. النصّ الأصليّ يبقى في متغيّرٍ محليٍّ عند
 * المستدعي ويُسقَط فور بناء هذه النتيجة.
 */
export function classifyInboundSecret(body: unknown): InboundSecretScan {
  if (typeof body !== "string" || body.length === 0) {
    return Object.freeze({ carriesSecret: false, kinds: Object.freeze([]), handoverIntent: false, redacted: typeof body === "string" ? body : "", redactions: 0, spans: Object.freeze([]) })
  }
  const spans = inboundSecretSpans(body)
  const intent = handoverIntent(body)
  const redaction = redactInboundBody(body)
  const kinds = Object.freeze([...new Set(spans.map((s) => s.kind))].sort())
  const provider = PROVIDER_BY_PREFIX.find((entry) => entry.re.test(body))
  // «حَمَل اعتماداً» = **موضعٌ مقيس**، لا نيّةٌ معلنة. النيّةُ وحدها كانت تكفي،
  // فسؤالٌ بريء («كيف أسجل الدخول؟») يفتح محرّراً على سطح المكتب ويكتب في
  // الخزنة: أثرٌ على جهاز المستخدم بلا سرٍّ في الأفق. النيّةُ تبقى موسِّعةً
  // للمطابقة داخل `inboundSecretSpans` — لا مُنشئةً لدعوى.
  const carriesSecret = spans.length > 0
  // ⛔ الأرضيّة البنيويّة: **لا دورٌ يُعلَن حاملاً ثم يُقبل جسدُه حرفياً**. كان
  // التحذير يقول «حُجب … ولم يُخزَّن» بينما القرص يحمل القيمة — دعوى أمنٍ
  // كاذبة أسوأ من الصمت. الحجبُ الآن مبنيٌّ من المواضع فيستحيل الافتراق،
  // وهذا السطرُ حزامٌ فوق ذلك: إن تساوى الجسدان رغم موضعٍ مرصود، يُستبدل
  // الجسدُ كلُّه بالعلامة — فشلٌ مُغلق لا قبولٌ صامت.
  const safeBody = carriesSecret && redaction.redactions === 0 ? REDACTED : redaction.text
  const redactions = safeBody === redaction.text ? redaction.redactions : 1
  return Object.freeze({
    carriesSecret,
    kinds,
    handoverIntent: intent,
    redacted: safeBody,
    redactions,
    spans: Object.freeze(spans),
    ...(provider === undefined ? {} : { providerHandle: provider.handle }),
  })
}

// ---------------------------------------------------------------------------
// تحذير التدوير — سطرٌ للمشرف، وجملةٌ واحدة يراها النموذج
// ---------------------------------------------------------------------------

/** خطوةُ التدوير الملموسة لمقبضٍ معروف — معرفةٌ جديدة، لا نسخةٌ من الكتالوج. */
const ROTATION_STEP: Readonly<Record<string, string>> = Object.freeze({
  "abdocode-anthropic": "احذف المفتاح من console.anthropic.com ← Settings ← API keys وأنشئ غيره.",
  "abdocode-openai": "احذف المفتاح من platform.openai.com/api-keys وأنشئ غيره.",
  "abdocode-google": "احذف المفتاح من aistudio.google.com/apikey وأنشئ غيره.",
  "abdocode-xai": "احذف المفتاح من console.x.ai ← API keys وأنشئ غيره.",
  "abdocode-mistral": "احذف المفتاح من console.mistral.ai/api-keys وأنشئ غيره.",
  "abdocode-groq": "احذف المفتاح من console.groq.com/keys وأنشئ غيره.",
  "abdocode-together": "احذف المفتاح من api.together.xyz/settings/api-keys وأنشئ غيره.",
  "github-token": "ألغِ الرمز من github.com/settings/tokens وأصدر غيره بأضيق صلاحية.",
  "slack-token": "أبطِل الرمز من api.slack.com/apps ← OAuth & Permissions وأعد التثبيت.",
  "aws-access-key": "عطّل المفتاح ثم احذفه من IAM ← Security credentials وأنشئ غيره.",
})

export interface RotationWarning {
  /** سطرُ حدثٍ للمشرف — يُكتب في الدفتر ويظهر في القشرة. */
  readonly operator: string
  /** جملةٌ واحدة قصيرة يراها النموذج — لا قيمة فيها ولا مقبضَ سرٍّ سرّيّ. */
  readonly model: string
  /** خطوةُ التدوير الملموسة إن عُرف المزوّد. */
  readonly step?: string
}

const shapeList = (kinds: readonly SecretShape[]): string =>
  kinds.length === 0 ? "اعتماد بلا شكلٍ مسمّى" : kinds.map((kind) => SECRET_SHAPE_LABEL[kind]).join(" و")

/**
 * التحذير — يسمّي **الشكل** فقط. القيمة لا تُذكر ولا يُذكر طولها ولا أوّل
 * محارفها: الرفضُ الذي يشرح الرفضَ هو أشيعُ موضعٍ يتسرّب منه السرّ.
 */
export function rotationWarning(kinds: readonly SecretShape[], handle?: string): RotationWarning {
  const shapes = shapeList(kinds)
  const step = handle === undefined ? undefined : ROTATION_STEP[handle]
  const operator =
    `🔐 تحذير تدوير الأسرار: وصل ${shapes} في نصّ المحادثة. ما يظهر في محادثة يُعدّ محروقاً — ` +
    `حُجب قبل أن يُكتب في الدفتر أو الذاكرة أو يُرسل إلى نموذج، ولم يُخزَّن.` +
    (step === undefined ? " دوّره الآن من لوحة مزوّده." : ` دوّره الآن: ${step}`)
  const model =
    `تنبيه أمني من المحرّك: حمل هذا الدور ${shapes} فحُجب ولم يُخزَّن؛ اعتبره محروقاً واطلب من المستخدم تدويره، ` +
    `وأشِر إلى السرّ بمقبض الخزنة لا بقيمته.`
  return Object.freeze({ operator, model, ...(step === undefined ? {} : { step }) })
}

// ---------------------------------------------------------------------------
// القالب — ما يفتحه المحرّر، وما يُقرأ منه
// ---------------------------------------------------------------------------

/** نصُّ الملفّ الذي يُفتح للمستخدم. سطورُ الشرح تبدأ بـ`#` وتُنزع عند القراءة. */
export function intakeTemplate(handle: string, kinds: readonly SecretShape[]): string {
  return [
    `${INTAKE_COMMENT} عبدو كود — إدخال سرٍّ إلى الخزنة`,
    `${INTAKE_COMMENT} المقبض: ${handle}`,
    `${INTAKE_COMMENT} الشكل المرصود: ${shapeList(kinds)}`,
    `${INTAKE_COMMENT}`,
    `${INTAKE_COMMENT} 1) السرّ الذي كتبتَه في المحادثة محروق — دوّره أولاً عند مزوّده.`,
    `${INTAKE_COMMENT} 2) الصق القيمة **الجديدة** مكان السطر الأخير، ثم احفظ وأغلق هذه النافذة.`,
    `${INTAKE_COMMENT} 3) تُكتب القيمة في خزنةٍ محميّة باسمك على هذا الجهاز، ثم يُزفّر هذا الملفّ ويُحذف.`,
    `${INTAKE_COMMENT} 4) لا تكتب مسافةً في أوّل السطر أو آخره، ولا سطراً ثانياً.`,
    `${INTAKE_COMMENT}`,
    INTAKE_PLACEHOLDER,
    "",
  ].join("\r\n")
}

export interface IntakeParse {
  readonly value?: string
  readonly refusal?: IntakeRefusal
}

/**
 * يقرأ ما كتبه المستخدم. فشلٌ مُغلق في كل فرع: القالبُ كما هو، أو الفراغ، أو
 * أكثرُ من سطرٍ، أو الطول — كلُّها رفضٌ مسمّى بلا قيمة جزئية.
 */
export function parseIntakeFile(text: unknown): IntakeParse {
  if (typeof text !== "string") return { refusal: INTAKE_REFUSALS.TEMPLATE_UNREADABLE }
  const lines = text.split(/\r\n|\n|\r/u).filter((line) => !line.trimStart().startsWith(INTAKE_COMMENT))
  const values = lines.map((line) => line.trim()).filter((line) => line.length > 0)
  if (values.some((line) => line === INTAKE_PLACEHOLDER)) return { refusal: INTAKE_REFUSALS.TEMPLATE_UNTOUCHED }
  if (values.length === 0) return { refusal: INTAKE_REFUSALS.TEMPLATE_EMPTY }
  if (values.length > 1) return { refusal: INTAKE_REFUSALS.TEMPLATE_AMBIGUOUS }
  const value = values[0]!
  if (new TextEncoder().encode(value).length > VAULT_VALUE_MAX_BYTES) return { refusal: INTAKE_REFUSALS.TEMPLATE_TOO_LONG }
  return { value }
}

// ---------------------------------------------------------------------------
// المقبض — يُشتقّ ولا يُخترع
// ---------------------------------------------------------------------------

/** يتحقّق من المقبض بالنمط الواحد. `undefined` = صالح. */
export const vaultHandleRefusal = (handle: unknown): IntakeRefusal | undefined =>
  typeof handle === "string" && VAULT_HANDLE_RE.test(handle) ? undefined : INTAKE_REFUSALS.HANDLE_SHAPE

/** لكل شكلٍ مقبضٌ افتراضيّ مقروء — لا معرّفاتٌ عشوائية لا يذكرها أحد. */
const HANDLE_BY_SHAPE: Readonly<Record<SecretShape, string>> = Object.freeze({
  "api-key": "chat-api-key",
  password: "chat-password",
  "bearer-token": "chat-bearer-token",
  "connection-string": "chat-connection-string",
  "encoded-credential": "chat-credential",
  "account-handle": "chat-account",
})

/**
 * المقبضُ المقترح لدورٍ حمل اعتماداً: مقبضُ المزوّد إن عُرف، وإلا مقبضُ
 * الشكل. النتيجة تطابق `VAULT_HANDLE_RE` دوماً بالبناء.
 */
export function suggestedHandle(scan: Pick<InboundSecretScan, "kinds" | "providerHandle">): string {
  if (scan.providerHandle !== undefined && VAULT_HANDLE_RE.test(scan.providerHandle)) return scan.providerHandle
  const first = scan.kinds.find((kind) => kind !== "account-handle") ?? scan.kinds[0]
  return first === undefined ? "chat-credential" : HANDLE_BY_SHAPE[first]
}

// ---------------------------------------------------------------------------
// المنفذ الوحيد إلى القرص والمحرّر — «لا نجعل المستخدم يضطر للعمل اليدوي»
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync, closeSync, fsyncSync } from "node:fs"
import { stripChildEnv } from "@abdo/tools/env-strip"
import { join } from "node:path"

/** مهلةُ انتظار المحرّر — محدودةٌ بالبناء، ولا انتظارَ مفتوح. */
export const INTAKE_TIMEOUT_MS_DEFAULT = 180_000
export const INTAKE_TIMEOUT_MS_MIN = 5_000
export const INTAKE_TIMEOUT_MS_MAX = 15 * 60_000

/** قيمةٌ من البيئة أو الافتراض — قيمةٌ مشوَّهة تعيد الافتراض لا انتظاراً بلا حدّ. */
export function intakeTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/u.test(raw.trim())) return INTAKE_TIMEOUT_MS_DEFAULT
  const parsed = Number.parseInt(raw.trim(), 10)
  return parsed >= INTAKE_TIMEOUT_MS_MIN && parsed <= INTAKE_TIMEOUT_MS_MAX ? parsed : INTAKE_TIMEOUT_MS_DEFAULT
}

/**
 * سطرُ أمرِ المحرّر — **تنفيذيٌّ ووسائطُه**، لا نصُّ صدفةٍ أبداً. لا
 * `cmd /c start`: تلك تمرّ بمفسّرٍ يُعيد تفسير المسار (فراغات، `&`)، وتعود
 * فوراً فلا يبقى شيءٌ يُنتظر خروجه. `ABDO_INTAKE_EDITOR` يعيّن التنفيذيّ،
 * و`ABDO_INTAKE_EDITOR_ARG` وسيطاً ثابتاً واحداً قبل المسار (مثل `-w`).
 */
export function editorArgv(env: Readonly<Record<string, string | undefined>>, platform: string): string[] {
  const explicit = env.ABDO_INTAKE_EDITOR
  if (explicit !== undefined && explicit.trim().length > 0) {
    const extra = env.ABDO_INTAKE_EDITOR_ARG
    return extra !== undefined && extra.trim().length > 0 ? [explicit.trim(), extra.trim()] : [explicit.trim()]
  }
  if (platform === "win32") return ["notepad.exe"]
  if (platform === "darwin") return ["open", "-W", "-t"]
  return ["nano"]
}

/**
 * هل تنقص هذه الجلسةَ واجهةٌ رسوميّة؟ فتحُ محرّرٍ في خدمةِ ويندوز أو جلسةٍ
 * بلا شاشة يعلّق الدورَ حتى المهلة (‏180 ثانية) ثم يرفض — والمستخدم لا يرى إلا
 * صمتاً. القياسُ بإشاراتٍ صريحة وحدها كي لا تُعطَّل الحالةُ السويّة: المحرّكُ
 * يعمل على أنابيب دوماً فـ`isTTY` ليس دليلاً على غياب سطح المكتب.
 * ومحرّرٌ عيّنه المشغّل بنفسه (`ABDO_INTAKE_EDITOR`) قرارُه هو، فلا يُنقض.
 */
export function intakeDesktopAbsent(env: Readonly<Record<string, string | undefined>>, platform: string): boolean {
  if (env.ABDO_INTAKE_HEADLESS === "1") return true
  const explicit = env.ABDO_INTAKE_EDITOR
  if (explicit !== undefined && explicit.trim().length > 0) return false
  if (platform === "win32") return env.SESSIONNAME === "Services" || (env.USERPROFILE ?? "").trim().length === 0
  if (platform === "darwin") return false
  // لينكس وغيره: المحرّرُ الافتراضيّ طرفيّ ومدخلُه القياسيّ مُهمَل، فبلا خادم
  // عرضٍ لا سبيل إلى إغلاقه — غيابُ الإشارتين رفضٌ لا إذن.
  return (env.DISPLAY ?? "").trim().length === 0 && (env.WAYLAND_DISPLAY ?? "").trim().length === 0
}

export interface AssistedIntakeInput {
  readonly handle: string
  readonly kinds: readonly SecretShape[]
  /** مجلّدٌ محميٌّ للمستخدم وحده — يُهيّئه `vaultGuard` قبل النداء. */
  readonly directory: string
  readonly editor: readonly string[]
  readonly timeoutMs: number
  /** كتابةُ الخزنة — تُحقن، فلا تعرف هذه الوحدة الخزنة ولا تستوردها. */
  readonly store: (handle: string, value: string) => Promise<{ ok: true } | { refusal: string }>
}

export interface AssistedIntakeResult {
  readonly ok: boolean
  readonly handle: string
  readonly refusal?: string
  /** هل بقي ملفُّ القالب على القرص؟ يجب أن يكون `false` في كلّ فرع. */
  readonly templateRemains: boolean
}

/** يزفّر الملفّ ثم يحذفه — في كلّ فرعٍ بلا استثناء، نجاحاً كان أو فشلاً. */
const shredFile = (path: string): void => {
  try {
    if (!existsSync(path)) return
    const size = readFileSync(path).length
    if (size > 0) {
      const handle = openSync(path, "r+")
      try {
        writeSync(handle, new Uint8Array(size), 0, size, 0)
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
    }
  } catch {
    /* الزفر مساعِد؛ الحذف أدناه هو الحاسم */
  }
  try { rmSync(path, { force: true }) } catch { /* يُبلَّغ عنه بـtemplateRemains */ }
}

/**
 * الطريق الآليّ: يُكتب قالبٌ تحت ملفّ المستخدم، ويُفتح بمحرّر النظام
 * كتنفيذيٍّ مباشر، ويُنتظر خروجُه بمهلة، ثم تُقرأ القيمة وتُكتب في الخزنة،
 * ثم **يُزفَّر الملفّ ويُحذف في كلّ فرع** — نجاحاً وفشلاً ومهلةً.
 */
export async function assistedIntake(input: AssistedIntakeInput): Promise<AssistedIntakeResult> {
  const handleRefusal = vaultHandleRefusal(input.handle)
  if (handleRefusal !== undefined) return { ok: false, handle: String(input.handle), refusal: handleRefusal, templateRemains: false }
  // لاحقةٌ فريدة لكل إدخال: كان المسارُ مشتقّاً من المقبض وحده، فإدخالان
  // متزامنان على المقبض نفسه يتقاسمان ملفّاً واحداً — يفوز أحدهما ويُخبَر
  // الآخرُ أن «قراءة القالب تعذّرت»، وهو نسبُ تصادمٍ إلى عطلِ ملفّ.
  const path = join(input.directory, `${input.handle}.${Math.random().toString(36).slice(2, 10)}.intake.txt`)
  const done = (refusal?: string): AssistedIntakeResult => {
    shredFile(path)
    return { ok: refusal === undefined, handle: input.handle, ...(refusal === undefined ? {} : { refusal }), templateRemains: existsSync(path) }
  }
  try {
    mkdirSync(input.directory, { recursive: true })
    writeFileSync(path, intakeTemplate(input.handle, input.kinds), { encoding: "utf8", mode: 0o600 })
  } catch {
    return done(INTAKE_REFUSALS.TEMPLATE_WRITE_FAILED)
  }
  let child: { exited: Promise<number>; kill: (code?: number) => void }
  try {
    // محرّرٌ يُفتح **ليستقبل سرّاً** لا ليقرأ الخزنة: تسليمُه مقابضَ الخزنة
    // ومفتاحَ القشرة نقيضُ الغرض. (مقيس 2026-09-04.)
    child = Bun.spawn([...input.editor, path], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore",
      env: stripChildEnv(process.env).env,
    })
  } catch {
    return done(INTAKE_REFUSALS.EDITOR_UNAVAILABLE)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = await new Promise<boolean>((settle) => {
    timer = setTimeout(() => settle(true), input.timeoutMs)
    child.exited.then(() => settle(false)).catch(() => settle(false))
  })
  if (timer !== undefined) clearTimeout(timer)
  if (timedOut) {
    try { child.kill() } catch { /* المهم أن الملفّ يُزفَّر ويُحذف */ }
    return done(INTAKE_REFUSALS.EDITOR_TIMEOUT)
  }
  let text: string
  try { text = readFileSync(path, "utf8") } catch { return done(INTAKE_REFUSALS.TEMPLATE_UNREADABLE) }
  const parsed = parseIntakeFile(text)
  if (parsed.value === undefined) return done(parsed.refusal ?? INTAKE_REFUSALS.TEMPLATE_EMPTY)
  const stored = await input.store(input.handle, parsed.value)
  return done("refusal" in stored ? stored.refusal : undefined)
}
