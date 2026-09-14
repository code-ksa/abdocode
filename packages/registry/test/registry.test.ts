import { describe, expect, test } from "bun:test"
import { DeterministicRegistry } from "../src"

describe("DeterministicRegistry", () => {
  test("has one digest regardless of registration order", () => {
    const first = new DeterministicRegistry()
      .register({ id: "ollama", version: "1", source: "builtin" })
      .register({ id: "openai", version: "1", source: "owner-config" })
    const second = new DeterministicRegistry()
      .register({ id: "openai", version: "1", source: "owner-config" })
      .register({ id: "ollama", version: "1", source: "builtin" })
    expect(first.snapshot()).toEqual(second.snapshot())
  })

  test("rejects duplicate and ambiguous ids", () => {
    const registry = new DeterministicRegistry().register({ id: "ollama", version: "1", source: "builtin" })
    expect(() => registry.register({ id: "ollama", version: "2", source: "builtin" })).toThrow("duplicate")
    expect(() => new DeterministicRegistry().register({ id: "../escape", version: "1", source: "builtin" })).toThrow("invalid")
  })
})
