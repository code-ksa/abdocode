import { describe, expect, test } from "bun:test"
import { labelDigest } from "@abdo/kernel/contracts"
import { attest, buildChatRequest, classifyInput, HarnessRegistry } from "../src"

describe("owned harness adapter", () => {
  test("uses the generated Rust channel vocabulary without duplicating wake semantics", () => {
    expect(classifyInput("OperatorSteer", "stop after tests")).toEqual({ channel: "OperatorSteer", body: "stop after tests" })
    expect(classifyInput("SchedulerSignal", "tick")).toEqual({ channel: "SchedulerSignal", body: "tick" })
    expect("wakesAgent" in classifyInput("SystemInject", "policy")).toBeFalse()
  })

  test("validates the generated enforcement report instead of defining another", () => {
    const digest = labelDigest("test-enforcement")
    expect(attest({
      requested_digest: digest,
      granted_digest: digest,
      enforcement: "Unavailable",
      backend_digest: digest,
      limitations_digest: digest,
    }).enforcement).toBe("Unavailable")
  })

  test("loads the locally written DeepSeek-style profile without network discovery", () => {
    expect(HarnessRegistry.ids()).toContain("deepseek-style")
    const request = buildChatRequest({
      wire: "native-ollama",
      harness: "deepseek-style",
      model: "qwen",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    })
    const body = JSON.parse(request.body)
    expect(request.path).toBe("/api/chat")
    expect(body.think).toBeFalse()
    expect(body.messages[0].role).toBe("system")
  })

  test("applies the profile to real tools and keeps a reversible legal-name map", () => {
    const request = buildChatRequest({
      wire: "native-ollama",
      harness: "qwen-style",
      model: "qwen",
      system: "Run {{tool:status}} when asked.\n{{tool-catalogue}}",
      messages: [{ role: "user", content: "status?" }],
      tools: [{
        legalName: "status",
        usage: "status",
        description: "read the local kernel status",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
      stream: false,
    })
    const body = JSON.parse(request.body)
    expect(request.toolBindings).toEqual([expect.objectContaining({ legalName: "status", exposedName: "abdo_status", usage: "abdo_status" })])
    expect(body.messages.filter((message: { role: string }) => message.role === "system")).toHaveLength(1)
    expect(body.messages[0].content).toContain("Run abdo_status when asked.")
    expect(body.messages[0].content).toContain("- abdo_status — read the local kernel status")
  })

  test("rejects ambiguous mappings and a second system-message channel", () => {
    const duplicate = { legalName: "status", usage: "status", description: "status", parameters: {} }
    expect(() => buildChatRequest({
      wire: "native-ollama",
      harness: "abdo-native",
      model: "qwen",
      messages: [],
      tools: [duplicate, duplicate],
      stream: false,
    })).toThrow("duplicate legal tool name")
    expect(() => buildChatRequest({
      wire: "native-ollama",
      harness: "abdo-native",
      model: "qwen",
      messages: [{ role: "system", content: "second channel" }],
      stream: false,
    })).toThrow("singular system field")
  })
})
