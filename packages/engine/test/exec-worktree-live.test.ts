/**
 * الفجوة #8 محلّيّاً (2026-09-27) — `exec --worktree`: مهمّتان متوازيتان على مستودعٍ واحد، كلٌّ في فرعٍ وشجرةٍ وحالةٍ منفصلة.
 * نسخةُ العمل الأصليّة لا تُمسّ، وكلُّ فرعٍ يحمل إيداعَه وحده، والأشجارُ تُزال؛ ومهمّةٌ لا تغيّر شيئاً لا تُبقي فرعاً.
 */
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { stripChildEnv } from "../../tools/src/env-strip"

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  return r.stdout.toString().trim()
}

test("two tasks in parallel, each on its own branch; the working copy untouched; worktrees removed; nothing left by a no-op", async () => {
  // يكتب المهمّةُ ملفَّ اسمِها ثمّ يُنهي — حسب محتوى الطلب، فالمهمّتان المتوازيتان لا تتشاركان عدّاداً.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const payload = await request.json() as { stream?: boolean; messages?: { content?: unknown }[] }
    const text = JSON.stringify(payload.messages ?? [])
    const name = text.includes("alpha") ? "alpha" : text.includes("beta") ? "beta" : undefined
    const content = name === undefined || text.includes("✍") ? "Done." : `نفّذ: write ${name}.txt <<<\n${name} from its own branch\n`
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-wt-")), repo = join(home, "repo"), plain = join(home, "plain"), settings = join(home, "settings.json")
  mkdirSync(repo, { recursive: true }); mkdirSync(plain, { recursive: true })
  const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" }
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo])
  writeFileSync(join(repo, "README.md"), "base\n")
  Bun.spawnSync(["git", "-C", repo, "add", "."], { env: { ...process.env, ...identity } })
  Bun.spawnSync(["git", "-C", repo, "commit", "-q", "-m", "base"], { env: { ...process.env, ...identity } })
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "full-access", modelRole: "agent", routerGate: "off", project: repo, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const exec = async (task: string, project: string) => {
    const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "exec", task, "--project", project, "--mode", "full-access", "--worktree", "--json", "--quiet"], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...stripChildEnv(process.env).env, ...identity, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "3", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
      stdout: "pipe", stderr: "pipe",
    })
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { code, summary: JSON.parse(stdout) }
  }
  try {
    const [alpha, beta] = await Promise.all([exec("Create alpha.txt", repo), exec("Create beta.txt", repo)])
    for (const [run, name] of [[alpha, "alpha"], [beta, "beta"]] as const) {
      expect(run.code).toBe(0)
      expect(run.summary.worktree.branch).toMatch(/^abdocode\/task-[0-9a-f]{8}$/u)
      expect(run.summary.worktree.changedFiles).toEqual([`${name}.txt`])
      expect(run.summary.worktree.commit).toMatch(/^[0-9a-f]{7,}$/u)
      expect(git(repo, "show", `${run.summary.worktree.branch}:${name}.txt`)).toBe(`${name} from its own branch`)
    }
    expect(alpha.summary.worktree.branch).not.toBe(beta.summary.worktree.branch)
    // نسخةُ العمل الأصليّة كما كانت، والأشجارُ المؤقّتة أُزيلت.
    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(existsSync(join(repo, "alpha.txt")) || existsSync(join(repo, "beta.txt"))).toBe(false)
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1)
    // مهمّةٌ لا تكتب شيئاً لا تُبقي فرعاً.
    const before = git(repo, "branch", "--list", "abdocode/*").split("\n").filter(Boolean).length
    const noop = await exec("Just say hello", repo)
    expect(noop.summary.worktree.changedFiles).toEqual([])
    expect(git(repo, "branch", "--list", "abdocode/*").split("\n").filter(Boolean)).toHaveLength(before)
    // والتوأم: مجلّدٌ ليس مستودعاً يُرفض باسمه.
    const notRepo = await exec("Create gamma.txt", plain)
    expect(notRepo.code).toBe(2)
    expect(notRepo.summary.reason).toContain("يحتاج مستودعَ git")
  } finally {
    server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 240_000)
