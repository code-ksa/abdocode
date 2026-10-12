/**
 * ب7 — جسرُ كروم: خادمُ MCP مدمج (JSON-RPC على stdio كإخوته) يُطلقه المحرّكُ كمزوّدٍ خارجيّ، ومن الجهة الأخرى
 * مقبسُ WebSocket محلّيّ (127.0.0.1) برمزٍ لا يعرفه إلا المستخدم، تتّصل به **إضافةُ كروم** في متصفّح المستخدم
 * الحقيقيّ (`packages/browser-bridge/extension`). كلُّ أداةٍ يستدعيها النموذجُ تمرّ: المحرّك ⇦ MCP ⇦ هذا الجسر ⇦
 * الإضافة ⇦ الصفحة، ويعود الجوابُ الطريقَ نفسَه.
 *
 * ═══ لماذا جسرٌ لا وصلُ CDP بكروم المستخدم ═══
 * كرومُ المستخدم الجاري بلا منفذِ تنقيح، وإعادةُ إطلاقه بمنفذٍ يجعل ملفَّه كلَّه (جلساتُه، كوكيزُه) سطحَ وكيل.
 * الإضافةُ تعمل داخل نموذج أذونات كروم نفسِه: المستخدمُ يثبّتها ويرى شارةَ «يجري تنقيحُ هذا التبويب» عند كلّ
 * حدثِ إدخال، ويعزلها بنقرة.
 *
 * ═══ ما يُحرَس هنا لا في الإضافة ═══
 * - حقولُ الاعتماد (كلمة مرور/بطاقة/OTP/كابتشا): الحارسُ نفسُه `Surface.judge` — لا يُكتب فيها حرفٌ ولا يُطلب
 *   من الإضافة أن تكتب؛ الجوابُ يدلّ على التسليم للمستخدم.
 * - سياسةُ المواقع المحفوظة (`workspace-v1.json`) تُفرض على `open` قبل أن يصل الطلبُ الإضافةَ.
 * - لا إضافةَ موصولة ⇒ خطأٌ مسمّى لا صمت؛ رمزٌ خاطئ ⇒ إغلاقُ المقبس قبل أوّل رسالة.
 * - الردودُ نصٌّ فقط للنموذج (عقدُ MCP عندنا)؛ اللقطةُ تُحفظ ملفّاً على قرص المستخدم ويُعاد مسارُها — لا تُرسل.
 */
import { randomBytes } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, basename, dirname, extname, join, relative, resolve, sep } from "node:path"
import { browserSiteAllowed } from "../browser-site-policy"
import { judge } from "../mind/surface"
import { REFERENCE_ROOT, referenceDir, referenceFiles, referenceReceipt, type ReferenceCopy } from "../reference-save"

export const CHROME_BRIDGE_PROTOCOL = "2025-11-25"
export const DEFAULT_BRIDGE_PORT = 9367
export const CALL_TIMEOUT_MS = 20_000
/** ن3 — ما لا يُرفع بالنيابة عن أحد مهما كان الطلب (نسخةُ الجسر من قاعدة المحرّك). */
export const UPLOAD_SECRET_FILE = /(^|[\\/])(\.env(\..*)?|\.npmrc|\.netrc|id_(rsa|ed25519|ecdsa)(\.pub)?|.*\.(pem|key|p12|pfx|kdbx)|secrets?\.(json|ya?ml|toml)|credentials(\.json)?)$/iu

/** صيغُ الصور التي تُحفظ من الصفحة — من بايتاتها لا من ترويسة الخادم ولا من امتداد الطلب. */
export type ImageKind = "png" | "jpg" | "webp" | "gif" | "avif"
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif)$/iu

