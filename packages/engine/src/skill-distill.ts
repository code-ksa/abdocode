/**
 * أ5/م7 (09-16) — «احفظ هذا الدورَ مهارةً»: إيصالاتُ الدور الناجحة من أدوات المتصفّح وسطح المكتب والسكربت تُقطَّر إلى ملفّ
 * مهارةٍ في المشروع بمتغيّراتٍ مسمّاة (الرابط، النصّ، الملفّ، النافذة) فتُعاد بلا نموذجٍ للخطوات الحتميّة، والنموذجُ للتفرّع.
 * مبدأُ الفلسفة: **النجاحُ فقط يُقطَّر** — ما رُفض أو فشل لا يدخل. والنصوصُ المكتوبة لا تُحفظ قيمةً (قد تكون اعتماداً)، تُملأ عند الإعادة.
 * الوحدة خالصةٌ من الأثر: تُعطى الإيصالات وتعيد نصّاً؛ الكتابةُ إلى القرص والبوّابةُ في المحرّك.
 */
import { secretish } from "./local-extensions"

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,47}$/u
export const SKILL_SAVE_USAGE = "الصيغة: skill save <اسمٌ لاتينيّ-بشرطات> [:: وصفٌ قصير] — يقطّر خطواتِ هذا الدور الناجحة (متصفّح/سطح مكتب/سكربت) إلى .abdo/skills/<اسم>/SKILL.md"

/** ما يُقطَّر: أفعالُ المتصفّح وسطح المكتب والسكربتات — لا القراءةَ والكتابةَ البرمجيّة (تلك كودٌ لا ورك فلو). */
const DISTILLABLE = /^(?:desk|open|ui|page|tap|fill|key|select|upload|drag|scroll|wait|dismiss|tabs|back|forward|find|look|shot|hover|handoff|script)(?:\s|$)/u

export interface DistillReceipt { readonly command: string; readonly verdict?: { readonly ok: boolean } }
export type Distilled =
  | { readonly ok: true; readonly markdown: string; readonly steps: readonly string[]; readonly variables: readonly string[] }
  | { readonly ok: false; readonly why: string }

interface Vars { readonly urls: Map<string, string>; texts: number; choices: number; files: number; windows: number }

const parametrize = (command: string, vars: Vars, examples: string[]): string => {
  let c = command.trim().replace(/\s+/gu, " ")
  c = c.replace(/https?:\/\/\S+/gu, (url) => {
    let key = vars.urls.get(url)
    if (key === undefined) { key = `url_${vars.urls.size + 1}`; vars.urls.set(url, key); examples.push(`- {{${key}}} — مثال: ${url.slice(0, 120)}`) }
    return `{{${key}}}`
  })
  const text = (label: "text" | "choice" | "file" | "window"): string => {
    const n = label === "text" ? ++vars.texts : label === "choice" ? ++vars.choices : label === "file" ? ++vars.files : ++vars.windows
    const key = `${label}_${n}`
    examples.push(`- {{${key}}} — ${label === "text" ? "نصٌّ يُملأ عند الإعادة (لا يُحفظ هنا)" : label === "choice" ? "خيارٌ من القائمة" : label === "file" ? "مسارُ ملفٍّ داخل المشروع" : "جزءٌ من عنوان النافذة أو pid"}`)
    return `{{${key}}}`
  }
  c = c.replace(/^(desk type) .+$/u, (_m, head: string) => `${head} ${text("text")}`)
  c = c.replace(/^(desk set u?\d+) .+$/u, (_m, head: string) => `${head} ${text("text")}`)
  c = c.replace(/^(fill r\d+) .+$/u, (_m, head: string) => `${head} ${text("text")}`)
  c = c.replace(/^(select r\d+) .+$/u, (_m, head: string) => `${head} ${text("choice")}`)
  c = c.replace(/^(upload r\d+) .+$/u, (_m, head: string) => `${head} ${text("file")}`)
  c = c.replace(/^(desk focus) .+$/u, (_m, head: string) => `${head} ${text("window")}`)
  return c
}

export const distillSkill = (name: string, description: string, receipts: readonly DistillReceipt[], now: Date = new Date()): Distilled => {
  if (!SKILL_NAME.test(name)) return { ok: false, why: `اسمُ المهارة «${name.slice(0, 40)}» لا يطابق ${SKILL_NAME.source} — ${SKILL_SAVE_USAGE}` }
  const successful = receipts.filter((r) => (r.verdict === undefined || r.verdict.ok) && DISTILLABLE.test(r.command.trim()))
  const vars: Vars = { urls: new Map(), texts: 0, choices: 0, files: 0, windows: 0 }
  const examples: string[] = []
  const steps: string[] = []
  for (const r of successful) {
    const step = parametrize(r.command.split("\n", 1)[0]!, vars, examples)
    if (steps[steps.length - 1] !== step) steps.push(step)
  }
  if (steps.length < 2) return { ok: false, why: `لا يكفي للتقطير: ${steps.length} خطوةً ناجحة من أدوات المتصفّح/سطح المكتب/السكربت في هذا الدور — المهارةُ تحتاج خطوتين فأكثر (ما رُفض أو فشل لا يدخل).` }
  const variables = examples.map((e) => /\{\{([a-z_0-9]+)\}\}/u.exec(e)?.[1] ?? "").filter((v) => v.length > 0)
  const desc = description.trim().length > 0 ? description.trim().slice(0, 240) : `ورك فلو مقطَّر من دورٍ ناجح (${steps.length} خطوات)`
  const markdown = [
    "---",
    `name: ${name}`,
    `description: ${desc}`,
    `variables: ${variables.join(", ") || "(بلا)"}`,
    `distilled: ${now.toISOString()} — من ${successful.length} إيصالاً ناجحاً`,
    "---",
    `# ${name}`,
    "",
    desc,
    "",
    "## المتغيّرات",
    ...(examples.length > 0 ? examples : ["- (بلا متغيّرات)"]),
    "",
    "## الخطوات — نفّذ بالترتيب؛ المراجعُ rN/uN تُقرأ من page أو desk ui لحظتَها لا من هنا",
    ...steps.map((s, i) => `${i + 1}. نفّذ: ${s}`),
    "",
    "## القواعد",
    "- النجاحُ فقط قُطِّر: خطواتٌ رُفضت أو فشلت لم تدخل.",
    "- كلُّ فعلٍ ذي أثرٍ يمرّ ببوّابة الموافقة نفسِها عند الإعادة؛ المهارةُ تعليماتٌ لا صلاحيات.",
    "- إن اختلفت الصفحةُ أو النافذة عمّا تصفه الخطوة فقف واقرأ (page/desk ui) بدل المضيّ أعمى.",
    "- الجدولة: من الإعدادات ▸ الروتينات — والأفعالُ الخارجيّة (نشرٌ، إرسال) بإذنٍ مكتوبٍ في الروتين نفسه.",
    "",
  ].join("\n")
  if (secretish.test(markdown)) return { ok: false, why: "رُفض التقطير: النصُّ الناتج يحمل ما يشبه اعتماداً — أزل السرَّ من الدور وأعد المحاولة." }
  return { ok: true, markdown, steps, variables }
}
