/**
 * مقيس حيّاً 2026-09-27 (مختبر م8، الطرفان على Qwen3.8-9B محلّيّاً): `write` استبدل `rules/patterns.js` النقيَّ CRLF — والمهمّةُ
 * تقول «يبقى CRLF» — بمحتوى LF ستّ مرّات، فخسر الطرفُ نقطةَ البايتات، وسكت التحذيرُ لأنّه قارن بـ`before` الفارغ.
 * على المحرّك الحقيقيّ: الملفُّ على القرص يبقى نقيَّ CRLF، والإيصالُ يقول كم سطراً حُوّل.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { stripChildEnv } from "../../tools/src/env-strip"

async function writeTurn(initial: string) {
  const replies = ["نفّذ: write rules.js <<<\nexport const A = 1\nexport const B = 2\nexport const C = 3\n", "Done."]
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(requests, replies.length - 1)]!
    requests += 1
    const payload = await request.json() as { stream?: boolean }
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-eol-kept-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, "rules.js"), initial)
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
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "t", ABDO_FRAMED_STDIO: "1", USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "3", ABDO_REQUIRE_SPRINT_PLAN: "0", ABDO_AGENT_PHASE: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder()
  const reading = (async () => { for await (const bytes of child.stdout) for (const frame of decoder.push(bytes)) frames.push(frame) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean, label: string) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out: " + label); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "t" })
    await wait(() => frames.some((f) => f.kind === "ready"), "ready")
    send({ kind: "submit", mode: "full-access", turn: { id: "e1", body: "Rewrite rules.js with three constants" } })
    await wait(() => frames.some((f) => f.turnId === "e1" && ["done", "refused", "unresolved"].includes(f.kind)), "turn end")
    const receipt = String(frames.find((f) => f.turnId === "e1" && f.kind === "tool-result" && String(f.cmd).startsWith("write"))?.output ?? "")
    return { disk: readFileSync(join(project, "rules.js"), "utf8"), receipt }
  } finally {
    child.kill(); await child.exited; await reading; await stderr; server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}

const count = (text: string) => ({ crlf: (text.match(/\r\n/gu) ?? []).length, lone: (text.match(/(?<!\r)\n/gu) ?? []).length })

test("a pure-CRLF file rewritten with LF content stays pure CRLF on disk, and the receipt says so", async () => {
  const kept = await writeTurn("export const A = 0\r\nexport const B = 0\r\n")
  expect(kept.disk).toBe("export const A = 1\r\nexport const B = 2\r\nexport const C = 3\r\n")
  expect(count(kept.disk)).toEqual({ crlf: 3, lone: 0 })
  // سطرا المحتوى حُوّلا، والسطرُ الأخير الذي قصّه البروتوكولُ أُعيد بنهاية الملفّ.
  expect(kept.receipt).toContain("«rules.js»: الملفُّ نقيُّ CRLF فبقي كذلك — حُوّل 2 سطراً")
}, 120_000)

test("the twin: a pure-LF file receives LF content untouched and nothing is said", async () => {
  const plain = await writeTurn("export const A = 0\n")
  expect(count(plain.disk)).toEqual({ crlf: 0, lone: 3 })
  expect(plain.receipt).not.toContain("فبقي كذلك")
}, 120_000)
