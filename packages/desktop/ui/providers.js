// packages/providers/src/catalog.ts
var PROVIDER_DEFINITIONS = [
  { id: "deepseek", version: "1", source: "builtin", label: "DeepSeek", local: false, wire: "openai-compatible", harness: "abdo-native", baseUrl: "https://api.deepseek.com", workerUrl: "https://api.deepseek.com/chat/completions", vaultKey: "abdocode-deepseek", models: ["deepseek-v4-flash", "deepseek-v4-pro"] },
  { id: "ollama", version: "1", source: "builtin", label: "أولاما (محليّ)", local: true, wire: "native-ollama", harness: "qwen-style", baseUrl: "http://127.0.0.1:11434", models: ["qwen2b-gpu:latest", "qwen9b-gpu-32k:latest", "empero-qwen3.8-9b-gpu:latest"] },
  { id: "anthropic", version: "1", source: "builtin", label: "Anthropic", local: false, wire: "anthropic", harness: "claude-style", baseUrl: "https://api.anthropic.com/v1", workerUrl: "https://api.anthropic.com/v1/messages", vaultKey: "abdocode-anthropic", models: ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"] },
  { id: "openai", version: "1", source: "builtin", label: "شات جي بي تي (OpenAI)", local: false, wire: "openai-compatible", harness: "codex-style", baseUrl: "https://api.openai.com/v1", workerUrl: "https://api.openai.com/v1/chat/completions", vaultKey: "abdocode-openai", models: ["gpt-4o", "gpt-4o-mini", "o3-mini"] },
  { id: "google", version: "1", source: "builtin", label: "جيميني (Google)", local: false, wire: "openai-compatible", harness: "abdo-native", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", workerUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", vaultKey: "abdocode-google", models: ["gemini-3.7-flash"] },
  { id: "xai", version: "1", source: "builtin", label: "جروك (xAI)", local: false, wire: "openai-compatible", harness: "abdo-native", baseUrl: "https://api.x.ai/v1", workerUrl: "https://api.x.ai/v1/chat/completions", vaultKey: "abdocode-xai", models: [] },
  { id: "mistral", version: "1", source: "builtin", label: "ميسترال", local: false, wire: "openai-compatible", harness: "abdo-native", baseUrl: "https://api.mistral.ai/v1", workerUrl: "https://api.mistral.ai/v1/chat/completions", vaultKey: "abdocode-mistral", models: ["mistral-large-latest"] },
  { id: "groq", version: "1", source: "builtin", label: "جروك (Groq)", local: false, wire: "openai-compatible", harness: "abdo-native", baseUrl: "https://api.groq.com/openai/v1", workerUrl: "https://api.groq.com/openai/v1/chat/completions", vaultKey: "abdocode-groq", models: [] },
  { id: "together", version: "1", source: "builtin", label: "توغيذر (Together AI)", local: false, wire: "openai-compatible", harness: "abdo-native", baseUrl: "https://api.together.xyz/v1", workerUrl: "https://api.together.xyz/v1/chat/completions", vaultKey: "abdocode-together", models: ["openai/gpt-oss-20b"] },
  { id: "moonshot", version: "1", source: "builtin", label: "كيمي (Moonshot)", local: false, wire: "openai-compatible", harness: "abdo-native", baseUrl: "https://api.moonshot.cn/v1", workerUrl: "https://api.moonshot.cn/v1/chat/completions", vaultKey: "abdocode-moonshot", models: ["kimi-k2-0905-preview", "moonshot-v1-128k"] },
  { id: "dashscope", version: "1", source: "builtin", label: "كوين (DashScope)", local: false, wire: "openai-compatible", harness: "qwen-style", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", workerUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", vaultKey: "abdocode-dashscope", models: ["qwen-max", "qwen-plus", "qwen2.5-72b-instruct"] },
  { id: "qwen-token-plan", version: "1", source: "builtin", label: "كوين — خطة التوكنز", local: false, wire: "openai-compatible", harness: "qwen-style", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", workerUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", vaultKey: "abdocode-qwen-token-plan", models: ["qwen3.7-plus", "qwen3.8-max-preview", "qwen3.8-max", "qwen3.7-max"], imageModels: ["qwen3.7-plus", "qwen3.8-max-preview", "qwen3.8-max"] },
  { id: "qwen-coding-plan", version: "1", source: "builtin", label: "كوين — خطة البرمجة", local: false, wire: "openai-compatible", harness: "qwen-style", baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1", workerUrl: "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions", vaultKey: "abdocode-qwen-coding-plan", models: ["qwen3.7-plus", "qwen3.6-plus", "qwen3-coder-next", "qwen3-coder-plus", "qwen3.5-plus", "qwen3-max-2026-01-23", "kimi-k2.5", "glm-5", "MiniMax-M2.5", "glm-4.7"] },
  { id: "minimax", version: "1", source: "builtin", label: "ميني ماكس (MiniMax)", local: false, wire: "openai-compatible", harness: "abdo-native", baseUrl: "https://api.minimax.chat/v1", workerUrl: "https://api.minimax.chat/v1/chat/completions", vaultKey: "abdocode-minimax", models: ["minimax-m2", "abab6.5s-chat"] },
  { id: "openrouter", version: "1", source: "builtin", label: "أوبن راوتر (OpenRouter)", local: false, wire: "openai-compatible", harness: "abdo-native", baseUrl: "https://openrouter.ai/api/v1", workerUrl: "https://openrouter.ai/api/v1/chat/completions", vaultKey: "abdocode-openrouter", models: ["anthropic/claude-sonnet-4.5", "meta-llama/llama-3.3-70b-instruct"] },
  { id: "nvidia", version: "1", source: "builtin", label: "إنفيديا (NIM)", local: false, wire: "openai-compatible", harness: "abdo-native", baseUrl: "https://integrate.api.nvidia.com/v1", workerUrl: "https://integrate.api.nvidia.com/v1/chat/completions", vaultKey: "abdocode-nvidia", models: ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-super-120b-a12b", "meta/llama-3.2-11b-vision-instruct"], imageModels: ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "meta/llama-3.2-11b-vision-instruct"] },
  { id: "meta", version: "1", source: "builtin", label: "ميتا (Llama API)", local: false, wire: "openai-compatible", harness: "abdo-native", baseUrl: "https://api.llama.com/compat/v1", workerUrl: "https://api.llama.com/compat/v1/chat/completions", vaultKey: "abdocode-meta", models: ["llama-4-maverick", "llama-4-scout"] }
];
var DEFAULT_MODEL = "qwen-token-plan/qwen3.7-plus";
var MAX_CUSTOM_PROVIDERS = 64;
var TEMPLATE_ROWS = [
  ["deepseek", "DeepSeek", "Cloud"],
  ["openai", "OpenAI", "Cloud"],
  ["anthropic", "Anthropic", "Cloud"],
  ["google", "Google Gemini", "Cloud"],
  ["openrouter", "OpenRouter", "Gateway"],
  ["groq", "Groq", "Cloud"],
  ["mistral", "Mistral AI", "Cloud"],
  ["xai", "xAI", "Cloud"],
  ["cohere", "Cohere", "Cloud", "gateway-required"],
  ["together", "Together AI", "Cloud"],
  ["fireworks", "Fireworks AI", "Cloud"],
  ["cerebras", "Cerebras", "Cloud"],
  ["sambanova", "SambaNova", "Cloud"],
  ["perplexity", "Perplexity", "Cloud"],
  ["huggingface", "Hugging Face", "Gateway"],
  ["nebius", "Nebius", "Cloud"],
  ["novita", "Novita AI", "Cloud"],
  ["siliconflow", "SiliconFlow", "Cloud"],
  ["moonshot", "Moonshot / Kimi", "Cloud"],
  ["zai", "Z.ai / GLM", "Cloud"],
  ["dashscope", "Alibaba Cloud / Qwen", "Cloud"],
  ["qwen-token-plan", "Qwen Token Plan", "Cloud"],
  ["qwen-coding-plan", "Qwen Coding Plan", "Cloud"],
  ["minimax", "MiniMax", "Cloud"],
  ["baidu", "Baidu Qianfan", "Cloud", "gateway-required"],
  ["tencent", "Tencent Hunyuan", "Cloud", "gateway-required"],
  ["volcengine", "ByteDance / Volcengine", "Cloud"],
  ["azure", "Azure AI", "Enterprise", "gateway-required"],
  ["bedrock", "Amazon Bedrock", "Enterprise", "gateway-required"],
  ["vertex", "Google Vertex AI", "Enterprise", "gateway-required"],
  ["cloudflare", "Cloudflare Workers AI", "Enterprise", "gateway-required"],
  ["github", "GitHub Models", "Gateway"],
  ["vercel", "Vercel AI Gateway", "Gateway"],
  ["portkey", "Portkey", "Gateway", "gateway-required"],
  ["litellm", "LiteLLM", "Gateway"],
  ["ollama", "Ollama", "Local"],
  ["lmstudio", "LM Studio", "Local", "local-compatible"],
  ["vllm", "vLLM", "Local", "local-compatible"],
  ["llamacpp", "llama.cpp", "Local", "local-compatible"],
  ["localai", "LocalAI", "Local", "local-compatible"],
  ["jan", "Jan", "Local", "local-compatible"],
  ["nvidia", "NVIDIA NIM", "Cloud"],
  ["meta", "Meta Llama API", "Cloud"]
];
var PROVIDER_TEMPLATES = Object.freeze(TEMPLATE_ROWS.map(([id, label, category, requestedSupport]) => {
  const builtin = PROVIDER_DEFINITIONS.find((entry) => entry.id === id);
  const support = builtin ? "builtin" : requestedSupport ?? "openai-compatible";
  const local = builtin?.local ?? support === "local-compatible";
  return Object.freeze({
    id,
    label,
    category,
    support,
    local,
    baseUrl: builtin?.baseUrl ?? "",
    models: builtin?.models ?? [],
    vaultKey: builtin?.vaultKey ?? (local ? "" : `custom-${id}-api-key`),
    note: id === "qwen-token-plan" ? "Use a Token Plan key for this endpoint. Token Plan, Coding Plan and standard DashScope credentials are separate." : id === "qwen-coding-plan" ? "Use a Coding Plan key for this endpoint and interactive coding sessions. It does not share credentials with Token Plan or standard DashScope." : support === "gateway-required" ? "Connect through an OpenAI-compatible HTTPS gateway. Native enterprise authentication is not implemented." : support === "local-compatible" ? "OpenAI-compatible server on this computer. Loopback URLs only; no cloud credential is sent." : support === "openai-compatible" ? "Enter an OpenAI-compatible HTTPS base URL and exact model IDs. Credentials stay in the native vault." : "Native provider transport. Add its credential in the vault and choose an available model."
  });
}));
var Providers = Object.freeze({ PROVIDERS: PROVIDER_DEFINITIONS, PROVIDER_TEMPLATES, DEFAULT_MODEL, MAX_CUSTOM_PROVIDERS });
export {
  Providers,
  PROVIDER_TEMPLATES,
  PROVIDER_DEFINITIONS,
  MAX_CUSTOM_PROVIDERS,
  DEFAULT_MODEL
};
