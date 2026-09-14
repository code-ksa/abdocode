/**
 * S13.5 — تعريفُ الوكيل المحمول: شكلان يُكتبان باليد، سجلٌّ داخليٌّ واحد.
 *
 * قيس على هذا الجهاز (2026-09-03) شكلان يكتبهما المشغّلون فعلاً لوكلائهم:
 *
 *   • **ماركداون** بمقدّمةٍ بين سطرَي `---` تحمل ثلاثة مفاتيح — `name` و
 *     `description` و`tools` — ثم متنٌ هو رسالةُ نظام الوكيل.
 *   • **TOML** يحمل `name` و`description` و`developer_instructions` — وقد
 *     **لا يحمل `tools` أصلاً**.
 *
 * وفي الشكل الثاني الفخُّ الأوّل المقيس: في الهارنس المرجعيّ «قائمةُ أدواتٍ
 * غائبة» تعني **كلَّ الأدوات**. وهذا يناقض قانون المالك «الغياب رفضٌ لا إذن»
 * نصّاً. فهنا: **قائمةٌ غائبة أو غير قابلة للتحليل ⇒ رفضٌ بالاسم**، ولا وكيل
 * يُبنى. لا سقفَ ضمنيّاً ولا افتراضَ توسّع.
 *
 * والفخُّ الثاني: الخاصّةُ الحاملة في وكلاء المرجع كلّهم — «يقيسون ويقترحون
 * ولا ينفّذون» — نثرٌ في المتن لا يقرؤه أحد. فلا حقلَ يحملها ولا بوّابة.
 * هنا **تُشتقّ** `readOnly` من أصناف الأدوات المعلَنة وحدها (كلُّها `read`
 * ⇒ قراءة-فقط)، وتُقال للمشغّل مشتقّةً — ولا تُصدَّق من نثر.
 *
 * الوحدة **خالصة**: لا `node:` ولا قرص ولا ساعة. القارئ يتلقّى نصوصَ ملفّاتٍ
 * ويعيد سجلّاتٍ أو رفوضاً مسمّاة. من يقرأ القرص هو `cli.ts` وحده.
 */

import { ProductTools } from "@abdo/tools"

/** الشكل الذي جاء منه التعريف — يُروى في العرض ولا يغيّر السجلّ. */
export type AgentSource = "markdown" | "toml"

/** ما تحتاجه هذه الوحدة من سجلّ الأدوات — منفذٌ لا اقتران. */
export interface AgentToolLookup {
  (word: string): { readonly name: string; readonly effect: string; readonly agentCallable: boolean; readonly aliases?: readonly string[] } | undefined
}

const defaultLookup: AgentToolLookup = (word) => ProductTools.tool(word)

/** السجلّ الداخليّ الواحد الذي يُطابَق عليه الشكلان. */
export interface AgentDefinition {
  readonly name: string
  readonly description: string
  /** سقفُ الوكيل: أسماءُ أدواتٍ قانونيّة من السجلّ الواحد، واحدةٌ على الأقل. */
  readonly tools: readonly string[]
  /** الأسماء والمرادفات معاً — فحصُ الإذن مطابقةُ مجموعة لا بحثٌ خطّي. */
  readonly callable: ReadonlySet<string>
  /** متنُ الملفّ: رسالةُ نظام الوكيل. */
  readonly instructions: string
  readonly source: AgentSource
  /** **مشتقّة** من أصناف الأدوات المعلَنة — لا تُقرأ من نثرٍ ولا تُعلَن يدوياً. */
  readonly readOnly: boolean
}

export type AgentParse = { readonly ok: true; readonly agent: AgentDefinition } | { readonly ok: false; readonly why: string }

/** اسمُ ملفٍّ يحمل تعريف وكيل — الامتداد يحسم الشكل، لا تخمينٌ من المحتوى. */
export const AGENT_FILE_RE = /^([A-Za-z0-9_-]{1,64})\.agent\.(md|toml)$/u

/** المجلَّد الذي يملكه المنتَج تحت دليل التثبيت (لا جذر مشروع العميل). */
export const AGENT_DIR = "agents"

export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,31}$/u

/** سقوفٌ تمنع ملفّاً ضخماً من ابتلاع نافذة السياق. */
export const AGENT_MAX_TOOLS = 24
export const AGENT_MAX_INSTRUCTION_CHARS = 4000
export const AGENT_MAX_DESCRIPTION_CHARS = 240

const refuse = (why: string): AgentParse => ({ ok: false, why })

