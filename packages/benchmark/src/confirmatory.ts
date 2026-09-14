/**
 * Slice 12I.6 confirmatory benchmark — the PRE-REGISTERED 250-pair suite and
 * its paired non-inferiority statistics.
 *
 * Why this exists: re-running the frozen 100 after code changes measures
 * overfitting, not generalization (`docs/slice-12i6-reliability-hardening.md`
 * §4). This suite is FRESH — no task id or fixture overlaps FULL_SUITE,
 * SAMPLE_SUITE, the HARD canary, the strategy probes, or the prior 95 live
 * pairs — and its design (endpoint, model, pairing, margin, CI method) is
 * frozen here BEFORE any confirmatory outcome exists. The frozen SHA-256
 * fingerprint makes task-definition drift a hard, mechanical failure.
 *
 * Cohorts (mechanically checkable via `cohort` on every task):
 *   - 150 known-template fresh variants — the FULL_SUITE template families at
 *     fresh indices (offset 100), same shape, never-seen fixtures.
 *   - 100 unseen-template variants — task shapes with NO counterpart in any
 *     prior suite (40% of 250, the top of the pre-registered 30–40% band).
 * No crash_resume tasks: recovery is measured by local crash-injection in the
 * live runner, not by the paired live suite.
 */
import { createHash } from "node:crypto"
import { METRICS_SCHEMA_VERSION } from "./metrics"
import { SAMPLE_SUITE, type BenchTask, type TaskCategory } from "./tasks"
import { FULL_SUITE, GENERATORS } from "./suite-gen"
import { STRATEGY_PROBE_TASKS } from "./strategy-probes"
import type { BenchmarkData, TrialResult } from "./runner"

export type ConfirmatoryCohort = "known-template" | "unseen-template"

export interface ConfirmatoryTask extends BenchTask {
  readonly cohort: ConfirmatoryCohort
  /** Template family name, e.g. `known:single_file_edit` or `unseen:edit-negate-offset`. */
  readonly template: string
}

/**
 * The frozen design. Every field is part of the pre-registration
 * (`docs/slice-12i6-confirmatory-preregistration.md`); changing one changes
 * what the confirmatory verdict means and requires a NEW pre-registration.
 */
export const CONFIRMATORY_DESIGN = {
  suiteId: "abdo-confirmatory",
  suiteVersion: 2,
  pairs: 250,
  knownTemplateTasks: 150,
  unseenTasks: 100,
  provider: "qwen-local",
  endpoint: "http://127.0.0.1:11434/v1/chat/completions",
  /** V1 and V2 run the SAME model — the comparison is runtime vs runtime. */
  model: "qwen3.5:4b",
  v1Model: "ollama/qwen3.5:4b",
  orderSwap: true,
  confidence: 0.95,
  /** Two-sided 95% normal critical value (z), as pre-registered. */
  zCritical: 1.959963984540054,
  /** Non-inferiority margin on the paired V2−V1 success difference. */
  nonInferiorityMargin: -0.05,
  ciMethod: "paired-wald-normal-approximation",
  decisionRule: "one-sided non-inferiority: pass iff ciLower > -0.05 (strict)",
  successMetric: "taskSuccess (objective verification; judge-only tasks require a clean `completed`)",
} as const

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

// ---------------------------------------------------------------------------
// Known-template cohort: the FULL_SUITE template families at FRESH indices.
// Offset 100 keeps every id/fixture disjoint from FULL_SUITE (max index 19).
// ---------------------------------------------------------------------------

const KNOWN_INDEX_OFFSET = 100

const KNOWN_FAMILY: Record<Exclude<TaskCategory, "crash_resume">, string> = {
  qa: "qa",
  read_search: "read",
  single_file_edit: "edit",
  multi_file_edit: "multi",
  typescript_fix: "tsfix",
  tests_diagnose: "tests",
  git_analysis: "git",
  long_multi_tool: "long",
}

/** Counts sum to 150 — asserted by `assertConfirmatorySuite` and the tests. */
const KNOWN_TEMPLATE_COUNTS: Record<Exclude<TaskCategory, "crash_resume">, number> = {
  qa: 10,
  read_search: 10,
  single_file_edit: 32,
  multi_file_edit: 26,
  typescript_fix: 20,
  tests_diagnose: 20,
  git_analysis: 10,
  long_multi_tool: 22,
}

