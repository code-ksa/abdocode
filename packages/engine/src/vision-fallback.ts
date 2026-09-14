/**
 * أيُّ نموذجٍ يستلم اللقطةَ التالية؟ مقيسٌ 2026-09-13 في مهمّةٍ حقيقيّة: `shot` التقط صفحةَ مبرمج
 * (528 KB) ثمّ قال «لا نموذجَ رؤيةٍ مضبوط فلا تصل النموذج» — بينما نموذجُ الحارة نفسُه
 * (`qwen-token-plan/qwen3.7-plus`) يُعلن قبولَ الصور في الكتالوج (مقيسٌ حيّاً صباحَ اليوم).
 * ذ1 يقول: بلا ضبطٍ يبقى نموذجُ الحارة ويُرفض صراحةً إن لم يقبل الصور — فاللقطةُ تصل حين
 * يرى الحارةُ، وتُقال الحقيقةُ حين لا يرى. مالكٌ واحد لهذا السؤال بدل موضعين يكرّرانه.
 */
import * as Providers from "@abdo/providers"
import { MAX_IMAGE_BASE64 } from "@abdo/model-gateway"

/** هل تتّسع اللقطةُ (base64) في سقف البوّابة؟ السقفُ مصدرُه واحد (`MAX_IMAGE_BASE64`) لا رقمٌ مكرَّر هنا. */
export const shotFitsModel = (data: string): boolean => data.length > 0 && data.length <= MAX_IMAGE_BASE64

/**
 * مواضعُ التمرير للقطة الصفحة الكاملة: بلاطةٌ لكلّ منفذ، آخرُها محاذٍ لأسفل الوثيقة (لا يُقصّ الذيل)،
 * وبسقفٍ يمنع صفحةً لانهائيّة من ابتلاع الدور. صفحةٌ أقصرُ من المنفذ = بلاطةٌ واحدة.
 */
export function tilePlan(viewportHeight: number, scrollHeight: number, maxTiles = 8): number[] {
  const vh = Math.max(1, Math.floor(viewportHeight)), sh = Math.max(1, Math.floor(scrollHeight)), cap = Math.max(1, Math.floor(maxTiles))
  if (sh <= vh) return [0]
  const ys: number[] = []
  for (let y = 0; y + vh < sh && ys.length < cap - 1; y += vh) ys.push(y)
  ys.push(Math.max(0, sh - vh))
  return [...new Set(ys)]
}

export type ShotRoute =
  | { readonly reaches: true; readonly via: "vision" | "lane"; readonly ref: string }
  | { readonly reaches: false; readonly why: string }

export function shotRoute(settings: { visionModel?: string; agentModel?: string; model?: string }): ShotRoute {
  const vision = typeof settings.visionModel === "string" ? settings.visionModel : ""
  if (vision.length > 0 && Providers.parseRef(vision) !== undefined) return Object.freeze({ reaches: true, via: "vision", ref: vision })
  const laneRef = settings.agentModel ?? settings.model
  const parsed = typeof laneRef === "string" ? Providers.parseRef(laneRef) : undefined
  const provider = parsed === undefined ? undefined : Providers.provider(parsed.provider)
  if (parsed !== undefined && provider !== undefined && Providers.hasDeclaredImageInput(provider, parsed.model)) {
    return Object.freeze({ reaches: true, via: "lane", ref: laneRef as string })
  }
  return Object.freeze({ reaches: false, why: "لا نموذجَ رؤيةٍ مضبوط، ونموذجُ الحارة لا يُعلن قبولَ الصور" })
}