// ---------------------------------------------------------------------------
// تحليل الشكلين — بأبسط ما يكفي، وبلا مكتبة
// ---------------------------------------------------------------------------

interface RawFields {
  readonly name?: string
  readonly description?: string
  /** حاضرٌ نصّاً ⇒ نحلّله؛ غائبٌ ⇒ رفضٌ بالاسم (الغياب رفضٌ لا إذن). */
  readonly toolsRaw?: string
  readonly instructions: string
}

const stripQuotes = (value: string): string => {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1)
  return v
}

const parseMarkdown = (text: string): RawFields | string => {
  const normalised = text.replace(/\r\n/gu, "\n")
  if (!normalised.startsWith("---\n")) return "لا مقدّمة `---` في صدر الملفّ"
  const end = normalised.indexOf("\n---", 3)
  if (end < 0) return "مقدّمة `---` لم تُغلق"
  const header = normalised.slice(4, end)
  const body = normalised.slice(end + 4).replace(/^\n/u, "")
  const fields: Record<string, string> = {}
  for (const line of header.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    const colon = trimmed.indexOf(":")
    if (colon <= 0) return `سطرٌ في المقدّمة ليس «مفتاح: قيمة»: ${trimmed.slice(0, 40)}`
    fields[trimmed.slice(0, colon).trim()] = stripQuotes(trimmed.slice(colon + 1))
  }
  return {
    ...(fields.name === undefined ? {} : { name: fields.name }),
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.tools === undefined ? {} : { toolsRaw: fields.tools }),
    instructions: body.trim(),
  }
}

const TOML_TRIPLE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"""([\s\S]*?)"""\s*$/mu
const TOML_SCALAR = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*$/gmu
const TOML_ARRAY = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\[([^\]]*)\]\s*$/gmu

const parseToml = (text: string): RawFields | string => {
  const normalised = text.replace(/\r\n/gu, "\n")
  const fields: Record<string, string> = {}
  let arrays: Record<string, string> = {}
  let rest = normalised
  for (;;) {
    const triple = TOML_TRIPLE.exec(rest)
    if (triple === null) break
    fields[triple[1]!] = triple[2]!.trim()
    rest = rest.slice(0, triple.index) + rest.slice(triple.index + triple[0].length)
  }
  for (const match of rest.matchAll(TOML_SCALAR)) fields[match[1]!] = stripQuotes(match[2]!).replace(/\\n/gu, "\n")
  for (const match of rest.matchAll(TOML_ARRAY)) arrays = { ...arrays, [match[1]!]: match[2]! }
  const instructions = fields.developer_instructions ?? fields.instructions
  if (instructions === undefined) return "لا مفتاح `developer_instructions` — متنُ الوكيل غائب"
  return {
    ...(fields.name === undefined ? {} : { name: fields.name }),
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(arrays.tools === undefined ? {} : { toolsRaw: arrays.tools }),
    instructions: instructions.trim(),
  }
}

/** «read, grep» أو «[\"read\", \"grep\"]» ⇒ أسماءٌ؛ الفراغ يعود مصفوفةً فارغة فتُرفض فوق. */
const splitTools = (raw: string): readonly string[] =>
  raw
    .replace(/^\[/u, "")
    .replace(/\]$/u, "")
    .split(/[,\n]/u)
    .map((piece) => stripQuotes(piece).trim())
    .filter((piece) => piece.length > 0)

// ---------------------------------------------------------------------------
// القارئ الواحد
// ---------------------------------------------------------------------------

/**
 * يحلّل ملفَّ تعريفٍ واحداً. الرفضُ يسمّي الملفَّ والسبب، ولا يعود أبداً
 * إلى «افتراضٍ معقول»: تعريفٌ نصفُه مفهوم ليس تعريفاً.
 */
