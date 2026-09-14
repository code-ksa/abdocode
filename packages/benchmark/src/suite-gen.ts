/**
 * The full 100-task suite, generated from real, parameterized templates so the
 * dataset genuinely hits the category distribution without 100 hand-writes. Each
 * task is CONCRETE (its own fixture) and the majority are objectively verifiable
 * (typecheck / tests / expected+forbidden diff / required content); qa/read/git
 * are qualitative (judge). Templates vary the fixture per index so tasks differ.
 */
import { CATEGORY_DISTRIBUTION, type BenchTask, type TaskCategory } from "./tasks"

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

const qa = (i: number): BenchTask => ({
  id: `qa-${i}`,
  category: "qa",
  fixture: { [`src/m${i}.ts`]: `export function f${i}(a: number, b: number): number {\n  return a ${i % 2 ? "-" : "+"} b\n}\n` },
  messages: [`In one sentence, what does f${i} in src/m${i}.ts compute?`],
  timeoutMs: 60_000,
  verification: { judgePrompt: `Does the answer correctly describe f${i} as ${i % 2 ? "subtracting b from a" : "adding a and b"}?` },
})

const readSearch = (i: number): BenchTask => ({
  id: `read-${i}`,
  category: "read_search",
  fixture: {
    [`src/a${i}.ts`]: `// TODO: task ${i}\nexport const a${i} = ${i}\n`,
    [`src/b${i}.ts`]: `export const b${i} = ${i + 1}\n`,
  },
  messages: [`Which file under src/ contains a TODO comment for task ${i}? Give its path.`],
  timeoutMs: 60_000,
  verification: { judgePrompt: `Does the answer name src/a${i}.ts (and not src/b${i}.ts)?` },
})

const singleEdit = (i: number): BenchTask => ({
  id: `edit-${i}`,
  category: "single_file_edit",
  fixture: { [`src/g${i}.ts`]: `export function g${i}(name: string) {\n  return \`Hi \${name}\`\n}\n` },
  messages: [`Add a JSDoc comment (/** … */) above g${i} in src/g${i}.ts describing it. Do not change behavior.`],
  timeoutMs: 90_000,
  verification: { expectPaths: [`src/g${i}.ts`], requireContains: [{ path: `src/g${i}.ts`, text: "/**" }, { path: `src/g${i}.ts`, text: `g${i}` }] },
})

const multiEdit = (i: number): BenchTask => ({
  id: `multi-${i}`,
  category: "multi_file_edit",
  fixture: {
    [`src/c${i}.ts`]: `export const K${i} = ${i}\n`,
    [`src/u${i}.ts`]: `import { K${i} } from './c${i}'\nexport const v${i} = K${i} * 2\n`,
  },
  messages: [`Rename the exported constant K${i} to LIMIT_${i} across both files. Keep behavior identical.`],
  timeoutMs: 120_000,
  verification: {
    expectPaths: [`src/c${i}.ts`, `src/u${i}.ts`],
    requireContains: [{ path: `src/c${i}.ts`, text: `LIMIT_${i}` }, { path: `src/u${i}.ts`, text: `LIMIT_${i}` }],
    requireAbsent: [{ path: `src/u${i}.ts`, text: `{ K${i} }` }],
  },
})

const tsFix = (i: number): BenchTask => ({
  id: `tsfix-${i}`,
  category: "typescript_fix",
  fixture: {
    [`src/broken${i}.ts`]: `export function d${i}(n: number) {\n  return n * '${i}'\n}\n`,
    "tsconfig.json": '{"compilerOptions":{"strict":true,"noEmit":true}}\n',
  },
  messages: [`src/broken${i}.ts has a TypeScript type error. Fix it so it type-checks and multiplies n by ${i}.`],
  timeoutMs: 120_000,
  verification: { typecheck: "bunx tsc --noEmit", requireContains: [{ path: `src/broken${i}.ts`, text: `n * ${i}` }] },
})

const testsDiagnose = (i: number): BenchTask => ({
  id: `tests-${i}`,
  category: "tests_diagnose",
  fixture: {
    [`op${i}.ts`]: `export const op${i} = (a: number, b: number) => a - b\n`,
    [`op${i}.test.ts`]: `import { expect, test } from 'bun:test'\nimport { op${i} } from './op${i}'\ntest('op${i}', () => expect(op${i}(${i + 2}, ${i})).toBe(${2 * i + 2}))\n`,
  },
  messages: [`The test op${i}.test.ts is failing. Fix the SOURCE (not the test) so it passes.`],
  timeoutMs: 120_000,
  // `bun test` passing IS the objective verification; an exact-string check on the
  // fix is brittle (a+b vs b+a vs no-spaces all pass the test), so it's dropped.
  verification: { test: "bun test", forbidPaths: [`op${i}.test.ts`] },
})

const gitAnalysis = (i: number): BenchTask => ({
  id: `git-${i}`,
  category: "git_analysis",
  fixture: { [`file${i}.md`]: `# doc ${i}\n` },
  messages: [`Run git status and summarize what is untracked or changed in the working tree.`],
  timeoutMs: 60_000,
  verification: { judgePrompt: `Does the answer reflect the real git status (e.g. file${i}.md untracked)?` },
})

const longMultiTool = (i: number): BenchTask => ({
  id: `long-${i}`,
  category: "long_multi_tool",
  fixture: {},
  messages: [`Create src/counter${i}.ts exporting a Counter${i} class with increment/decrement/value, and src/counter${i}.test.ts covering it, then run the tests.`],
  timeoutMs: 240_000,
  verification: { test: "bun test", expectPaths: [`src/counter${i}.ts`, `src/counter${i}.test.ts`] },
})

const crashResume = (i: number): BenchTask => ({
  id: `crash-${i}`,
  category: "crash_resume",
  fixture: { [`src/data${i}.ts`]: `export const data${i}: number[] = []\n` },
  messages: [`Append the number ${100 + i} to the exported data${i} array in src/data${i}.ts.`],
  timeoutMs: 120_000,
  // The runner may kill + resume this trial; the side effect must land exactly
  // once (no duplicate) and the file must be correct.
  verification: { requireContains: [{ path: `src/data${i}.ts`, text: `${100 + i}` }] },
})

// EXPORTED so the confirmatory suite can build fresh variants of the SAME
// known templates (its "known-template" cohort) instead of re-implementing
// them. Exporting does not touch FULL_SUITE's behavior or count.
export const GENERATORS: Record<TaskCategory, (i: number) => BenchTask> = {
  qa,
  read_search: readSearch,
  single_file_edit: singleEdit,
  multi_file_edit: multiEdit,
  typescript_fix: tsFix,
  tests_diagnose: testsDiagnose,
  git_analysis: gitAnalysis,
  long_multi_tool: longMultiTool,
  crash_resume: crashResume,
}

/** The full 100-task suite in the documented distribution. */
export function generateSuite(): BenchTask[] {
  const out: BenchTask[] = []
  for (const [cat, count] of Object.entries(CATEGORY_DISTRIBUTION) as [TaskCategory, number][]) {
    for (const i of range(count)) out.push(GENERATORS[cat](i))
  }
  return out
}

export const FULL_SUITE: readonly BenchTask[] = generateSuite()
