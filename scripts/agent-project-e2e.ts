import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { Providers } from "../packages/providers/src"

const [targetArg, stateArg, goalArg, recallSession] = Bun.argv.slice(2)
const agentModel = process.env.ABDO_E2E_AGENT_MODEL ?? "ollama/empero-qwen3.8-9b-gpu:latest"
// جولة سحابية بمزوّد مخصص (owner-config): ABDO_E2E_CUSTOM_PROVIDER بصيغة
// id|baseUrl|vaultKey — يُسجَّل هنا (لصحة parseRef في هذا السكربت) ويُمرَّر
// للمحرك عبر settings ليسجّله ويُعلنه لعامل Rust. الغياب = سلوك محلي كالسابق.
const customProviderSpec = (() => {
  const raw = process.env.ABDO_E2E_CUSTOM_PROVIDER
  if (raw === undefined || raw.trim().length === 0) return undefined
  const [id, baseUrl, vaultKey] = raw.split("|")
  if (!id || !baseUrl || !vaultKey) throw new Error("ABDO_E2E_CUSTOM_PROVIDER يجب أن يكون id|baseUrl|vaultKey")
  const refusal = Providers.registerCustomProvider({ id, label: id, baseUrl, vaultKey })
  if (refusal !== undefined) throw new Error(`رفض تسجيل المزوّد المخصص: ${refusal}`)
  return { id, label: id, baseUrl, vaultKey }
})()
const railPolicy = process.env.ABDO_E2E_RAIL_POLICY
if (railPolicy !== undefined && !["auto", "strict", "medium", "thin"].includes(railPolicy)) throw new Error("ABDO_E2E_RAIL_POLICY غير صالحة")
if (Providers.parseRef(agentModel) === undefined) throw new Error("invalid e2e agent model reference")
// سقف الدور كله (لا سقف الإطار): كان 45 دقيقة ثابتة — جولة النموذج القوي
// بسبعة سبرنتات تتجاوزها فيموت الدور عند المهلة لا عند نتيجة. الغياب أو
// القيمة الفاسدة = 45 دقيقة كما كان (السلوك القديم محفوظ).
const turnTimeoutMs = (() => {
  const raw = process.env.ABDO_E2E_TURN_TIMEOUT_MS
  if (raw === undefined || !/^\d+$/u.test(raw.trim())) return 45 * 60_000
  const parsed = Number.parseInt(raw.trim(), 10)
  return parsed >= 60_000 && parsed <= 24 * 60 * 60_000 ? parsed : 45 * 60_000
})()
if (!targetArg || !stateArg || !goalArg) {
  console.error("usage: bun scripts/agent-project-e2e.ts <project> <state-dir> <goal> [session-id]")
  process.exit(2)
}

const root = resolve(import.meta.dir, "..")
const project = resolve(targetArg)
const stateDir = resolve(stateArg)
mkdirSync(project, { recursive: true })
mkdirSync(stateDir, { recursive: true })

const child = Bun.spawn([process.execPath, resolve(root, "packages/engine/src/cli.ts"), "serve"], {
  cwd: root,
  env: {
    ...process.env,
    ABDO_PROJECT: project,
    ABDO_CODE_STATE_DIR: stateDir,
    ABDO_CODE_SETTINGS: resolve(stateDir, "settings.json"),
    ABDO_REQUIRE_SPRINT_PLAN: "1",
    ABDO_AGENT_MODEL_TIMEOUT_MS: "240000",
    // كتالوج 1.13: لا يتيم خمول — المحرك يخرج ذاتياً بعد دقيقتي صمت بلا دور.
    ABDO_SERVE_IDLE_EXIT_MS: "120000",
  },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
})

type Frame = Record<string, unknown> & { kind?: string }
const frames: Frame[] = []
const waiters: (() => void)[] = []
let stdoutDone = false
let stderrText = ""
let cursor = 0

const wake = () => { for (const waiter of waiters.splice(0)) waiter() }
const readLines = async (stream: ReadableStream<Uint8Array>, consume: (line: string) => void) => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    for (;;) {
      const newline = pending.indexOf("\n")
      if (newline < 0) break
      const line = pending.slice(0, newline).replace(/\r$/, "")
      pending = pending.slice(newline + 1)
      if (line.trim()) consume(line)
    }
  }
  pending += decoder.decode()
  if (pending.trim()) consume(pending)
}