const knownVariant = (cat: Exclude<TaskCategory, "crash_resume">, idx: number): ConfirmatoryTask => ({
  ...GENERATORS[cat](idx),
  id: `cf-${KNOWN_FAMILY[cat]}-${idx}`,
  cohort: "known-template",
  template: `known:${cat}`,
})

const knownTemplateTasks = (Object.keys(KNOWN_TEMPLATE_COUNTS) as Exclude<TaskCategory, "crash_resume">[]).flatMap((cat) =>
  range(KNOWN_TEMPLATE_COUNTS[cat]).map((i) => knownVariant(cat, KNOWN_INDEX_OFFSET + i)),
)

// ---------------------------------------------------------------------------
// Unseen-template cohort: shapes with no counterpart in any prior suite.
// ---------------------------------------------------------------------------

const ueditNegate = (i: number): ConfirmatoryTask => ({
  id: `cf-uedit-neg-${i}`,
  category: "single_file_edit",
  cohort: "unseen-template",
  template: "unseen:edit-negate-offset",
  fixture: { [`src/neg${i}.ts`]: `export function neg${i}(a: number): number {\n  return a + ${i}\n}\n` },
  messages: [`In src/neg${i}.ts change neg${i} so it SUBTRACTS ${i} from a instead of adding it. Keep everything else identical.`],
  timeoutMs: 90_000,
  verification: {
    expectPaths: [`src/neg${i}.ts`],
    requireContains: [{ path: `src/neg${i}.ts`, text: `a - ${i}` }],
    requireAbsent: [{ path: `src/neg${i}.ts`, text: `a + ${i}` }],
  },
})

const ueditDefault = (i: number): ConfirmatoryTask => ({
  id: `cf-uedit-def-${i}`,
  category: "single_file_edit",
  cohort: "unseen-template",
  template: "unseen:edit-default-parameter",
  fixture: { [`src/greet${i}.ts`]: `export function greet${i}(name: string, punctuation = "!"): string {\n  return \`Hello \${name}\${punctuation}\`\n}\n` },
  messages: [`In src/greet${i}.ts change the default value of the punctuation parameter from "!" to "?". Do not change anything else.`],
  timeoutMs: 90_000,
  verification: {
    expectPaths: [`src/greet${i}.ts`],
    requireContains: [{ path: `src/greet${i}.ts`, text: `punctuation = "?"` }],
    requireAbsent: [{ path: `src/greet${i}.ts`, text: `punctuation = "!"` }],
  },
})

const ueditBound = (i: number): ConfirmatoryTask => ({
  id: `cf-uedit-bound-${i}`,
  category: "single_file_edit",
  cohort: "unseen-template",
  template: "unseen:edit-constant-revalue",
  fixture: { [`src/limit${i}.ts`]: `export const LIMIT${i} = ${i}\nexport const over${i} = (n: number) => n > LIMIT${i}\n` },
  messages: [`In src/limit${i}.ts change LIMIT${i} from ${i} to ${i + 100}. Do not touch the over${i} function.`],
  timeoutMs: 90_000,
  verification: {
    expectPaths: [`src/limit${i}.ts`],
    requireContains: [{ path: `src/limit${i}.ts`, text: `LIMIT${i} = ${i + 100}` }],
    requireAbsent: [{ path: `src/limit${i}.ts`, text: `LIMIT${i} = ${i}\n` }],
  },
})

const umultiPropagate = (i: number): ConfirmatoryTask => ({
  id: `cf-umulti-prop-${i}`,
  category: "multi_file_edit",
  cohort: "unseen-template",
  template: "unseen:multi-replace-literal-with-import",
  fixture: {
    [`src/base${i}.ts`]: `export const BASE${i} = ${i + 1}\n`,
    [`src/derive${i}.ts`]: `export const doubled${i} = ${(i + 1) * 2}\n`,
  },
  messages: [
    `src/derive${i}.ts hardcodes the value ${(i + 1) * 2}. Import BASE${i} from './base${i}' and define doubled${i} as BASE${i} * 2 instead. Keep the exported name doubled${i}.`,
  ],
  timeoutMs: 120_000,
  verification: {
    expectPaths: [`src/derive${i}.ts`],
    requireContains: [
      { path: `src/derive${i}.ts`, text: `BASE${i}` },
      { path: `src/derive${i}.ts`, text: `./base${i}` },
    ],
  },
})

