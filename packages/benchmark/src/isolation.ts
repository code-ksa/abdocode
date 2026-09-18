/**
 * Per-trial isolation with REAL git worktrees. Each trial runs in its own
 * detached worktree at the SAME commit, with a fresh db, so V1 never inherits
 * V2's edits (and vice versa). exec is injected so the logic is testable and the
 * real path uses git directly.
 */
// [CL-00A:ALLOW benchmark_worktree_files]
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}
export type Exec = (cmd: readonly string[], cwd: string) => Promise<ExecResult>

/** Default exec over Bun.spawn. */
export const bunExec: Exec = async (cmd, cwd) => {
  // [CL-00A:ALLOW benchmark_worktree_isolation]
  const child = Bun.spawn([...cmd], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const code = await child.exited
  return { code, stdout, stderr }
}

export interface Worktree {
  readonly dir: string
  readonly ref: string
  remove(): Promise<void>
}

export async function createWorktree(repoRoot: string, ref: string, exec: Exec, tmpBase?: string): Promise<Worktree> {
  const dir = join(tmpBase ?? tmpdir(), `abdo-bench-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  const r = await exec(["git", "worktree", "add", "--detach", dir, ref], repoRoot)
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.slice(0, 300)}`)
  return {
    dir,
    ref,
    async remove() {
      await exec(["git", "worktree", "remove", "--force", dir], repoRoot).catch(() => {})
    },
  }
}

export async function applyFixture(dir: string, fixture: Record<string, string> = {}): Promise<void> {
  for (const [rel, content] of Object.entries(fixture)) {
    const full = join(dir, rel)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
}

/**
 * Paths changed in the worktree (tracked + untracked), via porcelain status.
 * `-uall` lists every untracked FILE individually (not the collapsed directory),
 * so an expected path inside a newly-created folder is detected.
 */
export async function changedFiles(dir: string, exec: Exec): Promise<string[]> {
  const r = await exec(["git", "status", "--porcelain", "-uall"], dir)
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^\S+\s+/, "").replace(/^.*-> /, "")) // strip status + rename arrow
    .map((p) => p.replace(/^"(.*)"$/, "$1")) // unquote paths git quotes (spaces/unicode)
}

export async function resetWorktree(dir: string, exec: Exec): Promise<void> {
  await exec(["git", "checkout", "--", "."], dir).catch(() => {})
  await exec(["git", "clean", "-fd"], dir).catch(() => {})
}
