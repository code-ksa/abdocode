/**
 * وضعُ CI — الفجوة #6 في جدول 2026-09-27 (Codex `exec` وClaude `-p`): مهمّةٌ واحدة من سطر الأوامر، بلا واجهة، بخرجٍ يُقرأ آليّاً.
 *
 *   abdocode exec "<مهمّة>" [--project <مجلّد>] [--mode read-only|auto|full-access] [--timeout <ثوانٍ>] [--json] [--quiet]
 *
 * لا مسارَ ثانياً للوكيل: يُشغَّل المحرّكُ نفسُه في `serve` (البوّاباتُ والنواةُ والدفترُ كما هي)، ويقوده هذا الملفّ كما تقوده
 * القشرة. والفرقُ الوحيد أنّه **لا يملك من يوافق**: كلُّ طلب موافقةٍ يُرفض آليّاً ويُسجَّل في الخلاصة — CI لا يمنح إذناً
 * ضمنيّاً، والتوسعةُ باختيارٍ صريح (`--mode full-access`). ورمزُ الخروج يتبع النتيجة: 0 اكتمل، 1 توقّف بلا إكمال، 2 رُفض أو تعطّل.
 */
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

export interface ExecOptions {
  readonly task: string
  readonly project?: string
  readonly mode: "read-only" | "auto" | "full-access"
  readonly timeoutMs: number
  readonly json: boolean
  readonly quiet: boolean
  /** الفجوة #8 محلّيّاً: فرعٌ وشجرةُ عملٍ وحالةُ محرّكٍ منفصلة لهذه المهمّة. */
  readonly worktree?: boolean
}

export interface ExecSummary {
  readonly task: string
  readonly outcome: string
  readonly exitCode: 0 | 1 | 2
  readonly stop?: string
  readonly durationMs: number
  readonly tools: readonly { readonly cmd: string; readonly ok: boolean | null }[]
  readonly approvalsDenied: readonly string[]
  readonly gates?: string
  readonly answer: string
  readonly reason?: string
  readonly worktree?: { readonly branch: string; readonly commit?: string; readonly changedFiles: readonly string[] }
}

const USAGE = "الصيغة: exec \"<مهمّة>\" [--project <مجلّد>] [--mode read-only|auto|full-access] [--timeout <ثوانٍ>] [--worktree] [--json] [--quiet]"

/** الوسائطُ بعد `exec` — رفضٌ مسمّى لكلّ ما لا يُفهم، لا تخمين. */
export function parseExecArgs(args: readonly string[]): ExecOptions | { readonly error: string } {
  const words: string[] = []
  let project: string | undefined
  let mode: ExecOptions["mode"] = "auto"
  let timeoutMs = 30 * 60_000
  let json = false, quiet = false, worktree = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === "--json") json = true
    else if (arg === "--quiet") quiet = true
    else if (arg === "--worktree") worktree = true
    else if (arg === "--project") { project = args[++i]; if (project === undefined) return { error: `--project يحتاج مجلّداً. ${USAGE}` } }
    else if (arg === "--mode") {
      const value = args[++i]
      if (value !== "read-only" && value !== "auto" && value !== "full-access") return { error: `--mode: read-only أو auto أو full-access. ${USAGE}` }
      mode = value
    } else if (arg === "--timeout") {
      const seconds = Number(args[++i])
      if (!Number.isFinite(seconds) || seconds < 10 || seconds > 24 * 3600) return { error: `--timeout بالثواني بين 10 و86400. ${USAGE}` }
      timeoutMs = seconds * 1000
    } else if (arg.startsWith("--")) return { error: `خيارٌ غيرُ معروف «${arg.slice(0, 30)}». ${USAGE}` }
    else words.push(arg)
  }
  const task = words.join(" ").trim()
  if (task.length === 0) return { error: USAGE }
  return { task, ...(project === undefined ? {} : { project }), mode, timeoutMs, json, quiet, ...(worktree ? { worktree } : {}) }
}

const exitFor = (outcome: string): 0 | 1 | 2 => outcome === "completed" ? 0 : outcome === "checkpointed" || outcome === "unresolved" ? 1 : 2