const umultiShare = (i: number): ConfirmatoryTask => ({
  id: `cf-umulti-share-${i}`,
  category: "multi_file_edit",
  cohort: "unseen-template",
  template: "unseen:multi-add-export-and-new-consumer",
  fixture: {
    [`src/rates${i}.ts`]: `export const RATE${i} = ${i + 1}\n`,
    [`src/billA${i}.ts`]: `import { RATE${i} } from './rates${i}'\nexport const small${i} = RATE${i} * 1\n`,
    [`src/billB${i}.ts`]: `export const big${i} = ${(i + 1) * 5}\n`,
  },
  messages: [
    `Add a new exported constant EXTRA${i} with value ${i + 7} to src/rates${i}.ts. Then create a NEW file src/extra${i}.ts that imports EXTRA${i} from './rates${i}' and exports total${i} = EXTRA${i} + ${i}.`,
  ],
  timeoutMs: 150_000,
  verification: {
    expectPaths: [`src/rates${i}.ts`, `src/extra${i}.ts`],
    requireContains: [
      { path: `src/rates${i}.ts`, text: `EXTRA${i}` },
      { path: `src/extra${i}.ts`, text: `EXTRA${i}` },
      { path: `src/extra${i}.ts`, text: `./rates${i}` },
    ],
  },
})

const utsfixArgCount = (i: number): ConfirmatoryTask => ({
  id: `cf-utsfix-argc-${i}`,
  category: "typescript_fix",
  cohort: "unseen-template",
  template: "unseen:tsfix-wrong-arity-call",
  fixture: {
    [`src/argc${i}.ts`]: `export function sum3${i}(a: number, b: number, c: number): number {\n  return a + b + c\n}\n\nexport const total${i} = sum3${i}(${i}, ${i + 1})\n`,
    "tsconfig.json": '{"compilerOptions":{"strict":true,"noEmit":true}}\n',
  },
  messages: [`src/argc${i}.ts fails to type-check: sum3${i} is called with two arguments but takes three. Fix the CALL so it passes ${i + 2} as the third argument. Do not change sum3${i}'s signature.`],
  timeoutMs: 120_000,
  verification: { typecheck: "bunx tsc --noEmit", requireContains: [{ path: `src/argc${i}.ts`, text: `sum3${i}(${i}, ${i + 1}, ${i + 2})` }] },
})

const utsfixUndefined = (i: number): ConfirmatoryTask => ({
  id: `cf-utsfix-undef-${i}`,
  category: "typescript_fix",
  cohort: "unseen-template",
  template: "unseen:tsfix-optional-input-with-behavior-test",
  fixture: {
    [`src/undef${i}.ts`]: `export function headLen${i}(parts?: string[]): number {\n  return parts[0].length + ${i}\n}\n`,
    [`src/undef${i}.test.ts`]: `import { expect, test } from 'bun:test'\nimport { headLen${i} } from './undef${i}'\ntest('headLen${i}', () => {\n  expect(headLen${i}(['ab'])).toBe(2 + ${i})\n  expect(headLen${i}(undefined)).toBe(${i})\n})\n`,
    "tsconfig.json": '{"compilerOptions":{"strict":true,"noEmit":true}}\n',
  },
  messages: [
    `src/undef${i}.ts does not type-check under strict (parts may be undefined) and src/undef${i}.test.ts fails. Fix the SOURCE so bunx tsc --noEmit is clean and bun test passes: return ${i} when parts is undefined. Do not edit the test.`,
  ],
  timeoutMs: 150_000,
  verification: { typecheck: "bunx tsc --noEmit", test: "bun test", forbidPaths: [`src/undef${i}.test.ts`] },
})

