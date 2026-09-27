/**
 * الفجوة #4 (2026-09-27) — `run --sandbox` على المحرّك الحقيقيّ وخطّاف AppContainer الحقيقيّ (ويندوز).
 * التوأمُ أوّلاً: التشغيلُ العاديّ **يقرأ** ملفّاً خارج المشروع — فرفضُ الصندوق لقراءته ليس أخضرَ كاذباً. ثمّ الصندوق:
 * لا يقرأ ما خارج المشروع، ولا يبلغ الشبكة، ويكتب داخل المشروع.
 */
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { sandboxGrant, sandboxInvocation } from "../src/os-sandbox"
import { stripChildEnv } from "../../tools/src/env-strip"

const HELPER = resolve(import.meta.dir, "../../windows-isolation-helper/target/release/abdo-winiso.exe")
const MANIFEST = resolve(import.meta.dir, "../../windows-isolation-helper/helper-manifest.json")
const READY = process.platform === "win32" && existsSync(HELPER)
const MARKER = "TOP-SECRET-MARKER-7731"
const PROBE = "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('1.1.1.1', 443); 'NET-OK' } catch { 'NET-BLOCKED' }"

test("the grant is refused by name — never an unisolated fallback — off Windows or without a trusted helper", () => {
  expect(sandboxGrant({ helper: HELPER, manifest: MANIFEST }, tmpdir(), "linux")).toMatchObject({ refusal: expect.stringContaining("لويندوز وحده") })
  expect(sandboxGrant({ helper: join(tmpdir(), "no-helper.exe"), manifest: MANIFEST }, tmpdir(), "win32")).toMatchObject({ refusal: expect.stringContaining("غيرُ موجود") })
  // بيانٌ لا يطابق بصمةَ الثنائيّ = خطّافٌ غيرُ موثوق.
  const bad = join(mkdtempSync(join(tmpdir(), "abdo-sbx-")), "manifest.json")
  writeFileSync(bad, JSON.stringify({ ...JSON.parse(readFileSync(MANIFEST, "utf8")), helperBinaryHash: "0".repeat(64) }))
  if (READY) expect(sandboxGrant({ helper: HELPER, manifest: bad }, tmpdir(), "win32")).toMatchObject({ refusal: expect.stringContaining("غيرُ موثوق") })
})

test("the invocation: resolved on the host, argv kept apart, builtins through cmd, shell strings refused", () => {
  const which = (name: string) => name === "node" ? "C:\\Program Files\\nodejs\\node.exe" : name === "npm" ? "C:\\Program Files\\nodejs\\npm.cmd" : null
  expect(sandboxInvocation(`node -e "console.log(1)" x`, which)).toEqual({ executable: "C:\\Program Files\\nodejs\\node.exe", argv: ["-e", "console.log(1)", "x"] })
  expect(sandboxInvocation("npm test", which)).toEqual({ executable: "C:\\Windows\\System32\\cmd.exe", argv: ["/d", "/c", "C:\\Program Files\\nodejs\\npm.cmd", "test"] })
  expect(sandboxInvocation("type notes.txt", which)).toEqual({ executable: "C:\\Windows\\System32\\cmd.exe", argv: ["/d", "/c", "type", "notes.txt"] })
  for (const shell of ["node a.js | more", "node a.js && del x", "echo x > y", "node a.js; calc", "node $(calc)", "a `b`"]) expect(sandboxInvocation(shell, which), shell).toMatchObject({ refusal: expect.stringContaining("لا يفسّر") })
  // داخل علامات التنصيص ليست صَدَفة.
  expect(sandboxInvocation(`node -e "a|b; c > d"`, which)).toMatchObject({ argv: ["-e", "a|b; c > d"] })
  expect(sandboxInvocation("ghost-tool --x", which)).toMatchObject({ refusal: expect.stringContaining("لا يُعثر على «ghost-tool»") })
})

test.skipIf(!READY)("on the real engine: outside files and the network are closed to --sandbox, the project stays writable — and the unsandboxed twin reads what the sandbox cannot", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-sandbox-live-")), project = join(home, "proj"), outside = join(home, "outside"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true }); mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, "secret.txt"), MARKER)
  const secretPath = join(outside, "secret.txt")
  const replies = [
    `نفّذ: run Get-Content '${secretPath}'`,
    `نفّذ: run --sandbox type "${secretPath}"`,
    `نفّذ: run --sandbox powershell -NoProfile -Command "${PROBE}"`,
    "نفّذ: run --sandbox node -e \"require('fs').writeFileSync('inside.txt','written-in-box')\"",
    "نفّذ: run --sandbox type inside.txt | more",
    "Done.",
  ]
  let n = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(n++, replies.length - 1)]!
    const payload = await request.json() as { stream?: boolean }
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "full-access", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const frames: any[] = []
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "6", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 240_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label); await Bun.sleep(25) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    send({ kind: "submit", mode: "full-access", turn: { id: "s1", body: "Check the sandbox on this project" } })
    await wait(() => frames.some((f) => f.turnId === "s1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    const results = frames.filter((f) => f.turnId === "s1" && f.kind === "tool-result").map((f) => String(f.output))
    expect(results).toHaveLength(5)
    const [plainRead, boxRead, boxNet, boxWrite, boxPipe] = results as [string, string, string, string, string]
    // التوأم: بلا صندوق يُقرأ الملفُّ — فالصندوقُ هو ما يمنعه.
    expect(plainRead).toContain(MARKER)
    expect(boxRead).toContain("🛡 معزول")
    expect(boxRead).not.toContain(MARKER)
    expect(boxNet).toContain("NET-BLOCKED")
    expect(boxWrite).toContain("🛡 معزول")
    expect(readFileSync(join(project, "inside.txt"), "utf8").trim()).toBe("written-in-box")
    // الصندوقُ لا يفسّر سلاسلَ الصَّدَفة — يُرفض باسمه ولا يُشغَّل شيء.
    expect(boxPipe).toContain("⛔ الصندوقُ لا يفسّر سلاسلَ الصَّدَفة")
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 300_000)
