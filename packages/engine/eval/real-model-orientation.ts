/** Real-model evaluation (not a gate): does a local Qwen through the real framed engine,
 * given "استكمل مشروع رودود" with no project selected, locate the folder, open it and
 * propose development branches — and does "use PostgreSQL instead of SQLite" get learned?
 * Isolated state; the model is the local Ollama one the product ships with. Records a
 * verdict JSON; failure here is a measurement, not a build breaker. */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// جذرُ المستودع من البيئة أو من مجلّد التشغيل: مسارٌ مثبَّتٌ لجهازِ مطوّرٍ بعينه يشحن اسمَ
// بنيتنا الداخلية في مصدرٍ عامّ، ويكسر التقييمَ على أيّ نسخةٍ أخرى من الشجرة.
const ROOT = process.env.ABDO_EVAL_ROOT ?? resolve(import.meta.dir, "..", "..", "..")
const model = process.argv[2] ?? "ollama/qwen9b-gpu-32k:latest"
const engine = process.argv[3] // optional compiled engine
const base = mkdtempSync(join(tmpdir(), "abdo-real-eval-"))
const state = join(base, "state"), install = join(base, "payload"), documents = join(base, "Documents"), target = join(documents, "rodud")
for (const dir of [state, install, target, join(documents, "crm-board")]) mkdirSync(dir, { recursive: true })
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: target, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
git("init", "-q")
writeFileSync(join(target, "package.json"), JSON.stringify({ name: "rodud", dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" }, scripts: { build: "next build" } }))
writeFileSync(join(target, "PLAN.md"), "# Rodud — delivery app\n- [x] scaffold\n- [ ] driver onboarding flow\n- [ ] payments\n")
writeFileSync(join(target, "NEXT_ACTION.md"), "Resume the driver onboarding screen; API is stubbed.\n")
git("add", "."); git("commit", "-q", "-m", "scaffold rodud app")
const settings = join(state, "settings.json")
writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: model, chatModel: model, modelRole: "agent", mode: "full-access", project: install, memorySearchEnabled: true, plugins: { verifier: false, reviewer: false, delegation: false, projectAwareness: true, generalAwareness: false, sessionAwareness: false }, superAbdo: { enabled: false } }))
const child = Bun.spawn(engine ? [engine, "serve"] : [process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "real-eval", ABDO_FRAMED_STDIO: "1", ABDO_REQUIRE_PROJECT: "1", ABDO_INSTALL_ROOT: install, ABDO_PROJECT: "", ABDO_DOCUMENTS_DIR: documents, ABDO_CODE_STATE_DIR: state, ABDO_CODE_SETTINGS: settings, ABDO_VAULT_HOME: state, USERPROFILE: base, HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "", ABDO_MAX_AGENT_EPOCHS: "6", ABDO_CLOUD_DAILY_TOKENS: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
const errors = new Response(child.stderr).text(), frames: any[] = []
const decoder = new LocalJsonFrameDecoder()
const reading = (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
const wait = async (predicate: () => boolean, ms: number) => { const deadline = Date.now() + ms; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-3000)); await Bun.sleep(100) } }
const verdict: Record<string, unknown> = { at: new Date().toISOString(), model, engine: engine ?? "source" }
try {
  send({ kind: "hello", shell: "desktop", token: "real-eval" }); await wait(() => frames.some((f) => f.kind === "ready"), 20_000)
  const started = Date.now()
  send({ kind: "submit", turn: { id: "eval-orient", body: "استكمل مشروع رودود" } })
  await wait(() => frames.some((f) => f.turnId === "eval-orient" && ["done", "refused", "unresolved"].includes(f.kind)), 600_000)
  const tools = frames.filter((f) => f.kind === "tool" && f.turnId === "eval-orient").map((f) => String(f.cmd))
  const events = frames.filter((f) => f.kind === "event" && f.turnId === "eval-orient").map((f) => String(f.payload)).join("\n")
  const answer = frames.filter((f) => f.kind === "answer" || f.kind === "reply").filter((f) => f.turnId === "eval-orient").map((f) => String(f.text ?? f.payload ?? "")).join("\n")
  verdict.orientation = {
    seconds: Math.round((Date.now() - started) / 1000),
    outcome: frames.find((f) => f.turnId === "eval-orient" && ["done", "refused", "unresolved"].includes(f.kind))?.kind,
    toolsCalled: tools,
    calledLocate: tools.some((t) => /project.locate/u.test(t)),
    calledOpen: tools.some((t) => /project.open/u.test(t)),
    projectSwitched: frames.some((f) => f.kind === "project" && f.path === target),
    settingsProject: JSON.parse(readFileSync(settings, "utf8")).project === target,
    mentionsBranches: /فرع|فروع|branch|خيار|اقتراح|مقترح/iu.test(events + answer),
    mentionsOnboarding: /onboarding|التسجيل|السائق/iu.test(events + answer),
    editedFiles: git("status", "--porcelain").trim() !== "",
    tail: (events + "\n" + answer).slice(-1500),
  }
  if (verdict.orientation && (verdict.orientation as { projectSwitched: boolean }).projectSwitched) {
    send({ kind: "submit", turn: { id: "eval-correct", body: "لا، استخدم PostgreSQL بدل SQLite" } })
    await wait(() => frames.some((f) => f.turnId === "eval-correct" && ["done", "refused", "unresolved"].includes(f.kind)), 300_000)
    verdict.correction = { inferred: frames.filter((f) => f.kind === "memory-inferred").map((f) => ({ topic: f.topic, note: f.note, confidence: f.confidence })), outcome: frames.find((f) => f.turnId === "eval-correct" && ["done", "refused", "unresolved"].includes(f.kind))?.kind }
  }
} catch (error) { verdict.error = String(error) }
finally { child.kill(); await child.exited; await reading; verdict.stderrTail = (await errors).slice(-800); rmSync(base, { recursive: true, force: true }) }
writeFileSync(process.env.ABDO_EVAL_OUT ?? join(tmpdir(), "abdocode-real-model-eval.json"), JSON.stringify(verdict, null, 2))
console.log(JSON.stringify(verdict, null, 2))
