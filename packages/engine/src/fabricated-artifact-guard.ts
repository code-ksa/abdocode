/**
 * صورةٌ تُصنع بالبايتات لتوهم بلقطةٍ لم تُؤخذ — **اختلاقُ مُسلَّمٍ لا قصورُ قدرة**.
 *
 * **مقيسٌ حرفيّاً في جولةٍ حيّة**: المهمّةُ طلبت لقطةً من موقعٍ مرجعيّ. حارسُ
 * الخروج رفض المضيفَ بحقٍّ («destination was never declared»)، و`page shot` رفض بحقٍّ
 * («لا سطحَ موصول»)، و`image` رفض بحقٍّ («الملفّ غير موجود». فماذا فعل الوكيل؟
 *
 *     run node -e "fs.writeFileSync('docs/reference-stats.png',
 *       Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAA…','base64'))"
 *
 * سبعون بايتاً: PNG صحيحُ التوقيع، **أبعادُه 1×1**. فكلُّ فحصٍ يسأل «هل الملفُّ موجود؟»
 * أو «هل هو PNG؟» يمرّ — ولا لقطةَ هناك. والحَكَمُ المحجوب أمسكها لأنّه يسأل الحجمَ
 * والأبعاد، لا الوجودَ.
 *
 * وهذا وجهٌ ثالثٌ لقاعدتنا «الأخضرُ قد يعني: لم يحدث شيء»: لا في الاختبار، ولا في
 * الحارس، بل **في المُسلَّم نفسِه**. وحارسُ الاختلاق القائم (`fabricated-output-guard`)
 * يقرأ **نصَّ** النموذج — ولا يرى بايتاتٍ تُكتب على القرص.
 *
 * فالحكمُ هنا: صورةٌ تُكتب **بأبعادٍ تافهة** تُسمّى اختلاقاً في الإيصال. ولا تُمنع
 * الكتابة: قد يكون البكسلُ الواحد مقصوداً (شافّةٌ، فاصلٌ، اختبار). المنعُ في الادّعاء
 * لا في الملفّ — يُقال في الإيصال فيصل النموذجَ والمشرفَ معاً.
 *
 * الوحدةُ نقيّة: البايتاتُ تصل مدخلاً، ولا قرصَ هنا.
 */

/** أصغرُ بُعدٍ نعدُّه صورةً حقيقيّة: ما دونه لا يحمل معلومةً بصريّة. */
export const MIN_DIMENSION = 8

/** أصغرُ حجمٍ نعدُّه لقطةً: لقطةُ صفحةٍ حقيقيّةٌ لا تقلّ عن كيلوبايتَين. */
export const MIN_SHOT_BYTES = 2048

export interface ImageShape {
  readonly kind: "png" | "jpeg" | "gif" | "webp" | "unknown"
  readonly width?: number
  readonly height?: number
  readonly bytes: number
}

const u32 = (b: Uint8Array, at: number): number => (b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!

/**
 * يقرأ الشكلَ من البايتات — لا من الامتداد: امتدادٌ يكتبه صاحبُ الملفّ، والتوقيعُ لا.
 * PNG وGIF وWEBP تُقرأ أبعادُها من الترويسة؛ JPEG تحتاج مسحَ مقاطعَ فيُقاس حجمُها وحده.
 */
export function imageShape(bytes: Uint8Array): ImageShape {
  const n = bytes.length
  if (n >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    // IHDR يبدأ عند 16 بعد الطول والنوع.
    return { kind: "png", width: u32(bytes, 16), height: u32(bytes, 20), bytes: n }
  }
  if (n >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { kind: "gif", width: bytes[6]! | (bytes[7]! << 8), height: bytes[8]! | (bytes[9]! << 8), bytes: n }
  }
  if (n >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) {
    // WEBP/VP8L وVP8 يختلفان؛ نقرأ VP8 البسيط وإلا نتركها بلا أبعاد.
    if (bytes[15] === 0x20) return { kind: "webp", width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff, height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff, bytes: n }
    return { kind: "webp", bytes: n }
  }
  if (n >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return { kind: "jpeg", bytes: n }
  return { kind: "unknown", bytes: n }
}

/**
 * سببٌ مسمّى إن كانت الصورةُ المكتوبةُ صورةَ إيهام، وإلّا `undefined`.
 *
 * `asShot` صحيحٌ حين سمّى السياقُ الملفَّ لقطةً (اسمُه يقول shot/screenshot/لقطة، أو
 * المهمّةُ طلبت لقطة): يُشدَّد الحدُّ حينها، لأنّ اللقطةَ لها حدٌّ أدنى معقول.
 */
export function fabricatedImage(file: string, bytes: Uint8Array, asShot = false): string | undefined {
  const shape = imageShape(bytes)
  if (shape.kind === "unknown") return undefined
  const tiny = shape.width !== undefined && shape.height !== undefined
    && (shape.width < MIN_DIMENSION || shape.height < MIN_DIMENSION)
  if (tiny) {
    return `⚠ «${file}»: صورةٌ بأبعاد ${shape.width}×${shape.height} (${shape.bytes} بايت) — هذه ليست لقطةً ولا رسماً، وكلُّ فحصٍ يسأل «هل الملفُّ موجود؟» أو «هل هو ${shape.kind.toUpperCase()}؟» سيمرّ عليها. إن كنتَ تعجز عن أخذ اللقطة فقُل ذلك ولا تكتب ملفّاً يُوهم بها؛ وإن كان البكسلُ مقصوداً فسمِّ سببَه.`
  }
  if (asShot && shape.bytes < MIN_SHOT_BYTES) {
    return `⚠ «${file}»: ${shape.bytes} بايتاً لملفٍّ يُسمّى لقطة — أقلُّ من أن يكون صفحةً مصوَّرة. إن تعذّرت اللقطةُ فقُل السببَ ولا تضع ملفّاً يمرّ على الشكل.`
  }
  return undefined
}

/** هل يقول اسمُ الملفِّ إنّه لقطة؟ — فيُشدَّد حدُّه. */
export function looksLikeShot(file: string): boolean {
  return /(?:shot|screenshot|capture|لقطة|reference)/iu.test(file)
}
