/**
 * ن3 — وسائطُ أفعال المتصفّح (select/upload/drag) في الخلفيّتين، ووسائطُ الجسر للإضافة.
 *
 * مقيس 09-15: `fill r5 hello` عبر إضافة المتصفّح كان يُرفض «الأداة تحتاج كائنَ JSON بمفاتيح: ref، text» لأنّ النصَّ الحرّ
 * يُقبل لمفتاحٍ واحد فقط — فكان النموذجُ مضطرّاً إلى `chrome.fill {"ref":…}`. هنا تُبنى الوسائطُ كائناً حتميّاً لكلّ فعلٍ
 * ذي مفتاحين فأكثر، والمسارُ المرفوع يُحكم قبل أن يغادر الجهاز: داخلَ المشروع، موجودٌ، ليس ملفَّ سرّ.
 */
import { existsSync, lstatSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"

export const BROWSER_ACTION_VERBS = Object.freeze(["select", "upload", "drag"] as const)
export type BrowserActionVerb = (typeof BROWSER_ACTION_VERBS)[number]

const REF = /^r\d{1,6}$/u
/** أسماءُ ملفّاتٍ لا تُرفع إلى موقعٍ بالنيابة عن أحد — مهما كان الطلب. */
export const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|p12|pfx|kdbx)|secrets?\.(json|ya?ml|toml)|credentials(\.json)?)$/iu

export type UploadVerdict =
  | Readonly<{ ok: true; abs: string; name: string; bytes: number }>
  | Readonly<{ ok: false; why: string }>