export const parseAgentDefinition = (fileName: string, text: string, lookup: AgentToolLookup = defaultLookup): AgentParse => {
  const match = AGENT_FILE_RE.exec(fileName)
  if (match === null) return refuse(`«${fileName}» ليس ملفَّ وكيل — الصيغة <اسم>.agent.md أو <اسم>.agent.toml`)
  const source: AgentSource = match[2] === "toml" ? "toml" : "markdown"
  const raw = source === "toml" ? parseToml(text) : parseMarkdown(text)
  if (typeof raw === "string") return refuse(`${fileName}: ${raw}`)

  const name = raw.name?.trim() ?? ""
  if (!AGENT_NAME_RE.test(name)) return refuse(`${fileName}: اسمُ الوكيل «${name.slice(0, 32)}» لا يطابق ${AGENT_NAME_RE.source}`)
  if (name !== match[1]) return refuse(`${fileName}: الاسم المعلَن «${name}» يخالف اسم الملفّ «${match[1]}» — مصدرُ الاسم واحد`)

  const description = raw.description?.trim() ?? ""
  if (description.length === 0) return refuse(`${fileName}: لا وصف — الوكيل بلا وصفٍ لا يُختار`)

  const instructions = raw.instructions
  if (instructions.length === 0) return refuse(`${fileName}: المتن فارغ — لا رسالة نظامٍ للوكيل`)

  // الفخّ المقيس (1): الغيابُ رفضٌ لا إذن. في الهارنس المرجعيّ يعني الغيابُ
  // «كلَّ الأدوات»؛ هنا يعني «لا وكيل».
  if (raw.toolsRaw === undefined) {
    return refuse(`${fileName}: لا مفتاح tools — قائمةُ الأدوات الغائبة رفضٌ لا إذن، ولا تعني «كل الأدوات». أعلِن سقفَ الوكيل صراحةً`)
  }
  const declared = splitTools(raw.toolsRaw)
  if (declared.length === 0) return refuse(`${fileName}: قائمةُ tools فارغة — أعلِن أداةً واحدة على الأقل`)
  if (declared.length > AGENT_MAX_TOOLS) return refuse(`${fileName}: قائمةُ tools أطول من ${AGENT_MAX_TOOLS}`)

  const tools: string[] = []
  const callable = new Set<string>()
  const effects: string[] = []
  for (const word of declared) {
    const spec = lookup(word)
    if (spec === undefined) return refuse(`${fileName}: أداةٌ غير مسجَّلة «${word.slice(0, 32)}» — السقف يُعلن بأسماء السجلّ وحدها`)
    if (!spec.agentCallable) return refuse(`${fileName}: «${word}» ليست أداةَ نموذج (agentCallable=false) — لا تُعلَن في سقف وكيل`)
    if (callable.has(spec.name)) continue
    tools.push(spec.name)
    callable.add(spec.name)
    for (const alias of spec.aliases ?? []) callable.add(alias)
    effects.push(spec.effect)
  }

  // الفخّ المقيس (2): الخاصّةُ الحاملة تُشتقّ من الأصناف، لا من نثر المتن.
  const readOnly = effects.every((effect) => effect === "read")

  return {
    ok: true,
    agent: Object.freeze({
      name,
      description: description.slice(0, AGENT_MAX_DESCRIPTION_CHARS),
      tools: Object.freeze(tools),
      callable,
      instructions: instructions.slice(0, AGENT_MAX_INSTRUCTION_CHARS),
      source,
      readOnly,
    }),
  }
}

export interface AgentCatalogue {
  readonly agents: readonly AgentDefinition[]
  /** ملفّاتٌ رُفضت بأسمائها وأسبابها — تُروى للمشغّل ولا تُبتلع. */
  readonly refusals: readonly string[]
}

/**
 * يبني الكتالوج من ملفّاتٍ (نصوصاً). التصادمُ على الاسم يُحسم للأوّل ويُروى:
 * ملفّان باسمٍ واحد غموضٌ لا يُحسم صامتاً.
 */
export const buildAgentCatalogue = (
  files: readonly { readonly file: string; readonly text: string }[],
  lookup: AgentToolLookup = defaultLookup,
): AgentCatalogue => {
  const agents: AgentDefinition[] = []
  const refusals: string[] = []
  const seen = new Set<string>()
  for (const entry of files) {
    const parsed = parseAgentDefinition(entry.file, entry.text, lookup)
    if (!parsed.ok) { refusals.push(parsed.why); continue }
    if (seen.has(parsed.agent.name)) { refusals.push(`${entry.file}: وكيلٌ بالاسم «${parsed.agent.name}» معرَّفٌ مرّتين — أُبقي الأوّل`); continue }
    seen.add(parsed.agent.name)
    agents.push(parsed.agent)
  }
  return Object.freeze({ agents: Object.freeze(agents), refusals: Object.freeze(refusals) })
}

export const findAgent = (catalogue: AgentCatalogue, name: string): AgentDefinition | undefined =>
  catalogue.agents.find((agent) => agent.name === name.trim())

/**
 * الإذنُ بالبناء: أداةٌ خارج السقف تُرفض **بالاسم** وتُسمّى معها أدواتُ
 * الوكيل المعلَنة، فيصحّح النموذجُ خطوته بدل أن يُعيد المحاولة عمياء.
 */
