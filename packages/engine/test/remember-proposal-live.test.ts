/**
 * 10-09 — the agent proposes a project memory with `remember <title> :: <text>`; it is saved only when the user approves. The rule
 * «only an explicit command persists a preference» stays: the approval click is that command. Live on the real engine in auto mode,
 * where edits pass without asking — `remember` still asks; approved ⇒ /memory lists it; denied (the twin) ⇒ nothing saved.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const ROOT = resolve(import.meta.dir, "../../..")

async function run(decision: "approve" | "deny"): Promise<{ approvals: number; listed: string; receipt: string }> {
  const base = mkdtempSync(join(tmpdir(), "abdo-remember-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  const bodies: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const text = await request.text()
    bodies.push(text)
    const body = JSON.parse(text) as { stream?: boolean }
    const content = bodies.length === 1 ? "نفّذ: remember يوم النشر :: النشر إلى الإنتاج يوم الخميس فقط، بعد نسخةٍ احتياطيّة." : "تمّ."
    return body.stream === false
      ? Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] })
      : new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "fake/model", chatModel: "fake/model", modelRole: "agent", mode: "auto", project, routerGate: "off", railPolicy: "thin", workMode: "basic", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "fake", label: "fake", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 120_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  const ended = (id: string) => () => frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind))
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "auto", turn: { id: "m1", body: "تذكّر أنّ النشر يوم الخميس فقط" } })
    await wait(() => frames.some((f) => f.kind === "approval" && f.turnId === "m1") || ended("m1")())
    const approvals = frames.filter((f) => f.kind === "approval" && f.turnId === "m1").length
    if (approvals > 0) send({ kind: decision, turnId: "m1" })
    await wait(ended("m1"))
    send({ kind: "submit", mode: "auto", turn: { id: "m2", body: "/memory" } })
    await wait(ended("m2"))
    const text = (id: string) => frames.filter((f) => f.turnId === id).map((f) => JSON.stringify(f)).join("\n")
    return { approvals, listed: text("m2"), receipt: bodies[1] ?? "" }
  } finally { child.kill(); await child.exited; server.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}

test.skipIf(process.platform !== "win32")("approved: the proposal asks even in auto mode, and /memory lists it afterwards", async () => {
  const r = await run("approve")
  expect(r.approvals).toBe(1)
  expect(r.receipt).toContain("حُفظ في ذاكرة المشروع «يوم النشر»")
  expect(r.listed).toContain("يوم النشر")
}, 180_000)

test.skipIf(process.platform !== "win32")("denied (the twin): nothing is saved and the model is told the decision is the user's", async () => {
  const r = await run("deny")
  expect(r.approvals).toBe(1)
  expect(r.receipt).toContain("الحفظُ في الذاكرة قرارُ المستخدم وحده")
  expect(r.listed).not.toContain("يوم النشر")
}, 180_000)
