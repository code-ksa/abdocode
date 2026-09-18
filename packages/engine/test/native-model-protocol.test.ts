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
  expect(usesNativeToolProtocol("qwen-token-plan", "qwen3.8-max", "native")).toBe(false)
})
