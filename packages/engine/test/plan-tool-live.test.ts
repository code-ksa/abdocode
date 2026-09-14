import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// ذ9د — لوحُ الخطّة يديره النموذجُ بنفسه على المحرّك الحقيقيّ: set بمعرّفاتٍ واعتماديّات (فواصلُ عربيّة أو فراغات)، دورةٌ ومرجعٌ
// مجهول يُرفضان **بسببهما** والخطّةُ القائمة تبقى، صيغةُ اعتماديّاتٍ لا تُقرأ تُرفض لا تُبتلع، done يُحدِّث، إعادةُ تخطيطٍ تُسقط
// خطوةً مُثبَتة تُرفض بينما إسقاطُ غير المثبَتة يمرّ والهدفُ يبقى، fail بسببٍ يُحفظ ويُعرض في اللوح والإطار والخلاصة، إطارُ `plan`
// يحمل cmd، والخلاصةُ تدخل **نظامَ** الدور التالي (لا قبل أوّل خطّة). النموذجُ خادمٌ زائف يحفظ ما أُرسل إليه.

const ROOT = resolve(import.meta.dir, "../../..")

test.skipIf(process.platform !== "win32")("plan: set/start/done/fail/show with reasons, guards that name their cause, frame with cmd, and the brief in the next system prompt", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-plan-live-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(join(project, "src"), { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  writeFileSync(join(project, "src", "a.ts"), "export const a = 1\n")
  let script: string[] = []
  const requests: { role: string; content: string }[][] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    requests.push((body.messages ?? []).map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) })))
    const content = script.shift() ?? "Done."
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2500)); await Bun.sleep(15) } }
  const results = (id: string) => frames.filter((f) => f.kind === "tool-result" && f.turnId === id).map((f) => String(f.output))
  let n = 0
  const turn = async (...replies: string[]) => { const id = `pl-${++n}`; script = [...replies, "Done."]; send({ kind: "submit", mode: "full-access", turn: { id, body: "go " + id } }); await wait(() => frames.some((f) => f.turnId === id && ["done", "refused", "unresolved"].includes(f.kind))); return results(id) }
  const planFrames = () => frames.filter((f) => f.kind === "plan" && f.turnId === "session")
  const systemOfNextTurn = async (): Promise<string> => { const before = requests.length; await turn("نفّذ: plan show"); return requests.slice(before).map((msgs) => msgs.filter((m) => m.role === "system").map((m) => m.content).join("\n")).join("\n") }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    // قبل أيّ خطّة: show يقولها، ولا إطارَ، ولا خلاصةَ في النظام (التوأمُ السالب للخلاصة)
    const empty = await turn("نفّذ: plan show")
    expect(empty[0]).toContain("لا خطّةَ بعد")
    expect(planFrames()).toHaveLength(0)
    expect(await systemOfNextTurn()).not.toContain("لوحُ الخطّة")
    // set بهدفٍ وثلاثِ خطوات — الاعتماديّاتُ بفاصلةٍ عربيّةٍ وفراغ
    const set = await turn("نفّذ: plan set بناءُ الموقع <<<\ns1: أنشئ الهيكل\ns2: اختبر [after: s1]\ns3: انشر [بعد: s1، s2]")
    expect(set[0]).toContain("الخطّة (0/3 منجزة) — بناءُ الموقع")
    expect(set[0]).toContain("○ s1: أنشئ الهيكل")
    expect(set[0]).toContain("○ s3: انشر (بعد s1، s2)")
    const first = planFrames().at(-1)
    expect(first.goal).toBe("بناءُ الموقع")
    expect(first.steps).toHaveLength(3)
    expect(first.steps[0]).toMatchObject({ id: "s1", cmd: "أنشئ الهيكل", action: "أنشئ الهيكل", state: "pending" })
    expect(first.steps[2].dependsOn).toEqual(["s1", "s2"])
    // الخلاصةُ في **نظام** الدور التالي
    const sys1 = await systemOfNextTurn()
    expect(sys1).toContain("لوحُ الخطّة: 0/3 منجزة")
    expect(sys1).toContain("التالي: s1: أنشئ الهيكل")
    // الحرّاس يسمّون سببهم: دورةٌ، مرجعٌ مجهول، اعتماديّاتٌ لا تُقرأ، معرّفٌ طويل — والخطّةُ القائمة تبقى
    const cycle = await turn("نفّذ: plan set <<<\na: x [after: b]\nb: y [after: a]")
    expect(cycle[0]).toContain("خطّةٌ مرفوضة")
    expect(cycle[0]).toContain("cycle")
    const dangling = await turn("نفّذ: plan set <<<\nq1: شيء [after: nope]")
    expect(dangling[0]).toContain("خطّةٌ مرفوضة")
    expect(dangling[0]).toContain("nope")
    const unreadable = await turn("نفّذ: plan set <<<\ns9: انشر [after: s1] (اختياري)")
    expect(unreadable[0]).toContain("اعتماديّاتُ «s9» لا تُقرأ")
    const longId = await turn("نفّذ: plan set <<<\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: x")
    expect(longId[0]).toContain("أطول من ٣٢ حرفاً")
    const still = await turn("نفّذ: plan show")
    expect(still[0]).toContain("(0/3 منجزة) — بناءُ الموقع")
    expect(still[0]).toContain("s3")
    // start ثمّ done: الإطارُ والخلاصةُ يتقدّمان، والجاريةُ تُذكر
    expect((await turn("نفّذ: plan start s1"))[0]).toContain("▶ s1")
    expect(await systemOfNextTurn()).toContain("جارية: s1")
    const done = await turn("نفّذ: plan done s1")
    expect(done[0]).toContain("(1/3 منجزة)")
    expect(done[0]).toContain("✓ s1")
    expect(planFrames().at(-1).steps[0].state).toBe("done")
    expect(await systemOfNextTurn()).toContain("لوحُ الخطّة: 1/3 منجزة — التالي: s2: اختبر")
    // إعادةُ تخطيطٍ تُسقط s1 المُثبَتة تُرفض؛ وإسقاطُ s3 غير المثبَتة مع إبقاء s1 يمرّ، تحفظ s1 حالتَها والهدفُ يبقى
    const dropProven = await turn("نفّذ: plan set <<<\ns2: اختبر\ns3: انشر [after: s2]")
    expect(dropProven[0]).toContain("إعادةُ التخطيط مرفوضة")
    expect(dropProven[0]).toContain("s1")
    const replanned = await turn("نفّذ: plan set <<<\ns1: أنشئ الهيكل\ns2: اختبر [after: s1]\ns4: وثّق [after: s2]")
    expect(replanned[0]).toContain("(1/3 منجزة) — بناءُ الموقع")
    expect(replanned[0]).toContain("✓ s1")
    expect(replanned[0]).toContain("○ s4: وثّق (بعد s2)")
    expect(replanned[0]).not.toContain("s3")
    expect(planFrames().at(-1).goal).toBe("بناءُ الموقع")
    // fail بسبب: يُحفظ ويُعرض في اللوح والإطار والخلاصة؛ وdone يمسحه
    const failed = await turn("نفّذ: plan fail s2 :: الاختبار أحمر في page.test.ts")
    expect(failed[0]).toContain("✗ s2: اختبر (بعد s1) — السبب: الاختبار أحمر في page.test.ts")
    expect(planFrames().at(-1).steps[1]).toMatchObject({ id: "s2", state: "failed", reason: "الاختبار أحمر في page.test.ts" })
    expect(await systemOfNextTurn()).toContain("فشلت: s2 (الاختبار أحمر في page.test.ts)")
    const redone = await turn("نفّذ: plan done s2")
    expect(redone[0]).not.toContain("السبب")
    expect(planFrames().at(-1).steps[1].reason).toBeUndefined()
    // معرّفٌ مجهول يُقال، وdone بلا معرّف صيغةٌ، وسطرٌ لا يُقرأ يُسمّى
    expect((await turn("نفّذ: plan done s9"))[0]).toContain("لا خطوةَ بالمعرّف «s9»")
    expect((await turn("نفّذ: plan done"))[0]).toContain("الصيغة: plan set")
    expect((await turn("نفّذ: plan set <<<\nهذا ليس خطوة"))[0]).toContain("سطرٌ لا يُقرأ")
  } finally { child.kill(); await child.exited; server.stop(true); await errors; rmSync(base, { recursive: true, force: true }) }
}, 180_000)
