/** Drives the real framed engine with an in-process synthetic local model.
 * No cloud calls, owner settings, vaults, or project files are touched. */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { SUPER_ABDO_DEFAULTS } from "../src/super-abdo"

const ROOT = resolve(import.meta.dir, "../../..")
const nativeBinaryDir = process.env.ABDO_TEST_NATIVE_BINARY_DIR ?? resolve(ROOT, "packages/desktop/src-tauri/payload/bin")
const enabled = { ...SUPER_ABDO_DEFAULTS, enabled: true, maxRepairPasses: 0 }

async function engine(reviewAnswer = "COMPLETE\nThe explanatory answer needs no project change.", nativeWrite = false, nativeVerify = false) {
  if (nativeWrite && !["abdo-kernel.exe", "abdo-tool-worker.exe"].every(name => existsSync(join(nativeBinaryDir, name)))) throw Error("Build the native payload before running Preview qualification tests")
  const state = mkdtempSync(join(tmpdir(), "abdo-super-native-"))
  const settingsFile = join(state, "settings.json")
  const requestsFile = join(state, "requests.jsonl")
  const preload = join(state, "model-fixture.ts")
  if (nativeVerify) writeFileSync(join(state, "super-probe.test.ts"), 'import { expect, test } from "bun:test"; import { readFileSync } from "node:fs"; test("written artifact is real", () => expect(readFileSync("super-probe.txt", "utf8")).toBe("native evidence probe\\n"));')
  writeFileSync(settingsFile, JSON.stringify({ modelRole: "agent", agentModel: "ollama/qwen9b-gpu-32k:latest", mode: "read-only", plugins: { verifier: false, reviewer: false, delegation: false, projectAwareness: false, generalAwareness: false, sessionAwareness: false }, superAbdo: enabled }))
  writeFileSync(preload, [
    'import { appendFileSync } from "node:fs"',
    'import { basename, join } from "node:path"',
    `const nativeBinaryDir = ${JSON.stringify(nativeBinaryDir)};`,
    'if (nativeBinaryDir) { const original = Bun.spawn.bind(Bun); Bun.spawn = (command, options) => {',
    '  const name = Array.isArray(command) ? basename(String(command[0])) : "";',
    '  return original(name === "abdo-kernel.exe" || name === "abdo-tool-worker.exe" ? [join(nativeBinaryDir, name), ...command.slice(1)] : command, options);',
    '} }',
    'let wrote = false, verified = false;',
    'globalThis.fetch = async (input, init) => {',
    '  const url = String(input); if (!url.endsWith("/api/chat")) throw new Error("unexpected fixture network call: " + url)',
    '  const body = JSON.parse(String(init?.body));',
    `  appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify(body) + "\\n");`,
    '  if (body.messages?.some((m) => m.role === "user" && m.content.includes("hold-for-session-check"))) await Bun.sleep(1800);',
    '  const review = body.messages?.some((m) => m.role === "system" && m.content.includes("[SUPER_ABDO_REVIEW]"));',
    `  if (${nativeWrite} && !review && !wrote) { wrote = true; const tool = body.tools.find((item) => item.function?.parameters?.properties?.content && item.function?.parameters?.properties?.path); return Response.json({ model: body.model, message: { role: "assistant", content: "", tool_calls: [{ function: { name: tool.function.name, arguments: { path: "super-probe.txt", content: "native evidence probe\\n" } } }] }, done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 12 }); }`,
    `  if (${nativeVerify} && !review && wrote && !verified) { verified = true; const tool = body.tools.find((item) => item.function?.parameters?.properties?.command); return Response.json({ model: body.model, message: { role: "assistant", content: "", tool_calls: [{ function: { name: tool.function.name, arguments: { command: "bun test super-probe.test.ts" } } }] }, done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 12 }); }`,
    `  const content = review ? ${JSON.stringify(reviewAnswer)} : "جاهز. هذا جواب نصي فقط ولا أدّعي تعديلاً أو اختباراً.";`,
    '  return Response.json({ model: body.model, message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: 12, eval_count: 12 });',
    '}',
  ].join("\n"))
  const executable = process.env.ABDO_TEST_ENGINE
  const child = Bun.spawn(executable ? [executable,"serve"] : [process.execPath, "--preload", preload, "packages/engine/src/cli.ts", "serve"], {
    cwd: ROOT,
    env: { ...process.env, ABDO_SHELL_TOKEN: "super-native-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_STATE_DIR: state, ABDO_CODE_SETTINGS: settingsFile, ABDO_VAULT_HOME: state, ABDO_PROJECT: state, USERPROFILE: state, HOME: state, ABDO_MAX_AGENT_EPOCHS: "3", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "", ABDO_TURN_TOKEN_CAP: "", ABDO_CLOUD_DAILY_TOKENS: "0" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const decoder = new LocalJsonFrameDecoder()
  const reader = child.stdout.getReader()
  const seen: Record<string, unknown>[] = []
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  const send = async (frame: Record<string, unknown>) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
  const until = async (predicate: (frame: Record<string, unknown>) => boolean) => {
    const deadline = Date.now() + 45_000
    for (;;) {
      const matched = seen.find(predicate)
      if (matched) return matched
      if (Date.now() > deadline) throw new Error(`engine timeout; frames=${JSON.stringify(seen).slice(-1800)}`)
      pending ??= reader.read()
      const result = await Promise.race([pending, Bun.sleep(75).then(() => undefined)])
      if (result === undefined) continue
      pending = undefined
      if (result.done) throw new Error(`engine ended: ${(await stderr).slice(0, 1500)}`)
      for (const frame of decoder.push(result.value)) seen.push(frame as Record<string, unknown>)
    }
  }
  const stop = async () => {
    child.kill(); await child.exited
    const actual = resolve(state)
    if (!actual.startsWith(resolve(tmpdir()) + "\\") || !actual.includes("abdo-super-native-")) throw new Error("refusing cleanup outside owned fixture")
    rmSync(actual, { recursive: true, force: true })
  }
  await send({ kind: "hello", shell: "desktop", token: "super-native-test" })
  try { await until((f) => f.kind === "ready") } catch (error) { await stop(); throw error }
  return { state, settingsFile, send, until, seen, stop, requests: () => !existsSync(requestsFile) ? [] : readFileSync(requestsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)) }
}

describe("Super Abdo through native engine", () => {
  test("explicit memory commands save, correct and forget through the real journal without a model", async () => {
    const wire=await engine()
    try {
      const submit=async(id:string,body:string)=>{await wire.send({kind:'submit',turn:{id,body}});const done=await wire.until(f=>f.kind==='done'&&f.turnId===id);expect(done.outcome).toBe('completed')}
      await submit('remember-first','/remember database: SQLite')
      expect(wire.seen.some(f=>f.kind==='memory-saved')).toBe(true)
      await submit('remember-correction','تذكر database: PostgreSQL')
      const notes=wire.seen.filter(f=>f.kind==='memory-notes').at(-1)?.facts as any[]
      expect(notes.filter(f=>f.key==='database')).toHaveLength(1)
      expect(notes.find(f=>f.key==='database').value.note).toBe('PostgreSQL')
      expect(notes.find(f=>f.key==='database').sourceTurnId).toBe('remember-correction')
      expect(typeof notes.find(f=>f.key==='database').sourceSession).toBe('string')
      await submit('remember-list','/memory')
      expect(wire.seen.filter(f=>f.kind==='event'&&f.turnId==='remember-list').map(f=>f.payload).join('\n')).toContain('PostgreSQL')
      await submit('remember-forget','/forget database')
      expect((wire.seen.filter(f=>f.kind==='memory-notes').at(-1)?.facts as any[]).filter(f=>f.key==='database')).toHaveLength(0)
      expect(wire.requests()).toHaveLength(0)
    } finally {await wire.stop()}
  },60_000)

  test("current plan observations reach the provider only while project awareness is enabled", async () => {
    const wire = await engine()
    try {
      writeFileSync(join(wire.state, "PLAN.md"), "# Plan\n- [x] Foundation\n- [ ] private-plan-label-never-injected\n")
      await wire.send({ kind: "settings-set", settings: { plugins: { projectAwareness: true } } })
      await wire.until(f => f.kind === "settings" && (f.settings as any)?.plugins?.projectAwareness === true)
      await wire.send({ kind: "submit", turn: { id: "orientation-on", body: "Explain the next step without executing anything." } })
      await wire.until(f => f.kind === "done" && f.turnId === "orientation-on")
      const content = JSON.stringify(wire.requests())
      expect(content).toContain("CURRENT_PROJECT_OBSERVATIONS")
      expect(content).toContain("firstUncheckedLine")
      expect(content).not.toContain("private-plan-label-never-injected")
      await wire.send({ kind: "settings-set", settings: { plugins: { projectAwareness: false } } })
      await wire.until(f => f.kind === "settings" && (f.settings as any)?.plugins?.projectAwareness === false)
      const before = wire.requests().length
      await wire.send({ kind: "submit", turn: { id: "orientation-off", body: "Explain this briefly without executing anything." } })
      await wire.until(f => f.kind === "done" && f.turnId === "orientation-off")
      const requests = wire.requests().slice(before)
      expect(requests.length).toBeGreaterThan(0)
      expect(JSON.stringify(requests)).not.toContain("CURRENT_PROJECT_OBSERVATIONS")
    } finally { await wire.stop() }
  }, 120_000)

  test("project instructions persist and reach only their matching project's next request", async () => {
    const wire = await engine()
    try {
      const instruction = "Use the project scoped alpha naming convention."
      const scoped = { path: wire.state, text: instruction }
      await wire.send({ kind: "settings-set", settings: { projectInstructions: scoped } })
      await wire.until((f) => f.kind === "settings" && (f.settings as { projectInstructions?: { text?: string } })?.projectInstructions?.text === instruction)
      expect(JSON.parse(readFileSync(wire.settingsFile, "utf8")).projectInstructions).toEqual(scoped)
      await wire.send({ kind: "submit", turn: { id: "scoped-project", body: "أجب بكلمة جاهز فقط." } })
      await wire.until((f) => f.kind === "done" && f.turnId === "scoped-project")
      expect(wire.requests().some((r) => r.messages.some((m: { role: string; content: string }) => m.role === "system" && m.content.includes(instruction)))).toBe(true)
      const otherProject = join(wire.state, "other-project")
      mkdirSync(otherProject)
      await wire.send({ kind: "trust-grant", path: otherProject })
      await wire.until((f) => f.kind === "project" && f.path === otherProject)
      const before = wire.requests().length
      await wire.send({ kind: "submit", turn: { id: "other-project", body: "أجب بكلمة حاضر فقط." } })
      await wire.until((f) => f.kind === "done" && f.turnId === "other-project")
      const otherRequests = wire.requests().slice(before)
      expect(otherRequests.length).toBeGreaterThan(0)
      expect(otherRequests.every((r) => r.messages.every((m: { content: string }) => !m.content.includes(instruction)))).toBe(true)
      await wire.send({ kind: "settings-set", settings: { projectInstructions: { path: wire.state, text: "x".repeat(12_001) } } })
      await wire.until((f) => f.kind === "refused" && String(f.why).includes("projectInstructions.text"))
      expect(JSON.parse(readFileSync(wire.settingsFile, "utf8")).projectInstructions).toEqual(scoped)
      await wire.send({ kind: "settings-set", settings: { projectInstructions: { path: wire.state, text: "sk-fixture1234567890123456" } } })
      await wire.until((f) => f.kind === "refused" && String(f.why).includes("سرّ"))
      expect(JSON.parse(readFileSync(wire.settingsFile, "utf8")).projectInstructions).toEqual(scoped)
    } finally { await wire.stop() }
  }, 60_000)

  test("the desktop agents command returns the installed catalogue without a model request", async () => {
    const wire = await engine()
    try {
      await wire.send({ kind: "submit", turn: { id: "agents-list", body: "agents" } })
      await wire.until((f) => f.kind === "done" && f.turnId === "agents-list")
      const output = wire.seen.filter((f) => f.kind === "event" && f.turnId === "agents-list").map((f) => f.payload).join("\n")
      expect(output).toContain("planner")
      expect(output).toContain("reviewer")
      expect(wire.requests()).toHaveLength(0)
    } finally { await wire.stop() }
  }, 60_000)

  test("settings persist on disk without changing permissions or plugin defaults", async () => {
    const wire = await engine()
    try {
      const next = { ...enabled, maxRepairPasses: 3 }
      await wire.send({ kind: "settings-set", settings: { superAbdo: next } })
      await wire.until((f) => f.kind === "settings" && (f.settings as { superAbdo?: { maxRepairPasses?: number } })?.superAbdo?.maxRepairPasses === 3)
      const saved = JSON.parse(readFileSync(wire.settingsFile, "utf8"))
      expect(saved.superAbdo).toEqual(next)
      expect(saved.mode).toBe("read-only")
      expect(saved.plugins).toMatchObject({ verifier: false, reviewer: false, delegation: false })
      await wire.send({ kind: "settings-set", settings: { superAbdo: { ...next, autoApprove: true } } })
      await wire.until((f) => f.kind === "refused" && String(f.why).includes("superAbdo"))
      expect(JSON.parse(readFileSync(wire.settingsFile, "utf8")).superAbdo).toEqual(next)
    } finally { await wire.stop() }
  }, 60_000)

  test("the enabled strategy reaches the actual provider request; review has no tools/history", async () => {
    const wire = await engine()
    try {
      await wire.send({ kind: "submit", turn: { id: "super-on", body: "أجب بكلمة جاهز فقط." } })
      const done = await wire.until((f) => f.kind === "done" && f.turnId === "super-on")
      expect(done.outcome).toBe("completed")
      const requests = wire.requests()
      const work = requests.find((r) => r.messages.some((m: { role: string; content: string }) => m.role === "system" && m.content.includes("[SUPER_ABDO_WORKFLOW]")))
      const review = requests.find((r) => r.messages.some((m: { role: string; content: string }) => m.role === "system" && m.content.includes("[SUPER_ABDO_REVIEW]")))
      expect(work).toBeDefined()
      expect(work.tools.length).toBeGreaterThan(0)
      expect(review).toBeDefined()
      expect(review.tools ?? []).toHaveLength(0)
      expect(review.messages.filter((m: { role: string }) => m.role === "assistant" || m.role === "tool")).toHaveLength(0)
      expect(wire.seen.some((f) => f.kind === "tool")).toBe(false)
      await wire.send({ kind: "settings-set", settings: { superAbdo: SUPER_ABDO_DEFAULTS } })
      await wire.until((f) => f.kind === "settings" && (f.settings as { superAbdo?: { enabled?: boolean } })?.superAbdo?.enabled === false)
      const before = wire.requests().length
      await wire.send({ kind: "submit", turn: { id: "super-off", body: "أجب بكلمة حاضر فقط." } })
      await wire.until((f) => f.kind === "done" && f.turnId === "super-off")
      expect(wire.requests().slice(before).every((r) => !r.messages.some((m: { role: string; content: string }) => m.role === "system" && m.content.includes("[SUPER_ABDO_")))).toBe(true)
    } finally { await wire.stop() }
  }, 120_000)

  test("invalid review stays checkpointed instead of fabricating completion", async () => {
    const wire = await engine("COMPLETE")
    try {
      await wire.send({ kind: "submit", turn: { id: "super-unknown", body: "أجب بكلمة جاهز فقط." } })
      const done = await wire.until((f) => f.kind === "done" && f.turnId === "super-unknown")
      expect(done.outcome).toBe("checkpointed")
      expect(done.rerun).toBe(true)
      expect(wire.requests().filter((r) => r.messages.some((m: { role: string; content: string }) => m.role === "system" && m.content.includes("[SUPER_ABDO_REVIEW]")))).toHaveLength(1)
    } finally { await wire.stop() }
  }, 60_000)

  test("recall cannot rebind a running turn, and succeeds after the turn ends", async () => {
    const wire = await engine()
    try {
      await wire.send({ kind: "submit", turn: { id: "prior-session", body: "أجب بكلمة جاهز فقط." } })
      await wire.until((f) => f.kind === "done" && f.turnId === "prior-session")
      await wire.send({ kind: "history" })
      const firstHistory = await wire.until((f) => f.kind === "history")
      const original = (firstHistory.sessions as { id: string; current: boolean }[]).find((session) => session.current)!.id
      await wire.send({ kind: "session-new" })
      const fresh = await wire.until((f) => f.kind === "session")
      expect(fresh.id).not.toBe(original)
      await wire.send({ kind: "recall", session: fresh.id })
      const empty = await wire.until((f) => f.kind === "archive" && f.session === fresh.id)
      expect(empty.turns).toEqual([])
      await wire.send({ kind: "submit", turn: { id: "running-session", body: "hold-for-session-check" } })
      await wire.until((f) => f.kind === "admission" && f.turnId === "running-session")
      await wire.send({ kind: "recall", session: original })
      await wire.until((f) => f.kind === "refused" && String(f.why).includes("استعادة محادثة"))
      expect(wire.seen.some((f) => f.kind === "archive" && f.session === original)).toBe(false)
      await wire.until((f) => f.kind === "done" && f.turnId === "running-session")
      await wire.send({ kind: "recall", session: original })
      const archive = await wire.until((f) => f.kind === "archive" && f.session === original)
      expect((archive.turns as { id: string }[]).map((turn) => turn.id)).toEqual(["prior-session"])
      await wire.send({ kind: "recall", session: "nonexistent-session" })
      await wire.until((f) => f.kind === "refused" && String(f.why).includes("غير موجودة في السجل"))
    } finally { await wire.stop() }
  }, 60_000)

  test("a real policy-backed file change without verification stays checkpointed", async () => {
    const wire = await engine(undefined, true)
    try {
      // Explicit fixture-owned authority; the user's settings are never used.
      await wire.send({ kind: "trust-grant", path: wire.state })
      await wire.until((f) => f.kind === "project" && f.trusted === true)
      await wire.send({ kind: "submit", mode: "full-access", turn: { id: "super-write", body: "اكتب ملاحظة قصيرة في super-probe.txt داخل المشروع الحالي." } })
      const done = await wire.until((f) => f.kind === "done" && f.turnId === "super-write")
      if (!existsSync(join(wire.state, "super-probe.txt"))) throw new Error(JSON.stringify(wire.seen.filter((f) => ["tool", "tool-result", "event", "refused"].includes(String(f.kind)))).slice(-5000))
      expect(readFileSync(join(wire.state, "super-probe.txt"), "utf8")).toBe("native evidence probe\n")
      expect(wire.seen.some((f) => f.kind === "tool-result" && String(f.cmd).startsWith("write") && (f.verdict as { ok?: boolean })?.ok === true)).toBe(true)
      expect(done.outcome).toBe("checkpointed")
      expect(wire.seen.some((f) => f.kind === "event" && String(f.payload).includes("No verification receipt follows"))).toBe(true)
      expect(wire.requests().some((r) => r.messages.some((m: { role: string; content: string }) => m.role === "system" && m.content.includes("[SUPER_ABDO_REVIEW]")))).toBe(false)
    } finally { await wire.stop() }
  }, 60_000)

  test("a real file change followed by a non-empty passing test and review can complete", async () => {
    const wire = await engine("COMPLETE\nThe written file is proved by the subsequent non-empty passing test receipt.", true, true)
    try {
      await wire.send({ kind: "trust-grant", path: wire.state })
      await wire.until((f) => f.kind === "project" && f.trusted === true)
      await wire.send({ kind: "submit", mode: "full-access", turn: { id: "super-verified", body: "اكتب ملاحظة قصيرة في super-probe.txt داخل المشروع الحالي." } })
      const done = await wire.until((f) => f.kind === "done" && f.turnId === "super-verified")
      expect(readFileSync(join(wire.state, "super-probe.txt"), "utf8")).toBe("native evidence probe\n")
      expect(wire.seen.some((f) => f.kind === "tool-result" && String(f.cmd) === "run bun test super-probe.test.ts" && (f.verdict as { ok?: boolean })?.ok === true)).toBe(true)
      expect(done.outcome).toBe("completed")
      expect(wire.requests().some((r) => r.messages.some((m: { role: string; content: string }) => m.role === "system" && m.content.includes("[SUPER_ABDO_REVIEW]")))).toBe(true)
    } finally { await wire.stop() }
  }, 60_000)
})
