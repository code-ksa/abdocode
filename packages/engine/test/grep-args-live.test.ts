import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { effectivePattern, parseGrepArgs, tokenizeArgs } from "../src/grep-args"

// 🔴 مقيس 10-02: `grep -i avatar . -r --include="*.tsx"` عاد «لا مطابقة» عن مشروعٍ فيه عشراتُ المطابقات — الوسيطُ الثاني
// عُدّ glob («.» لا يطابق ملفّاً)، و`grep -n "x" f` جعل «-n» نمطاً، والتنصيصُ بقي في النمط. نفيٌ كاذبٌ يبني عليه النموذج.

describe("grep arguments as the model writes them (GNU grep)", () => {
  test("quotes are honoured and removed, spaces inside them kept", () => {
    expect(tokenizeArgs(`-n "Sprint 14" ABDO-SPRINTS.md`)).toEqual(["-n", "Sprint 14", "ABDO-SPRINTS.md"])
    expect(tokenizeArgs(`'a b'  c`)).toEqual(["a b", "c"])
    expect(tokenizeArgs(`""`)).toEqual([""])
  })

  test("flags in any position, clusters, --include, -A/-B, and a trailing pipe is named not swallowed", () => {
    const a = parseGrepArgs(tokenizeArgs(`-i avatar . -r --include="*.tsx"`))
    expect(a).toMatchObject({ pattern: "avatar", paths: ["."], ignoreCase: true, includes: ["*.tsx"], ignored: [] })
    const b = parseGrepArgs(tokenizeArgs(`-rni "x y" src | head -30`))
    expect(b).toMatchObject({ pattern: "x y", paths: ["src"], ignoreCase: true, ignored: ["| head -30"] })
    expect(parseGrepArgs(tokenizeArgs(`-A 50 "Sprint 14" f.md`))).toMatchObject({ pattern: "Sprint 14", context: 5, paths: ["f.md"] })
    expect(parseGrepArgs(tokenizeArgs(`-c avatar f.tsx`))).toMatchObject({ pattern: "avatar", count: true, paths: ["f.tsx"] })
    expect(parseGrepArgs(tokenizeArgs(`-Z x`)).ignored).toEqual(["-Z"])
    // الصيغةُ القديمة باقية: النمطُ ثمّ glob، و--type/--files.
    expect(parseGrepArgs(tokenizeArgs(`alpha src/*.ts --files`))).toMatchObject({ pattern: "alpha", paths: ["src/*.ts"], files: true })
  })

  test("-F is literal and -w is a whole word", () => {
    expect(effectivePattern(parseGrepArgs(["-F", "a.b(c"]))).toBe("a\\.b\\(c")
    expect(new RegExp(effectivePattern(parseGrepArgs(["-w", "cat"]))!).test("concat")).toBe(false)
    expect(new RegExp(effectivePattern(parseGrepArgs(["-w", "cat"]))!).test("a cat here")).toBe(true)
  })
})

const ROOT = resolve(import.meta.dir, "../../..")

test.skipIf(process.platform !== "win32")("the real grep tool on disk: GNU forms find what is there, and a missing path is named", async () => {
  const base = mkdtempSync(join(tmpdir(), "abdo-grep-args-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(join(project, "src", "components"), { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  writeFileSync(join(project, "src", "components", "header.tsx"), `export const H = () => <AvatarImage src="/avatar.png" alt="" />\n`)
  writeFileSync(join(project, "src", "components", "notes.css"), `.avatar { color: red }\n`)
  writeFileSync(join(project, "PLAN.md"), "# plan\n## Sprint 14: redesign\nالحالة: مفتوح\n")
  let asked = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const text = (m: { content: unknown } | undefined) => m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    const all = (body.messages ?? []).filter((m) => m.role === "user").map(text).join("\n")
    let content = "Done."
    if (all.includes("GREP-GNU")) {
      asked += 1
      content = asked === 1
        ? `نفّذ: grep -i avatar . -r --include="*.tsx"\nنفّذ: grep -n "Sprint 14" PLAN.md\nنفّذ: grep -rn avatar src | head -30\nنفّذ: grep avatar nowhere/`
        : "وجدتُ المطابقات."
    }
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy: "thin", plugins: { inventory: false, verifier: false, reviewer: false, delegation: false, projectAwareness: false, sessionAwareness: false, generalAwareness: false, semanticFrame: false, lessons: false, usageMeter: false }, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "full-access", turn: { id: "g-1", body: "GREP-GNU ابحث" } })
    await wait(() => frames.some((f) => f.turnId === "g-1" && ["done", "refused", "unresolved"].includes(f.kind)))
    const outs = frames.filter((f) => f.kind === "tool-result" && f.turnId === "g-1").map((f) => String(f.output).replaceAll("\\", "/"))
    expect(outs).toHaveLength(4)
    // «.» مع --include: الملفُّ tsx وحده، لا css
    expect(outs[0]).toContain("src/components/header.tsx:1")
    expect(outs[0]).not.toContain("notes.css")
    // «-n» علمٌ لا نمط، والتنصيصُ نُزع والمسافةُ بقيت
    expect(outs[1]).toContain("PLAN.md:2: ## Sprint 14: redesign")
    // مجلّدٌ مساراً، والأنبوبُ مسمّى لا مبتلَع
    expect(outs[2]).toContain("src/components/header.tsx:1")
    expect(outs[2]).toContain("src/components/notes.css:1")
    expect(outs[2]).toContain("تُجوهل (لا يُدعم هنا): | head -30")
    // مسارٌ غائب: «لا مطابقة» ومعها اسمُه — لا نفيٌ صامت
    expect(outs[3]).toContain("لا مطابقة")
    expect(outs[3]).toContain("غير موجود: nowhere/")
  } finally { child.kill(); await child.exited; server.stop(true); await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}, 180_000)
