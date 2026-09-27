/**
 * Gap #7 (2026-09-27) — AbdoCode in VS Code. The logic is pure and tested here; the live test drives a real task
 * through `core.runTask` against the real engine (from source) with a scripted model; the activation test loads
 * extension.js against a stand-in `vscode` module and proves both commands register.
 */
import { expect, mock, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
// @ts-expect-error — plain CommonJS module
import core from "../extension/core.js"

test("the engine is found from the setting first, then the desktop installs; nothing found is undefined", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", ProgramFiles: "C:\\Program Files" }
  expect(core.engineCandidates(env, "")).toEqual(["C:\\Users\\u\\AppData\\Local\\AbdoCode\\payload\\abdocode.exe", "C:\\Program Files\\AbdoCode\\payload\\abdocode.exe"])
  expect(core.engineCandidates(env, " D:\\tools\\abdocode.exe ")[0]).toBe("D:\\tools\\abdocode.exe")
  expect(core.findEngine(["a", "b"], (p: string) => p === "b")).toBe("b")
  expect(core.findEngine(["a"], () => false)).toBeUndefined()
})

test("the desktop's settings and vault are shared, but the engine state is the extension's own", () => {
  const env = core.engineEnv({ APPDATA: "C:\\Users\\u\\AppData\\Roaming", PATH: "x" }, "")
  expect(env.ABDO_CODE_SETTINGS).toBe("C:\\Users\\u\\AppData\\Roaming\\io.abdocode.desktop\\engine-settings.json")
  expect(env.ABDO_CODE_STATE_DIR).toBe("C:\\Users\\u\\AppData\\Roaming\\io.abdocode.desktop\\engine-state-vscode")
  expect(env.ABDO_VAULT_DIR).toBe("C:\\Users\\u\\AppData\\Roaming\\io.abdocode.desktop\\vault-home\\vault")
  expect(env.PATH).toBe("x")
  // An explicit environment wins over the defaults.
  expect(core.engineEnv({ APPDATA: "C:\\A", ABDO_CODE_SETTINGS: "C:\\mine.json" }, "").ABDO_CODE_SETTINGS).toBe("C:\\mine.json")
})

test("arguments: the mode is one of three and the timeout is bounded; the selection travels fenced with its place", () => {
  expect(core.execArgs("fix it", { project: "C:\\p", mode: "yolo", timeoutSeconds: 5 })).toEqual(["exec", "fix it", "--project", "C:\\p", "--mode", "auto", "--timeout", "10", "--json"])
  expect(core.execArgs("t", { project: "C:\\p", mode: "full-access", timeoutSeconds: 99999 })).toContain("86400")
  const task = core.taskWithSelection("why is this slow?", { file: "src/a.ts", language: "typescript", startLine: 3, endLine: 5, text: "for (;;) {}" })
  expect(task).toBe("why is this slow?\n\nFile: src/a.ts (lines 3-5)\n```typescript\nfor (;;) {}\n```")
  expect(core.taskWithSelection("q", { file: "a.md", text: "```x```" })).toContain("~~~~")
  expect(core.taskWithSelection("q", { file: "a", text: "  " })).toBe("q")
})

test("the summary is read strictly: no JSON or no outcome is a named error, not a guess", () => {
  expect(core.parseSummary("noise\n{\"outcome\":\"completed\",\"tools\":[]}")).toMatchObject({ summary: { outcome: "completed" } })
  expect(core.parseSummary("nothing")).toMatchObject({ error: expect.stringContaining("no JSON") })
  expect(core.parseSummary("{\"x\":1}")).toMatchObject({ error: expect.stringContaining("no outcome") })
  const lines = core.reportLines({ outcome: "checkpointed", stop: "tool_budget", tools: [{ cmd: "write a", ok: true }, { cmd: "run b", ok: false }], durationMs: 4200, approvalsDenied: ["run x"] })
  expect(lines[0]).toBe("— checkpointed (tool_budget) · 2 tools · 4 s")
  expect(lines).toContain("  ✓ write a")
  expect(lines).toContain("  ✗ run b")
  expect(lines.some((l: string) => l.includes("1 approval(s) refused"))).toBe(true)
})

test.skipIf(process.platform !== "win32")("live: a task from the extension's runner goes through `abdocode exec` on the real engine", async () => {
  const replies = ["نفّذ: write from-editor.txt <<<\nhello from vscode\n", "Wrote from-editor.txt."]
  let n = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(n++, replies.length - 1)]!
    const payload = await request.json() as { stream?: boolean }
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-vscode-")), project = join(home, "proj"), profile = join(home, "profile")
  mkdirSync(project, { recursive: true }); mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, "engine-settings.json"), JSON.stringify({
    language: "en", mode: "auto", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const progress: string[] = []
  try {
    // The desktop's variables are dropped so the defaults under `profile` are what is measured.
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ABDO_(?:CODE_|VAULT_)/u.test(k)))
    const env = core.engineEnv({ ...base, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_MAX_AGENT_EPOCHS: "3", ABDO_AGENT_PHASE: "" }, profile)
    const result = await core.runTask({
      command: [process.execPath, resolve(import.meta.dir, "../../engine/src/cli.ts")],
      args: core.execArgs("Create from-editor.txt saying hello from vscode", { project, mode: "full-access", timeoutSeconds: 120 }),
      env,
      cwd: resolve(import.meta.dir, "../../.."),
      spawn,
      onProgress: (line: string) => progress.push(line),
    })
    expect(result.error).toBeUndefined()
    expect(result.summary).toMatchObject({ outcome: "completed", exitCode: 0 })
    expect(result.summary.answer).toContain("Wrote from-editor.txt.")
    expect(readFileSync(join(project, "from-editor.txt"), "utf8")).toBe("hello from vscode")
    expect(progress.some((l) => l.startsWith("⚙ write from-editor.txt"))).toBe(true)
    // The extension's own engine state — never the desktop app's.
    expect(existsSync(join(profile, "engine-state-vscode"))).toBe(true)
    expect(existsSync(join(profile, "engine-state"))).toBe(false)
  } finally { server.stop(true); rmSync(home, { recursive: true, force: true }) }
}, 150_000)

test("activation: both commands register, and a task without an open folder is refused by name", async () => {
  const registered = new Map<string, (...a: unknown[]) => unknown>()
  const errors: string[] = []
  mock.module("vscode", () => ({
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showInputBox: async () => "do something",
      showErrorMessage: (m: string) => { errors.push(m) },
      showWarningMessage: () => undefined, showInformationMessage: () => undefined,
      activeTextEditor: undefined,
    },
    workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: () => undefined }), asRelativePath: (u: unknown) => String(u) },
    commands: { registerCommand: (name: string, fn: (...a: unknown[]) => unknown) => { registered.set(name, fn); return { dispose() {} } } },
    ProgressLocation: { Notification: 15 },
  }))
  // @ts-expect-error — plain CommonJS module
  const extension = await import("../extension/extension.js")
  const context = { subscriptions: [] as unknown[] }
  ;(extension.default ?? extension).activate(context)
  expect([...registered.keys()].sort()).toEqual(["abdocode.askSelection", "abdocode.runTask"])
  await registered.get("abdocode.runTask")!()
  expect(errors[0]).toContain("open a folder first")
})