export const agentToolRefusal = (agent: AgentDefinition, word: string): string | undefined => {
  const trimmed = word.trim()
  if (trimmed.length > 0 && agent.callable.has(trimmed)) return undefined
  return `رُفضت «${trimmed.slice(0, 40)}»: الوكيل «${agent.name}» لا يعلنها في سقفه — أدواته: ${agent.tools.join("، ")}. (الغياب رفضٌ لا إذن.)`
}

/** سطرٌ لكل وكيل يقرؤه النموذج والمشغّل — والقراءة-فقط **مشتقّةٌ** تُقال. */
export const describeAgents = (catalogue: AgentCatalogue): string =>
  catalogue.agents
    .map((agent) => `- ${agent.name} — ${agent.description} [${agent.readOnly ? "قراءة-فقط (مشتقّ من أدواته)" : "يكتب/ينفّذ"}؛ أدواته: ${agent.tools.join("، ")}]`)
    .join("\n")

/**
 * الصيغةُ المُوجَزة — لوصف أداةِ التفويض نفسِها.
 *
 * العطلُ المقيس (2026-09-03): وصفُ `delegate` كان يُركَّب من الصيغة الكاملة
 * أعلاه فبلغ **728 حرفاً**، وسقفُ الوصف في هيئة qwen — وهي هيئةُ نموذجنا
 * المحلّي — **512**. والهيئةُ لا تقصّ الوصفَ بل **تُسقط الأداة كلَّها** عمداً
 * («قصٌّ صامتٌ يخفي أيَّ الطرفين مخطئ»). فكانت أداةُ التفويض تختفي من كتالوج
 * النموذج كلّما فُعِّل مفتاحُها — وهو «مسجَّلة ≠ قابلة للاستدعاء» بعينه.
 *
 * فالوصفُ يحمل الأسماءَ والأدوارَ وحدها، وتفصيلُ الأدوات يبقى في الصيغة
 * الكاملة حيث لا سقف. ونموُّه محكومٌ بعدد الوكلاء لا بطول متونهم.
 */
export const describeAgentsBrief = (catalogue: AgentCatalogue): string =>
  catalogue.agents
    .map((agent) => `- ${agent.name} (${agent.readOnly ? "قراءة-فقط" : "يكتب/ينفّذ"})`)
    .join("\n")

// ---------------------------------------------------------------------------
// وكلاءُ المنتَج — نصوصٌ يشحنها الثنائيّ، يقرؤها **القارئُ نفسه**
// ---------------------------------------------------------------------------

/**
 * هذه ملفّاتُ المنتَج نفسه، لا نسخاً من ملفّاتِ أحد. تُمرَّر على
 * `parseAgentDefinition` كما يُمرَّر أيُّ ملفٍّ من مجلَّد التثبيت — فلا طريقان
 * لبناء وكيل، ولا وكيلٌ «مضمَّن» يفلت من الفحص الذي يمرّ به الخارجيّ.
 */
