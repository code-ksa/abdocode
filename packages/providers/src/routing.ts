import { DEFAULT_MODEL } from "./catalog"

export type ModelRole = "auto" | "chat" | "agent"
export type ModelLane = Exclude<ModelRole, "auto">

// Fresh-install fallback only. Existing explicit lane/provider settings win.
export const DEFAULT_CHAT_MODEL = DEFAULT_MODEL
export const DEFAULT_AGENT_MODEL = DEFAULT_MODEL

// أفعال الاستئناف — القائمة الواحدة للمسار وللمحرّك (2026-09-02: كانت قائمتان
// متباعدتان، فـ«تابع» استئنافٌ يرث بوابات البناء عند المحرّك ودردشةٌ عند المسار).
// حدودها حروفٌ لا `\b` (لا يطابق العربية).
const RESUME_VERB_ALTERNATION = "اكمل|أكمل|كمّل|كمل|واصل|تابع|استأنف|continue|resume|carry\\s+on"
const RESUME_VERBS = new RegExp(`(?<!\\p{L})(?:${RESUME_VERB_ALTERNATION})(?!\\p{L})`, "giu")
const RESUME_LEAD = new RegExp(`^(?:${RESUME_VERB_ALTERNATION})(?:\\s|$)`, "iu")
// عبارات الاستئناف الحقيقية — تُطلق الاستئناف كالأفعال.
const RESUME_PHRASES = /(?:من\s+حيث\s+توقفت|من\s+حيث\s+انتهيت|من\s+حيث\s+توقفنا|ما\s+توقفت\s+عنده|من\s+النقطة\s+السابقة|where\s+you\s+left\s+off|from\s+where\s+you\s+stopped)/giu
// أدب الطلب والنداء والظرف: تُنزَع من البقيّة ولا تُطلق شيئاً — «من فضلك» وحدها
// ليست استئنافاً (fail-closed: لا يُستبدل هدفٌ من الذاكرة بلا فعلٍ صريح).
const RESUME_DECORATIONS = /(?<!\p{L})(?:please|من\s+فضلك|الآن|يا\s+عبدو)(?!\p{L})/giu
// «استكمل مشروع رودود» / «افتح مشروع X» / «continue project rodud»: فعلُ استكمالٍ أو فتحٍ
// يتبعه اسمُ المشروع — طريقُ الوكيل دوماً (يحدّد المشروع ويقرأ حاله ويقترح فروعاً).
const PROJECT_INTENT = /(?<!\p{L})(?:استكمل|استكمال|اكمل|أكمل|كمل|كمّل|واصل|تابع|افتح|فتح|ارجع\s+ل|continue|resume|open|finish|pick\s+up)(?!\p{L})[^\n]{0,40}?(?<!\p{L})(?:مشروع|المشروع|project|repo|repository)(?!\p{L})/iu
// حمولة النصّ: حروفٌ وأرقام معاً — «اكمل S3» و«اكمل 2» هدفان يحملان معرّفاً لا استئناف.
const payloadCount = (s: string): number => (s.match(/[\p{L}\p{N}]/gu) ?? []).length

/**
 * صادقٌ فقط حين يكون النصّ تعليمةَ استئنافٍ ولا شيء غيرها: لا بدّ من فعلِ أو
 * عبارةِ استئنافٍ صريحة، ثم تُنزَع هي والزينة والترقيم والفراغ؛ فإن بقي أيّ
 * حرفٍ أو رقم فالنصّ هدفٌ لا استئناف. «أكمل خطة اسبرينتات إيدو جلوبال» هدف؛
 * النصّ الفارغ و«من فضلك» وحدها ليسا استئنافاً.
 */
export function isResumeIntent(body: string): boolean {
  const text = body.trim()
  if (text.length === 0) return false
  // replace بعلم g يصفّر lastIndex بنفسه؛ نصٌّ لم يتغيّر = لا فعل ولا عبارة استئناف.
  const stripped = text.replace(RESUME_PHRASES, " ").replace(RESUME_VERBS, " ")
  if (stripped === text) return false
  return payloadCount(stripped.replace(RESUME_DECORATIONS, " ")) === 0
}

/**
 * A deliberately narrow, deterministic router. Ambiguous prompts stay on the
 * lightweight chat lane; only explicit software/workflow intent selects the
 * coding and agentic lane. The operator can always pin either lane.
 *
 * A bare resume instruction (isResumeIntent) always takes the agent lane: the
 * engine inherits the prior goal's build/test gates for it, and a turn gated as
 * agent work must not run on the chat model.
 */
export function classifyModelLane(input: string): ModelLane {
  const text = input.trim().toLowerCase()
  if (text.length === 0) return "chat"
  if (isResumeIntent(text)) return "agent"
  if (/^(خطة|plan)(?:\s|$)/u.test(text)) return "agent"
  if (RESUME_LEAD.test(text)) return "agent"
  // Naming a project to continue, open or finish is agent work: the engine must
  // locate it, read its state and propose branches — never answer from chat memory.
  if (PROJECT_INTENT.test(text)) return "agent"

  const action = /(?:برمج|برمجة|كود|شفرة|اصلح|أصلح|طوّر|طور|نفّذ|نفذ|ابنِ|ابني|اختبر|اربط|ركّب|ركب|راجع الهيكل|implement|code|debug|fix|refactor|build|test|wire|install|agentic)/u
  const artifact = /(?:مشروع|مستودع|ريبو|حزمة|نواة|محرك|هيكل|ملف|دالة|واجهة|api|repo|package|crate|kernel|engine|file|function|class|component|database|migration|test|\.rs\b|\.ts\b|\.tsx\b|\.js\b|\.py\b|cargo\b|npm\b|bun\b|git\b)/u
  return action.test(text) && artifact.test(text) ? "agent" : "chat"
}

export function selectModelLane(role: ModelRole, input: string): ModelLane {
  return role === "auto" ? classifyModelLane(input) : role
}