/** الصيغةُ من التوقيع السحريّ: صفحةُ خطأٍ HTML أو JSON بامتداد .png لا تُكتب صورةً. */
export const sniffImage = (bytes: Uint8Array): ImageKind | undefined => {
  const at = (i: number) => bytes[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "png"
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpg"
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "gif"
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp"
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp" && /^avi[fs]$/u.test(ascii(8, 12))) return "avif"
  return undefined
}

/**
 * أين تُكتب صورةٌ طلبها النموذج: مسارٌ نسبيٌّ داخل جذر المشروع (أو مطلقٌ تحته)، بامتداد صورة، لا ملفَّ اعتماد ولا «..» يخرج.
 * الامتدادُ يُصحَّح لاحقاً على صيغة البايتات (`placeImage`) — هنا يُحكم المكانُ فقط.
 */
export const imageTargetPath = (root: string, requested: string): Readonly<{ ok: true; abs: string; rel: string }> | Readonly<{ ok: false; why: string }> => {
  const text = requested.trim().replace(/^["'«]+|["'»]+$/gu, "")
  if (text.length === 0) return { ok: false, why: "الصيغة: image {path: \"public/images/hero.png\", wait?: 90, ref?} — المسارُ داخل المشروع" }
  const base = resolve(root)
  const abs = resolve(base, text)
  const rel = relative(base, abs)
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, why: `رُفض: ${text} خارج المشروع (${base}) — الصورُ تُحفظ داخله فقط` }
  if (UPLOAD_SECRET_FILE.test(abs)) return { ok: false, why: `رُفض: ${text} اسمُ ملفِّ اعتماد — اختر اسمَ صورة` }
  if (!IMAGE_EXT.test(abs)) return { ok: false, why: `رُفض: ${text} بلا امتداد صورة (.png/.jpg/.webp/.gif/.avif)` }
  return { ok: true, abs, rel: rel.split(sep).join("/") }
}

/**
 * 10-12 (مقيس في دور مستخدم): النموذجُ يكتب «chrome.image public/images/hero.png wait=90» نصّاً حرّاً فيصل السطرُ كلُّه في `path`
 * فيُرفض «بلا امتداد صورة» أربعَ مرّاتٍ والصورةُ جاهزة. يُفكّ السطر: المسارُ (الكلمةُ ذاتُ امتداد الصورة)، وwait بأيّ فاصل، ومرجعُ rN.
 * الحقولُ الصريحة في الكائن تغلب ما في السطر.
 */
export const imageArgs = (args: Record<string, unknown>): { path: string; ref: string; wait: number } => {
  const line = String(args.path ?? "").trim()
  const words = line.split(/\s+/u).filter((w) => w.length > 0)
  const path = words.find((w) => IMAGE_EXT.test(w.replace(/^["'«]+|["'»,]+$/gu, ""))) ?? line
  const waitText = /\bwait\s*[:=]?\s*(\d{1,3})\b/iu.exec(line)?.[1]
  const refText = words.find((w) => /^\[?r\d{1,6}\]?$/u.test(w))?.replace(/[[\]]/gu, "")
  const wait = args.wait !== undefined ? Number(args.wait) : Number(waitText ?? 0)
  return {
    path: path.replace(/^["'«]+|["'»,]+$/gu, ""),
    ref: typeof args.ref === "string" && args.ref.length > 0 ? args.ref : refText ?? "",
    wait: Math.min(120, Math.max(0, Math.trunc(wait) || 0)),
  }
}

export interface LinksPage { url?: string; title?: string; headings?: string[]; links?: { href: string; text?: string }[] }

/**
 * روابطُ صفحةٍ JSON صالحاً تحت سقفٍ — لا قصَّ نصٍّ في منتصف JSON (مقيس 10-12: «Unterminated string» على صفحة ClickUp الرئيسيّة).
 * يُسقط نصوصَ الروابط أوّلاً ثمّ يقلّل عددَها حتى يتّسع.
 */
export const fitLinks = (page: LinksPage, max: number): string => {
  let out = JSON.stringify(page)
  if (out.length <= max) return out
  const bare: LinksPage = { ...page, links: (page.links ?? []).map((l) => ({ href: l.href })) }
  out = JSON.stringify(bare)
  let count = bare.links!.length
  while (out.length > max && count > 0) { count = Math.floor(count * 0.8); out = JSON.stringify({ ...bare, links: bare.links!.slice(0, count) }) }
  return out
}

/** ما لا يُنسخ من التنزيلات إلى مشروعٍ أبداً: ملفّاتٌ تُشغَّل بنقرة. */
const EXECUTABLE_EXT = /\.(exe|msi|msix|bat|cmd|com|scr|ps1|psm1|vbs|vbe|js|jse|wsf|hta|dll|jar|sh|lnk|reg)$/iu

/** أين يُنسخ ملفٌّ نزّله زرٌّ في الصفحة: داخل المشروع، بامتداد، لا ملفَّ اعتماد ولا ملفّاً تنفيذيّاً. */
export const downloadTargetPath = (root: string, requested: string): Readonly<{ ok: true; abs: string; rel: string }> | Readonly<{ ok: false; why: string }> => {
  const text = requested.trim().replace(/^["'«]+|["'»,]+$/gu, "")
  if (text.length === 0) return { ok: false, why: "الصيغة: download {path: \"public/images/hero-full.png\", wait?: 30} — انقر زرَّ التنزيل بـtap أوّلاً" }
  const base = resolve(root)
  const abs = resolve(base, text)
  const rel = relative(base, abs)
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, why: `رُفض: ${text} خارج المشروع (${base})` }
  if (UPLOAD_SECRET_FILE.test(abs)) return { ok: false, why: `رُفض: ${text} اسمُ ملفِّ اعتماد` }
  if (EXECUTABLE_EXT.test(abs)) return { ok: false, why: `رُفض: ${text} ملفٌّ تنفيذيّ — لا يُنسخ تنزيلٌ يُشغَّل إلى المشروع` }
  if (extname(abs).length < 2) return { ok: false, why: `رُفض: ${text} بلا امتداد` }
  return { ok: true, abs, rel: rel.split(sep).join("/") }
}

/** يضبط الامتدادَ على الصيغة المقيسة: طلبُ hero.png وبايتاتٌ JPEG ⇒ hero.jpg (والإيصالُ يقول ذلك). */
export const placeImage = (target: { abs: string; rel: string }, kind: ImageKind): { abs: string; rel: string; renamed: boolean } => {
  const current = (IMAGE_EXT.exec(target.abs)?.[1] ?? "").toLowerCase().replace("jpeg", "jpg")
  if (current === kind) return { ...target, renamed: false }
  const swap = (path: string) => path.replace(IMAGE_EXT, `.${kind}`)
  return { abs: swap(target.abs), rel: swap(target.rel), renamed: true }
}

type RpcId = string | number | null
type RpcRequest = { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown> }

/**
 * `autofilled` (الإضافة ≥0.6.6): المتصفّحُ عبّأ الحقلَ بحفظه ويخفي قيمتَه عن السكربت حتى أوّل لمسة. كان `isNode` يُسقط العقدةَ كلَّها
 * بهذه الحالة (مقيس 10-10) فتختفي خانةُ كلمة المرور من الشجرة ولا يظهر تلميحُ الدخول — وهي أهمُّ حالةٍ فيها.
 */
export interface PageNode { readonly ref: string; readonly role: string; readonly name: string; readonly state?: "filled" | "empty" | "autofilled" }

/**
 * صفحةُ دخولٍ في شجرة الصفحة: حقلُ كلمة مرورٍ ظاهر. الحكمُ من حالة الحقول لا من قيمها (الإضافةُ 0.6.2 لا ترسل
 * قيمةَ كلمة المرور أبداً): معبّأةٌ بحفظ كروم ⇦ الوكيل يضغط زرَّ الدخول بنفسه؛ فارغة ⇦ يطلب من المستخدم
 * تسجيلَ الدخول في التبويب. مقيس 2026-09-17: المالك اضطرّ لضغط الزرّ بيده والحقولُ معبّأة.
 */
export const loginHint = (nodes: readonly PageNode[]): string | undefined => {
  const secret = nodes.find((n) => n.role === "textbox:password")
  if (secret === undefined) return undefined
  const submit = nodes.find((n) => n.role === "button" && /دخول|login|sign\s*in|log\s*in/iu.test(n.name))
  const button = submit === undefined ? "زرّ الدخول" : `[${submit.ref}] «${submit.name}»`
  if (secret.state === "filled" || secret.state === "autofilled") return `صفحةُ دخولٍ وحقولُها معبّأة (حفظُ المتصفّح${secret.state === "autofilled" ? " — القيمةُ مخفيّةٌ عن السكربت حتى أوّل لمسة، وهي موجودة" : ""}): اضغط ${button} بـchrome.tap بنفسك — لا تكتب شيئاً ولا تطلب من المستخدم الضغط.`
  if (secret.state === "empty") return `صفحةُ دخولٍ وكلمةُ المرور فارغة: قل للمستخدم «سجّل الدخول في هذا التبويب» وانتظره — لا تطلب كلمةَ المرور ولا تكتبها.`
  // إضافةٌ قبل 0.6.2 لا ترسل الحالة — لا يُدّعى «فارغة»؛ يُسمّى الجهلُ ويُطلب تحديثُ الإضافة.
  return `صفحةُ دخولٍ وحالةُ حقولها غيرُ معروفة (الإضافةُ أقدمُ من 0.6.2 — أعد تحميلها من chrome://extensions): اطلب من المستخدم تسجيلَ الدخول في هذا التبويب — لا تطلب كلمةَ المرور ولا تكتبها.`
}

export const MASKED_VALUE = "«محجوب»"

/**
 * S11 (2026-09-18) — إيصالُ `look` على حقل: `value` تُقرأ (innerText لـ<input> فارغٌ أبداً فكانت القيمةُ لا
 * تُقرأ إلا باللقطة). الحكمُ في الجسر لا في الإضافة: كلمةُ المرور «محجوب» **دائماً** ولو أرسلت الإضافةُ
 * قيمةً؛ وإضافةٌ قبل 0.6.5 لا ترسل `value` فتُشتقّ من الشجرة (اسمُ الحقل المعبّأ هو قيمتُه — READ_TREE).
 * نصٌّ ليس JSON يعود كما هو.
 */
export const lookReceipt = (raw: unknown, node: PageNode | undefined): string => {
  const text = typeof raw === "string" ? raw : JSON.stringify(raw)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return text }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return text
  const record = parsed as Record<string, unknown>
  if (node?.role === "textbox:password") return JSON.stringify({ ...record, value: MASKED_VALUE })
  if (node?.state !== undefined && typeof record.value !== "string") return JSON.stringify({ ...record, value: node.state === "filled" ? node.name : "" })
  return typeof raw === "string" ? raw : text
}

/** الأدواتُ كما تُعلَن للمحرّك — يسمّيها `chrome.<اسم>` بعد التطبيع. */
export const BRIDGE_TOOLS = Object.freeze([
  { name: "page", description: "قراءةُ الصفحة الفعّالة في كروم المستخدم شجرةً نصّيةً بمراجع (r1, r2…)", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "open", description: "فتحُ رابط http/https في التبويب الفعّال — يخضع لسياسة المواقع المحفوظة", inputSchema: { type: "object", properties: { url: { type: "string", minLength: 8, maxLength: 2048 } }, required: ["url"], additionalProperties: false } },
  { name: "look", description: "نصُّ الصفحة أو عنصرٍ بمرجعه مع أنماطه المحسوبة وحالةِ تركيزه", inputSchema: { type: "object", properties: { ref: { type: "string", maxLength: 12 } }, additionalProperties: false } },
  { name: "tap", description: "نقرةٌ موثوقة على عنصرٍ بمرجعه (عبر منقّح كروم — يرى المستخدم الشارة)", inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 2, maxLength: 12 } }, required: ["ref"], additionalProperties: false } },
  { name: "fill", description: "كتابةٌ موثوقة في حقلٍ بمرجعه — حقولُ الاعتماد مرفوضةٌ وتُسلَّم للمستخدم", inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 2, maxLength: 12 }, text: { type: "string", maxLength: 2000 } }, required: ["ref", "text"], additionalProperties: false } },
  { name: "key", description: "ضغطةُ مفتاحٍ باسمه (Enter, Tab, Escape, ArrowDown, F5, a…) مع مُعدِّلات اختياريّة: Control+a, Shift+Tab, Control+Enter", inputSchema: { type: "object", properties: { key: { type: "string", minLength: 1, maxLength: 40 } }, required: ["key"], additionalProperties: false } },
  // ن3 (09-15) — قائمةٌ منسدلة ورفعُ ملفّ وسحبٌ في تبويب المستخدم؛ المسارُ المرفوع مطلقٌ حُكم في المحرّك (داخل المشروع، ليس سرّاً) ويُعاد فحصُه هنا.
  { name: "select", description: "اختيارُ خيارٍ في قائمةٍ منسدلة (select) بمرجعها: بالنصّ أو القيمة؛ يُقرأ ما استقرّ", inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 2, maxLength: 12 }, text: { type: "string", minLength: 1, maxLength: 200 } }, required: ["ref", "text"], additionalProperties: false } },
  { name: "upload", description: "رفعُ ملفٍّ من قرص المستخدم إلى حقل ملفّ (input type=file) بمرجعه — مسارٌ مطلقٌ داخل المشروع، لا ملفّاتِ اعتماد", inputSchema: { type: "object", properties: { ref: { type: "string", minLength: 2, maxLength: 12 }, path: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["ref", "path"], additionalProperties: false } },
  { name: "drag", description: "سحبُ عنصرٍ بمرجعه وإفلاتُه على عنصرٍ آخر بمرجعه (ماوسٌ موثوق + أحداثُ سحب HTML5)", inputSchema: { type: "object", properties: { from: { type: "string", minLength: 2, maxLength: 12 }, to: { type: "string", minLength: 2, maxLength: 12 } }, required: ["from", "to"], additionalProperties: false } },
  { name: "scroll", description: "تمريرٌ في الصفحة: up أو down بعدد شاشات", inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] }, count: { type: "integer", minimum: 1, maximum: 10 } }, required: ["direction"], additionalProperties: false } },
  // ن5 (09-16) — التبويبات والتاريخ في متصفّح المستخدم: قائمةٌ مرقّمة، تبديلٌ/إغلاقٌ برقم، تبويبٌ جديد بسياسة المواقع، ورجوعٌ/تقدّم.
  { name: "tabs", description: "تبويباتُ النافذة الحاليّة: list (مرقّمة بالفعّال) | switch <رقم> | close <رقم> (آخرُ تبويبٍ لا يُغلق) | new <رابط>", inputSchema: { type: "object", properties: { op: { type: "string", enum: ["list", "switch", "close", "new"] }, target: { type: "string", maxLength: 24 }, url: { type: "string", minLength: 8, maxLength: 2048 } }, required: ["op"], additionalProperties: false } },
  { name: "back", description: "رجوعٌ إلى الصفحة السابقة في تاريخ التبويب الفعّال — بلا سابقةٍ يُقال", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "forward", description: "تقدّمٌ إلى الصفحة اللاحقة في تاريخ التبويب الفعّال — بلا لاحقةٍ يُقال", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "shot", description: "لقطةُ التبويب الفعّال تُحفظ PNG على قرص المستخدم ويُعاد مسارُها — full: true للصفحة كاملةً بطولها لا الشاشة الظاهرة وحدها", inputSchema: { type: "object", properties: { full: { type: "boolean" } }, additionalProperties: false } },
  // 10-10 نسخُ الصفحة كما في DevTools، وقراءةُ الكونسول والشبكة، وأكثرُ من متصفّحٍ في وقتٍ واحد.
  { name: "save", description: "حفظُ الصفحة الفعّالة مرجعاً للتصميم = DevTools «Inspect ⇦ <html> ⇦ Copy element» + كلُّ أوراق الأنماط والسكربتات، ملفّاتٍ في <المشروع>/.abdo/reference/<الموقع>/<الصفحة>/ — يعمل على الصفحات التي تحتاج دخولاً في متصفّح المستخدم", inputSchema: { type: "object", properties: { dir: { type: "string", maxLength: 200 } }, additionalProperties: false } },
  { name: "devtools", description: "ما في أدوات المطوّر للتبويب الفعّال: console (رسائلُ الكونسول والأخطاء غيرُ الممسوكة) | network (الطلباتُ بحالتها ونوعها وزمنها — تُسجَّل من أوّل نداء؛ reload: true يعيد تحميل الصفحة ليلتقط كلَّ طلباتها)", inputSchema: { type: "object", properties: { what: { type: "string", enum: ["console", "network"] }, reload: { type: "boolean" }, clear: { type: "boolean" } }, required: ["what"], additionalProperties: false } },
  { name: "browsers", description: "المتصفّحاتُ الموصولة (كروم وإيدج معاً): list (● الذي تذهب إليه الأفعال — آخرُ متصفّحٍ ركّز عليه المستخدم) | use <chrome|edge|auto> لتثبيت متصفّحٍ بعينه", inputSchema: { type: "object", properties: { op: { type: "string", enum: ["list", "use"] }, target: { type: "string", maxLength: 24 } }, required: ["op"], additionalProperties: false } },
  { name: "reload", description: "إعادةُ تحميل إضافة المتصفّح من ملفّاتها على القرص (بعد تحديثها) — تعود موصولةً بالرمز نفسه خلال ثوانٍ", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  // 2026-09-14 — تكافؤُ أدوات الفحص مع المتصفّح المملوك: تصميمُ الصفحة بالأرقام، عنصرٌ بمرجعه، قواعدُ CSS لمحدِّد، الأصول.
  // S9 (09-18) — spec: شجرةُ العناصر الظاهرة بصناديقها وأنماطها (ماشي المواصفة) لاستخراج مواصفة تصميمٍ آليّة؛ الهدفُ مرجعُ جذرٍ اختياريّ.
  // 10-12 — «ولّد صورةً من Gemini المفتوح في متصفّحي»: الصورةُ المولَّدة تُحفظ ملفّاً في المشروع (لا لقطةَ شاشة ولا SVG بديل).
  { name: "image", description: "حفظُ صورةٍ من الصفحة الفعّالة ملفّاً في المشروع: أحدثُ صورةٍ كبيرة (≥256px) لم تُحفظ بعد، أو صورةُ مرجعٍ بعينه؛ wait ينتظرها حتى تظهر (توليدُ Gemini/ChatGPT يأخذ 20–90 ث). path نسبيٌّ داخل المشروع (public/images/hero.png)", inputSchema: { type: "object", properties: { path: { type: "string", minLength: 5, maxLength: 300 }, ref: { type: "string", maxLength: 12 }, wait: { type: "integer", minimum: 0, maximum: 120 } }, required: ["path"], additionalProperties: false } },
  // 0.8.0 (10-12) — زاحفُ الموقع يقرأ روابطَ كلِّ صفحة، وزرُّ «تنزيل» يُلتقط ملفُّه إلى المشروع.
  { name: "links", description: "روابطُ الصفحة الفعّالة (حتى 400، http/https) وعنوانُها وعناوينُها h1–h3 — JSON؛ يستعمله crawl لزحف الموقع", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "download", description: "بعد نقر زرّ تنزيلٍ بـtap: ينتظر اكتمالَ ذلك التنزيل (wait ≤120 ث، الافتراض 30) وينسخه إلى path داخل المشروع — الأصلُ يبقى في مجلّد التنزيلات؛ لا ملفّاتٍ تنفيذيّة", inputSchema: { type: "object", properties: { path: { type: "string", minLength: 3, maxLength: 300 }, wait: { type: "integer", minimum: 0, maximum: 120 } }, required: ["path"], additionalProperties: false } },
  { name: "inspect", description: "فحصُ الصفحة الفعّالة: styles (التصميم بالأرقام) | dom <ref> | css <selector> | assets | spec [ref] (شجرةُ الصناديق والأنماط لمواصفة التصميم) — قراءةٌ بلا أثر", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["styles", "dom", "css", "assets", "spec"] }, target: { type: "string", maxLength: 120 } }, required: ["mode"], additionalProperties: false } },
])

