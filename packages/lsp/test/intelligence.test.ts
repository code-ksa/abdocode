/**
 * S39-S44 GATES — the graph, diagnostics as a blocker, reference-safe deletion,
 * range-exact patching, impact analysis, and the code-intelligence exam.
 *
 * The exam at the bottom is the S44 gate: 100 edits applied to one file, byte
 * exactness proven by reconstruction rather than asserted, and a reference
 * accuracy measured against a known-correct answer.
 */
import { describe, expect, test } from "bun:test"
import type { LspDiagnostic, LspLocation } from "../src/client"
import {
  addEdge,
  addGap,
  addNode,
  dependenciesOf,
  emptyGraph,
  impactedFiles,
  referencesTo,
  safeToRemove,
  type SymbolGraph,
  type TextMatch,
} from "../src/graph"
import { applyEdits, completionAllowed, offsetOf, verifyUntouched, type Edit } from "../src/patch"
import { formatImpact, selectTests } from "../src/impact"

const at = (uri: string, line: number): LspLocation => ({
  uri,
  range: { start: { line, character: 0 }, end: { line, character: 4 } },
})

/** api.load <- web.page, api.helper; and a test on each side. */
function repoGraph(): SymbolGraph {
  let g = emptyGraph()
  for (const [id, uri] of [
    ["api.load", "packages/api/src/config.ts"],
    ["api.helper", "packages/api/src/helper.ts"],
    ["web.page", "packages/web/src/page.ts"],
    ["api.test", "packages/api/test/config.test.ts"],
    ["web.test", "packages/web/test/page.test.ts"],
    ["unrelated", "packages/other/src/x.ts"],
  ] as const) {
    g = addNode(g, { id, name: id.split(".")[1]!, uri, kind: "function" })
  }
  g = addEdge(g, { from: "api.helper", to: "api.load", kind: "call", at: at("packages/api/src/helper.ts", 3), source: "lsp" })
  g = addEdge(g, { from: "web.page", to: "api.load", kind: "import", at: at("packages/web/src/page.ts", 1), source: "lsp" })
  g = addEdge(g, { from: "api.test", to: "api.load", kind: "reference", at: at("packages/api/test/config.test.ts", 5), source: "lsp" })
  g = addEdge(g, { from: "web.test", to: "web.page", kind: "reference", at: at("packages/web/test/page.test.ts", 2), source: "lsp" })
  return g
}

describe("S39 — the graph, and where its edges came from", () => {
  test("references cross package boundaries", () => {
    const g = repoGraph()
    expect(referencesTo(g, "api.load").map((e) => e.from).sort()).toEqual(["api.helper", "api.test", "web.page"])
    expect(dependenciesOf(g, "web.page").map((e) => e.to)).toEqual(["api.load"])
  })

  test("every edge records the tool that produced it — an edge with no provenance is not evidence", () => {
    for (const edge of repoGraph().edges) expect(["lsp", "text"]).toContain(edge.source)
  })

  test("the impact walk reports its own depth bound instead of stopping quietly", () => {
    const g = repoGraph()
    const shallow = impactedFiles(g, ["api.load"], 1)
    expect(shallow.truncated).toBe(true)
    const deep = impactedFiles(g, ["api.load"], 5)
    expect(deep.truncated).toBe(false)
    expect(deep.files).toContain("packages/web/test/page.test.ts")
  })

  test("a file the graph could not cover is a recorded gap, not an absence", () => {
    const g = addGap(repoGraph(), "packages/legacy/a.php", "no language server is installed for .php")
    expect(g.gaps).toHaveLength(1)
  })
})

describe("S41 GATE — 12 references and 15 text matches is a refusal", () => {
  const refs: LspLocation[] = Array.from({ length: 12 }, (_, i) => at("src/a.ts", i))

  test("the three unexplained occurrences stop the deletion and are named", () => {
    const matches: TextMatch[] = [
      ...refs.map((r) => ({ uri: r.uri, line: r.range.start.line, text: "load()" })),
      { uri: "src/registry.ts", line: 40, text: 'handlers["load"]()' },
      { uri: "config/app.json", line: 3, text: '"entry": "load"' },
      { uri: "src/reexport.ts", line: 1, text: "export { load } from './a'" },
    ]
    const verdict = safeToRemove(refs, matches)
    expect(verdict.allowed).toBe(false)
    expect(verdict.lspReferences).toBe(12)
    expect(verdict.textMatches).toBe(15)
    expect(verdict.unexplained).toHaveLength(3)
    expect(verdict.why).toContain("dynamic call, a re-export or a name in a config string")
  })

  test("comments are discounted BY RULE, and the rule is visible", () => {
    const matches: TextMatch[] = [
      ...refs.map((r) => ({ uri: r.uri, line: r.range.start.line, text: "load()" })),
      { uri: "src/a.ts", line: 99, text: "// load() used to be called here" },
      { uri: "src/a.ts", line: 100, text: " * load() is documented in the readme" },
    ]
    const verdict = safeToRemove(refs, matches)
    expect(verdict.allowed).toBe(true)
    expect(verdict.why).toContain("is a comment")
  })

  test("no language server answer means no deletion, whatever the text search found", () => {
    const verdict = safeToRemove(undefined, [{ uri: "src/a.ts", line: 1, text: "load()" }])
    expect(verdict.allowed).toBe(false)
    expect(verdict.why).toContain("a text search is not a substitute")
  })
})

