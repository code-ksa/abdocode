/**
 * توليدُ الصور — الفجوة #11 في جدول 2026-09-27 (ChatGPT يرسم).
 *
 * `imagine <وصف> [--out مسار.png]` بنموذج `imageGenModel` في الإعدادات (الافتراضُ `qwen-token-plan/wan2.7-image`).
 * الطلبُ بصيغته المقيسة على خطّة التوكن (ذاكرة qwen-token-plan-key): عبر chat/completions لا /images/generations (404)،
 * والمحتوى **قائمة** `[{type:"text"}]` (النصُّ المجرّد يُرفض InvalidParameter)، والصورةُ رابطٌ موقَّعٌ في
 * `output.choices[0].message.content[].image`. والصيغُ الأخرى الشائعة تُقرأ أيضاً (OpenAI: data[].url/b64_json).
 * المفتاحُ لا يلمسه المحرّك: النداءُ السحابيّ عبر عامل Rust كنداءات النموذج كلّها، والحفظُ عبر write_file في النواة.
 */

export const DEFAULT_IMAGE_MODEL = "qwen-token-plan/wan2.7-image"
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export interface ImagineRequest { readonly prompt: string; readonly out?: string }

/** `imagine <وصف> [--out مسار]` — المسارُ بامتداد صورة. */
export function parseImagineCommand(rest: string): ImagineRequest {
  let out: string | undefined
  const prompt = rest.replace(/\s--out\s+(\S+)/u, (_whole, path: string) => { out = path; return " " }).replace(/\s+/gu, " ").trim()
  if (prompt.length < 3) throw new Error("imagine يحتاج وصفاً: imagine <وصف> [--out images/name.png]")
  if (out !== undefined && !/\.(?:png|jpe?g|webp)$/iu.test(out)) throw new Error("--out يحتاج امتدادَ صورة: .png أو .jpg أو .webp")
  return { prompt: prompt.slice(0, 1500), ...(out === undefined ? {} : { out }) }
}

export const imageRequestBody = (model: string, prompt: string): string =>
  JSON.stringify({ model, messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] })

/** الصورةُ من جسد الردّ: رابطٌ أو base64، أو سببٌ مسمّى. */
export function extractImage(body: string): { readonly url: string } | { readonly base64: string } | { readonly error: string } {
  let json: any
  try { json = JSON.parse(body) } catch { return { error: `الردّ ليس JSON: ${body.slice(0, 120)}` } }
  const contentLists = [json?.output?.choices?.[0]?.message?.content, json?.choices?.[0]?.message?.content]
  for (const content of contentLists) {
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (typeof part?.image === "string") return { url: part.image }
      if (typeof part?.image_url?.url === "string") return part.image_url.url.startsWith("data:") ? { base64: part.image_url.url.replace(/^data:[^,]*,/u, "") } : { url: part.image_url.url }
    }
  }
  const data = json?.data?.[0]
  if (typeof data?.b64_json === "string") return { base64: data.b64_json }
  if (typeof data?.url === "string") return { url: data.url }
  const message = json?.error?.message ?? json?.message ?? json?.code
  return { error: message !== undefined ? `المزوّد: ${String(message).slice(0, 200)}` : "لا صورةَ في الردّ" }
}

/** نوعُ الصورة من بايتاتها لا من اسمها. */
export function imageKind(bytes: Uint8Array): "png" | "jpg" | "webp" | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg"
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "webp"
  return undefined
}

export const defaultImagePath = (prompt: string, kind: string, now = Date.now()): string =>
  `images/${prompt.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "image"}-${now}.${kind}`