export interface BridgeOptions {
  readonly port?: number
  readonly token?: string
  /** ملفُّ الإعدادات — منه تُقرأ سياسةُ المواقع؛ غيابُه = لا سياسةَ محفوظة فيُفتح http/https فقط. */
  readonly settingsFile?: string
  /** مجلّدُ الحالة على قرص المستخدم: فيه `chrome-bridge.json` (المنفذُ والرمز) واللقطات. */
  readonly stateDir?: string
  /** أين تُحفظ اللقطات (الافتراض: `<stateDir>/chrome-shots`). */
  readonly shotsDir?: string
  readonly announce?: (line: string) => void
  /**
   * لهذه المدّة (الافتراض دقيقتان؛ 0 = لا تُفتح) وعند الطلب من المحرّك (`POST /pair/open` بالرمز). أثناءها يعطي
   * `GET /pair` المنفذَ والرمزَ لمن يطلبهما على 127.0.0.1 — الإضافةُ غيرُ المقترنة تسأل كلَّ ثوانٍ فتقترن بلا لصقٍ يدويّ.
   * خارجَها 423. النافذةُ محدودةٌ زمناً لأنّ أيَّ عمليّةٍ محلّيّة تستطيع السؤال؛ وكلُّ تسليمٍ يُعلَن باسم السائل.
   */
  readonly pairingWindowMs?: number
  /** بلا نبضٍ من الإضافة خلال هذه المدّة يُعدّ المقبسُ ميتاً ويُغلق (الافتراض ٤٥ ث؛ الإضافةُ تنبض كلَّ ٢٠ ث). */
  readonly staleMs?: number
}

/** متصفّحٌ موصول: مقبسُه ونبضُه وآخرُ لحظةٍ ركّز عليه المستخدم فيها. */
interface Peer {
  readonly socket: { send(data: string): void; close(): void }
  browser: string
  version: string
  readonly connectedAt: number
  focusedAt: number
  lastSeen: number
}

interface Pending { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout>; readonly peer: Peer }

/** اسمُ المتصفّح من ترويسة User-Agent عند الترقية — تُصحّحه رسالةُ hello من الإضافة (userAgentData أدقّ). */
export const browserFromUserAgent = (ua: string): string =>
  /\bEdg(?:A|iOS)?\//u.test(ua) ? "edge" : /\bOPR\//u.test(ua) ? "opera" : /\bFirefox\//u.test(ua) ? "firefox" : /\bSafari\//u.test(ua) && !/\bChrom(?:e|ium)\//u.test(ua) ? "safari" : "chrome"

/** أقصى رسالةٍ من الإضافة: نسخةُ صفحةٍ كاملة (save) تبلغ عشرات الميغابايت؛ سقفُ Bun الافتراضيّ ١٦MB كان يقطعها. */
const MAX_EXTENSION_MESSAGE = 64 * 1024 * 1024