const utestsBound = (i: number): ConfirmatoryTask => ({
  id: `cf-utests-bound-${i}`,
  category: "tests_diagnose",
  cohort: "unseen-template",
  template: "unseen:tests-exclusive-upper-bound",
  fixture: {
    [`bnd${i}.ts`]: `export const inRange${i} = (n: number) => n >= 0 && n <= ${i}\n`,
    [`bnd${i}.test.ts`]: `import { expect, test } from 'bun:test'\nimport { inRange${i} } from './bnd${i}'\ntest('inRange${i}', () => {\n  expect(inRange${i}(${i})).toBe(false)\n  expect(inRange${i}(${i - 1})).toBe(true)\n  expect(inRange${i}(0)).toBe(true)\n})\n`,
  },
  messages: [`The test bnd${i}.test.ts fails: the upper bound of inRange${i} should be EXCLUSIVE. Fix the SOURCE bnd${i}.ts (not the test) so it passes.`],
  timeoutMs: 120_000,
  verification: { test: "bun test", forbidPaths: [`bnd${i}.test.ts`] },
})

const utestsOperator = (i: number): ConfirmatoryTask => ({
  id: `cf-utests-op-${i}`,
  category: "tests_diagnose",
  cohort: "unseen-template",
  template: "unseen:tests-wrong-arithmetic-operator",
  fixture: {
    [`spread${i}.ts`]: `export const spread${i} = (a: number, b: number) => a * b + ${i}\n`,
    [`spread${i}.test.ts`]: `import { expect, test } from 'bun:test'\nimport { spread${i} } from './spread${i}'\ntest('spread${i}', () => expect(spread${i}(2, 3)).toBe(${5 + i}))\n`,
  },
  messages: [`spread${i}.test.ts fails because spread${i} multiplies a and b where it should ADD them (then add ${i}). Fix the SOURCE (not the test) so it passes.`],
  timeoutMs: 120_000,
  verification: { test: "bun test", forbidPaths: [`spread${i}.test.ts`] },
})

const ulongQueue = (i: number): ConfirmatoryTask => ({
  id: `cf-ulong-queue-${i}`,
  category: "long_multi_tool",
  cohort: "unseen-template",
  template: "unseen:long-scaffold-queue",
  fixture: {},
  messages: [
    `Create src/queue${i}.ts exporting a Queue${i} class with enqueue(value: number), dequeue(): number | undefined (FIFO), and size(): number, plus src/queue${i}.test.ts covering FIFO order and size, then run the tests.`,
  ],
  timeoutMs: 240_000,
  verification: { test: "bun test", expectPaths: [`src/queue${i}.ts`, `src/queue${i}.test.ts`] },
})

const ulongRectangle = (i: number): ConfirmatoryTask => ({
  id: `cf-ulong-rect-${i}`,
  category: "long_multi_tool",
  cohort: "unseen-template",
  template: "unseen:long-scaffold-rectangle",
  fixture: {},
  messages: [
    `Create src/rect${i}.ts exporting a Rectangle${i} class (constructor(width: number, height: number)) with area() and perimeter() methods, plus src/rect${i}.test.ts covering both, then run the tests.`,
  ],
  timeoutMs: 240_000,
  verification: { test: "bun test", expectPaths: [`src/rect${i}.ts`, `src/rect${i}.test.ts`] },
})

const uqaOutput = (i: number): ConfirmatoryTask => ({
  id: `cf-uqa-out-${i}`,
  category: "qa",
  cohort: "unseen-template",
  template: "unseen:qa-predict-exact-output",
  fixture: { [`src/calc${i}.ts`]: `export function calc${i}(a: number, b: number): number {\n  return a * ${i + 2} + b\n}\n` },
  messages: [`What number does calc${i}(3, 4) in src/calc${i}.ts return? Give the exact value.`],
  timeoutMs: 60_000,
  verification: { judgePrompt: `Does the answer give the exact value ${3 * (i + 2) + 4}?` },
})

