/** "استكمل مشروع رودود" through the real framed engine: the model locates the
 * folder by its spoken Arabic name, opens it behind the approval gate, and
 * receives the orientation (Git, plan, handoff, gaps) before proposing
 * branches. A denied approval leaves the selection untouched. The model is
 * a scripted local HTTP provider, so the same test runs against the source
 * engine and the compiled/installed engine (ABDO_TEST_ENGINE). No real
 * provider, credential or user project. */
import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { classifyModelLane } from "@abdo/providers"

const ROOT = resolve(import.meta.dir, "../../..")

test("naming a project to continue or open routes to the agent lane", () => {
  for (const text of ["استكمل مشروع رودود", "اكمل مشروع الفواتير من حيث توقفنا", "افتح مشروع crm", "continue project rodud", "open the eagle project", "pick up the repo mosaiden"]) expect(classifyModelLane(text)).toBe("agent")
  for (const text of ["ما هو المشروع؟", "شرح كلمة project", "open"]) expect(classifyModelLane(text)).toBe("chat")
})

async function fixture(mode: "open" | "deny") {
  const base = mkdtempSync(join(tmpdir(), "abdo-orient-live-"))
  const state = join(base, "state"), install = join(base, "payload"), documents = join(base, "Documents"), target = join(documents, "rodud")
  for (const dir of [state, install, target, join(documents, "crm-board"), join(documents, "node_modules", "rodud-dep")]) mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: target, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q")
  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "rodud", dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" }, scripts: { build: "next build" } }))
  writeFileSync(join(target, "PLAN.md"), "# Rodud\n- [x] scaffold\n- [ ] driver onboarding flow\n")
  writeFileSync(join(target, "NEXT_ACTION.md"), "Resume the driver onboarding screen.\n")
  git("add", "."); git("commit", "-q", "-m", "scaffold rodud app")
  // After opening, the fixture model tries to edit right away (what the real local model did on
  // 2026-09-06); the orientation turn must refuse it and the model must end with the proposal.
  const responses = ["نفّذ: project-locate رودود", `نفّذ: project-open ${target}`, "نفّذ: write PLAN.md <<<\n# hijacked", "Orientation read. Proposed branches: 1) driver onboarding flow (first unchecked plan line), 2) tests, 3) README. Which one?"]
  const requests: { stream?: boolean; messages: { role: string; content: string }[] }[] = []
  let step = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages: { role: string; content: string }[] }
    requests.push(body)
    const content = responses[Math.min(step++, 3)]!
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 10 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "en", agentModel: "orient-fixture/model", modelRole: "agent", mode: "read-only", project: install, memorySearchEnabled: true, semanticMemoryEnabled: false, routerGate: "off", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, generalAwareness: false, sessionAwareness: false }, superAbdo: { enabled: false }, customProviders: [{ id: "orient-fixture", label: "Local orientation test", baseUrl: `http://127.0.0.1:${server.port}/v1`, local: true, vaultKey: "", models: ["model"] }] }))
  const executable = process.env.ABDO_TEST_ENGINE
  const child = Bun.spawn(executable ? [executable, "serve"] : [process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "orient-test", ABDO_FRAMED_STDIO: "1", ABDO_REQUIRE_PROJECT: "1", ABDO_INSTALL_ROOT: install, ABDO_PROJECT: "", ABDO_DOCUMENTS_DIR: documents, ABDO_CODE_STATE_DIR: state, ABDO_CODE_SETTINGS: settings, ABDO_VAULT_HOME: state, USERPROFILE: base, HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "", ABDO_NATIVE_TOOLS: "text", ABDO_MAX_AGENT_EPOCHS: "4", ABDO_CLOUD_DAILY_TOKENS: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 25_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "orient-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: mode === "deny" ? "read-only" : "full-access", turn: { id: "orient-turn", body: "استكمل مشروع رودود" } })
    await wait(() => requests.length > 0)
    if (mode === "deny") { await wait(() => frames.some((f) => f.kind === "approval")); send({ kind: "deny", turnId: "orient-turn" }) }
    await wait(() => frames.some((f) => f.turnId === "orient-turn" && ["done", "refused", "unresolved"].includes(f.kind)))
    const calls = requests.map((r) => JSON.stringify(r))
    const results = frames.filter((f) => f.kind === "tool-result" && f.turnId === "orient-turn").map((f) => String(f.output))
    // The first request had no project; the locator ran without one and found the Latin folder by its Arabic name.
    expect(calls[0]).toContain("NO PROJECT IS SELECTED")
    expect(results[0]).toContain('"name": "rodud"')
    expect(results[0]).toContain("One clear match")
    expect(results[0]).not.toContain("rodud-dep")
    if (mode === "open") {
      expect(frames.some((f) => f.kind === "project" && f.path === target)).toBe(true)
      expect(JSON.parse(readFileSync(settings, "utf8")).project).toBe(target)
      expect(results[1]).toContain("Selected project: " + target)
      expect(results[1]).toContain("[PROJECT_ORIENTATION]")
      expect(results[1]).toContain("scaffold rodud app")
      expect(results[1]).toContain("driver onboarding flow")
      expect(results[1]).toContain("No README.md")
      expect(results[1]).toContain("propose 3-5 ranked development branches")
      // The orientation reached the model's next request as data, and no file in the project changed.
      expect(results[2]).toContain("Project just opened in this turn")
      expect(readFileSync(join(target, "PLAN.md"), "utf8")).not.toContain("hijacked")
      expect(calls.at(-1)).toContain("[PROJECT_ORIENTATION]")
      expect(calls.at(-1)).toContain("Active project root: " + target.replaceAll("\\", "\\\\"))
      expect(git("status", "--porcelain").trim()).toBe("")
      expect(frames.find((f) => f.kind === "done" && f.turnId === "orient-turn")).toBeDefined()
    } else {
      expect(frames.some((f) => f.kind === "project")).toBe(false)
      expect(JSON.parse(readFileSync(settings, "utf8")).project).toBe(install)
      expect(results[1]).toContain("not approved")
    }
    expect(existsSync(join(install, "PLAN.md"))).toBe(false)
  } finally { child.kill(); await child.exited; await reading; await errors; server.stop(true); rmSync(base, { recursive: true, force: true }) }
}

test("the real engine locates a project by its spoken name, opens it with approval and orients before proposing branches", () => fixture("open"), 40_000)
test("a denied approval leaves the selected project untouched", () => fixture("deny"), 40_000)