/** الجسر: مقبسٌ لكلّ متصفّحٍ موصول ونداءاتٌ مرقّمة بمهلة. لا يعرف MCP — تلك حلقةُ `serveChromeBridge`. */
export class ChromeBridge {
  readonly token: string
  readonly port: number
  #server: ReturnType<typeof Bun.serve> | undefined
  // 10-10 كروم وإيدج موصولان معاً. كان مقبسٌ واحد والثاني يُردّ 409، فأيُّ متصفّحٍ اتّصل أوّلاً
  // احتكر الجسر. الآن: مقبسٌ لكلّ متصفّح، والأفعالُ تذهب إلى آخرِ متصفّحٍ ركّز عليه المستخدم (أو المثبَّت بـbrowsers use).
  #peers = new Map<object, Peer>()
  #pinned: string | undefined
  #routed: Peer | undefined
  #pending = new Map<number, Pending>()
  #seq = 0
  #refs: readonly PageNode[] = []
  #generation = 1
  /** مفاتيحُ الصور المحفوظة في هذه الجلسة — تُستثنى في الطلب التالي فلا تُعاد السابقةُ والجديدةُ تُولَّد. */
  readonly #savedImages = new Set<string>()
  /** آخرُ نقرةٍ أرسلها الوكيل — التنزيلُ الذي يُلتقط هو ما بدأ بعدها (لا ما نزّله المستخدمُ قبل ساعة). */
  #lastTapAt = 0
  readonly #settingsFile: string | undefined
  readonly #stateDir: string
  readonly #shotsDir: string
  readonly #announce: (line: string) => void
  readonly #pairingWindowMs: number
  #pairingUntil = 0
  // ب8د: المقبسُ «مفتوحٌ» والإضافةُ ميتة (عاملُ الخدمة MV3 أُوقف) ⇦ `open` انتظر ٢٠ ث بلا ردّ و«connected» كذب.
  // النبضُ كلَّ ٢٠ ث من الإضافة يُبقي عاملَها حيّاً (كروم ≥116) ويجعل «متّصل» قياساً: بلا نبضٍ خلال staleMs المقبسُ ميتٌ ويُغلق.
  // (10-10: النبضُ لكلّ مقبسٍ على حدة — وإغلاقُ مقبسٍ قديم لا يمحو الجديد كما كان حين كانت الحالةُ حقلاً واحداً.)
  readonly #staleMs: number

