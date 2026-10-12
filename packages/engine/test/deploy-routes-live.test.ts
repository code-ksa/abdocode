/**
 * 10-08 — موجزُ طرق النشر يصل النموذجَ حين تُفتح عائلةُ الخوادم (نشرٌ، خادمٌ تجريبيّ، Docker)، ولا يصله في غيرها.
 * يُسأل الطلبُ الذي بلغ النموذج (رسالةُ النظام نفسُها) لا الدالّة.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { stripChildEnv } from "../../tools/src/env-strip"
import { familiesFor } from "../src/tool-exposure"

async function systemFor(goal: string): Promise<string> {
  const systems: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    systems.push((body.messages ?? []).filter((m) => m.role === "system").map((m) => String(m.content)).join("\n"))
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-deploy-routes-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }))
  writeFileSync(settings, JSON.stringify({
    language: "ar", mode: "full-access", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const frames: any[] = []
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "2", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    send({ kind: "submit", mode: "full-access", turn: { id: "r1", body: goal } })
    await wait(() => frames.some((f) => f.turnId === "r1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    return systems[0] ?? ""
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}

test("the brief carries no control characters at runtime (\\b in a Windows path inside a JS string becomes a backspace — measured 10-08)", async () => {
  const { DEPLOY_ROUTES_BRIEF } = await import("../src/deploy-routes")
  expect([...DEPLOY_ROUTES_BRIEF].filter((c) => c.charCodeAt(0) < 32 && c !== "\n")).toEqual([])
  expect(DEPLOY_ROUTES_BRIEF).toContain("%LOCALAPPDATA%\\Docker\\backend.error.json")
})

test("Docker / test-server words open the servers family", () => {
  for (const goal of ["اعمل خادم تجريبي بـ docker وانشر عليه", "deploy to a test server", "ارفع المشروع على حاوية دوكر", "ديبلوي على السيرفر"]) expect(familiesFor(goal).has("servers")).toBe(true)
  expect(familiesFor("أصلح زرّ الدخول").has("servers")).toBe(false)
})

test("the deploy routes brief reaches the model when the servers family is open, and not otherwise", async () => {
  const deploy = await systemFor("اعمل خادماً تجريبيّاً بـ docker وانشر المشروع عليه")
  expect(deploy).toContain("طرقُ النشر")
  expect(deploy).toContain("-p 127.0.0.1:2222:22")
  expect(deploy).toContain("لا نشرَ إلى خادم إنتاجٍ بلا إذنٍ صريح")
  const plain = await systemFor("أصلح زرّ الدخول في الصفحة")
  expect(plain).not.toContain("طرقُ النشر")
}, 200_000)
