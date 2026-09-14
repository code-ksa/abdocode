/**
 * م11 حيّاً: مزوّدٌ وهميّ يردّ أوّلاً بنصٍّ يسرد خرجَ `ls -la` مختلَقاً مع طلب أداةٍ حقيقيّ، ثمّ يكمل. المقيس: حدثُ «سرد خرجَ أمرٍ لم
 * تُنفّذه أداة» يُبثّ، والنداءُ الثاني يحمل «[تصحيحٌ من النظام]» في مدخله، والدورُ يكتمل (لا رفضَ للردّ). التوأمُ السلبيّ: ردٌّ بلا خرجٍ
 * مختلَق ⇦ لا حدثَ ولا تصحيح.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const ROOT = resolve(import.meta.dir, "../../..")

async function run(firstReply: string): Promise<{ events: string[]; prompts: string[]; end: string }> {
  const base = mkdtempSync(join(tmpdir(), "abdo-fab-live-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  const prompts: string[] = []
  let calls = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const msgs = body.messages ?? []
    const text = (m: { content: unknown } | undefined) => m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    const system = msgs.filter((m) => m.role === "system").map(text).join("\n")
    const users = msgs.filter((m) => m.role === "user").map(text)
    let content = "تمّ الهدف."
    if (system.includes("أنت الوكيلُ الموجِّه") || users.join("\n").includes("أنت الوكيلُ الموجِّه")) content = "لا حاجة للتوجيه هنا."
    else { calls += 1; prompts.push(users[users.length - 1] ?? ""); content = calls === 1 ? firstReply : "قرأتُ المجلّد — تمّ الهدف." }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "fab/model", chatModel: "fab/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy: "thin", workMode: "basic", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 }, customProviders: [{ id: "fab", label: "fab", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 120_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "full-access", turn: { id: "f1", body: "اقرأ المجلّد وقل ما فيه" } })
    await wait(() => frames.some((f) => f.turnId === "f1" && ["done", "refused", "unresolved"].includes(f.kind)))
    const end = frames.find((f) => f.turnId === "f1" && ["done", "refused", "unresolved"].includes(f.kind))
    return { events: frames.filter((f) => f.kind === "event" && f.turnId === "f1").map((f) => String(f.payload ?? "")), prompts, end: end.kind }
  } finally { child.kill(); await child.exited; server.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}

test.skipIf(process.platform !== "win32")("a reply narrating ls output without a receipt is named to the operator and corrected in the next call; the turn still completes", async () => {
  const r = await run("سأتحقّق أوّلاً:\nنفّذ: list .\ndrwxr-xr-x 5 abdelrahman staff 4096 Oct 15 10:00 .\n-rw-r--r-- 1 abdelrahman staff 33 Oct 15 10:00 package.json")
  expect(r.events.some((t) => t.startsWith("⚠ النموذجُ سرد خرجَ أمرٍ لم تُنفّذه أداة") && t.includes("drwxr-xr-x 5 abdelrahman staff"))).toBe(true)
  expect(r.prompts.length).toBeGreaterThanOrEqual(2)
  expect(r.prompts[1]!.startsWith("[تصحيحٌ من النظام]")).toBe(true)
  expect(r.prompts[1]).toContain("لا تكتب خرجاً بنفسك")
  expect(r.end).toBe("done")
}, 120_000)

test.skipIf(process.platform !== "win32")("a clean reply produces no fabrication event and no correction (negative twin)", async () => {
  const r = await run("سأتحقّق أوّلاً:\nنفّذ: list .")
  expect(r.events.some((t) => t.includes("سرد خرجَ أمرٍ"))).toBe(false)
  expect(r.prompts.some((p) => p.includes("[تصحيحٌ من النظام]"))).toBe(false)
  expect(r.end).toBe("done")
}, 120_000)
