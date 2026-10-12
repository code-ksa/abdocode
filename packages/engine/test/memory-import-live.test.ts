import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// استيرادُ الذاكرة والتخصيصات عبر المحرّك الحيّ (10-10) — **ما يصل المزوّد يُقاس في جسد الطلب نفسِه**:
//   (١) المعاينةُ لا تكتب: قبل إطار الحفظ لا ملاحظةَ في الذاكرة ولا حرفَ من البند في طلبات النموذج.
//   (٢) بعد الحفظ (نطاق «كلّ المشاريع») يصل البندُ طلبَ النموذج — والتوأمُ: المفتاحُ الذي كان معه لا يصل أبداً.
//   (٣) والنطاقُ «كلّ المشاريع» حقيقيّ: بعد إعادة التشغيل وفي مشروعٍ آخر يصل البندُ أيضاً.

const ROOT = resolve(import.meta.dir, "../../..")
const SECRET = "sk-live-ZZTESTKEY9911223344556677"
const MARK = "ZEBRA-PREF-71"

const start = async (base: string, project: string, state: string) => {
  const bodies: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const raw = await request.text()
    bodies.push(raw)
    const body = JSON.parse(raw) as { stream?: boolean }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "imp-fixture/model", chatModel: "imp-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off",
    semanticMemoryEnabled: false, memorySearchEnabled: false, sensitiveMemoryEnabled: false,
    plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, semanticFrame: false, usageMeter: false },
    customProviders: [{ id: "imp-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "imp-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const next = async (kind: string, where?: (f: any) => boolean) => { const deadline = Date.now() + 60_000; for (;;) { const i = frames.findIndex((f) => f.kind === kind && (where === undefined || where(f))); if (i >= 0) return frames.splice(i, 1)[0]; if (Date.now() > deadline) throw Error(`Missing ${kind}: ${JSON.stringify(frames.map((f) => f.kind + (f.why ? ":" + f.why : ""))).slice(-1500)}`); await Bun.sleep(15) } }
  const runTurn = async (id: string) => {
    send({ kind: "submit", mode: "full-access", turn: { id, body: "اكتب صفحة الدفع" } })
    const deadline = Date.now() + 120_000
    while (!frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind))) { if (Date.now() > deadline) throw Error(`${id} end: ${JSON.stringify(frames.map((f) => f.kind)).slice(-800)}`); await Bun.sleep(15) }
  }
  send({ kind: "hello", shell: "desktop", token: "imp-test" })
  await next("ready")
  return { bodies, frames, send, next, runTurn, stop: async () => { child.kill(); await child.exited; server.stop(true); await errors } }
}

test("preview writes nothing; after the review-save frame the imported preference reaches the provider in every project — its key never does", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-import-live-")), state = join(base, "state"), project = join(base, "project"), other = join(base, "other")
  for (const dir of [project, other, join(state, "trust"), join(base, ".codex")]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "project", version: "1.0.0" }))
  writeFileSync(join(other, "package.json"), JSON.stringify({ name: "other", version: "1.0.0" }))
  writeFileSync(join(base, ".codex", "AGENTS.md"), "- Prefer small pull requests\n")
  let h = await start(base, project, state)
  try {
    // الفحصُ يسرد ملفَّ Codex في البيت (HOME=base) بمساره وحجمه — بلا محتوى.
    h.send({ kind: "memory-import-scan" })
    const sources = await h.next("memory-import-sources")
    const codex = sources.sources.find((s: any) => s.agent === "codex")
    expect(codex.bytes).toBeGreaterThan(0)
    expect(JSON.stringify(sources)).not.toContain("small pull requests")

    h.send({ kind: "memory-import-preview", source: "paste", from: "chatgpt", text: `Sure! Here's what I remember:\n- Always answer in Arabic with short sentences ${MARK}\n- My OpenAI key is ${SECRET}` })
    const review = await h.next("memory-import-review")
    expect(JSON.stringify(review)).not.toContain(SECRET)
    expect(review.items.map((i: any) => i.text)).toEqual(expect.arrayContaining([`Always answer in Arabic with short sentences ${MARK}`]))

    // (١) لا كتابةَ قبل الحفظ: لا ملاحظة، ولا حرفَ في طلب النموذج.
    h.send({ kind: "memory-list" })
    expect(JSON.stringify(await h.next("memory-notes"))).not.toContain(MARK)
    await h.runTurn("before")
    expect(h.bodies.length).toBeGreaterThan(0)
    expect(h.bodies.join("\n")).not.toContain(MARK)

    // (٢) نقرةُ الحفظ: نطاق «كلّ المشاريع».
    const seen = h.bodies.length
    h.send({ kind: "memory-import-save", scope: "user", items: review.items.map((i: any) => ({ text: i.text, agent: i.agent, origin: i.origin, category: i.category })) })
    const saved = await h.next("memory-import-saved")
    expect(saved.saved.length).toBe(review.items.length)
    const notes = await h.next("memory-notes")
    const note = notes.facts.find((f: any) => String(f.value?.note).includes(MARK))
    expect(note.scope).toBe("user")
    expect(note.value.importedFrom.agent).toBe("chatgpt")
    await h.runTurn("after")
    const after = h.bodies.slice(seen).join("\n")
    expect(after).toContain(MARK)
    expect(h.bodies.join("\n")).not.toContain(SECRET)
  } finally { await h.stop() }

  // (٣) بعد إعادة التشغيل وفي مشروعٍ آخر: التخصيصُ ما زال يصل.
  h = await start(base, other, state)
  try {
    await h.runTurn("other-project")
    expect(h.bodies.join("\n")).toContain(MARK)
    expect(h.bodies.join("\n")).not.toContain(SECRET)
  } finally {
    await h.stop()
    for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
  }
}, 300_000)
