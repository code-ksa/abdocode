/**
 * سطر النيّة — بروتوكول نصّيّ خالص (IDEA 2، `plugins.intentField`).
 *
 * النموذج يصرّح بنيّته في السطر نفسه الذي يستدعي فيه الأداة: سطرٌ واحد
 * يسبق «نفّذ:». الوحدة هنا **خالصة**: لا حالة، ولا I/O، ولا معرفة بالحلقة —
 * وظيفتها رفعُ ذلك السطر عن النصّ **قبل** أن يراه `parseCommand`، فتبقى
 * قاعدتا «استدعاء واحد» و«بلا شرح قبله» كما هما بايتاً.
 *
 * ثلاثة قيود مقصودة:
 * - **السطر الأوّل وحده**: حمولة `write` لا تُلمس أبداً؛ سطرٌ داخلها يشبه
 *   النيّة يبقى بايتاً في الملف (اختبار «حمولة لا تُشقّ»).
 * - **النيّة بيانات لا أمر**: تُنظَّف من محارف التحكّم، وتُطوى إلى سطر
 *   واحد، وتُقصّ عند `INTENT_MAX_CHARS` — لأنها تُخزَّن وتُستدعى لاحقاً.
 * - **الغياب ليس فشلاً**: نصٌّ بلا سطر نيّة يعود كما هو (بعد تصفية المقيس)،
 *   فلا يتعطّل تقدّمٌ بسبب صيغةٍ لم يلتزم بها نموذج صغير.
 */

/** بادئة السطر — نحوُ الشرطة نفسه الذي تستعمله أسطر «— المقيس» الجانبيّة. */
export const INTENT_PREFIX = "— النية:"
/** سقف محارف النيّة المخزَّنة (قيمةٌ تعبر إلى الذاكرة الدائمة). */
export const INTENT_MAX_CHARS = 200

/**
 * تصفية أسطر القياس الجانبيّة — **المصدر الواحد**: الحلقة تستوردها من هنا
 * فلا تفترق تصفيتها عن تصفية `splitIntent` (النيّة تُرفع بعد التصفية نفسها).
 */
export const stripMeasure = (text: string): string => text
  .split("\n")
  .filter((line) => !line.startsWith("— المقيس") && !line.startsWith("— حقب التنفيذ"))
  .join("\n")
  .trim()

/** محرف تحكّم: ما دون الفراغ، وDEL. يُكتب بالرمز العدديّ لا بمحرفٍ حرفيّ. */
const CONTROL_CHAR = (ch: string): boolean => {
  const code = ch.codePointAt(0)
  return code !== undefined && (code < 32 || code === 127)
}

/**
 * نيّةٌ صالحةٌ للتخزين، أو `undefined` إن كانت فارغة. سطرٌ واحد، بلا محارف
 * تحكّم، بفراغاتٍ مطويّة، ومقصوصةٌ عند السقف. تُستعمل لنيّة النصّ ولنيّة
 * الاستدعاء المنظَّم معاً — مفردةٌ واحدة لا اثنتان.
 */
export const sanitizeIntent = (raw: string): string | undefined => {
  const oneLine = raw.split(/\r?\n/u, 1)[0] ?? ""
  const cleaned = [...oneLine].map((ch) => (CONTROL_CHAR(ch) ? " " : ch)).join("").replace(/\s+/gu, " ").trim()
  return cleaned.length === 0 ? undefined : cleaned.slice(0, INTENT_MAX_CHARS)
}

export interface IntentSplit {
  /** غائبة حين لا سطر نيّة، أو حين كان السطر بلا نصّ بعد البادئة. */
  readonly intent?: string
  /** النصّ بعد رفع السطر — هو وحده ما يُسلَّم إلى `parseCommand`. */
  readonly body: string
}

/**
 * يرفع **سطراً واحداً** في الصدر إن بدأ بالبادئة، ويعيد الباقي. سطرٌ في
 * موضعٍ آخر (داخل حمولة، بعد الأمر) ليس نيّةً ولا يُمسّ.
 */
export const splitIntent = (text: string): IntentSplit => {
  const stripped = stripMeasure(text)
  const newline = stripped.indexOf("\n")
  const head = (newline < 0 ? stripped : stripped.slice(0, newline)).trimStart()
  if (!head.startsWith(INTENT_PREFIX)) return Object.freeze({ body: stripped })
  const intent = sanitizeIntent(head.slice(INTENT_PREFIX.length))
  const rest = newline < 0 ? "" : stripped.slice(newline + 1)
  return Object.freeze({ ...(intent === undefined ? {} : { intent }), body: rest.trim() })
}