void readLines(child.stdout, (line) => {
  try { frames.push(JSON.parse(line) as Frame) }
  catch { frames.push({ kind: "invalid-output", line }) }
  wake()
}).finally(() => { stdoutDone = true; wake() })
void readLines(child.stderr, (line) => { stderrText += `${line}\n` })

const send = (frame: object) => {
  child.stdin.write(`${JSON.stringify(frame)}\n`)
  child.stdin.flush()
}

const next = async (predicate: (frame: Frame) => boolean, timeoutMs: number): Promise<Frame> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    while (cursor < frames.length) {
      const frame = frames[cursor++]!
      if (["model-route", "tool", "tool-result", "event", "done", "refused", "unresolved"].includes(frame.kind ?? "")) {
        const visible = frame.kind === "tool"
          ? { ...frame, cmd: String(frame.cmd ?? "").split("\n", 1)[0] }
          : frame.kind === "tool-result"
            ? { ...frame, cmd: String(frame.cmd ?? "").split("\n", 1)[0], output: String(frame.output ?? "").slice(0, 1_500) }
            : frame
        const printable = JSON.stringify(visible)
        console.log(printable.length > 2_000 ? `${printable.slice(0, 2_000)}…` : printable)
      }
      if (predicate(frame)) return frame
    }
    if (stdoutDone) throw new Error(`engine exited before expected frame; stderr=${stderrText.slice(-2_000)}`)
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`timed out waiting for engine frame; stderr=${stderrText.slice(-2_000)}`)
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, Math.min(remaining, 1_000))
      waiters.push(() => { clearTimeout(timer); resolveWait() })
    })
  }
}

let sessionId = recallSession
let turnId = `e2e-${Date.now()}`
let toolCount = 0
let route = ""
let done = false

try {
  await next((frame) => frame.kind === "ready", 30_000)
  send({
    kind: "settings-set",
    settings: {
      project,
      mode: "full-access",
      modelRole: "agent",
      agentModel,
      chatModel: "ollama/qwen9b-gpu-32k:latest",
      ...(railPolicy === undefined ? {} : { railPolicy }),
      ...(customProviderSpec === undefined ? {} : { customProviders: [customProviderSpec] }),
    },
  })
  await next((frame) => frame.kind === "settings", 10_000)
  send({ kind: "project-set", path: project })
  const projectFrame = await next((frame) => frame.kind === "project" || frame.kind === "trust-request", 10_000)
  if (projectFrame.kind === "trust-request") {
    send({ kind: "trust-grant", path: project })
    await next((frame) => frame.kind === "project" && frame.trusted === true, 10_000)
  }
  send({ kind: "mode-set", mode: "full-access" })
  await next((frame) => frame.kind === "mode", 10_000)

  if (sessionId) {
    send({ kind: "recall", session: sessionId })
    await next((frame) => frame.kind === "archive" && frame.session === sessionId, 30_000)
  } else {
    send({ kind: "session-new" })
    const session = await next((frame) => frame.kind === "session", 10_000)
    sessionId = String(session.id)
  }

  send({ kind: "submit", turn: { id: turnId, body: goalArg }, mode: "full-access" })
  await next((frame) => frame.kind === "admission" && frame.turnId === turnId, 10_000)
  const final = await next((frame) => {
    if (frame.kind === "refused") throw new Error(`engine refused the turn: ${String(frame.why ?? "unknown refusal")}`)
    if (frame.kind === "tool" && frame.turnId === turnId) toolCount += 1
    if (frame.kind === "model-route" && frame.turnId === turnId) {
      route = String(frame.ref ?? "")
      if (route !== agentModel) throw new Error(`model route mismatch: requested ${agentModel}, got ${route}`)
    }
    return (frame.kind === "done" && frame.turnId === turnId) || frame.kind === "unresolved"
  }, turnTimeoutMs)
  done = final.kind === "done" && final.outcome === "completed" && final.rerun !== true
} finally {
  child.stdin.end()
}

const exitCode = await child.exited
console.log(JSON.stringify({ status: done ? "AGENT_TURN_DONE" : "AGENT_TURN_UNRESOLVED", project, stateDir, sessionId, turnId, requestedModel: agentModel, route, toolCount, exitCode, stderr: stderrText.slice(-1_000) }, null, 2))
if (!done || exitCode !== 0) process.exit(1)
