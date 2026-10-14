import { expect, test } from "bun:test"
import { usesNativeToolProtocol } from "../src/native-model-protocol"

test("verified local aliases use tools without enabling arbitrary small model names", () => {
  for (const model of ["qwen2b-gpu:latest", "qwen9b-gpu-32k:latest", "empero-qwen3.8-9b-gpu:latest"]) {
    expect(usesNativeToolProtocol("ollama", model, undefined)).toBe(true)
    expect(usesNativeToolProtocol("ollama", model, "text")).toBe(false)
    expect(usesNativeToolProtocol("owner-server", model, undefined)).toBe(false)
  }
  expect(usesNativeToolProtocol("ollama", "unverified-qwen2b:latest", undefined)).toBe(false)
  expect(usesNativeToolProtocol("ollama", "empero-qwen3.8-other:latest", undefined)).toBe(false)
  expect(usesNativeToolProtocol("ollama", "operator-qualified-model", "native")).toBe(true)
  // 10-08: النقلُ الأصليّ صار مؤهَّلاً على الشكل المتوافق مع OpenAI — فرضُ المشغّل «native» يسري على السحابة أيضاً، و«text» يغلبه دائماً.
  expect(usesNativeToolProtocol("qwen-token-plan", "qwen3.8-max", "native")).toBe(true)
  expect(usesNativeToolProtocol("qwen-token-plan", "qwen3.8-max", undefined)).toBe(false)
})

test("10-08: cloud families that only call tools natively (gpt-oss, measured on NIM) default to native; other cloud models stay on text", () => {
  for (const model of ["openai/gpt-oss-20b", "openai/gpt-oss-120b", "gpt-oss:20b"]) {
    expect(usesNativeToolProtocol("nvidia", model, undefined)).toBe(true)
    expect(usesNativeToolProtocol("nvidia", model, "text")).toBe(false)
  }
  for (const model of ["nvidia/nemotron-3-ultra-550b-a55b", "moonshotai/kimi-k2.6", "z-ai/glm-5.3", "my-gpt-ossify"]) {
    expect(usesNativeToolProtocol("nvidia", model, undefined)).toBe(false)
  }
})

// 10-08 — measured with a live OpenAI key: gpt-6.1-sol refuses function tools on /v1/chat/completions; gpt-5.5/5.4/4.1 accept them.
test("OpenAI gpt-6 and later stay on the text protocol even when native is forced; gpt-5.x may go native on request", () => {
  for (const m of ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "gpt-7"]) expect(usesNativeToolProtocol("openai", m, "native")).toBe(false)
  for (const m of ["gpt-5.5", "gpt-5.4", "gpt-4.1"]) expect(usesNativeToolProtocol("openai", m, "native")).toBe(true)
  expect(usesNativeToolProtocol("openai", "gpt-6.1-sol", undefined)).toBe(false)
})

// 10-09 — measured against OpenCode with the same model and judges: the text protocol cost 1471 s on m7 (26 write refusals) and
// native tools 234 s (21/21); m8 1047 s vs 167 s (27/27). The nemotron-3 family goes native while plugins.nativeTools is on.
test("plugins.nativeTools: the measured nemotron-3 family goes native; other cloud models and an operator «text» do not", () => {
  for (const model of ["nvidia/nemotron-3-super-120b-a12b", "nvidia/nemotron-3-ultra-550b-a55b"]) {
    expect(usesNativeToolProtocol("nvidia2", model, undefined, true)).toBe(true)
    expect(usesNativeToolProtocol("nvidia2", model, undefined, false)).toBe(false)
    expect(usesNativeToolProtocol("nvidia2", model, "text", true)).toBe(false)
  }
  for (const model of ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "moonshotai/kimi-k2.6", "z-ai/glm-5.3", "nvidia/llama-3.1-nemotron-ultra-253b-v1"]) {
    expect(usesNativeToolProtocol("nvidia2", model, undefined, true)).toBe(false)
  }
  expect(usesNativeToolProtocol("openai", "gpt-6.1-sol", undefined, true)).toBe(false)
})

// 10-14 — against Claude Code with the same model (claude-sonnet-5-5) on m11: the text protocol finished 16/16 in 602 s with 62 calls and no
// prompt cache; Claude Code 215 s, 18 calls. The Anthropic wire now carries tool_use/tool_result, so every Anthropic model goes native.
test("plugins.nativeTools: every Anthropic model goes native; the switch off or an operator «text» keeps the text protocol", () => {
  for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"]) {
    expect(usesNativeToolProtocol("anthropic", model, undefined, true)).toBe(true)
    expect(usesNativeToolProtocol("anthropic", model, undefined, false)).toBe(false)
    expect(usesNativeToolProtocol("anthropic", model, "text", true)).toBe(false)
  }
  expect(usesNativeToolProtocol("openrouter", "anthropic/claude-sonnet-5-5", undefined, true)).toBe(false)
})

// 10-14 — Claude Code made 22 tool calls in 18 model calls on m11; AbdoCode 35 in 34, because its contract said «one tool per reply».
test("multi-call contract: only the measured family is told to batch independent calls; the others keep the old text byte for byte", async () => {
  const { nativeMultiCall } = await import("../src/native-model-protocol")
  const { nativeAgentSystem } = await import("../src/native-agent-tools")
  expect(nativeMultiCall("anthropic")).toBe(true)
  for (const provider of ["ollama", "nvidia2", "openai", "deepseek", "openrouter"]) expect(nativeMultiCall(provider)).toBe(false)
  const multi = nativeAgentSystem(false, false, false, "", true)
  expect(multi).toContain("كلَّ النداءات المستقلّة")
  // 10-14 — m11: فحصُ الواجهة (fill/tap/wait/page) كان ثمانيَ نداءاتٍ متتالية؛ السلسلةُ المعروفةُ مراجعُها ردٌّ واحد
  expect(multi).toContain("(fill ثمّ tap ثمّ wait ثمّ page) ردٌّ واحد")
  // 10-14 — m11: المراجِعُ حجب «npm start لا يظهر في الإيصالات» (فُحص بـnode مباشرة) ⇦ حقبةُ إصلاحٍ 74 ث
  expect(multi).toContain("أنتِج الدليلَ بأوامر العقد نفسِها")
  expect(multi).not.toContain("أداة واحدة في الرد")
  expect(multi).not.toContain("انتظر الإيصال بعد كل أداة")
  const single = nativeAgentSystem(false, false, false, "")
  expect(single).toContain("أداة واحدة في الرد")
  expect(single).toBe(nativeAgentSystem(false, false, false, "", false))
})
