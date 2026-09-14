/**
 * OBJECTIVE verification. For code tasks the verdict is mechanical — typecheck,
 * tests, build, the expected file diff, forbidden changes, required/absent
 * content — not a model's opinion. A judge (judgePrompt) may score the few
 * qualitative tasks, but is NEVER the sole gate for a mechanical task.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { changedFiles, type Exec } from "./isolation"
import type { Verification } from "./tasks"

export interface CheckResult {
  readonly name: string
  readonly passed: boolean
  readonly detail?: string
}

export interface VerificationResult {
  /** All mechanical checks passed. Judge checks are advisory (not gating). */
  readonly passed: boolean
  readonly score: number // passed / total mechanical checks
  readonly checks: readonly CheckResult[]
  /** True when the task is qualitative-only (needs a judge, not mechanical). */
  readonly judgeOnly: boolean
}

const readOr = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8")
  } catch {
    return ""
  }
}

export async function verifyTask(dir: string, v: Verification, exec: Exec): Promise<VerificationResult> {
  const checks: CheckResult[] = []
  const runCmd = async (name: string, cmd?: string) => {
    if (!cmd) return
    const r = await exec(cmd.split(" "), dir)
    checks.push({ name, passed: r.code === 0, detail: r.code === 0 ? undefined : (r.stderr || r.stdout).slice(0, 300) })
  }

  await runCmd("typecheck", v.typecheck)
  await runCmd("test", v.test)
  await runCmd("build", v.build)
  await runCmd("lint", v.lint)

  if (v.expectPaths || v.forbidPaths) {
    const changed = await changedFiles(dir, exec)
    const changedSet = new Set(changed)
    for (const p of v.expectPaths ?? []) checks.push({ name: `expect:${p}`, passed: changedSet.has(p), detail: changedSet.has(p) ? undefined : `not changed (changed: ${changed.join(", ") || "none"})` })
    for (const p of v.forbidPaths ?? []) checks.push({ name: `forbid:${p}`, passed: !changedSet.has(p), detail: changedSet.has(p) ? "was modified" : undefined })
  }
  for (const rc of v.requireContains ?? []) {
    const content = await readOr(join(dir, rc.path))
    checks.push({ name: `contains:${rc.path}`, passed: content.includes(rc.text), detail: content.includes(rc.text) ? undefined : `missing "${rc.text}"` })
  }
  for (const ra of v.requireAbsent ?? []) {
    const content = await readOr(join(dir, ra.path))
    checks.push({ name: `absent:${ra.path}`, passed: !content.includes(ra.text), detail: content.includes(ra.text) ? `still contains "${ra.text}"` : undefined })
  }

  const judgeOnly = checks.length === 0 && !!v.judgePrompt
  const total = checks.length
  const passedCount = checks.filter((c) => c.passed).length
  return {
    passed: total > 0 ? passedCount === total : false, // a judge-only task is not mechanically "passed"
    score: total > 0 ? passedCount / total : 0,
    checks,
    judgeOnly,
  }
}