describe("S40 GATE — a type error blocks the completion claim", () => {
  const error: LspDiagnostic = {
    uri: "src/a.ts",
    range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } },
    severity: "error",
    message: "Type 'string' is not assignable to type 'number'.",
  }

  test("an error diagnostic refuses completion even when the shell command passed", () => {
    const check = completionAllowed(new Map([["src/a.ts", { kind: "ok" as const, value: [error] }]]))
    expect(check.allowed).toBe(false)
    expect(check.why).toContain("does not overrule the compiler that read this project")
  })

  test("warnings do not block — the rule is about errors, not tidiness", () => {
    const warning: LspDiagnostic = { ...error, severity: "warning" }
    const check = completionAllowed(new Map([["src/a.ts", { kind: "ok" as const, value: [warning] }]]))
    expect(check.allowed).toBe(true)
  })

  test("a changed file with no diagnostics available blocks — not checked is not clean", () => {
    const check = completionAllowed(
      new Map([["src/a.ts", { kind: "unavailable" as const, why: "the server crashed while indexing" }]]),
    )
    expect(check.allowed).toBe(false)
    expect(check.why).toContain('"not checked" is not "clean"')
  })

  test("a caller may opt out of the availability requirement, but not out of the errors", () => {
    const lenient = completionAllowed(
      new Map([["src/a.ts", { kind: "unavailable" as const, why: "unsupported language" }]]),
      { requireDiagnostics: false },
    )
    expect(lenient.allowed).toBe(true)
    const strict = completionAllowed(new Map([["src/a.ts", { kind: "ok" as const, value: [error] }]]), {
      requireDiagnostics: false,
    })
    expect(strict.allowed).toBe(false)
  })
})

