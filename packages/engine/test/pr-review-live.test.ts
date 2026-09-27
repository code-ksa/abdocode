/**
 * الفجوة #9 (2026-09-27) — `review pr <رقم|رابط> [--post]` على المحرّك الحقيقيّ، و`gh` مزيّفٌ أوّلَ المسار (لا GitHub حقيقيّ):
 * الفرقُ يصل العدساتِ كاملاً، والنشرُ ببوّابة الشبكة (full-access ينشر بإرادة --post، وauto يسأل فيُرفض)، والمرجعُ المسموم لا يصل الصَّدَفة.
 */
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { changesFromUnifiedDiff, parsePrRef } from "../src/review-lane"
import { stripChildEnv } from "../../tools/src/env-strip"

const DIFF = [
  "diff --git a/src/math.js b/src/math.js", "index 1111111..2222222 100644", "--- a/src/math.js", "+++ b/src/math.js",
  "@@ -1,3 +1,3 @@", " export function ratio(a, b) {", "-  return b === 0 ? 0 : a / b", "+  return a / b", " }",
  "diff --git a/README.md b/README.md", "--- a/README.md", "+++ b/README.md", "@@ -1 +1 @@", "-old", "+new MARKER-FROM-PR-DIFF", "",
].join("\n")
const FINDING = "- [حرج] src/math.js:2 — أُزيل حارسُ القسمة على صفر — كيف يفشل: ratio(1, 0) يعيد Infinity"

test("the PR reference reaches a shell command, so only a number or a github.com PR URL passes", () => {
  expect(parsePrRef("42")).toBe("42")
  expect(parsePrRef("https://github.com/code-ksa/abdocode/pull/7/")).toBe("https://github.com/code-ksa/abdocode/pull/7")
  for (const evil of ["42;calc", "42 & calc", "$(calc)", "42|calc", "https://evil.example/pull/1", "https://github.com/a/b/pull/1&calc", "-1", "0x2A"]) expect(parsePrRef(evil), evil).toBeUndefined()
  const changes = changesFromUnifiedDiff(DIFF)
  expect(changes.map((c) => c.path)).toEqual(["src/math.js", "README.md"])
  expect(changes[0]!.patch).toContain("-  return b === 0 ? 0 : a / b")
})

async function reviewTurn(body: string, mode: "auto" | "full-access", decision?: "deny") {
  const fake = mkdtempSync(join(tmpdir(), "abdo-fakegh-"))
  writeFileSync(join(fake, "fixture.diff"), DIFF)
  writeFileSync(join(fake, "gh.cmd"), [
    "@echo off",
    'if "%1"=="pr" if "%2"=="diff" (', '  type "%~dp0fixture.diff"', "  exit /b 0", ")",
    'if "%1"=="pr" if "%2"=="review" (', '  copy /y "%~6" "%~dp0posted.md" >nul', '  echo %* > "%~dp0posted-args.txt"', "  exit /b 0", ")",
    "echo unexpected %* 1>&2", "exit /b 3", "",
  ].join("\r\n"))
  const bodies: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const payload = await request.json() as { stream?: boolean; messages?: unknown }
    bodies.push(JSON.stringify(payload.messages ?? []))
    const content = FINDING
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-prreview-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  writeFileSync(settings, JSON.stringify({
    language: "en", mode, modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const base = stripChildEnv(process.env).env as Record<string, string | undefined>
  const pathKey = Object.keys(base).find((k) => k.toLowerCase() === "path") ?? "PATH"
  const frames: any[] = []
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...base, [pathKey]: `${fake};${base[pathKey] ?? ""}`, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label + " " + JSON.stringify(frames.slice(-4)).slice(0, 1200)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    send({ kind: "submit", mode, turn: { id: "p1", body } })
    const ended = () => frames.some((f) => f.turnId === "p1" && ["done", "refused", "unresolved"].includes(f.kind))
    if (decision !== undefined) {
      await wait(() => ended() || frames.some((f) => f.turnId === "p1" && f.kind === "approval"), "approval")
      if (!ended()) send({ kind: decision, turnId: "p1" })
    }
    await wait(ended, "turn end")
    const answer = frames.filter((f) => f.turnId === "p1" && f.kind === "event").map((f) => String(f.payload)).join("\n")
    return { answer, bodies, posted: existsSync(join(fake, "posted.md")) ? readFileSync(join(fake, "posted.md"), "utf8") : undefined, approvals: frames.filter((f) => f.turnId === "p1" && f.kind === "approval").length, ghCalls: existsSync(join(fake, "posted-args.txt")) }
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(home, { recursive: true, force: true }); rmSync(fake, { recursive: true, force: true })
  }
}

test("review pr: the whole diff reaches the three lenses and the verdict is reported; nothing is posted without --post", async () => {
  const run = await reviewTurn("review pr 42", "auto")
  expect(run.bodies).toHaveLength(3)
  for (const body of run.bodies) { expect(body).toContain("MARKER-FROM-PR-DIFF"); expect(body).toContain("return b === 0 ? 0 : a / b") }
  expect(run.answer).toContain("🔍 مراجعةُ PR 42: 2 ملفّاً")
  expect(run.answer).toContain("يحتاج إصلاحاً")
  expect(run.posted).toBeUndefined()
}, 150_000)

test("--post publishes under full access (the user wrote --post), and under auto the approval is asked — refused means nothing is posted", async () => {
  const full = await reviewTurn("review pr 42 --post", "full-access")
  expect(full.posted).toContain("## مراجعةُ عبدو كود")
  expect(full.posted).toContain("يحتاج إصلاحاً")
  expect(full.answer).toContain("✓ نُشرت المراجعة تعليقاً على PR 42.")
  const asked = await reviewTurn("review pr 42 --post", "auto", "deny")
  expect(asked.approvals).toBe(1)
  expect(asked.posted).toBeUndefined()
  expect(asked.answer).toContain("⚠ لم تُنشر المراجعة على PR 42")
}, 240_000)

test("a poisoned reference is refused before any command runs", async () => {
  const run = await reviewTurn("review pr 42&calc", "full-access")
  expect(run.bodies).toHaveLength(0)
  expect(run.answer).toContain("review pr يحتاج رقمَ PR أو رابطَه")
  expect(run.ghCalls).toBe(false)
}, 120_000)
