import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { apply, parse } from "../src/harness-profile"
import { HarnessRegistry } from "../src/harness"
import { document as abdoNative } from "../src/harness/abdo-native"

/**
 * S125 — the two ways "the harness is data" can be false.
 *
 * The first is a special case: an applier that reads a field for four profiles
 * and then, for the fifth, checks which one it is holding. That is checked by
 * reading the applier's own source, with the list of forbidden literals derived
 * from the registry — so a profile added tomorrow is covered without anybody
 * updating this test.
 *
 * The second is a profile that is only rejected once it is on the wire. That is
 * checked by validating with a network layer that fails the test if it is
 * touched at all, and — because a probe that can never fire proves nothing —
 * by showing the same probe does fire for a request that is allowed through.
 */

const SOURCE_DIR = join(import.meta.dir, "..", "src")

const sourceOf = (relative: string) => readFileSync(join(SOURCE_DIR, relative), "utf8")

const valid = () => structuredClone(abdoNative) as Record<string, unknown>

const tool = (patch: Partial<{ name: string; description: string }> = {}) => ({
  name: patch.name ?? "read file",
  description: patch.description ?? "Read a file",
  parameters: { type: "object" },
})

// --- 1. a new harness is a new file ---------------------------------------------

describe("S125 the applier has no per-profile code", () => {
  test("a profile id appears only on an import line, and only once", () => {
    // Derived, not typed out: whatever the registry holds today is what must
    // not be hardcoded, so tomorrow's profile is covered by this test as it is
    // written now.
    //
    // The rule is not "the name never appears" — a static registry has to name
    // each file it loads. It is that naming the file is the *only* place the
    // name may appear: the applier must not mention it at all, and the registry
    // must mention it exactly once, on the import.
    const ids = HarnessRegistry.ids()
    expect(ids.length).toBeGreaterThan(0)

    const applier = sourceOf("harness-profile.ts")
    expect(ids.filter((id) => applier.includes(id))).toEqual([])

    const registry = sourceOf("harness/index.ts").split(/\r?\n/)
    const imports = registry.filter((line) => line.trimStart().startsWith("import "))
    const rest = registry.filter((line) => !line.trimStart().startsWith("import "))
    for (const id of ids) {
      expect(rest.filter((line) => line.includes(id))).toEqual([])
      expect(imports.filter((line) => line.includes(id))).toHaveLength(1)
    }
  })

  test("no provider or vendor name appears in it either", () => {
    // A harness profile describes a *style*; the moment a vendor name reaches
    // the applier, the next style is a branch instead of a file.
    const VENDORS = ["openai", "anthropic", "claude", "gemini", "google", "bedrock", "deepseek", "qwen", "codex"]
    const code = sourceOf("harness-profile.ts").toLowerCase()
    expect(VENDORS.filter((vendor) => code.includes(vendor))).toEqual([])
  })

  test("every profile file in the harness directory is registered", () => {
    // A file that exists and is not loaded is the failure this catches: it
    // looks like a supported harness in the tree and is not one at runtime.
    const files = readdirSync(join(SOURCE_DIR, "harness"))
      .filter((name) => name.endsWith(".ts") && name !== "index.ts")
      .map((name) => name.replace(/\.ts$/, ""))
    expect(files.sort()).toEqual([...HarnessRegistry.ids()].sort())
  })

  test("the guard notices a hardcoded id, so its silence above means something", () => {
    const ids = HarnessRegistry.ids()
    const pretendApplier = 'if (id === "abdo-native") return special()'
    expect(ids.filter((id) => pretendApplier.includes(id))).toEqual(["abdo-native"])

    const pretendRegistry = ['import { document as x } from "./abdo-native"', 'if (x.id === "abdo-native") boost(x)']
    const rest = pretendRegistry.filter((line) => !line.trimStart().startsWith("import "))
    expect(rest.filter((line) => line.includes("abdo-native"))).toHaveLength(1)
  })
})

// --- 2. invalid is rejected before anything is sent -------------------------------