const uqaCompare = (i: number): ConfirmatoryTask => ({
  id: `cf-uqa-cmp-${i}`,
  category: "qa",
  cohort: "unseen-template",
  template: "unseen:qa-compare-two-functions",
  fixture: { [`src/pair${i}.ts`]: `export function f${i}(n: number): number {\n  return n + ${i}\n}\nexport function g${i}(n: number): number {\n  return n * 2\n}\n` },
  messages: [`For input ${i + 3}, which function in src/pair${i}.ts returns the larger value: f${i} or g${i}?`],
  timeoutMs: 60_000,
  // g(i+3) = 2i+6 > 2i+3 = f(i+3), always.
  verification: { judgePrompt: `Does the answer name g${i} (value ${2 * (i + 3)}) as the larger, not f${i} (value ${i + 3 + i})?` },
})

const ureadCount = (i: number): ConfirmatoryTask => ({
  id: `cf-uread-count-${i}`,
  category: "read_search",
  cohort: "unseen-template",
  template: "unseen:read-count-matching-files",
  fixture: {
    [`src/alpha${i}.ts`]: `export const MARK${i} = ${i}\n`,
    [`src/beta${i}.ts`]: `export const MARK${i}B = ${i + 1}\n`,
    [`src/gamma${i}.ts`]: `// no marker here\nexport const other${i} = 0\n`,
  },
  messages: [`How many files under src/ export a constant whose name starts with MARK${i}? Answer with the count and the file paths.`],
  timeoutMs: 60_000,
  verification: { judgePrompt: `Does the answer say exactly 2 files (src/alpha${i}.ts and src/beta${i}.ts) and NOT src/gamma${i}.ts?` },
})

const ureadLocate = (i: number): ConfirmatoryTask => ({
  id: `cf-uread-locate-${i}`,
  category: "read_search",
  cohort: "unseen-template",
  template: "unseen:read-locate-marker",
  fixture: {
    [`src/one${i}.ts`]: `export const plain${i} = 1\n`,
    [`src/two${i}.ts`]: `// NEEDLE-${i}\nexport const needle${i} = 2\n`,
    [`src/three${i}.ts`]: `export const plain${i}b = 3\n`,
  },
  messages: [`Exactly one file under src/ contains the comment marker NEEDLE-${i}. Find it and give its path.`],
  timeoutMs: 60_000,
  verification: { judgePrompt: `Does the answer name src/two${i}.ts (and only that file)?` },
})

const ugitState = (i: number): ConfirmatoryTask => ({
  id: `cf-ugit-state-${i}`,
  category: "git_analysis",
  cohort: "unseen-template",
  template: "unseen:git-cleanliness-and-branch",
  fixture: { [`notes${i}.md`]: `# notes ${i}\n`, [`extra${i}.txt`]: `${i}\n` },
  messages: [`Run git status and git branch in this repo. Report whether the working tree is clean and name the current branch.`],
  timeoutMs: 60_000,
  verification: { judgePrompt: `Does the answer report the REAL result of git status and git branch (the fixture is committed before the run, so a clean tree; the branch name must be one git actually shows)?` },
})

// Counts per unseen family — together exactly 100 (asserted, not trusted).
const UNSEEN_FAMILIES: readonly { name: string; gen: (i: number) => ConfirmatoryTask; count: number; start?: number }[] = [
  { name: "edit-negate-offset", gen: ueditNegate, count: 8 },
  { name: "edit-default-parameter", gen: ueditDefault, count: 8 },
  { name: "edit-constant-revalue", gen: ueditBound, count: 8 },
  { name: "multi-replace-literal-with-import", gen: umultiPropagate, count: 10 },
  { name: "multi-add-export-and-new-consumer", gen: umultiShare, count: 10 },
  { name: "tsfix-wrong-arity-call", gen: utsfixArgCount, count: 7 },
  { name: "tsfix-optional-input-with-behavior-test", gen: utsfixUndefined, count: 7 },
  { name: "tests-exclusive-upper-bound", gen: utestsBound, count: 7, start: 1 },
  { name: "tests-wrong-arithmetic-operator", gen: utestsOperator, count: 7 },
  { name: "long-scaffold-queue", gen: ulongQueue, count: 4 },
  { name: "long-scaffold-rectangle", gen: ulongRectangle, count: 4 },
  { name: "qa-predict-exact-output", gen: uqaOutput, count: 5 },
  { name: "qa-compare-two-functions", gen: uqaCompare, count: 5 },
  { name: "read-count-matching-files", gen: ureadCount, count: 3 },
  { name: "read-locate-marker", gen: ureadLocate, count: 3 },
  { name: "git-cleanliness-and-branch", gen: ugitState, count: 4 },
]

