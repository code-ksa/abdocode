// These exact installed aliases were inspected with Ollama /api/show and
// advertise the native tools capability. Keep unknown aliases on the existing
// text protocol unless the operator explicitly opts in.
const VERIFIED_LOCAL_TOOL_MODELS = new Set([
  "qwen2b-gpu:latest",
  "qwen9b-gpu-32k:latest",
  "empero-qwen3.8-9b-gpu:latest",
])

/**
 * 10-08 (مقيس على NIM): عائلاتٌ سحابيّة تستدعي أدواتِها بقناتها الأصليّة ولا تكتب «نفّذ:» نصّاً مهما نُبّهت — gpt-oss أعاد محتوًى فارغاً
 * ووسائطَ الأداة في reasoning ثلاثَ مرّات. لها البروتوكولُ الأصليّ على الشكل المتوافق مع OpenAI؛ والمشغّلُ يفرض أيَّهما بـABDO_AGENT_PROTOCOL.
 */
const NATIVE_ONLY_CLOUD_FAMILIES = /(?:^|\/)gpt-oss(?:[-:]|$)/iu

/**
 * 10-08 — مقيسٌ بمفتاح OpenAI حيّ: gpt-6.1-sol يرفض أدواتِ الدوالّ على /v1/chat/completions («Function tools with reasoning_effort are not
 * supported … use /v1/responses»)، ولا يقبل reasoning_effort=none؛ وgpt-5.5/5.4/4.1 تقبلها. فعائلةُ gpt-6 فما بعدها تبقى على البروتوكول
 * النصّيّ (الذي أنهى مهمّة النشر بلا تصحيحٍ واحد) ولو فُرض native — بدل 400 في أوّل نداء.
 */
const OPENAI_NO_CHAT_TOOLS = /^(?:openai\/)?gpt-(?:[6-9]|[1-9]\d)(?:[.\-]|$)/iu

/**
 * 10-09 — مقيسٌ مقابل OpenCode بالنموذج نفسِه (nemotron-3-super عبر NIM) والمهامّ نفسِها والحَكَم نفسِه: البروتوكولُ النصّيّ يضع الملفَّ
 * كلَّه داخل «write … <<<» فيرفضه حارسُ الصياغة على سياجٍ أو سطرٍ زائد — 26 رفضاً في m7 و1471 ثانية؛ وبالأدوات الأصليّة يصل المحتوى
 * حقلاً في JSON فلا يُرفض شيء: m7 ‏21/21 في 234 ث (OpenCode ‏347 ث)، وm8 ‏27/27 في 167 ث (النصّيّ 26/27 في 1047 ث). فعائلةُ
 * nemotron-3 تبدأ أصليّةً حين يكون مفتاحُ `plugins.nativeTools` مفعَّلاً (الافتراض)؛ و«text» من المشغّل يغلبها دائماً.
 */
const NATIVE_MEASURED_CLOUD_FAMILIES = /(?:^|\/)nemotron-3-(?:super|ultra)(?:[-:]|$)/iu

/**
 * 10-14 — Claude مدرَّبٌ على tool_use الأصليّ، والنصّيُّ («نفّذ:» بعُرفٍ لم يره) كان يدور: مقابل Claude Code بالنموذج نفسِه (sonnet-5-5)
 * على n8n ستُّ حقبِ تحقّقٍ بلا تعديل. والشكلُ الأنثروبيّ صار ينقل الأدوات (model-gateway). فعائلةُ Anthropic أصليّةٌ تحت المفتاح نفسِه.
 */
const NATIVE_MEASURED_PROVIDERS = new Set(["anthropic"])

/** 10-14 — العائلاتُ التي يُقال لها «اجمع النداءات المستقلّة في الرد» (عقدُ native-agent-tools)؛ المقيسةُ وحدها. */
export const nativeMultiCall = (provider: string): boolean => NATIVE_MEASURED_PROVIDERS.has(provider)

export function usesNativeToolProtocol(provider: string, model: string, override: string | undefined, measuredNative = false): boolean {
  if (override === "text") return false
  if (measuredNative && NATIVE_MEASURED_PROVIDERS.has(provider)) return true
  if (provider === "openai" && OPENAI_NO_CHAT_TOOLS.test(model)) return false
  if (provider !== "ollama") return override === "native" || NATIVE_ONLY_CLOUD_FAMILIES.test(model) || (measuredNative && NATIVE_MEASURED_CLOUD_FAMILIES.test(model))
  return override === "native" || VERIFIED_LOCAL_TOOL_MODELS.has(model) ||
    // Existing qualified families retain their previous behavior.
    /^(?:qwen9b-gpu-|qwen3\.5:)/u.test(model)
}
