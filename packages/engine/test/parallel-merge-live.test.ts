/**
 * 09-29 — اختبارُ جودةٍ حيّ لفكرة Verdent على نظامنا: `parallel <<<` يشغّل عاملَين حقيقيّين (محرّكان كاملان عبر exec --worktree)
 * على مستودعٍ واحد بنموذجٍ زائف يكتب ملفَّ مهمّته، ثمّ `merge` يدمج الفرعَين بلا تعارض، ويُلغي دمجَ فرعٍ متعارض ويترك الشجرةَ
 * كما كانت، ويرفض فرعاً ليس فرعَ عامل. المسارُ المباشر (جسمُ الدور يبدأ باسم الأداة) — لا نموذجَ في الأب.
 */
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { stripChildEnv } from "../../tools/src/env-strip"

const ROOT = resolve(import.meta.dir, "../../..")
const git = (cwd: string, ...args: string[]) => { const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" }); return r.stdout.toString().trim() }

test.skipIf(process.platform !== "win32")("parallel: two workers on their own branches → merge both cleanly → a conflicting worker branch is aborted → non-worker branches are refused", async () => {
  // العاملُ يكتب ملفَّ اسمِ مهمّته ثمّ ينهي — حسب نصّ الطلب، فلا يتشارك العاملان شيئاً.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const payload = await request.json() as { stream?: boolean; messages?: { role?: string; content?: unknown }[] }
    const all = JSON.stringify(payload.messages ?? [])
    // القرارُ من آخر رسالة مستخدم (نصّ المهمّة) لا من السياق كلِّه: بعد الدمج يذكر السياقُ alpha.txt في كلّ مهمّة.
    const users = (payload.messages ?? []).filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
    const task = users[0] ?? ""
    const name = task.includes("REWRITE_README") ? "readme" : task.includes("alpha") ? "alpha" : task.includes("beta") ? "beta" : undefined
    const content = name === undefined || all.includes("✍") ? "Done." : name === "readme"
      ? "نفّذ: write README.md <<<\nconflicting readme\n"
      : `نفّذ: write ${name}.txt <<<\n${name} from its own branch\n`
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-par-live-")), repo = join(home, "repo"), state = join(home, "state"), settings = join(home, "settings.json")
  mkdirSync(repo, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" }
  Bun.spawnSync(["git", "init", "-q", "-b", "main", repo])
  writeFileSync(join(repo, "README.md"), "base\n")
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "repo", version: "1.0.0" }))
  Bun.spawnSync(["git", "-C", repo, "add", "."], { env: { ...process.env, ...identity } })
  Bun.spawnSync(["git", "-C", repo, "commit", "-q", "-m", "base"], { env: { ...process.env, ...identity } })
  writeFileSync(settings, JSON.stringify({
    language: "ar", mode: "full-access", modelRole: "agent", routerGate: "off", project: repo, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(repo).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project: repo, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: ROOT,
    env: { ...stripChildEnv(process.env).env, ...identity, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "3" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, ms = 240_000) => { const deadline = Date.now() + ms; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2500)); await Bun.sleep(50) } }
  let n = 0
  const turn = async (body: string): Promise<string> => {
    const id = `pm-${++n}`
    const before = frames.length
    send({ kind: "submit", mode: "full-access", turn: { id, body } })
    await wait(() => frames.slice(before).some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind)))
    return frames.slice(before).filter((f) => f.turnId === id && ["delta", "event", "tool-result", "refused", "done"].includes(f.kind)).map((f) => `${f.kind === "delta" ? "" : `[${f.kind}] `}${String(f.text ?? f.payload ?? f.output ?? f.why ?? f.answer ?? "")}`).join("\n")
  }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"), 60_000)
    const report = await turn("parallel <<<\nCreate alpha.txt with a line of text\nCreate beta.txt with a line of text")
    expect(report).toContain("عمّالٌ متوازون: 2")
    const branches = [...report.matchAll(/الفرع: (abdocode\/task-[0-9a-f]{8}) @ [0-9a-f]{7,}/gu)].map((m) => m[1]!)
    expect(branches).toHaveLength(2)
    expect(report).toContain("الملفّات: alpha.txt")
    expect(report).toContain("الملفّات: beta.txt")
    expect(report).toContain(`merge ${branches[0]}`)
    // الأصلُ لم يُمسّ، والأشجارُ أُزيلت.
    expect(git(repo, "status", "--porcelain")).toBe("")
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1)
    // الدمجُ واحداً واحداً
    for (const branch of branches) expect(await turn(`merge ${branch}`)).toContain(`✓ دُمج ${branch}`)
    expect(readFileSync(join(repo, "alpha.txt"), "utf8")).toContain("alpha from its own branch")
    expect(readFileSync(join(repo, "beta.txt"), "utf8")).toContain("beta from its own branch")
    expect(git(repo, "log", "--oneline").split("\n").filter((l) => l.includes("Merge branch"))).toHaveLength(2)
    // فرعٌ يتعارض مع الأصل: العاملُ يعيد كتابة README على فرعه، ثمّ يتغيّر README على main **بعد** تفرّعه ⇦ الدمجُ يتعارض فيُلغى
    // وتبقى الشجرة نظيفة والملفُّ كما كان على main.
    const conflicting = await turn("parallel <<<\nREWRITE_README: rewrite README.md completely\nCreate alpha.txt again with a line of text")
    writeFileSync(join(repo, "README.md"), "base changed on main\n")
    Bun.spawnSync(["git", "-C", repo, "commit", "-q", "-am", "main edit"], { env: { ...process.env, ...identity } })
    const readmeBranch = [...conflicting.matchAll(/الفرع: (abdocode\/task-[0-9a-f]{8}) @ [0-9a-f]{7,} · الملفّات: README\.md/gu)].map((m) => m[1]!)[0]
    if (readmeBranch === undefined) { console.log("REPORT>>" + conflicting.replace(/\n/gu, " ⏎ ")); throw new Error("no README branch in report") }
    const aborted = await turn(`merge ${readmeBranch}`)
    expect(aborted).toContain("تعذّر دمجُ")
    expect(aborted).toContain("أُلغي الدمج")
    expect(git(repo, "status", "--porcelain")).toBe("")
    // autocrlf قد يعيد الملفَّ بـCRLF بعد --abort — المقارنةُ بالمحتوى لا بنهايات الأسطر.
    expect(readFileSync(join(repo, "README.md"), "utf8").replace(/\r\n/gu, "\n")).toBe("base changed on main\n")
    expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false)
    // ليس فرعَ عاملٍ ⇦ رفضٌ بالاسم، ولا git يُنفَّذ.
    expect(await turn("merge main")).toContain("ليس فرعَ عاملٍ")
  } finally {
    child.kill(); await child.exited; server.stop(true); await errors
    for (let i = 0; i < 20; i += 1) { try { rmSync(home, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 400_000)
