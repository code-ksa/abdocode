/**
 * البند 12 من جرد هيرمس/أوبن‑كلاو — أداةٌ شرطُها غائبٌ لا تُعلَن.
 * مقيس 2026-09-27 قبل الإصلاح: تحكّمُ سطح المكتب مطفأ ومشروعٌ بلا git، والنموذجُ يرى `desk` و`git` بأخواتها.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { hiddenToolsLine, unavailableBecause } from "../src/tool-availability"

test("a tool is hidden only while its own condition is missing, and the line names why", () => {
  const off = { desktopControl: false, gitRepository: false }
  const on = { desktopControl: true, gitRepository: true }
  for (const name of ["desk", "git", "git-stage", "git-unstage", "git-commit"]) {
    expect(unavailableBecause(name, off)).toBeDefined()
    expect(unavailableBecause(name, on)).toBeUndefined()
  }
  // ما لا شرطَ له لا يُخفى أبداً.
  for (const name of ["read", "write", "run", "search", "image", "lsp"]) expect(unavailableBecause(name, off)).toBeUndefined()
  expect(hiddenToolsLine(["read", "desk", "git", "git-commit"], off)).toBe("🧰 مخفيّةٌ لغياب شرطها: desk (تحكّمُ سطح المكتب مطفأ في الإعدادات) · git، git-commit (المشروعُ ليس مستودعَ git)")
  expect(hiddenToolsLine(["read", "desk", "git"], on)).toBe("")
})

async function catalogueFor(options: { desktopControl: boolean; git: boolean; availability: boolean }) {
  const bodies: any[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any
    bodies.push(body)
    const content = "done"
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const base = mkdtempSync(join(tmpdir(), "abdo-availability-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), "{}")
  if (options.git) mkdirSync(join(project, ".git"))
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({
    language: "en", agentModel: "fx/model", chatModel: "fx/model", modelRole: "agent", mode: "auto", project, routerGate: "off", railPolicy: "thin", workMode: "basic",
    desktopControlEnabled: options.desktopControl,
    plugins: { inventory: false, verifier: false, reviewer: false, toolAvailability: options.availability },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, APPDATA: base, ABDO_VAULT_HOME: join(base, "vh"), ABDO_REQUIRE_SPRINT_PLAN: "0" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), frames: any[] = [], decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    // الهدفُ يفتح عائلةَ سطح المكتب بالنيّة — فالإخفاءُ هنا من الشرط لا من النيّة.
    send({ kind: "submit", mode: "auto", turn: { id: "c1", body: "Commit the change with git and click the Start button on my desktop" } })
    await wait(() => frames.some((f) => f.turnId === "c1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    const prompt = JSON.stringify(bodies[0]?.messages ?? [])
    const shown = new Set([...prompt.matchAll(/\\n- ([a-z][a-z0-9-]*)[ :]/gu)].map((m) => m[1]!))
    const lines = frames.filter((f) => f.turnId === "c1" && f.kind === "event" && String(f.payload).startsWith("🧰")).map((f) => String(f.payload))
    return { shown, lines }
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(base, { recursive: true, force: true })
  }
}

test("the real engine hides desk and git while their conditions are missing, and shows them when present", async () => {
  const missing = await catalogueFor({ desktopControl: false, git: false, availability: true })
  expect(missing.shown.has("desk")).toBe(false)
  expect(missing.shown.has("git")).toBe(false)
  expect(missing.shown.has("read")).toBe(true)
  expect(missing.lines.some((l) => l.startsWith("🧰 مخفيّةٌ لغياب شرطها: desk"))).toBe(true)

  // التوأمُ الإيجابيّ: الشرطان حاضران ⇦ تُعرضان، ولا سطرَ إخفاء.
  const present = await catalogueFor({ desktopControl: true, git: true, availability: true })
  expect(present.shown.has("desk")).toBe(true)
  expect(present.shown.has("git")).toBe(true)
  expect(present.lines.some((l) => l.includes("مخفيّةٌ"))).toBe(false)

  // والمفتاحُ مطفأً ⇦ السلوكُ القديم: تُعرض ويرفضها المُوزِّع عند النداء.
  const legacy = await catalogueFor({ desktopControl: false, git: false, availability: false })
  expect(legacy.shown.has("desk")).toBe(true)
  expect(legacy.shown.has("git")).toBe(true)
}, 180_000)