/** يحكم مسارَ ملفٍّ سيُرفع: نسبيٌّ إلى المشروع أو مطلقٌ داخلَه؛ موجودٌ وملفٌّ لا مجلّد؛ ليس اسمَ سرّ. */
export const uploadPathVerdict = (rawPath: string, projectDir: string): UploadVerdict => {
  const path = rawPath.trim().replace(/^["'«»]+|["'«»]+$/gu, "")
  if (path.length === 0) return { ok: false, why: "الصيغة: upload <مرجع> <مسار ملفٍّ داخل المشروع>" }
  const abs = isAbsolute(path) ? resolve(path) : resolve(projectDir, path)
  const rel = relative(resolve(projectDir), abs)
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, why: `رُفض الرفع: «${path}» خارج مجلّد المشروع — يُرفع ما في المشروع وحده؛ انسخ الملفَّ إليه أوّلاً إن كان مطلوباً` }
  if (SECRET_FILE.test(abs)) return { ok: false, why: `رُفض الرفع: «${path}» ملفُّ اعتمادٍ أو مفتاحٍ بنوعه — لا يُرفع إلى موقعٍ بالنيابة عن أحد` }
  if (!existsSync(abs)) return { ok: false, why: `رُفض الرفع: الملفُّ غير موجود — ${path}` }
  if (lstatSync(abs).isDirectory()) return { ok: false, why: `رُفض الرفع: المسارُ مجلّدٌ لا ملفّ — ${path}` }
  return { ok: true, abs, name: abs.replace(/\\/g, "/").split("/").pop() ?? abs, bytes: lstatSync(abs).size }
}

export type BrowserActionParse =
  | Readonly<{ ok: true; verb: "select"; ref: string; choice: string }>
  | Readonly<{ ok: true; verb: "upload"; ref: string; path: string }>
  | Readonly<{ ok: true; verb: "drag"; from: string; to: string }>
  | Readonly<{ ok: false; why: string }>

type Refusal = Readonly<{ ok: false; why: string }>
/** يحلّل ذيلَ الأمر لكلّ فعل — الصيغةُ تُقال بالاسم عند النقص؛ التحميلاتُ تُضيّق النوعَ للمستدعي. */
export function parseBrowserAction(verb: "select", rest: string): Readonly<{ ok: true; verb: "select"; ref: string; choice: string }> | Refusal
export function parseBrowserAction(verb: "upload", rest: string): Readonly<{ ok: true; verb: "upload"; ref: string; path: string }> | Refusal
export function parseBrowserAction(verb: "drag", rest: string): Readonly<{ ok: true; verb: "drag"; from: string; to: string }> | Refusal
export function parseBrowserAction(verb: BrowserActionVerb, rest: string): BrowserActionParse {
  const [first = "", ...tail] = rest.trim().split(/\s+/u)
  if (verb === "select") {
    const choice = tail.join(" ").replace(/^["'«»]+|["'«»]+$/gu, "").trim()
    if (!REF.test(first) || choice.length === 0) return { ok: false, why: "الصيغة: select <مرجع> <نصّ الخيار أو قيمته> — لقائمةٍ منسدلة (combobox) من page" }
    return { ok: true, verb, ref: first, choice }
  }
  if (verb === "upload") {
    const path = tail.join(" ").trim()
    if (!REF.test(first) || path.length === 0) return { ok: false, why: "الصيغة: upload <مرجع> <مسار ملفٍّ داخل المشروع> — لحقل ملفّ (textbox:file) من page" }
    return { ok: true, verb, ref: first, path }
  }
  const to = tail[0] ?? ""
  if (!REF.test(first) || !REF.test(to) || first === to) return { ok: false, why: "الصيغة: drag <مرجعُ المصدر> <مرجعُ الهدف> — مرجعان مختلفان من page" }
  return { ok: true, verb, from: first, to }
}

/**
 * وسائطُ نداء الجسر (الإضافة) لفعلٍ ونصّه: كائنُ JSON للأفعال ذات المفاتيح المتعدّدة، والنصُّ كما هو لما يقبله مفتاحٌ واحد.
 * `upload` يحمل المسارَ **المطلق** بعد الحكم — الإضافةُ تعمل في متصفّح المستخدم على الجهاز نفسِه.
 */
export const bridgeCallArgs = (target: string, rest: string, projectDir: string): Readonly<{ ok: true; args: string }> | Readonly<{ ok: false; why: string }> => {
  const text = rest.trim()
  if (target === "fill") {
    const [ref = "", ...tail] = text.split(/\s+/u)
    if (!REF.test(ref) || tail.length === 0) return { ok: false, why: "الصيغة: fill <مرجع> <نصّ>" }
    return { ok: true, args: JSON.stringify({ ref, text: tail.join(" ") }) }
  }
  if (target === "select") {
    const p = parseBrowserAction("select", text)
    if (!p.ok) return p
    return { ok: true, args: JSON.stringify({ ref: p.ref, text: p.choice }) }
  }
  if (target === "upload") {
    const p = parseBrowserAction("upload", text)
    if (!p.ok) return p
    const v = uploadPathVerdict(p.path, projectDir)
    return v.ok ? { ok: true, args: JSON.stringify({ ref: p.ref, path: v.abs }) } : v
  }
  if (target === "drag") {
    const p = parseBrowserAction("drag", text)
    if (!p.ok) return p
    return { ok: true, args: JSON.stringify({ from: p.from, to: p.to }) }
  }
  // ن5 — التبويبات والتاريخ عبر الإضافة: كائنٌ بمفتاح op، والرابطُ يُحكم في المحرّك قبل المغادرة (سياسةُ المواقع).
  if (target === "tabs") {
    const [op = "list", arg = ""] = text.split(/\s+/u)
    if (op === "list" || op === "") return { ok: true, args: JSON.stringify({ op: "list" }) }
    if (op === "switch" || op === "close") return arg.length === 0 ? { ok: false, why: `الصيغة: tabs ${op} <رقم من tabs list>` } : { ok: true, args: JSON.stringify({ op, target: arg }) }
    if (op === "new") return /^https?:\/\//iu.test(arg) ? { ok: true, args: JSON.stringify({ op: "new", url: arg }) } : { ok: false, why: "الصيغة: tabs new <رابط http/https>" }
    return { ok: false, why: "الصيغة: tabs [list | switch <رقم> | close <رقم> | new <رابط>]" }
  }
  if (target === "back" || target === "forward") return { ok: true, args: JSON.stringify({}) }
  return { ok: true, args: rest }
}
