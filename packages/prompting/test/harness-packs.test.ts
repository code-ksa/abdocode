import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { estimateTokens, tokensFromChars } from "@abdo/schema/tokens"
import { apply, overheadChars, type Profile, type ToolInput } from "../src/harness-profile"
import { HarnessRegistry } from "../src/harness"

/**
 * S126 — the five harness packs.
 *
 * `abdo-native` plus four written in the conventions other model families were
 * tuned on. Every one of them is written here; none is a copy of a published
 * prompt.
 *
 * # What the licensing check actually checks
 *
 * A test cannot verify authorship. What it can do is refuse a pack that will
 * not declare its provenance, refuse one carrying somebody else's copyright or
 * SPDX header, and refuse one that is a copy-paste of a sibling. That is what
 * runs below, and saying so is the point: a "licence test" that implied it had
 * verified originality would be the same class of lie as a gate whose zero
 * means nothing because nothing was attempted.
 *
 * # What the tournament is, and is not
 *
 * The packs are authored here, so "native is cheapest" is partly a statement
 * about how they were written, and the test does not pretend to have
 * discovered it. Its value is as a **regression guard**: the native harness
 * exists to be the one without ceremony, and this fails the day an edit makes
 * it heavier than a pack written for somebody else's model. The comparison is
 * held fair by giving every pack the identical tool set and counting with the
 * one token estimator this tree has.
 */

const SOURCE_DIR = join(import.meta.dir, "..", "src", "harness")

const NATIVE = "abdo-native"

/**
 * Scopes every pack must carry.
 *
 * This is what makes the tournament fair: the packs are compared at equal
 * capability, so a pack cannot win on tokens by leaving a mode out.
 */
const CORE_SCOPES = ["system", "builder", "verifier"] as const

/** The same tools for every pack. A tournament with different fields is not one. */
const TOOLS: readonly ToolInput[] = [
  { name: "read file", description: "Read a file from the workspace.", parameters: { type: "object" } },
  { name: "write file", description: "Write a file in the workspace.", parameters: { type: "object" } },
  { name: "run command", description: "Run a shell command and return its output.", parameters: { type: "object" } },
  { name: "search code", description: "Search the workspace for a pattern.", parameters: { type: "object" } },
  { name: "list directory", description: "List the entries of a directory.", parameters: { type: "object" } },
]

const packs = (): readonly { readonly id: string; readonly profile: Profile }[] =>
  HarnessRegistry.ids().map((id) => {
    const profile = HarnessRegistry.get(id)
    if (profile === undefined) throw new Error(`registry lists ${id} and cannot produce it`)
    return { id, profile }
  })

const fileOf = (id: string) => readFileSync(join(SOURCE_DIR, `${id}.ts`), "utf8")

// --- 1. conformance ----------------------------------------------------------

describe("S126 every pack meets the same contract", () => {
  test("the five packs are present, and the registry is the only list of them", () => {
    const onDisk = readdirSync(SOURCE_DIR)
      .filter((name) => name.endsWith(".ts") && name !== "index.ts")
      .map((name) => name.replace(/\.ts$/, ""))
      .sort()
    expect(onDisk).toEqual([...HarnessRegistry.ids()])
    expect(onDisk).toHaveLength(5)
    expect(onDisk).toContain(NATIVE)
  })

  test("every pack covers the same core scopes, so none looks cheap by doing less", () => {
    // Without this the tournament below is not a tournament. A pack that omits
    // `verifier` carries fewer characters and is not cheaper — it is a mode the
    // agent silently does not have under that harness, and the token count
    // would have rewarded exactly that.
    for (const { id, profile } of packs()) {
      const declared = profile.document.instructions.map((entry) => entry.scope).sort()
      expect(CORE_SCOPES.every((scope) => declared.includes(scope)), `${id} declares ${declared.join(", ")}`).toBe(true)
    }
  })

  test("each pack declares a system scope and leaves no placeholder unsubstituted", () => {
    for (const { id, profile } of packs()) {
      const applied = apply(profile, TOOLS)
      expect(applied.instructions.system, id).toBeDefined()
      for (const [scope, text] of Object.entries(applied.instructions)) {
        expect(text, `${id}/${scope}`).not.toContain("{assistant}")
        expect(text, `${id}/${scope}`).toContain(applied.assistant)
      }
    }
  })

  test("no pack silently loses a tool", () => {
    // The failure this forbids is a pack whose caps are tight enough that the
    // agent quietly has fewer capabilities under it than under another. A pack
    // may be more expensive; it may not be less capable without saying so.
    for (const { id, profile } of packs()) {
      const applied = apply(profile, TOOLS)
      expect(applied.dropped, id).toEqual([])
      expect(applied.tools, id).toHaveLength(TOOLS.length)
    }
  })

  test("each pack's tool names are unique and map back to exactly one tool", () => {
    for (const { id, profile } of packs()) {
      const applied = apply(profile, TOOLS)
      expect(new Set(applied.tools.map((tool) => tool.name)).size, id).toBe(TOOLS.length)
    }
  })

  test("the conformance check can fail, so five passes mean something", () => {
    const tight = HarnessRegistry.from([
      { ...JSON.parse(JSON.stringify(HarnessRegistry.get(NATIVE)!.document)), id: "too-tight", tools: { shape: "json-schema", strict: true, limit: 2, descriptionMaxChars: 8 } },
    ])
    const applied = apply(tight.get("too-tight")!, TOOLS)
    expect(applied.tools.length).toBeLessThan(TOOLS.length)
    expect(applied.dropped.length).toBeGreaterThan(0)
  })
})

// --- 2. licensing ------------------------------------------------------------