/** يقود دوراً واحداً على محرّكٍ في `serve` ويعيد خلاصته. `engineArgv` = المحرّكُ نفسُه (مُجمَّعاً أو من المصدر). */
export async function runExec(options: ExecOptions, engineArgv: readonly string[], env: Record<string, string | undefined>, progress: (line: string) => void): Promise<ExecSummary> {
  const started = Date.now()
  const token = crypto.randomUUID()
  const turnId = `exec-${token.slice(0, 8)}`
  const child = Bun.spawn([...engineArgv, "serve"], {
    env: { ...env, ABDO_FRAMED_STDIO: "1", ABDO_SHELL_TOKEN: token, ...(options.project === undefined ? {} : { ABDO_PROJECT: options.project }) },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const decoder = new LocalJsonFrameDecoder()
  const tools: { cmd: string; ok: boolean | null }[] = []
  const denied: string[] = []
  let answer = "", stop: string | undefined, gates: string | undefined
  let finalAnswer: string | undefined
  let end: { kind: string; outcome?: string; why?: string } | undefined
  let ready = false
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const reading = (async () => {
    for await (const bytes of child.stdout) for (const frame of decoder.push(bytes) as Record<string, unknown>[]) {
      if (frame.kind === "ready") ready = true
      if (frame.turnId !== turnId) continue
      if (frame.kind === "delta") answer += String(frame.text ?? "")
      else if (frame.kind === "tool") { tools.push({ cmd: String(frame.cmd ?? "").split("\n", 1)[0]!.slice(0, 200), ok: null }); progress(`⚙ ${tools.at(-1)!.cmd}`) }
      else if (frame.kind === "tool-result") {
        const last = [...tools].reverse().find((t) => t.ok === null)
        const verdict = frame.verdict as { ok?: boolean } | undefined
        if (last !== undefined) last.ok = verdict?.ok ?? null
      } else if (frame.kind === "approval") {
        // لا مُوافِقَ في CI: الطلبُ يُرفض الآن ويُسجَّل — لا ينتظر حتى مهلة الصمت.
        denied.push(String(frame.request ?? "").slice(0, 200))
        progress(`🔐 رُفض آليّاً (لا مُوافِق في exec): ${String(frame.request ?? "").slice(0, 160)}`)
        send({ kind: "deny", turnId })
      } else if (frame.kind === "event") {
        const payload = String(frame.payload ?? "")
        const stopMatch = /التوقف: (\S+)/u.exec(payload)
        if (stopMatch !== null) stop = stopMatch[1]
        if (payload.startsWith("بوابات القبول:")) gates = payload
        if (/^(?:↻|⚠|🪝|✓ نقطة حفظ|—|⏳|⛰|⛔)/u.test(payload)) progress(payload.split("\n", 1)[0]!.slice(0, 240))
      } else if (frame.kind === "done" || frame.kind === "refused" || frame.kind === "unresolved") {
        end = frame as typeof end
        // الجوابُ الخاتم من إطار done (يرسله المحرّكُ لقشرة «cli» وحدها)؛ والدلتا — وفيها نصُّ كلّ الحقب — احتياطٌ فقط.
        if (typeof frame.answer === "string") finalAnswer = frame.answer
      }
    }
  })()
  const waitFor = async (predicate: () => boolean, deadline: number) => { while (!predicate() && Date.now() < deadline && child.exitCode === null) await Bun.sleep(25) }
  let reason: string | undefined
  try {
    send({ kind: "hello", shell: "cli", token })
    await waitFor(() => ready, started + 60_000)
    if (!ready) reason = "المحرّكُ لم يبلغ «ready» خلال 60 ث"
    else {
      send({ kind: "submit", mode: options.mode, turn: { id: turnId, body: options.task } })
      await waitFor(() => end !== undefined, started + options.timeoutMs)
      if (end === undefined) reason = child.exitCode !== null ? `خرج المحرّكُ برمز ${child.exitCode} قبل نهاية الدور` : `بلغ الدورُ مهلةَ ${Math.round(options.timeoutMs / 1000)} ث`
    }
  } finally {
    child.kill(); await child.exited; await reading.catch(() => undefined)
  }
  const tail = (await stderr).trim().split("\n").slice(-3).join(" / ").slice(-300)
  const outcome = end === undefined ? "error" : end.kind === "done" ? String(end.outcome ?? "completed") : end.kind
  return {
    task: options.task, outcome, exitCode: end === undefined ? 2 : exitFor(outcome),
    ...(stop === undefined ? {} : { stop }), durationMs: Date.now() - started, tools, approvalsDenied: denied,
    ...(gates === undefined ? {} : { gates }), answer: (finalAnswer ?? answer).trim().slice(-8000),
    ...(reason !== undefined ? { reason: tail.length > 0 ? `${reason} — ${tail}` : reason } : end?.why !== undefined ? { reason: String(end.why) } : {}),
  }
}

/**
 * الفجوة #8 محلّيّاً (2026-09-27) — `exec --worktree`: ما تفعله مهامُّ Codex السحابيّة في جوهره — بيئةٌ معزولة لكلّ مهمّة
 * ونتيجةٌ تُراجَع قبل الدمج — على هذا الجهاز: فرعٌ `abdocode/task-<معرّف>` في شجرة عملٍ منفصلة، وحالةُ محرّكٍ منفصلة
 * (محرّكان على دفترٍ واحد يكسران تسلسله)، فتتوازى المهامُّ ولا تمسّ نسخةَ عمل المستخدم. ما تغيّر يُودَع **في الفرع وحده**
 * (لا دفع)، وتُزال الشجرةُ ويبقى الفرع. والتشغيلُ على خادمٍ بعيد قرارُ بنيةٍ تحتيّة عند المالك — لا يُدّعى هنا.
 */
const git = (cwd: string, args: readonly string[], env?: Record<string, string | undefined>) => {
  const run = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", ...(env === undefined ? {} : { env }) })
  return { ok: run.exitCode === 0, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() }
}

export async function runExecInWorktree(options: ExecOptions, engineArgv: readonly string[], env: Record<string, string | undefined>, progress: (line: string) => void): Promise<ExecSummary> {
  const started = Date.now()
  const base = options.project ?? process.cwd()
  const fail = (reason: string): ExecSummary => ({ task: options.task, outcome: "error", exitCode: 2, durationMs: Date.now() - started, tools: [], approvalsDenied: [], answer: "", reason })
  const top = git(base, ["rev-parse", "--show-toplevel"])
  if (!top.ok) return fail(`--worktree يحتاج مستودعَ git: ${base} ليس فيه (${top.err.slice(0, 120)})`)
  const id = crypto.randomUUID().slice(0, 8)
  const branch = `abdocode/task-${id}`
  const root = join(tmpdir(), "abdocode-worktrees")
  const dir = join(root, id), state = join(root, `${id}-state`)
  const added = git(top.out, ["worktree", "add", "-q", "-b", branch, dir, "HEAD"])
  if (!added.ok) return fail(`تعذّر إنشاءُ شجرة العمل: ${added.err.slice(0, 200)}`)
  progress(`🌿 فرعٌ معزول ${branch} في ${dir}`)
  try {
    const summary = await runExec({ ...options, project: dir }, engineArgv, { ...env, ABDO_CODE_STATE_DIR: state }, progress)
    const changed = git(dir, ["status", "--porcelain"]).out.split("\n").filter((line) => line.trim().length > 0).map((line) => line.slice(3))
    let commit: string | undefined
    if (changed.length > 0) {
      git(dir, ["add", "-A"])
      const made = git(dir, ["commit", "-q", "-m", `abdocode: ${options.task.split("\n")[0]!.slice(0, 72)}`])
      if (made.ok) commit = git(dir, ["rev-parse", "--short", "HEAD"]).out
      else progress(`⚠ تعذّر الإيداعُ في ${branch}: ${made.err.slice(0, 160)} — التغييراتُ لم تُحفظ في الفرع`)
    }
    return { ...summary, worktree: { branch, ...(commit === undefined ? {} : { commit }), changedFiles: changed } }
  } finally {
    git(top.out, ["worktree", "remove", "--force", dir])
    rmSync(state, { recursive: true, force: true })
    // فرعٌ بلا إيداع ولا تغيير لا يُبقى أثراً.
    if (git(top.out, ["rev-parse", "--verify", "-q", branch]).ok && git(top.out, ["rev-list", "--count", `HEAD..${branch}`]).out === "0") git(top.out, ["branch", "-q", "-D", branch])
  }
}
