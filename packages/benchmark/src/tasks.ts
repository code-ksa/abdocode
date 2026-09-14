/**
 * Benchmark task schema + the category distribution. A task is REAL: a concrete
 * prompt over a fixture, verified OBJECTIVELY (typecheck/tests/expected+forbidden
 * diff/required content) — never "say hello".
 *
 * The full suite target is 100 tasks in the distribution below. This file ships
 * the schema, the distribution, a validator, and a representative real sample;
 * the suite is data-driven so the set can grow to 100 without code changes.
 */
export type TaskCategory =
  | "qa"
  | "read_search"
  | "single_file_edit"
  | "multi_file_edit"
  | "typescript_fix"
  | "tests_diagnose"
  | "git_analysis"
  | "long_multi_tool"
  | "crash_resume"

/** Target counts — sums to 100. */
export const CATEGORY_DISTRIBUTION: Record<TaskCategory, number> = {
  qa: 10,
  read_search: 15,
  single_file_edit: 20,
  multi_file_edit: 15,
  typescript_fix: 10,
  tests_diagnose: 10,
  git_analysis: 10,
  long_multi_tool: 5,
  crash_resume: 5,
}

export interface Verification {
  /** Shell commands run in the workdir; exit 0 = pass. */
  readonly typecheck?: string
  readonly test?: string
  readonly build?: string
  readonly lint?: string
  /** git diff MUST touch every path here. */
  readonly expectPaths?: readonly string[]
  /** git diff must touch NONE of these. */
  readonly forbidPaths?: readonly string[]
  readonly requireContains?: readonly { path: string; text: string }[]
  readonly requireAbsent?: readonly { path: string; text: string }[]
  /** A qualitative check for non-mechanical tasks (a judge may score it). */
  readonly judgePrompt?: string
}

export interface BenchTask {
  readonly id: string
  readonly category: TaskCategory
  readonly messages: readonly string[]
  /** Files written into the worktree before the run (relative paths). */
  readonly fixture?: Record<string, string>
  readonly timeoutMs: number
  readonly verification: Verification
  /** Dangerous side effects -> run one side live, the other in a sandbox/shadow. */
  readonly dangerous?: boolean
}

export interface DistributionCheck {
  readonly total: number
  readonly byCategory: Record<string, number>
  readonly matchesTarget: boolean
  readonly missing: Partial<Record<TaskCategory, number>>
}

export function checkDistribution(suite: readonly BenchTask[]): DistributionCheck {
  const byCategory: Record<string, number> = {}
  for (const t of suite) byCategory[t.category] = (byCategory[t.category] ?? 0) + 1
  const missing: Partial<Record<TaskCategory, number>> = {}
  let matches = true
  for (const [cat, target] of Object.entries(CATEGORY_DISTRIBUTION) as [TaskCategory, number][]) {
    const have = byCategory[cat] ?? 0
    if (have < target) {
      missing[cat] = target - have
      matches = false
    }
  }
  return { total: suite.length, byCategory, matchesTarget: matches && suite.length >= 100, missing }
}

/** A representative REAL sample (one per category). The full 100 extends this. */
export const SAMPLE_SUITE: readonly BenchTask[] = [
  {
    id: "qa-what-does-add-do",
    category: "qa",
    fixture: { "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b\n}\n" },
    messages: ["What does the add function in src/math.ts do? Answer in one sentence."],
    timeoutMs: 60_000,
    verification: { judgePrompt: "Does the answer correctly state that add returns the sum of a and b?" },
  },
  {
    id: "read-find-todo",
    category: "read_search",
    fixture: { "src/a.ts": "// TODO: handle empty input\nexport const a = 1\n", "src/b.ts": "export const b = 2\n" },
    messages: ["Which files contain a TODO comment? List their paths."],
    timeoutMs: 60_000,
    verification: { judgePrompt: "Does the answer name src/a.ts (and not src/b.ts)?" },
  },
  {
    id: "edit-add-jsdoc",
    category: "single_file_edit",
    fixture: { "src/greet.ts": "export function greet(name: string) {\n  return `Hi ${name}`\n}\n" },
    messages: ["Add a JSDoc comment above the greet function describing what it does. Do not change its behavior."],
    timeoutMs: 90_000,
    verification: { expectPaths: ["src/greet.ts"], requireContains: [{ path: "src/greet.ts", text: "/**" }], typecheck: "bunx tsc --noEmit src/greet.ts" },
  },
  {
    id: "multi-rename-const",
    category: "multi_file_edit",
    fixture: {
      "src/config.ts": "export const MAX = 10\n",
      "src/use.ts": "import { MAX } from './config'\nexport const limit = MAX * 2\n",
    },
    messages: ["Rename the exported constant MAX to MAX_ITEMS across the project. Keep behavior identical."],
    timeoutMs: 120_000,
    verification: {
      expectPaths: ["src/config.ts", "src/use.ts"],
      requireContains: [{ path: "src/config.ts", text: "MAX_ITEMS" }, { path: "src/use.ts", text: "MAX_ITEMS" }],
      requireAbsent: [{ path: "src/use.ts", text: "{ MAX }" }],
    },
  },
  {
    id: "tsfix-missing-return-type",
    category: "typescript_fix",
    fixture: { "src/broken.ts": "export function double(n: number) {\n  return n * '2'\n}\n", "tsconfig.json": '{"compilerOptions":{"strict":true,"noEmit":true}}\n' },
    messages: ["src/broken.ts has a TypeScript error. Fix it so it type-checks and doubles the number."],
    timeoutMs: 120_000,
    verification: { typecheck: "bunx tsc --noEmit", requireContains: [{ path: "src/broken.ts", text: "n * 2" }] },
  },
  {
    id: "tests-fix-failing",
    category: "tests_diagnose",
    fixture: {
      "sum.ts": "export const sum = (a: number, b: number) => a - b\n",
      "sum.test.ts": "import { expect, test } from 'bun:test'\nimport { sum } from './sum'\ntest('sum', () => expect(sum(2, 3)).toBe(5))\n",
    },
    messages: ["The test in sum.test.ts is failing. Diagnose and fix the source so the test passes. Do not edit the test."],
    timeoutMs: 120_000,
    verification: { test: "bun test", forbidPaths: ["sum.test.ts"], requireContains: [{ path: "sum.ts", text: "a + b" }] },
  },
  {
    id: "git-summarize-diff",
    category: "git_analysis",
    fixture: { "README.md": "# Project\n" },
    messages: ["Run git status and summarize what has changed in the working tree."],
    timeoutMs: 60_000,
    verification: { judgePrompt: "Does the answer reflect the actual git status output?" },
  },
  {
    id: "long-scaffold-module",
    category: "long_multi_tool",
    fixture: {},
    messages: ["Create src/counter.ts exporting a Counter class with increment/decrement/value, and src/counter.test.ts covering it, then run the tests."],
    timeoutMs: 240_000,
    verification: { test: "bun test", expectPaths: ["src/counter.ts", "src/counter.test.ts"] },
  },
  {
    id: "crash-resume-write",
    category: "crash_resume",
    fixture: { "src/data.ts": "export const data = []\n" },
    messages: ["Append the number 42 to the exported data array in src/data.ts."],
    timeoutMs: 120_000,
    // The runner kills the runtime mid-run and resumes; the side effect must not
    // duplicate and the final file must be correct exactly once.
    verification: { requireContains: [{ path: "src/data.ts", text: "42" }] },
    dangerous: false,
  },
]