export const BUILTIN_AGENT_FILES: readonly { readonly file: string; readonly text: string }[] = Object.freeze([
  // هـ2 (أمر المالك 2026-09-07): «أوّلُ وكيلٍ نموذجٌ قويّ يقرأ المشروع من الوعي والذاكرة مثلما تفعل تماماً» — يُشغَّل قبل الحقبة الأولى في الأوضاع فوق الأساسيّ.
  Object.freeze({
    file: "orient.agent.md",
    text: `---
name: orient
description: يقرأ المشروعَ من الوعي والذاكرة قبل أيّ فعل ويخرج بخلاصةٍ مهيكلة — لا يكتب ولا ينفّذ
tools: project-orient, recall, read, list, glob, grep, git, docs
---
أنت الوكيلُ الموجِّه: أوّلُ من يقرأ المشروعَ قبل أن يعمل غيرُك — من الوعي والذاكرة لا من التخمين، كما يبدأ مساعدٌ خبير.

الترتيب:
1. «نفّذ: project-orient» — حالُ المشروع الآن (Git، الخطط، التسليم، الفجوات).
2. «نفّذ: recall <الطلب>» — ما قيس سابقاً في هذا المشروع وما يخصّ الطلب.
3. اقرأ ما يلزم فقط: ملفّاتِ التوجيه في جذر المشروع (AGENTS.md وREADME وأمثالها) والوحداتِ التي يمسّها الطلب — بـgrep والمقاطع لا بقراءة الكبير كاملاً.

جوابُك الخاتم نصٌّ واحد بهذا الشكل حرفاً، وما لا إيصالَ له يُسقَط:
[ORIENTATION]
الهدف: <الطلب بكلماتك>
الحالة الآن: <Git/الفرع/آخر إيداع/شجرة العمل/الخطط>
ما يخصّ الطلب: <الملفّات والوحدات والأوامر ذات الصلة بمساراتها>
الفجوات والمخاطر: <ما قد يكسر أو ينقص>
اقرأ قبل الفعل: <ملفّات بعينها>
خطّة مقترحة: <s1: … | s2: … [after: s1] | …>
[/ORIENTATION]
لا تكتب ملفّاً ولا تنفّذ أمراً: سقفُك قراءةٌ فقط، وهو مقصود.
`,
  }),
  Object.freeze({
    file: "planner.agent.md",
    text: `---
name: planner
description: يقرأ الموجود ويكتب خطوات العمل — لا يكتب ملفّاً ولا ينفّذ أمراً
tools: read, list, glob, grep, docs, recall
---
أنت عدسةُ التخطيط. مهمّتك أن تقرأ الموجود فعلاً ثمّ تصف الخطوات بالترتيب.

القواعد:
- لا تدّعِ حقيقةً بلا إيصالٍ في هذا الدور. ما لم تقرأه لا تصفه.
- ابدأ من «recall» لسؤال طبقات الوعي عمّا قيس سابقاً، ثمّ اقرأ ما ينقص.
- خطوتك الأخيرة نصٌّ واحد: الخطوات مرقّمةً، وأمامَ كلّ خطوةٍ دليلُ قبولها.
- لا تقترح أداةَ كتابةٍ أو تنفيذ: سقفُك قراءةٌ فقط، وهو مقصود.
`,
  }),
  Object.freeze({
    file: "reviewer.agent.md",
    text: `---
name: reviewer
description: يراجع ما كُتب فعلاً ضدّ ما طُلب ويسمّي العيوب — لا يصلحها بنفسه
tools: read, list, glob, grep, git, recall
---
أنت عدسةُ المراجعة. تقرأ التغيير كما هو على القرص وتحكم عليه.

القواعد:
- ادّعاءُ المؤلِّف عن عمله ليس دليلاً؛ اقرأ الملفّ أو الفرق بنفسك.
- سمِّ كلّ عيبٍ بموضعه: الملفّ والسطر وما يكسره — لا انطباعاتٍ عامّة.
- إن لم تجد عيباً فقل ذلك صراحةً؛ اختلاقُ ملاحظةٍ لملء التقرير عيبٌ بذاته.
- لا تصلح شيئاً: سقفُك قراءةٌ فقط، والإصلاح قرارُ من فوّضك.
`,
  }),
  Object.freeze({
    file: "recaller.agent.md",
    text: `---
name: recaller
description: يسأل طبقات الوعي الأربع ويعيد ما قيس بنسبه — والغياب يقوله لا يملؤه
tools: recall, read, grep
---
أنت عدسةُ الوعي. سؤالُك واحد: ما الذي قيس سابقاً وله صلةٌ بهذه المهمّة؟

القواعد:
- ابدأ بـrecall على السؤال كما وردك، ثمّ ضيّقه بكلماتٍ أدقّ إن عاد فارغاً.
- انقل كلّ سطرٍ بنسبه (أيّ طبقةٍ جاء منها)، ولا تدمج طبقتين في جملة.
- «لا شيء مقيس» جوابٌ صحيح ونهائيّ — لا تملأ الفراغ بمعرفةٍ عامّة تخمّنها.
`,
  }),
  Object.freeze({
    file: "builder.agent.toml",
    text: `name = "builder"
description = "ينفّذ خطوةً واحدة مسمّاة ويثبتها بإيصال — بسقفٍ أضيق من سقف الدور"
tools = ["read", "list", "glob", "grep", "write", "edit", "run"]
developer_instructions = """
أنت عدسةُ البناء. تنفّذ الخطوة التي فُوّضت إليك وحدها، لا ما جاورها.

القواعد:
- اقرأ قبل أن تكتب؛ والتحرير يطابق نصّاً فريداً لا يخمّنه.
- كلّ أثرٍ يمرّ ببوّابة الموافقة نفسها التي يمرّ بها الدور — لا تلتفّ عليها.
- أنهِ بإيصالٍ حقيقيّ (بناءٌ أو اختبارٌ نُفّذ)، ولا تقل «تم» قبله.
- إن اتّسعت المهمّة عن خطوتها فقُل ذلك وقِف؛ التوسّع قرارُ من فوّضك.
"""
`,
  }),
])