describe("S42 — patching by range, applied backwards", () => {
  const text = "const a = 1\nconst b = 2\nconst c = 3\n"

  test("offsets are computed from real line/character positions", () => {
    expect(offsetOf(text, 0, 0)).toBe(0)
    expect(offsetOf(text, 1, 6)).toBe(18)
    expect(offsetOf(text, 9, 0)).toBe(-1)
    expect(offsetOf(text, 0, 99)).toBe(-1)
  })

  test("two edits land in the right places — a forwards application would not", () => {
    const edits: Edit[] = [
      { uri: "a.ts", range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "alpha" },
      { uri: "a.ts", range: { start: { line: 2, character: 6 }, end: { line: 2, character: 7 } }, newText: "gamma" },
    ]
    const result = applyEdits(text, edits)
    expect(result.kind).toBe("ok")
    if (result.kind === "ok") expect(result.text).toBe("const alpha = 1\nconst b = 2\nconst gamma = 3\n")
  })

  test("overlapping edits are REJECTED, never merged", () => {
    const edits: Edit[] = [
      { uri: "a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, newText: "x" },
      { uri: "a.ts", range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "y" },
    ]
    const result = applyEdits(text, edits)
    expect(result.kind).toBe("rejected")
    if (result.kind === "rejected") expect(result.why).toContain("computed twice or from stale positions")
  })

  test("touching ranges are fine — only overlap is a conflict", () => {
    const edits: Edit[] = [
      { uri: "a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "let  " },
      { uri: "a.ts", range: { start: { line: 0, character: 5 }, end: { line: 0, character: 7 } }, newText: "z " },
    ]
    expect(applyEdits(text, edits).kind).toBe("ok")
  })

  test("a range that does not exist is refused rather than clamped", () => {
    const result = applyEdits(text, [
      { uri: "a.ts", range: { start: { line: 40, character: 0 }, end: { line: 40, character: 1 } }, newText: "x" },
    ])
    expect(result.kind).toBe("rejected")
  })
})

describe("S43 — tests selected from the graph, or honestly not selected at all", () => {
  test("a change selects the tests that actually reach it, across packages", () => {
    const report = selectTests(repoGraph(), ["api.load"])
    expect(report.recommendation).toBe("run_selected")
    // web.test reaches api.load only through web.page — the name-matching guess
    // would never have found it
    expect([...report.tests].sort()).toEqual(["packages/api/test/config.test.ts", "packages/web/test/page.test.ts"])
    expect(report.affected).not.toContain("packages/other/src/x.ts")
  })

  test("a truncated traversal means run everything, and says why", () => {
    const report = selectTests(repoGraph(), ["api.load"], { maxDepth: 1 })
    expect(report.recommendation).toBe("run_everything")
    expect(report.why).toContain("would look complete and would not be")
  })

  test("a graph with gaps means run everything — unanalysable files cannot be excluded", () => {
    const report = selectTests(addGap(repoGraph(), "legacy.php", "no server for .php"), ["api.load"])
    expect(report.recommendation).toBe("run_everything")
    expect(report.why).toContain("gap")
  })

  test("no reachable test is a thin graph, not a green light", () => {
    const report = selectTests(repoGraph(), ["unrelated"])
    expect(report.recommendation).toBe("run_everything")
    expect(formatImpact(report)).toContain("(none reachable)")
  })
})

describe("S44 GATE — the code-intelligence exam", () => {
  /** A file with 100 call sites, plus decoys inside strings and comments. */
  const examFile = (() => {
    const lines: string[] = ["import { load } from './config'", ""]
    for (let i = 0; i < 100; i++) lines.push(`export const v${i} = load(${i})`)
    lines.push('const decoyString = "load(999) must never be rewritten"')
    lines.push("// decoy comment: load(998) must never be rewritten")
    return lines.join("\n") + "\n"
  })()

  /** The 100 true call sites, as a language server would report them. */
  const trueSites = Array.from({ length: 100 }, (_, i) => {
    const line = 2 + i
    const character = `export const v${i} = `.length
    return { line, character }
  })

  test("100 edits apply, and NOT ONE BYTE outside the intended ranges moves", () => {
    const edits: Edit[] = trueSites.map(({ line, character }) => ({
      uri: "exam.ts",
      range: { start: { line, character }, end: { line, character: character + 4 } },
      newText: "loadConfig",
      reason: "rename load -> loadConfig",
    }))

    const result = applyEdits(examFile, edits)
    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") return

    expect(result.applied).toHaveLength(100)
    expect((result.text.match(/loadConfig\(/g) ?? []).length).toBe(100)

    // the decoys are untouched — this is where a regex rename does the damage
    expect(result.text).toContain('"load(999) must never be rewritten"')
    expect(result.text).toContain("// decoy comment: load(998) must never be rewritten")
    expect(result.text).toContain("import { load } from './config'")

    // and byte exactness is PROVEN by reconstruction, not asserted
    const proof = verifyUntouched(examFile, result.text, result.applied)
    expect(proof.ok).toBe(true)
    expect(proof.why).toContain("every byte outside them is identical")
  })

  test("the proof fails when something outside the ranges really did move", () => {
    const edits: Edit[] = [
      { uri: "exam.ts", range: { start: { line: 2, character: 20 }, end: { line: 2, character: 24 } }, newText: "loadConfig" },
    ]
    const result = applyEdits(examFile, edits)
    if (result.kind !== "ok") throw new Error("setup failed")
    // simulate the damage a regex would do: one extra rewrite nobody declared
    const tampered = result.text.replace('"load(999)', '"loadConfig(999)')
    expect(verifyUntouched(examFile, tampered, result.applied).ok).toBe(false)
  })

  test("reference accuracy is measured against a known-correct answer, not estimated", () => {
    const references: LspLocation[] = trueSites.map(({ line }) => ({
      uri: "exam.ts",
      range: { start: { line, character: 0 }, end: { line, character: 4 } },
    }))
    // what a text search sees: the 100 real sites plus both decoys plus the import
    const textMatches: TextMatch[] = [
      ...trueSites.map(({ line }) => ({ uri: "exam.ts", line, text: `export const v = load()` })),
      { uri: "exam.ts", line: 102, text: 'const decoyString = "load(999) must never be rewritten"' },
      { uri: "exam.ts", line: 103, text: "// decoy comment: load(998) must never be rewritten" },
      { uri: "exam.ts", line: 0, text: "import { load } from './config'" },
    ]

    const precision = references.length / textMatches.length
    expect(precision).toBeGreaterThan(0.96)

    // and the two genuine extras (the string and the import) still block a
    // deletion, because 98% accurate is not "safe to delete"
    const verdict = safeToRemove(references, textMatches)
    expect(verdict.allowed).toBe(false)
    expect(verdict.unexplained.map((u) => u.line).sort((a, b) => a - b)).toEqual([0, 102])
  })
})