const unseenTemplateTasks = UNSEEN_FAMILIES.flatMap((f) => range(f.count).map((n) => f.gen((f.start ?? 0) + n)))

/**
 * The pre-registered 250-task confirmatory suite. EXACT and IMMUTABLE for the
 * verdict: the frozen fingerprint below binds to precisely these definitions.
 * Order is fixed (known cohort first, families in declared order) so the
 * runner's per-task order-swap pattern is reproducible run to run.
 */
export const CONFIRMATORY_SUITE: readonly ConfirmatoryTask[] = [...knownTemplateTasks, ...unseenTemplateTasks]

// ---------------------------------------------------------------------------
// Frozen fingerprint — drift is a mechanical failure, not a review comment.
// ---------------------------------------------------------------------------

/** Canonical JSON: sorted object keys at every depth, so the hash cannot move
 *  because of property order. Only task DEFINITIONS feed it. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`
}

/** Recompute the suite fingerprint. The verifier compares this to the frozen constant. */
export function suiteFingerprint(suite: readonly ConfirmatoryTask[]): string {
  const payload = stableStringify({
    suiteId: CONFIRMATORY_DESIGN.suiteId,
    suiteVersion: CONFIRMATORY_DESIGN.suiteVersion,
    tasks: suite.map((t) => ({ ...t })),
  })
  return createHash("sha256").update(payload, "utf8").digest("hex")
}

/**
 * The frozen SHA-256 of the suite above, computed once at pre-registration.
 * Any task-definition change makes `assertConfirmatorySuite` throw until this
 * constant is DELIBERATELY updated — which is a new pre-registration event and
 * must be recorded in `docs/slice-12i6-confirmatory-preregistration.md`.
 */
export const CONFIRMATORY_FINGERPRINT = "e374c72f790abbfc5034b950471ad07428fe2cad696c4a81ac91d7fb156a3185"

export class ConfirmatorySuiteError extends Error {}
export class ConfirmatoryDataError extends Error {}

const PRIOR_IDS: ReadonlySet<string> = new Set([
  ...FULL_SUITE.map((t) => t.id),
  ...SAMPLE_SUITE.map((t) => t.id),
  ...STRATEGY_PROBE_TASKS.map((t) => t.id),
])

const LIVE_CATEGORIES: readonly TaskCategory[] = [
  "qa",
  "read_search",
  "single_file_edit",
  "multi_file_edit",
  "typescript_fix",
  "tests_diagnose",
  "git_analysis",
  "long_multi_tool",
]

/**
 * Full integrity check of a confirmatory suite (the shipped one by default):
 * exact counts, cohort split, category coverage, unique + non-overlapping ids,
 * no crash tasks, and the frozen fingerprint. Throws ConfirmatorySuiteError on
 * ANY violation — the live runner calls this BEFORE creating work or calling
 * the provider.
 */
export function assertConfirmatorySuite(suite: readonly ConfirmatoryTask[] = CONFIRMATORY_SUITE): void {
  const fail = (msg: string): never => {
    throw new ConfirmatorySuiteError(msg)
  }
  if (suite.length !== CONFIRMATORY_DESIGN.pairs) fail(`confirmatory suite must have exactly ${CONFIRMATORY_DESIGN.pairs} tasks, got ${suite.length}`)
  const known = suite.filter((t) => t.cohort === "known-template").length
  const unseen = suite.filter((t) => t.cohort === "unseen-template").length
  if (known !== CONFIRMATORY_DESIGN.knownTemplateTasks) fail(`known-template cohort must be exactly ${CONFIRMATORY_DESIGN.knownTemplateTasks}, got ${known}`)
  if (unseen !== CONFIRMATORY_DESIGN.unseenTasks) fail(`unseen-template cohort must be exactly ${CONFIRMATORY_DESIGN.unseenTasks}, got ${unseen}`)

  const ids = new Set<string>()
  for (const t of suite) {
    if (t.category === "crash_resume") fail(`confirmatory tasks must not be crash_resume (found ${t.id}) — recovery is measured by local crash-injection`)
    if (ids.has(t.id)) fail(`duplicate confirmatory task id ${t.id}`)
    ids.add(t.id)
    if (PRIOR_IDS.has(t.id)) fail(`confirmatory task id ${t.id} overlaps a prior suite — the confirmatory suite must be fresh`)
  }
  const cats = new Set(suite.map((t) => t.category))
  for (const c of LIVE_CATEGORIES) if (!cats.has(c)) fail(`confirmatory suite must cover category ${c}`)

  const fp = suiteFingerprint(suite)
  if (fp !== CONFIRMATORY_FINGERPRINT) fail(`suite fingerprint drift: frozen ${CONFIRMATORY_FINGERPRINT}, recomputed ${fp} — task definitions changed without a deliberate fingerprint update`)
}