  constructor(options: BridgeOptions = {}) {
    this.port = options.port ?? DEFAULT_BRIDGE_PORT
    this.#pairingWindowMs = options.pairingWindowMs ?? 120_000
    this.#staleMs = options.staleMs ?? 45_000
    this.#settingsFile = options.settingsFile
    // الافتراضُ مجلّدُ المستخدم لا مجلّدُ العمل: ملفُّ الرمز لا يُكتب في جذر مستودعٍ أبداً (قيس: أثرُ اختبارٍ وصل التراكبَ فأُزيل).
    this.#stateDir = resolve(options.stateDir ?? process.env.ABDO_CODE_STATE_DIR ?? join(homedir(), ".abdo"))
    // الرمزُ ثابتٌ بين التشغيلات: يُقرأ من ملفّ الحالة إن وُجد صالحاً، فالمستخدمُ يقرن الإضافةَ مرّةً لا في كلّ جلسة.
    this.token = options.token ?? persistedToken(this.#stateDir) ?? randomBytes(18).toString("base64url")
    this.#shotsDir = options.shotsDir ?? join(this.#stateDir, "chrome-shots")
    this.#announce = options.announce ?? ((line) => process.stderr.write(`${line}\n`))
  }

  /** يفتح المقبس. الرمزُ يُفحص عند الترقية وحدها — لا رسالةَ تصل قبل مطابقته. */
  start(): number {
    const bridge = this
    this.#server = Bun.serve<{ ua: string }>({
      hostname: "127.0.0.1",
      port: this.port,
      fetch(request, server) {
        const url = new URL(request.url)
        if (url.pathname === "/health") return Response.json({ ok: true, connected: bridge.connected, pairing: bridge.pairingOpen, browsers: bridge.browsers.map((b) => b.browser) })
        // ب8 — الاقترانُ الآليّ: داخل النافذة يُسلَّم المنفذُ والرمزُ لمن يسأل على 127.0.0.1 ويُعلَن التسليمُ باسم السائل؛ خارجَها 423 بلا تسريب.
        if (url.pathname === "/pair" && request.method === "GET") {
          if (!bridge.pairingOpen) return Response.json({ error: "pairing closed" }, { status: 423 })
          bridge.#announce(`chrome-bridge: pairing token handed to ${(request.headers.get("user-agent") ?? "unknown").slice(0, 120)}`)
          return Response.json({ port: bridge.#server?.port ?? bridge.port, token: bridge.token })
        }
        const presented = request.headers.get("x-abdo-bridge-token") ?? url.searchParams.get("token") ?? ""
        if (presented.length === 0 || presented.length !== bridge.token.length || !timingSafeEqualText(presented, bridge.token)) return new Response("forbidden", { status: 403 })
        if (url.pathname === "/pair/open" && request.method === "POST") { const until = bridge.openPairing(); return Response.json({ ok: true, until }) }
        if (server.upgrade(request, { data: { ua: request.headers.get("user-agent") ?? "" } })) return
        return new Response("upgrade required", { status: 426 })
      },
      websocket: {
        maxPayloadLength: MAX_EXTENSION_MESSAGE,
        open(socket) {
          const now = Date.now()
          const peer: Peer = { socket, browser: bridge.#uniqueName(browserFromUserAgent(socket.data.ua)), version: "", connectedAt: now, focusedAt: 0, lastSeen: now }
          bridge.#peers.set(socket, peer)
          bridge.#announce(`chrome-bridge: extension connected (${peer.browser})`)
        },
        message(socket, raw) { bridge.#onMessage(socket, String(raw)) },
        close(socket) {
          const peer = bridge.#peers.get(socket)
          if (peer === undefined) return
          bridge.#peers.delete(socket)
          bridge.#failFor(peer, new Error(`extension disconnected (${peer.browser})`))
          bridge.#announce(`chrome-bridge: extension disconnected (${peer.browser})`)
        },
      },
    })
    const port = this.#server.port ?? this.port
    if (this.#pairingWindowMs > 0) this.openPairing(this.#pairingWindowMs)
    // الرمزُ يصل المستخدمَ من ملفٍّ على قرصه لا من stderr (المحرّكُ يُهمل stderr خادمِ MCP): النافذةُ المنبثقة للإضافة
    // تطلب لصقَه، ولوحةُ الإعدادات تقرؤه من هنا. الملفُّ في مجلّد الحالة وحده.
    try {
      mkdirSync(this.#stateDir, { recursive: true })
      writeFileSync(join(this.#stateDir, "chrome-bridge.json"), `${JSON.stringify({ version: 1, port, token: this.token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2)}\n`, "utf8")
    } catch { /* الملفُّ مساعِد: غيابُه لا يمنع الجسر، والمستخدمُ يرى الرمز في stderr إن شغّله بيده */ }
    this.#announce(`chrome-bridge: listening on ws://127.0.0.1:${port} — token ${this.token} (also in chrome-bridge.json)`)
    return port
  }

  stop(): void {
    this.#failAll(new Error("bridge stopped"))
    for (const peer of this.#peers.values()) { try { peer.socket.close() } catch { /* مغلق */ } }
    this.#peers.clear()
    this.#server?.stop(true)
    this.#server = undefined
  }

  /** المتصفّحاتُ الحيّة: من صمت أطولَ من staleMs يُغلق مقبسُه ويُسقط هنا (قياسٌ لا حالة). */
  #live(): Peer[] {
    const now = Date.now()
    for (const [key, peer] of this.#peers) {
      if (now - peer.lastSeen <= this.#staleMs) continue
      this.#announce(`chrome-bridge: extension (${peer.browser}) silent for ${Math.round((now - peer.lastSeen) / 1000)}s — socket dropped`)
      this.#peers.delete(key)
      try { peer.socket.close() } catch { /* ميتٌ أصلاً */ }
      this.#failFor(peer, new Error("extension stale"))
    }
    return [...this.#peers.values()]
  }

  /** إلى أين يذهب الفعل: المثبَّتُ إن كان موصولاً، وإلّا آخرُ متصفّحٍ ركّز عليه المستخدم، وإلّا آخرُ من اتّصل. */
  #current(): Peer | undefined {
    const live = this.#live()
    const pinned = this.#pinned === undefined ? undefined : live.find((p) => p.browser === this.#pinned)
    return pinned ?? live.sort((a, b) => b.focusedAt - a.focusedAt || b.connectedAt - a.connectedAt)[0]
  }

  #uniqueName(base: string, self?: Peer): string {
    const taken = new Set([...this.#peers.values()].filter((p) => p !== self).map((p) => p.browser))
    if (!taken.has(base)) return base
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  }

  /** «متّصل» قياسٌ لا حالة: مقبسٌ مفتوح **ونبضٌ حديث** في متصفّحٍ واحدٍ على الأقلّ. */
  get connected(): boolean { return this.#live().length > 0 }
  /** المتصفّحاتُ الموصولة الآن، والحاليُّ أوّلها. */
  get browsers(): readonly { browser: string; version: string; current: boolean }[] {
    const current = this.#current()
    return this.#live().map((p) => ({ browser: p.browser, version: p.version, current: p === current })).sort((a, b) => Number(b.current) - Number(a.current))
  }
  get refs(): readonly PageNode[] { return this.#refs }
  get pairingOpen(): boolean { return Date.now() < this.#pairingUntil }
  /** يفتح نافذةَ الاقتران (أو يمدّها) ويعيد لحظةَ إغلاقها. */
  openPairing(ms = 120_000): number { this.#pairingUntil = Date.now() + Math.max(0, ms); this.#announce(`chrome-bridge: pairing window open for ${Math.round(Math.max(0, ms) / 1000)}s`); return this.#pairingUntil }

  #onMessage(socket: object, raw: string): void {
    const peer = this.#peers.get(socket)
    if (peer === undefined) return
    let message: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown; kind?: unknown; browser?: unknown; version?: unknown }
    try { message = JSON.parse(raw) } catch { return }
    peer.lastSeen = Date.now()
    if (message.kind === "ping") { try { peer.socket.send(JSON.stringify({ kind: "pong", at: peer.lastSeen })) } catch { /* المقبسُ يُغلق */ } return }
    if (message.kind === "hello") {
      const named = typeof message.browser === "string" && /^[a-z]{2,12}$/u.test(message.browser) ? message.browser : undefined
      if (named !== undefined && !peer.browser.startsWith(named)) { const was = peer.browser; peer.browser = this.#uniqueName(named, peer); this.#announce(`chrome-bridge: ${was} is ${peer.browser}`) }
      if (typeof message.version === "string") peer.version = message.version.slice(0, 16)
      return
    }
    if (message.kind === "focus") { peer.focusedAt = peer.lastSeen; return }
    if (typeof message.id !== "number") return
    const pending = this.#pending.get(message.id)
    if (pending === undefined || pending.peer !== peer) return
    this.#pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok === true) pending.resolve(message.result)
    else pending.reject(new Error(typeof message.error === "string" ? message.error.slice(0, 300) : "extension error"))
  }

  #failFor(peer: Peer, error: Error): void {
    for (const [id, p] of this.#pending) if (p.peer === peer) { clearTimeout(p.timer); p.reject(error); this.#pending.delete(id) }
  }

  #failAll(error: Error): void {
    for (const [id, p] of this.#pending) { clearTimeout(p.timer); p.reject(error); this.#pending.delete(id) }
  }

  /** نداءٌ خامّ إلى الإضافة — بلا حراسة؛ الحراسةُ في `run`. */
  send(action: string, args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    // الاتّصالُ يُقاس لحظةَ الإرسال (النبض): مقبسٌ صامتٌ يُغلق هنا فيسمّى الخطأُ بدل انتظارٍ ٢٠ ث بلا ردّ.
    const peer = this.#current()
    if (peer === undefined) return Promise.reject(new Error("لا إضافةَ موصولة (أو صمتت أطولَ من المهلة) — افتح المتصفّح وسينبض عاملُ الإضافة ويعود، أو نفّذ: bridge pair"))
    const id = ++this.#seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.#pending.delete(id)) reject(new Error(`الإضافة (${peer.browser}) لم تُجب ${action} خلال ${timeoutMs}ms`)) }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer, peer })
      peer.socket.send(JSON.stringify({ id, action, args }))
    })
  }

  /** قبل كلّ أداة: إن تبدّل المتصفّحُ الذي تذهب إليه الأفعال بطلت مراجعُ الصفحة (شجرةُ متصفّحٍ آخر). يعيد اسمَه للإيصال. */
  #route(): string {
    const peer = this.#current()
    if (peer !== undefined && this.#routed !== undefined && peer !== this.#routed) { this.#refs = []; this.#generation += 1 }
    if (peer !== undefined) this.#routed = peer
    return peer?.browser ?? ""
  }

  /** الأداةُ المحروسة: الحارسُ والسياسةُ هنا، والإضافةُ تنفّذ فقط. يعود نصّاً للنموذج. */
  async run(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === "browsers") return this.#browsersTool(args)
    const where = this.#route()
    const others = this.#peers.size > 1 ? ` (${where})` : ""
    switch (name) {
      case "page": {
        const nodes = await this.send("page", {})
        this.#refs = Array.isArray(nodes) ? nodes.filter(isNode).slice(0, 200) : []
        this.#generation += 1
        if (this.#refs.length === 0) return "صفحةٌ بلا عناصر قابلة للقيادة"
        const hint = loginHint(this.#refs)
        const stateWord = (n: PageNode) => n.state === "filled" ? " (معبّأ)" : n.state === "autofilled" ? " (معبّأ بحفظ المتصفّح)" : n.state === "empty" ? " (فارغ)" : ""
        return `جيل ${this.#generation}${others} — ${this.#refs.length} عنصراً:\n${this.#refs.map((n) => `[${n.ref}] ${n.role}${n.name ? `: ${n.name}` : ""}${stateWord(n)}`).join("\n")}${hint === undefined ? "" : `\n⚑ ${hint}`}`
      }
      case "open": {
        const url = String(args.url ?? "")
        const verdict = judge({ generation: this.#generation }, { kind: "navigate", url, origin: "operator" })
        if (!verdict.ok) return `العقد رفض: ${verdict.why}`
        if (this.#settingsFile !== undefined && !browserSiteAllowed(this.#settingsFile, url)) return "Navigation blocked by saved site permissions"
        // الإضافةُ تنتظر اكتمالَ التحميل حتى ٢٥ ث — المهلةُ هنا أطولُ منها كي يصل ردُّها لا خطأُ مهلة (كانت ٢٠ ث = أقصرَ من انتظار الإضافة).
        const opened = await this.send("open", { url }, 35_000) as { newTab?: boolean } | boolean | null
        this.#refs = []
        this.#generation += 1
        // الإضافةُ ≥0.7.2 لا تستبدل تبويبَ المستخدم: رابطٌ خارج تبويبات الوكيل يُفتح في تبويبٍ جديد — والإيصالُ يقول أين.
        const where2 = typeof opened === "object" && opened !== null && opened.newTab === true ? "فتحتُه في تبويبٍ جديد (تبويبُ المستخدم لم يُستبدل)" : "انتقلتُ"
        return `${where2} في متصفّح المستخدم${others} — الجيل ${this.#generation}، والمراجعُ القديمة بطلت. استعمل chrome.page لقراءة الصفحة.`
      }
      case "look": {
        const ref = typeof args.ref === "string" ? args.ref : ""
        if (ref.length > 0 && this.#node(ref) === undefined) return `مرجعٌ غير معروف «${ref}» — اقرأ الصفحة بـchrome.page أوّلاً`
        const text = await this.send("look", ref.length > 0 ? { ref } : {})
        return lookReceipt(text, ref.length > 0 ? this.#node(ref) : undefined).slice(0, 8000)
      }
      case "tap": {
        const ref = String(args.ref ?? ""); const node = this.#node(ref)
        if (node === undefined) return `مرجعٌ غير معروف «${ref}» — اقرأ الصفحة بـchrome.page أوّلاً`
        const verdict = judge({ generation: this.#generation }, { kind: "click", ref, generation: this.#generation })
        if (!verdict.ok) return `العقد رفض: ${verdict.why}`
        this.#lastTapAt = Date.now()
        const tapped = await this.send("tap", { ref })
        return `نقرتُ «${node.name || node.role}» في متصفّح المستخدم ${inputMode(tapped)}.`
      }
      case "fill": {
        const ref = String(args.ref ?? ""); const node = this.#node(ref); const text = String(args.text ?? "")
        if (node === undefined) return `مرجعٌ غير معروف «${ref}» — اقرأ الصفحة بـchrome.page أوّلاً`
        const verdict = judge({ generation: this.#generation }, { kind: "type", ref, generation: this.#generation, text, field: `${node.name} ${node.role}` })
        // الحارسُ قبل الإرسال: حقلُ اعتمادٍ لا يصل الإضافةَ أصلاً.
        if (!verdict.ok) return `العقد رفض: ${verdict.why} — اطلب من المستخدم أن يكتبه بيده في كروم ثم يخبرك.`
        const filled = await this.send("fill", { ref, text })
        return `كتبتُ في «${node.name || node.role}» في متصفّح المستخدم ${inputMode(filled)}.`
      }
      case "key": {
        const key = String(args.key ?? "")
        if (!KEY_SHAPE.test(key)) return "الصيغة: key <Enter|Tab|Escape|ArrowDown|F5|a…> ومُعدِّلاتٌ اختياريّة: Control+a، Shift+Tab، Control+Enter"
        const pressed = await this.send("key", { key })
        return `ضغطتُ ${key} في متصفّح المستخدم ${inputMode(pressed)}.`
      }
      case "select": {
        const ref = String(args.ref ?? ""); const node = this.#node(ref); const text = String(args.text ?? "").trim()
        if (node === undefined) return `مرجعٌ غير معروف «${ref}» — اقرأ الصفحة بـchrome.page أوّلاً`
        if (text.length === 0) return "الصيغة: select {ref, text}"
        const verdict = judge({ generation: this.#generation }, { kind: "select", ref, generation: this.#generation, choice: text })
        if (!verdict.ok) return `العقد رفض: ${verdict.why}`
        const r = await this.send("select", { ref, text }) as { ok?: boolean; why?: string; picked?: string; value?: string; options?: string[] } | null
        if (r === null || r === undefined) return `تعذّر الاختيارُ في «${node.name || node.role}» — العنصرُ لم يعد في الصفحة؛ أعد chrome.page`
        if (r.ok !== true && r.why === "not-select") return `«${node.name || node.role}» ليس قائمةً منسدلةً أصليّة — افتحها بـtap ثمّ اختر الظاهرَ بـtap أو key`
        if (r.ok !== true) return `لا خيارَ يطابق «${text.slice(0, 40)}» في «${node.name || node.role}». الخياراتُ: ${(r.options ?? []).slice(0, 20).join(" | ")}`
        return `اخترتُ «${r.picked ?? ""}» (القيمة «${String(r.value ?? "").slice(0, 40)}») في «${node.name || node.role}» في متصفّح المستخدم وقرأتُ القائمةَ بعدها.`
      }
      case "upload": {
        const ref = String(args.ref ?? ""); const node = this.#node(ref); const path = String(args.path ?? "")
        if (node === undefined) return `مرجعٌ غير معروف «${ref}» — اقرأ الصفحة بـchrome.page أوّلاً`
        if (!isAbsolute(path) || !existsSync(path) || UPLOAD_SECRET_FILE.test(path)) return `رُفض الرفع: المسارُ ليس مطلقاً موجوداً غيرَ سرّيّ — ${path.slice(0, 120)}`
        const verdict = judge({ generation: this.#generation }, { kind: "upload", ref, generation: this.#generation, file: basename(path) })
        if (!verdict.ok) return `العقد رفض: ${verdict.why}`
        const r = await this.send("upload", { ref, path }) as { ok?: boolean; why?: string; files?: string[] } | null
        if (r === null || r === undefined) return `تعذّر الرفعُ إلى «${node.name || node.role}» — العنصرُ لم يعد في الصفحة؛ أعد chrome.page`
        if (r.ok !== true) return r.why === "not-file" ? `«${node.name || node.role}» ليس حقلَ ملفّ (input type=file)` : `تعذّر الرفع: ${r.why ?? ""}`
        return `رفعتُ «${basename(path)}» إلى «${node.name || node.role}» في متصفّح المستخدم وقرأتُ الحقلَ بعدها: ${(r.files ?? []).join("، ")}.`
      }
      case "drag": {
        const from = String(args.from ?? ""); const to = String(args.to ?? ""); const a = this.#node(from); const b = this.#node(to)
        if (a === undefined || b === undefined) return `مرجعٌ غير معروف «${a === undefined ? from : to}» — اقرأ الصفحة بـchrome.page أوّلاً`
        const verdict = judge({ generation: this.#generation }, { kind: "drag", ref: from, to, generation: this.#generation })
        if (!verdict.ok) return `العقد رفض: ${verdict.why}`
        const r = await this.send("drag", { from, to })
        return `سحبتُ «${a.name || a.role}» وأفلتُّه على «${b.name || b.role}» في متصفّح المستخدم ${inputMode(r)}.`
      }
      case "scroll": {
        const direction = args.direction === "up" ? "up" : "down"
        const count = Math.min(10, Math.max(1, Number(args.count) || 1))
        await this.send("scroll", { direction, count })
        return `مرّرتُ ${direction} ×${count} في كروم المستخدم.`
      }
      case "tabs": {
        const op = String(args.op ?? "list")
        if (op === "list") {
          const raw = await this.send("tabs", { op: "list" })
          const tabs = (Array.isArray(raw) ? raw : []) as { index: number; title?: string; url?: string; active?: boolean }[]
          return tabs.length === 0 ? "لا تبويباتٍ في نافذة المتصفّح الحاليّة." : `${tabs.length} تبويباً في متصفّح المستخدم (● الفعّال):\n${tabs.map((t) => `${t.index}. ${t.active ? "●" : "○"} ${t.title || "(بلا عنوان)"} — ${t.url ?? ""}`).join("\n")}`
        }
        if (op === "switch" || op === "close") {
          const target = String(args.target ?? "")
          if (target.length === 0) return `الصيغة: tabs {op: "${op}", target: <رقم من tabs list>}`
          const r = await this.send("tabs", { op, target }) as { title?: string; url?: string; last?: boolean } | null
          if (r === null || r === undefined) return `لا تبويبَ رقمه «${target}» — أعد tabs list`
          if (r.last === true) return "لم أغلق: آخرُ تبويبٍ في النافذة لا يُغلق."
          this.#refs = []
          this.#generation += 1
          return op === "switch"
            ? `انتقلتُ إلى التبويب ${target} «${r.title ?? ""}» (${r.url ?? ""}) في متصفّح المستخدم — الجيل ${this.#generation}، والمراجعُ القديمة بطلت؛ اقرأه بـchrome.page.`
            : `أغلقتُ التبويب ${target} «${r.title ?? ""}» في متصفّح المستخدم — الجيل ${this.#generation}؛ اقرأ الفعّالَ بـchrome.page.`
        }
        if (op === "new") {
          const url = String(args.url ?? "")
          const verdict = judge({ generation: this.#generation }, { kind: "navigate", url, origin: "operator" })
          if (!verdict.ok) return `العقد رفض: ${verdict.why}`
          if (this.#settingsFile !== undefined && !browserSiteAllowed(this.#settingsFile, url)) return "Navigation blocked by saved site permissions"
          await this.send("tabs", { op: "new", url })
          this.#refs = []
          this.#generation += 1
          return `فتحتُ تبويباً جديداً (${url}) في متصفّح المستخدم وانتقلتُ إليه — الجيل ${this.#generation}؛ اقرأه بـchrome.page.`
        }
        return "الصيغة: tabs {op: list|switch|close|new, target?, url?}"
      }
      case "back":
      case "forward": {
        const r = await this.send(name, {}) as { moved?: boolean; url?: string; title?: string } | null
        if (r === null || r === undefined || r.moved !== true) return `لم أنتقل: لا صفحةَ ${name === "back" ? "سابقة" : "لاحقة"} في تاريخ هذا التبويب`
        this.#refs = []
        this.#generation += 1
        return `${name === "back" ? "رجعتُ" : "تقدّمتُ"} إلى «${r.title ?? ""}» (${r.url ?? ""}) في متصفّح المستخدم — الجيل ${this.#generation}، والمراجعُ القديمة بطلت؛ اقرأها بـchrome.page.`
      }
      case "inspect": {
        const mode = String(args.mode ?? "styles")
        if (!["styles", "dom", "css", "assets", "spec"].includes(mode)) return "الصيغة: inspect {mode: styles|dom|css|assets|spec, target?}"
        const target = typeof args.target === "string" ? args.target.slice(0, 120) : ""
        if ((mode === "dom" || (mode === "spec" && target.length > 0)) && this.#node(target) === undefined) return `مرجعٌ غير معروف «${target}» — اقرأ الصفحة بـchrome.page أوّلاً`
        const raw = await this.send("inspect", { mode, target })
        const text = typeof raw === "string" ? raw : raw === null || raw === undefined ? "" : JSON.stringify(raw)
        const label = mode === "styles" ? "تصميمُ الصفحة" : mode === "dom" ? `عنصرُ ${target}` : mode === "css" ? "قواعدُ CSS المطابقة" : mode === "spec" ? "شجرةُ المواصفة" : "أصولُ الصفحة"
        if (text.length === 0) return `${label}: لا شيء — ${mode === "dom" || mode === "spec" ? "المرجعُ لم يعد في الصفحة" : "الصفحةُ لم تُعطِ شيئاً"}`
        // spec يُستهلك آليّاً (design spec) لا يقرؤه النموذج — لا يُقصّ كي يبقى JSON صحيحاً؛ سقفٌ واحد للحجم فقط.
        return `${label} (تبويبُ المستخدم، جيل ${this.#generation}):\n${mode === "spec" ? text.slice(0, 600_000) : text.slice(0, 7000)}`
      }
      case "reload": {
        // إضافةٌ أقدم من 0.6.3 تردّ «unknown action» خطأً — يُسمّى بعمره لا بنصّه (مقيس 09-17: ظهر للنموذج «unknown action» عارياً).
        let r: { ok?: boolean; version?: string } | null
        try { r = await this.send("reload", {}, 5_000) as { ok?: boolean; version?: string } | null } catch (error) {
          if (/unknown action/iu.test(String(error instanceof Error ? error.message : error))) r = null
          else throw error
        }
        if (r === null || r === undefined || r.ok !== true) return "الإضافةُ لم تقبل إعادةَ التحميل — أقدمُ من 0.6.3؛ أعد تحميلها مرّةً من chrome://extensions وبعدها يتولّى عبدو كود ذلك."
        this.#refs = []
        this.#generation += 1
        return `طلبتُ من الإضافة (${r.version ?? "?"}) إعادةَ تحميل نفسها من قرصها — ستنقطع ثوانيَ ثمّ تعود موصولةً؛ انتظر بـchrome.tabs قبل أيّ فعل، والمراجعُ القديمة بطلت.`
      }
      case "shot": {
        const full = args.full === true
        const dataUrl = await this.send("shot", full ? { full: true } : {}, full ? 60_000 : CALL_TIMEOUT_MS)
        const data = typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,") ? dataUrl.slice("data:image/png;base64,".length) : ""
        if (data.length === 0) return "تعذّرت اللقطة — الإضافة لم تُعطِ صورة"
        mkdirSync(this.#shotsDir, { recursive: true })
        const file = join(this.#shotsDir, `${where || "chrome"}-${full ? "full-" : ""}${Date.now()}.png`)
        writeFileSync(file, Buffer.from(data, "base64"))
        return `حُفظت لقطةُ ${full ? "الصفحة كاملةً" : "التبويب"}${others} على قرصك: ${file} (${Math.round(data.length * 3 / 4)} بايت) — لا تُرسل إلى أحد.`
      }
      case "links": {
        let r: unknown
        try { r = await this.send("links", {}) } catch (error) {
          if (/unknown action/iu.test(String(error instanceof Error ? error.message : error))) return "الإضافةُ أقدمُ من 0.8.0 ولا تعرف links — حدّث ملفّاتها ثمّ chrome.reload"
          throw error
        }
        if (r === null || typeof r !== "object") return "تعذّرت قراءةُ روابط الصفحة — الإضافةُ لم تُعطِ شيئاً"
        return fitLinks(r as LinksPage, 150_000)
      }
      case "download": {
        const line = String(args.path ?? "").trim()
        const requested = line.split(/\s+/u).find((w) => /\.[A-Za-z0-9]{1,8}["'»,]*$/u.test(w)) ?? line
        const waitText = /\bwait\s*[:=]?\s*(\d{1,3})\b/iu.exec(line)?.[1]
        const wait = Math.min(120, Math.max(0, Math.trunc(Number(args.wait ?? waitText ?? 30)) || 0))
        const target = downloadTargetPath(this.#projectRoot(), requested)
        if (!target.ok) return target.why
        const since = (this.#lastTapAt > 0 ? this.#lastTapAt : Date.now()) - 5_000
        let r: { filename?: unknown; bytes?: unknown; mime?: unknown } | null
        try { r = await this.send("download", { since, wait }, (wait + 20) * 1000) as typeof r } catch (error) {
          if (/unknown action/iu.test(String(error instanceof Error ? error.message : error))) return "الإضافةُ أقدمُ من 0.8.0 ولا تعرف download — حدّث ملفّاتها ثمّ chrome.reload"
          throw error
        }
        if (r === null || r === undefined || typeof r.filename !== "string") return `لم يكتمل تنزيلٌ جديد خلال ${wait} ث${others} — انقر زرَّ التنزيل بـchrome.tap أوّلاً ثمّ أعد chrome.download`
        const source = r.filename
        if (!existsSync(source)) return `اكتمل التنزيلُ لكنّ ملفَّه غيرُ موجود على القرص (${basename(source)}) — لعلّ المستخدمَ نقله أو حذفه`
        if (EXECUTABLE_EXT.test(source)) return `رُفض: التنزيلُ ${basename(source)} ملفٌّ تنفيذيّ — لا يُنسخ إلى المشروع`
        const bytes = statSync(source).size
        if (bytes > 100 * 1024 * 1024) return `رُفض: التنزيلُ ${basename(source)} أكبرُ من 100MB (${bytes} بايت)`
        mkdirSync(dirname(target.abs), { recursive: true })
        copyFileSync(source, target.abs)
        return `نُسخ التنزيلُ ${basename(source)} (${bytes} بايت) إلى ${target.rel}${others} — الأصلُ باقٍ في مجلّد التنزيلات.`
      }
      case "image": {
        const { path, ref, wait } = imageArgs(args)
        if (ref.length > 0 && this.#node(ref) === undefined) return `مرجعٌ غير معروف «${ref}» — اقرأ الصفحة بـchrome.page أوّلاً`
        const target = imageTargetPath(this.#projectRoot(), path)
        if (!target.ok) return target.why
        let r: { data?: unknown; key?: unknown; src?: unknown; mime?: unknown; width?: unknown; height?: unknown } | null
        try { r = await this.send("image", { ref, wait, exclude: [...this.#savedImages], minSide: 256 }, (wait + 40) * 1000) as typeof r }
        catch (error) {
          if (/unknown action/iu.test(String(error instanceof Error ? error.message : error))) return "الإضافةُ أقدمُ من 0.7.1 ولا تعرف image — حدّث ملفّاتها ثمّ chrome.reload، وأعد المحاولة"
          throw error
        }
        if (r === null || r === undefined || typeof r.data !== "string" || r.data.length === 0) {
          return wait > 0
            ? `لم تظهر صورةٌ جديدة (≥256px) في الصفحة خلال ${wait} ث${others} — اقرأها بـchrome.page: هل رفض الموقعُ الطلب أو طلب الدخول؟ لا تختلق صورة.`
            : `لا صورةَ جديدة (≥256px) في الصفحة الآن${others} — إن كانت تُولَّد فأعد بـwait: 90`
        }
        const bytes = Buffer.from(r.data, "base64")
        const kind = sniffImage(bytes)
        if (kind === undefined) return `ما أعادته الصفحةُ ليس صورة (${String(r.mime ?? "نوعٌ مجهول").slice(0, 40)}، ${bytes.length} بايت) — لم يُكتب شيء`
        const placed = placeImage(target, kind)
        mkdirSync(dirname(placed.abs), { recursive: true })
        writeFileSync(placed.abs, bytes)
        if (typeof r.key === "string") this.#savedImages.add(r.key)
        const size = typeof r.width === "number" && typeof r.height === "number" ? `${r.width}×${r.height}، ` : ""
        const from = String(r.src ?? "").slice(0, 90)
        return `حُفظت الصورة من متصفّح المستخدم${others} في ${placed.rel} (${kind}، ${size}${bytes.length} بايت)${from.length > 0 ? ` — المصدر ${from}` : ""}${placed.renamed ? ` — طلبتَ ${target.rel} والصورةُ ${kind} فصُحّح الامتداد؛ استعمل ${placed.rel}` : ""}.`
      }
      case "save": {
        const copy = await this.send("save", {}, 120_000) as ReferenceCopy | null
        if (copy === null || typeof copy !== "object" || typeof copy.html !== "string" || typeof copy.url !== "string") return "تعذّر نسخُ الصفحة — الإضافة لم تُعطِ HTML (أقدمُ من 0.7.0؟ أعد تحميلها بـchrome.reload)"
        const placed = referenceDir(typeof args.dir === "string" ? args.dir : "", copy.url)
        if (!placed.ok) return placed.why
        // المشروعُ الحاليّ من ملفّ الإعدادات؛ والكتابةُ تحت .abdo/reference وحدها (referenceDir يرفض المطلقَ و«..»). بلا مشروعٍ: مجلّدُ الحالة.
        const root = this.#projectRoot()
        const written: string[] = [], refused: string[] = []
        for (const f of referenceFiles(copy, placed.dir, `browser extension (${where}): document.documentElement.outerHTML as DevTools Copy element + stylesheet and script texts`)) {
          const target = resolve(root, f.path)
          if (!target.startsWith(resolve(root, REFERENCE_ROOT))) { refused.push(`${f.path}: خارج ${REFERENCE_ROOT}`); continue }
          try { mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, f.content, "utf8"); written.push(`${f.path} (${f.content.length} حرفاً)`) }
          catch (error) { refused.push(`${f.path}: ${String(error instanceof Error ? error.message : error).slice(0, 120)}`) }
        }
        return referenceReceipt(copy, placed.dir, written, refused, ` في متصفّح المستخدم${others}`) + (root === this.#stateDir ? `\n(لا مشروعَ في الإعدادات — كُتبت تحت ${root})` : "")
      }
      case "devtools": {
        const what = args.what === "network" ? "network" : args.what === "console" ? "console" : ""
        if (what === "") return "الصيغة: devtools {what: console|network, reload?, clear?}"
        const r = await this.send("devtools", { what, reload: args.reload === true, clear: args.clear === true }, 45_000) as { started?: boolean; entries?: unknown[]; dropped?: number; url?: string } | null
        if (r === null || typeof r !== "object" || !Array.isArray(r.entries)) return "تعذّرت قراءةُ أدوات المطوّر — الإضافة أقدمُ من 0.7.0 أو بلا صلاحيّة debugger (سفاري/فايرفوكس)"
        const lines = r.entries.slice(-120).map((e) => maskSecrets(devtoolsLine(what, e)))
        const head = `${what === "console" ? "الكونسول" : "الشبكة"}${others} — ${r.url ?? ""}: ${r.entries.length} سطراً${r.dropped ? ` (أُسقط ${r.dropped} أقدم)` : ""}`
        const note = r.started === true && what === "network" && args.reload !== true ? "\n(بدأ التسجيلُ الآن — ما طُلب قبل هذا النداء لا يظهر؛ أعد بـreload: true لالتقاط كلّ طلبات الصفحة)" : ""
        return `${head}${note}\n${lines.length === 0 ? "(لا شيء)" : lines.join("\n")}`.slice(0, 12_000)
      }
      default:
        return `أداةُ جسرٍ مجهولة: ${name}`
    }
  }

  #node(ref: string): PageNode | undefined { return this.#refs.find((n) => n.ref === ref) }

  #browsersTool(args: Record<string, unknown>): string {
    const op = String(args.op ?? "list")
    if (op === "use") {
      const target = String(args.target ?? "").trim().toLowerCase()
      if (target === "auto" || target === "") { this.#pinned = undefined; return `الأفعالُ تتبع آخرَ متصفّحٍ يركّز عليه المستخدم.\n${this.#browsersTool({ op: "list" })}` }
      if (!this.#live().some((p) => p.browser === target)) return `لا متصفّحَ موصولاً باسم «${target.slice(0, 24)}».\n${this.#browsersTool({ op: "list" })}`
      this.#pinned = target
      return `ثبّتُّ الأفعالَ على ${target} حتى «browsers use auto».\n${this.#browsersTool({ op: "list" })}`
    }
    const list = this.browsers
    if (list.length === 0) return "لا متصفّحَ موصولاً — افتح كروم أو إيدج والإضافةُ فيه تتّصل خلال ثوانٍ (أو: bridge pair)."
    return `${list.length} متصفّحاً موصولاً (● تذهب إليه الأفعال${this.#pinned === undefined ? " — آخرُ من ركّز عليه المستخدم" : ` — مثبَّت: ${this.#pinned}`}):\n${list.map((b) => `${b.current ? "●" : "○"} ${b.browser}${b.version ? ` (الإضافة ${b.version})` : ""}`).join("\n")}`
  }

  /** جذرُ المشروع الحاليّ من ملفّ الإعدادات (`project`) — وإلّا مجلّدُ الحالة. */
  #projectRoot(): string {
    try {
      const project = (JSON.parse(readFileSync(this.#settingsFile ?? "", "utf8")) as { project?: unknown }).project
      if (typeof project === "string" && isAbsolute(project) && existsSync(project)) return resolve(project)
    } catch { /* لا إعدادات */ }
    return this.#stateDir
  }
}

/** شكلُ `key`: اسمُ مفتاحٍ أو حرفٌ/رقمٌ أو F1–F12، مسبوقٌ بمُعدِّلاتٍ اختياريّة. */
export const KEY_SHAPE = /^(?:(?:Control|Ctrl|Alt|Shift|Meta|Cmd)\+){0,3}(?:[A-Za-z]{2,16}|[A-Za-z0-9]|F(?:[1-9]|1[0-2]))$/u

/** سطرٌ من الكونسول أو الشبكة كما تعيده الإضافة — نصٌّ قصير للنموذج. */
const devtoolsLine = (what: "console" | "network", entry: unknown): string => {
  const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>
  const s = (v: unknown, n = 300) => String(v ?? "").replace(/\s+/gu, " ").slice(0, n)
  if (what === "console") return `[${s(e.level, 10)}] ${s(e.text, 400)}${e.at ? ` — ${s(e.at, 160)}` : ""}`
  return `${s(e.method, 8)} ${e.failed ? `✕ ${s(e.failed, 60)}` : s(e.status ?? "…", 4)} ${s(e.type, 12)} ${s(e.url, 240)}${typeof e.ms === "number" ? ` ${Math.round(e.ms)}ms` : ""}${typeof e.bytes === "number" ? ` ${e.bytes}B` : ""}`
}

/**
 * ما يُقرأ من الكونسول والشبكة يصل النموذج — والروابطُ والرسائلُ تحمل أحياناً رموزاً (token=…، Bearer …، JWT، sk-…).
 * الحجبُ هنا في الجسر لا في الإضافة، كحجب كلمة المرور في look.
 */
export const maskSecrets = (text: string): string => text
  .replace(/([?&#](?:access_token|id_token|refresh_token|token|code|key|api_key|apikey|secret|password|pass|auth|sig|signature|session|sid)=)[^&#\s]+/giu, "$1«محجوب»")
  .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gu, "$1 «محجوب»")
  .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "«JWT محجوب»")
  .replace(/\b(?:sk|pk|rk|ghp|gho|github_pat|xox[bpas])[-_][A-Za-z0-9_-]{16,}\b/gu, "«مفتاح محجوب»")

/** رمزُ اقترانٍ سابق من `chrome-bridge.json` — نصٌّ base64url بطول ٢٤ فأكثر، وإلا لا شيء. */
export function persistedToken(stateDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "chrome-bridge.json"), "utf8")) as { token?: unknown }
    return typeof parsed.token === "string" && /^[A-Za-z0-9_-]{24,64}$/.test(parsed.token) ? parsed.token : undefined
  } catch { return undefined }
}

/** ما تعرضه لوحةُ الإعدادات: المنفذُ والرمزُ من ملفّ الحالة — أو لا شيء إن لم يُشغَّل الجسر بعد. */
export function readBridgePairing(stateDir: string): { port: number; token: string; startedAt: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "chrome-bridge.json"), "utf8")) as { port?: unknown; token?: unknown; startedAt?: unknown }
    if (typeof parsed.port !== "number" || typeof parsed.token !== "string") return undefined
    return { port: parsed.port, token: parsed.token, startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "" }
  } catch { return undefined }
}

/** الإضافةُ تعلن كيف أُدخل الفعل: `trusted` عبر المنقّح (كروم/إيدج) أو `synthetic` بأحداث DOM (سفاري) — والنموذجُ يُخبَر بالفرق. */
const inputMode = (reply: unknown): string => {
  const mode = typeof reply === "object" && reply !== null ? (reply as { mode?: unknown }).mode : undefined
  return mode === "synthetic" ? "بأحداثٍ اصطناعية (سفاري — قد لا تراها بعضُ الصفحات)" : "بإدخالٍ موثوق"
}

const isNode = (v: unknown): v is PageNode => typeof v === "object" && v !== null && typeof (v as PageNode).ref === "string" && typeof (v as PageNode).role === "string" && typeof (v as PageNode).name === "string" && ((v as PageNode).state === undefined || (v as PageNode).state === "filled" || (v as PageNode).state === "empty" || (v as PageNode).state === "autofilled")

function timingSafeEqualText(a: string, b: string): boolean {
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** حلقةُ MCP على stdio — كإخوتها: initialize، tools/list، tools/call، ping. تعود برمز الخروج. */
export async function serveChromeBridge(options: BridgeOptions = {}, input: AsyncIterable<string> = console, output: (line: string) => void = (line) => console.log(line)): Promise<number> {
  const bridge = new ChromeBridge(options)
  try { bridge.start() } catch (error) { process.stderr.write(`chrome-bridge: ${String(error)}\n`); return 2 }
  const emit = (value: object) => output(JSON.stringify(value))
  const result = (id: RpcId, value: unknown) => emit({ jsonrpc: "2.0", id, result: value })
  const failure = (id: RpcId, code: number, message: string) => emit({ jsonrpc: "2.0", id, error: { code, message } })
  try {
    for await (const line of input) {
      if (line.trim().length === 0) continue
      let request: RpcRequest
      try { request = JSON.parse(line) } catch { failure(null, -32700, "Parse error"); continue }
      if (request.jsonrpc !== "2.0" || typeof request.method !== "string") { if (request.id !== undefined) failure(request.id, -32600, "Invalid Request"); continue }
      if (request.method === "notifications/initialized") continue
      const id = request.id ?? null
      if (request.method === "initialize") {
        const requested = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        result(id, { protocolVersion: typeof requested === "string" ? requested : CHROME_BRIDGE_PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "abdocode-chrome-bridge", version: "0.1.0" } })
        continue
      }
      if (request.method === "tools/list") { result(id, { tools: BRIDGE_TOOLS }); continue }
      if (request.method === "ping") { result(id, {}); continue }
      if (request.method !== "tools/call") { failure(id, -32601, "Method not found"); continue }
      const name = request.params?.name
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>
      if (typeof name !== "string" || !BRIDGE_TOOLS.some((t) => t.name === name)) { failure(id, -32602, "Invalid tool arguments"); continue }
      try {
        result(id, { content: [{ type: "text", text: await bridge.run(name, args) }] })
      } catch (cause) {
        result(id, { isError: true, content: [{ type: "text", text: String(cause instanceof Error ? cause.message : cause) }] })
      }
    }
    return 0
  } finally {
    bridge.stop()
  }
}

/** الوسيطان: مجلّدُ الحالة ثم المنفذ — كي لا يعتمد الإطلاقُ على بيئةٍ لا يمرّرها عميلُ MCP. */
export function bridgeOptionsFromArgs(args: readonly string[], env: Record<string, string | undefined> = process.env): BridgeOptions {
  const stateDir = args[0] && args[0].length > 0 ? args[0] : env.ABDO_CODE_STATE_DIR
  const portText = args[1] ?? env.ABDO_CHROME_BRIDGE_PORT
  const port = Number(portText ?? DEFAULT_BRIDGE_PORT)
  return { port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_BRIDGE_PORT, token: env.ABDO_CHROME_BRIDGE_TOKEN, settingsFile: env.ABDO_CODE_SETTINGS, ...(stateDir === undefined ? {} : { stateDir }) }
}

if (import.meta.main) {
  process.exitCode = await serveChromeBridge(bridgeOptionsFromArgs(process.argv.slice(2)))
}
