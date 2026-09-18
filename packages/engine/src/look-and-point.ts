/**
 * ن7 (09-16) — look-and-point: على واجهةٍ بلا شجرة (canvas، لعبة، سطحُ مكتبٍ بعيد) لا مرجعَ يُنقر، فيُسأل نموذجُ الرؤية
 * عن **إحداثيّات** عنصرٍ مسمّى في لقطة النافذة المربوطة ثمّ ينقر النموذجُ بـ`desk click x y` بالبوّابة نفسِها.
 * الحكمُ خالصٌ من الأثر: صياغةُ السؤال، وقراءةُ الجواب JSON بلا تساهل (لا نقرَ على تخمينٍ نثريّ)، وبصمةُ اللقطة
 * لبوّابة الإقفال «لقطتان متطابقتان = الفعلُ لم يقع» (مقيس: تكرارُ النقرة العمياء يستهلك الدور بلا أثر).
 */
import { createHash } from "node:crypto"

export const POINT_USAGE = "desk point <وصفُ العنصر كما يظهر في اللقطة: «زرُّ حفظ الأزرق»، «حقلُ البحث أعلى اليمين»…>"

export const pointSystem = (): string =>
  "أنت عينُ وكيلٍ يقود سطحَ مكتبٍ. تصلك لقطةُ نافذةٍ واحدة ووصفُ عنصرٍ فيها. أعد سطرَ JSON واحداً فقط بلا شرح ولا أسوار:\n" +
  '{"found":true,"x":<عدد صحيح>,"y":<عدد صحيح>,"label":"<ما رأيته>","confidence":<0..1>} إن وجدته، ' +
  'أو {"found":false,"why":"<لماذا>"} إن لم تجده أو التبس بغيره.\n' +
  "الإحداثيّاتُ بكسلاتُ الصورة من زاويتها العليا اليسرى، وتشير إلى **مركز** العنصر. لا تخمّن: إن لم يكن ظاهراً فقل found=false."

export const pointBody = (description: string, width: number, height: number): string =>
  `أبعادُ الصورة ${width}×${height}. العنصرُ المطلوب: ${description.trim().slice(0, 300)}`

export type PointVerdict =
  | { readonly ok: true; readonly x: number; readonly y: number; readonly label: string; readonly confidence: number }
  | { readonly ok: false; readonly why: string }

/** يقرأ جوابَ نموذج الرؤية بصرامة: كائنُ JSON واحد (ولو داخل نثرٍ أو سور ```)، أعدادٌ صحيحة داخل الصورة، وثقةٌ في [0,1]. */
export const parsePointReply = (text: string, width: number, height: number): PointVerdict => {
  const start = text.indexOf("{"), end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return { ok: false, why: "نموذجُ الرؤية لم يُعد JSON — لا نقرَ على تخمينٍ نثريّ" }
  let parsed: { found?: unknown; x?: unknown; y?: unknown; label?: unknown; confidence?: unknown; why?: unknown }
  try { parsed = JSON.parse(text.slice(start, end + 1)) as typeof parsed } catch { return { ok: false, why: "جوابُ نموذج الرؤية JSON معطوب" } }
  if (parsed.found !== true) return { ok: false, why: `لم يجد نموذجُ الرؤية العنصرَ: ${String(parsed.why ?? "بلا سبب").slice(0, 160)}` }
  const x = Number(parsed.x), y = Number(parsed.y)
  if (!Number.isInteger(x) || !Number.isInteger(y)) return { ok: false, why: "إحداثيّاتُ نموذج الرؤية ليست أعداداً صحيحة" }
  if (x < 0 || y < 0 || x >= width || y >= height) return { ok: false, why: `إحداثيّاتٌ خارج الصورة (${x},${y}) في ${width}×${height} — لا نقرَ خارج النافذة` }
  const raw = Number(parsed.confidence)
  const confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0
  return { ok: true, x, y, label: String(parsed.label ?? "").slice(0, 80), confidence }
}

/** بصمةُ لقطةٍ (base64) — للمقارنة قبل/بعد، لا للحفظ. */
export const shotDigest = (base64: string): string => createHash("sha256").update(base64).digest("hex").slice(0, 16)

export const pointReceipt = (v: Extract<PointVerdict, { ok: true }>, windowTitle: string): string =>
  `وجدتُ «${v.label || "العنصر"}» عند (${v.x},${v.y}) بثقة ${Math.round(v.confidence * 100)}٪ في «${windowTitle.slice(0, 60)}» — التالي: desk click ${v.x} ${v.y}؛ بعد النقر تُلتقط لقطةُ تحقّقٍ وتُقارن بهذه.`

/** بوّابةُ الإقفال بعد النقر: بصمةٌ لم تتغيّر = الفعلُ لم يقع، ويُقال بالاسم بدل تكرارٍ أعمى. */
export const afterClickLine = (before: string, after: string): string =>
  before === after
    ? "⚠ لقطةُ التحقّق بعد النقر مطابقةٌ للتي قبله — الفعلُ لم يقع؛ لا تكرّر النقرةَ نفسها: أعد desk ui، أو desk point بوصفٍ آخر، أو اسأل المستخدم."
    : "✓ تغيّرت الشاشةُ بعد النقر (لقطةُ التحقّق تختلف عمّا قبلها) — اقرأ الحالةَ الجديدة بـdesk ui أو desk shot."