describe("S125 an invalid profile never reaches the network", () => {
  const cases: readonly (readonly [string, (draft: Record<string, unknown>) => void])[] = [
    ["a missing id", (draft) => delete draft.id],
    ["a zero version", (draft) => (draft.version = 0)],
    ["no rationale", (draft) => (draft.rationale = "")],
    ["no instructions", (draft) => (draft.instructions = [])],
    ["an unknown scope", (draft) => (draft.instructions = [{ scope: "vibes", text: "x" }])],
    ["an empty instruction", (draft) => (draft.instructions = [{ scope: "system", text: "" }])],
    ["an unknown tool shape", (draft) => ((draft.tools as Record<string, unknown>).shape = "yaml")],
    ["a non-positive description cap", (draft) => ((draft.tools as Record<string, unknown>).descriptionMaxChars = 0)],
    ["an unknown name case", (draft) => ((draft.naming as Record<string, unknown>).toolNameCase = "SHOUTING")],
    [
      "the same scope twice",
      (draft) =>
        (draft.instructions = [
          { scope: "system", text: "a" },
          { scope: "system", text: "b" },
        ]),
    ],
  ]

  test("each malformed profile is refused with a reason, and nothing is opened", () => {
    // The probe. `parse` is synchronous and pure, so any network use would have
    // to go through one of these; touching either fails the test.
    let touched = 0
    const realFetch = globalThis.fetch
    const realRequest = globalThis.Request
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    globalThis.fetch = (() => {
      touched += 1
      throw new Error("the network was touched while validating a harness profile")
    }) as unknown as typeof fetch
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    globalThis.Request = class {
      constructor() {
        touched += 1
        throw new Error("a request was constructed while validating a harness profile")
      }
    } as never

    try {
      for (const [name, damage] of cases) {
        const draft = valid()
        damage(draft)
        const result = parse(draft)
        if (result.ok) throw new Error(`${name} was accepted`)
        expect(result.why.length).toBeGreaterThan(0)
      }
      // And the valid one still parses, so the ten refusals above are not just
      // a parser that refuses everything.
      expect(parse(valid()).ok).toBe(true)
    } finally {
      globalThis.fetch = realFetch
      globalThis.Request = realRequest
    }
    expect(touched).toBe(0)
  })

  test("the probe can fire, so a count of zero above is evidence", () => {
    let touched = 0
    const realFetch = globalThis.fetch
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    globalThis.fetch = (() => {
      touched += 1
      return undefined as never
    }) as unknown as typeof fetch
    try {
      globalThis.fetch("https://example.test")
    } finally {
      globalThis.fetch = realFetch
    }
    expect(touched).toBe(1)
  })

  test("a registry given an invalid document refuses to load at all", () => {
    const draft = valid()
    draft.version = -1
    expect(() => HarnessRegistry.from([draft])).toThrow(/invalid harness profile/)
  })

  test("two profiles cannot claim the same id", () => {
    expect(() => HarnessRegistry.from([valid(), valid()])).toThrow(/claim the id/)
  })
})

// --- 3. applying reads fields ------------------------------------------------------

describe("S125 applying a profile", () => {
  const profileOf = (draft: Record<string, unknown>) => {
    const result = parse(draft)
    if (!result.ok) throw new Error(result.why)
    return result.profile
  }

  test("tool names are cased by the profile, and the namespace joins in the same style", () => {
    const styles: readonly (readonly [string, string | undefined, string])[] = [
      ["snake", undefined, "read_file"],
      ["kebab", undefined, "read-file"],
      ["camel", undefined, "readFile"],
      ["as-written", undefined, "read file"],
      ["snake", "abdo", "abdo_read_file"],
      ["kebab", "abdo", "abdo-read-file"],
      ["camel", "abdo", "abdoReadFile"],
    ]
    for (const [style, namespace, expected] of styles) {
      const draft = valid()
      draft.naming = { assistant: "Abdo", toolNameCase: style, ...(namespace ? { toolNamespace: namespace } : {}) }
      const applied = apply(profileOf(draft), [tool()])
      expect(applied.tools[0]?.name).toBe(expected)
    }
  })

  test("{assistant} is substituted everywhere it appears", () => {
    const draft = valid()
    draft.naming = { assistant: "Zahra", toolNameCase: "snake" }
    const applied = apply(profileOf(draft), [])
    expect(applied.instructions.system).toContain("Zahra")
    expect(applied.instructions.system).not.toContain("{assistant}")
    expect(applied.instructions.planner).toBeUndefined()
  })

  test("an over-long description is dropped with a reason, never truncated", () => {
    const draft = valid()
    ;(draft.tools as Record<string, unknown>).descriptionMaxChars = 10
    const applied = apply(profileOf(draft), [tool({ description: "x".repeat(11) })])
    expect(applied.tools).toEqual([])
    expect(applied.dropped[0]?.why).toContain("over the profile maximum")
  })

  test("the tool limit drops the overflow instead of silently keeping it", () => {
    const draft = valid()
    ;(draft.tools as Record<string, unknown>).limit = 1
    const applied = apply(profileOf(draft), [tool({ name: "a" }), tool({ name: "b" })])
    expect(applied.tools.map((entry) => entry.name)).toEqual(["a"])
    expect(applied.dropped.map((entry) => entry.name)).toEqual(["b"])
  })
})