/**
 * A small separately-labeled subset for connectivity/cost checks ONLY. It can
 * NEVER produce or persist a non-inferiority verdict — the live runner only
 * computes paired statistics for the exact full `confirmatory` mode.
 */
export const CONFIRMATORY_SMOKE_TASKS: readonly ConfirmatoryTask[] = (() => {
  const ids = new Set(["cf-edit-100", "cf-tsfix-100", "cf-utests-bound-1", "cf-uqa-out-0"])
  return CONFIRMATORY_SUITE.filter((t) => ids.has(t.id))
})()

// ---------------------------------------------------------------------------
// Paired non-inferiority statistics (C3)
// ---------------------------------------------------------------------------

export interface PairedStats {
  readonly pairs: number
  readonly v1Successes: number
  readonly v2Successes: number
  readonly v1SuccessRate: number
  readonly v2SuccessRate: number
  /** Mean of the paired {-1, 0, +1} differences (V2 − V1). */
  readonly observedDifference: number
  readonly concordantBothSuccess: number
  readonly concordantBothFail: number
  /** Discordant: V1 succeeded, V2 failed. */
  readonly discordantV1Only: number
  /** Discordant: V2 succeeded, V1 failed. */
  readonly discordantV2Only: number
  /** SE of the mean paired difference: sqrt((Σd² − (Σd)²/n) / (n(n−1))). */
  readonly standardError: number
  readonly zCritical: number
  readonly confidence: number
  readonly ciLower: number
  readonly ciUpper: number
  readonly margin: number
  readonly method: string
  /** The pre-registered decision: ciLower strictly greater than the margin. */
  readonly nonInferior: boolean
}

export interface RuntimeSecondary {
  readonly normalCompletionRate: number
  readonly duplicateSideEffects: number
  readonly stuckRuns: number
  readonly humanInterventions: number
}

export interface ConfirmatoryResult {
  readonly stats: PairedStats
  /** Secondary facts — reported alongside, NEVER rewriting the primary outcome. */
  readonly secondary: { readonly v1: RuntimeSecondary; readonly v2: RuntimeSecondary }
}

/** The one-sided decision rule, named and exported so the strictness is testable:
 *  the lower bound must be STRICTLY greater than the margin. */
export const nonInferiorDecision = (ciLower: number, margin: number): boolean => ciLower > margin

/**
 * Paired non-inferiority statistics over a live BenchmarkData set. Pairs
 * EXACTLY one V1 and one V2 result per confirmatory task id and REFUSES
 * (ConfirmatoryDataError) duplicates, missing sides, unknown task ids, a stale
 * metrics schema, or a non-250 dataset — it never silently drops a pair.
 */
