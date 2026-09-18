// These exact installed aliases were inspected with Ollama /api/show and
// advertise the native tools capability. Keep unknown aliases on the existing
// text protocol unless the operator explicitly opts in.
const VERIFIED_LOCAL_TOOL_MODELS = new Set([
  "qwen2b-gpu:latest",
  "qwen9b-gpu-32k:latest",
  "empero-qwen3.8-9b-gpu:latest",
])

export function usesNativeToolProtocol(provider: string, model: string, override: string | undefined): boolean {
  if (provider !== "ollama" || override === "text") return false
  return override === "native" || VERIFIED_LOCAL_TOOL_MODELS.has(model) ||
    // Existing qualified families retain their previous behavior.
    /^(?:qwen9b-gpu-|qwen3\.5:)/u.test(model)
}