describe("S126 provenance", () => {
  test("every pack declares it was written here", () => {
    for (const { id, profile } of packs()) {
      expect(profile.document.origin, id).toBe("written-here")
    }
  })

  test("a pack that will not declare an origin cannot be registered", () => {
    const document = JSON.parse(JSON.stringify(HarnessRegistry.get(NATIVE)!.document)) as Record<string, unknown>
    delete document.origin
    expect(() => HarnessRegistry.from([document])).toThrow(/origin must be one of/)

    document.origin = "lifted-from-a-vendor"
    expect(() => HarnessRegistry.from([document])).toThrow(/origin must be one of/)
  })

  test("no pack file carries an imported copyright or licence header", () => {
    const MARKERS = [/copyright\s*\(c\)/i, /SPDX-License-Identifier/i, /all rights reserved/i, /licensed under the/i]
    for (const { id } of packs()) {
      const source = fileOf(id)
      for (const marker of MARKERS) expect(marker.test(source), `${id} matched ${marker}`).toBe(false)
    }
  })

  test("no pack is a copy-paste of a sibling", () => {
    // Eight-word verbatim runs. Two packs written independently about the same
    // subject share phrases; they do not share sentences.
    const runs = (text: string) => {
      const words = text.toLowerCase().split(/\s+/).filter((word) => word.length > 0)
      const found = new Set<string>()
      for (let index = 0; index + 8 <= words.length; index++) found.add(words.slice(index, index + 8).join(" "))
      return found
    }
    const instructionText = (profile: Profile) => profile.document.instructions.map((entry) => entry.text).join("\n")
    const entries = packs().map(({ id, profile }) => ({ id, runs: runs(instructionText(profile)) }))

    const shared: string[] = []
    for (let left = 0; left < entries.length; left++) {
      for (let right = left + 1; right < entries.length; right++) {
        for (const run of entries[left]!.runs) {
          if (entries[right]!.runs.has(run)) shared.push(`${entries[left]!.id}/${entries[right]!.id}: ${run}`)
        }
      }
    }
    expect(shared).toEqual([])
  })

  test("the copy-paste check finds a copy, so its silence means something", () => {
    const words = "you are the assistant and you must always do exactly what the user asked".split(" ")
    const runs = (text: string) => {
      const parts = text.toLowerCase().split(/\s+/)
      const found = new Set<string>()
      for (let index = 0; index + 8 <= parts.length; index++) found.add(parts.slice(index, index + 8).join(" "))
      return found
    }
    const left = runs(words.join(" "))
    const right = runs(`Preamble. ${words.join(" ")} Postamble.`)
    expect([...left].some((run) => right.has(run))).toBe(true)
  })
})

// --- 3. the tournament --------------------------------------------------------

describe("S126 the tournament", () => {
  const scoreOf = (scopes: readonly string[] | undefined) =>
    packs()
      .map(({ id, profile }) => {
        const applied = apply(profile, TOOLS)
        const instructions =
          scopes === undefined
            ? Object.values(applied.instructions).join("")
            : scopes.map((scope) => applied.instructions[scope as (typeof CORE_SCOPES)[number]] ?? "").join("")
        const chars =
          instructions.length +
          applied.tools.reduce(
            (total, tool) => total + tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length,
            0,
          ) +
          applied.stop.join("").length
        return { id, tokens: tokensFromChars(chars) }
      })
      .sort((left, right) => left.tokens - right.tokens)

  test("the native harness is the cheapest of the five", () => {
    // The whole harness, because that is what a turn actually sends. Extra
    // scopes beyond the core are not free capability — they are cost the
    // convention chose to carry, and the core-scope conformance check above is
    // what stops a pack from being cheap by lacking a mode.
    const scored = scoreOf(undefined)
    console.log(`[S126] whole-harness overhead: ${scored.map((entry) => `${entry.id} ${entry.tokens}t`).join(", ")}`)
    expect(scored[0]?.id).toBe(NATIVE)
    const runnerUp = scored[1]
    expect(runnerUp).toBeDefined()
    // A margin, not a rounding difference: a "cheapest" one token ahead is a
    // coin toss dressed as a result.
    expect(scored[0]!.tokens).toBeLessThan(runnerUp!.tokens * 0.97)
  })

  test("and on the core scopes alone it is second, which is reported rather than hidden", () => {
    // Stated because the honest reading of the number above depends on it.
    // Counting only system/builder/verifier, the reasoning-first pack is ~5%
    // cheaper: its convention is to say less in the system prompt and carry a
    // recovery mode instead. So the native harness's advantage is not "its
    // sentences are shortest" — it is that it carries no ceremony: no tool
    // namespace, no stop sequences, no shape inflation. Asserting a win here
    // too would mean trimming prose until the number came out right, which is
    // authoring the result rather than measuring it.
    const scored = scoreOf(CORE_SCOPES)
    console.log(`[S126] core-scope overhead: ${scored.map((entry) => `${entry.id} ${entry.tokens}t`).join(", ")}`)
    const native = scored.find((entry) => entry.id === NATIVE)
    expect(native).toBeDefined()
    expect(scored.indexOf(native!)).toBeLessThanOrEqual(1)
    // It may lose here; it may not drift far. A native harness 10% heavier than
    // the leanest convention has stopped being the lean one.
    expect(native!.tokens).toBeLessThan(scored[0]!.tokens * 1.1)
  })

  test("every pack is counted with the one estimator this tree has", () => {
    // Not a second estimator with a different divisor. The whole point of
    // S129's single-estimator condition is that two counts of the same text
    // silently disagree, and a tournament is exactly where that would decide
    // a winner.
    expect(estimateTokens("abc")).toBe(1)
    expect(estimateTokens("abcd")).toBe(2)
  })
})