export function confirmatoryStatistics(data: BenchmarkData): ConfirmatoryResult {
  const schema = data.metricsSchemaVersion ?? 1
  if (schema !== METRICS_SCHEMA_VERSION) {
    throw new ConfirmatoryDataError(`stale metrics schema ${schema} (current is ${METRICS_SCHEMA_VERSION}) — these numbers are not comparable; re-measure`)
  }

  const confirmatoryIds = new Set(CONFIRMATORY_SUITE.map((t) => t.id))
  const sides = new Map<string, { v1?: boolean; v2?: boolean }>()
  for (const t of data.trials) {
    if (!confirmatoryIds.has(t.taskId)) throw new ConfirmatoryDataError(`unknown task id "${t.taskId}" — not part of the confirmatory suite`)
    const entry = sides.get(t.taskId) ?? {}
    if (t.runtime === "v1") {
      if (entry.v1 !== undefined) throw new ConfirmatoryDataError(`duplicate v1 side for task "${t.taskId}" — pairs are never silently dropped or overwritten`)
      entry.v1 = t.metrics.taskSuccess
    } else {
      if (entry.v2 !== undefined) throw new ConfirmatoryDataError(`duplicate v2 side for task "${t.taskId}" — pairs are never silently dropped or overwritten`)
      entry.v2 = t.metrics.taskSuccess
    }
    sides.set(t.taskId, entry)
  }

  if (sides.size !== CONFIRMATORY_DESIGN.pairs) {
    throw new ConfirmatoryDataError(`expected exactly ${CONFIRMATORY_DESIGN.pairs} paired tasks, got ${sides.size} — the confirmatory verdict requires the exact full suite`)
  }
  for (const [taskId, entry] of sides) {
    if (entry.v1 === undefined) throw new ConfirmatoryDataError(`missing v1 side for task "${taskId}"`)
    if (entry.v2 === undefined) throw new ConfirmatoryDataError(`missing v2 side for task "${taskId}"`)
  }

  const n = CONFIRMATORY_DESIGN.pairs
  let sumD = 0
  let sumD2 = 0
  let bothSuccess = 0
  let bothFail = 0
  let v1Only = 0
  let v2Only = 0
  let v1Successes = 0
  let v2Successes = 0
  for (const entry of sides.values()) {
    const v1 = entry.v1!
    const v2 = entry.v2!
    if (v1) v1Successes++
    if (v2) v2Successes++
    if (v1 && v2) bothSuccess++
    else if (!v1 && !v2) bothFail++
    else if (v1) v1Only++
    else v2Only++
    const d = (v2 ? 1 : 0) - (v1 ? 1 : 0)
    sumD += d
    sumD2 += d * d
  }

  const observedDifference = sumD / n
  // Sample SD of the paired differences over sqrt(n); the max(0, …) guards a
  // floating-point negative zero variance (all-concordant data), never a real
  // negative.
  const standardError = Math.sqrt(Math.max(0, sumD2 - (sumD * sumD) / n) / (n * (n - 1)))
  const halfWidth = CONFIRMATORY_DESIGN.zCritical * standardError
  const ciLower = observedDifference - halfWidth
  const ciUpper = observedDifference + halfWidth

  return {
    stats: {
      pairs: n,
      v1Successes,
      v2Successes,
      v1SuccessRate: v1Successes / n,
      v2SuccessRate: v2Successes / n,
      observedDifference,
      concordantBothSuccess: bothSuccess,
      concordantBothFail: bothFail,
      discordantV1Only: v1Only,
      discordantV2Only: v2Only,
      standardError,
      zCritical: CONFIRMATORY_DESIGN.zCritical,
      confidence: CONFIRMATORY_DESIGN.confidence,
      ciLower,
      ciUpper,
      margin: CONFIRMATORY_DESIGN.nonInferiorityMargin,
      method: CONFIRMATORY_DESIGN.ciMethod,
      nonInferior: nonInferiorDecision(ciLower, CONFIRMATORY_DESIGN.nonInferiorityMargin),
    },
    secondary: { v1: secondaryFor(data.trials, "v1"), v2: secondaryFor(data.trials, "v2") },
  }
}

function secondaryFor(trials: readonly TrialResult[], runtime: "v1" | "v2"): RuntimeSecondary {
  const rt = trials.filter((t) => t.runtime === runtime)
  const rate = (k: number) => (rt.length === 0 ? 0 : k / rt.length)
  return {
    normalCompletionRate: rate(rt.filter((t) => t.metrics.completedNormally).length),
    duplicateSideEffects: rt.reduce((acc, t) => acc + (typeof t.metrics.duplicateSideEffects === "number" ? t.metrics.duplicateSideEffects : 0), 0),
    stuckRuns: rt.filter((t) => t.metrics.stuck).length,
    humanInterventions: rt.reduce((acc, t) => acc + t.metrics.humanInterventions, 0),
  }
}
