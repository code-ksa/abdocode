/**
 * تعليماتُ المجلّد بطبقاتها (2026-09-28): أوّلُ ما تمسّ أداةٌ ما تحت مجلّدٍ فيه AGENTS.md يصل الملفُّ نموذجَه — مرّةً، ودون الجذر،
 * والإحالةُ «@AGENTS.md» لا تُكرَّر. وحيٌّ عبر exec: قراءةُ ملفٍّ في apps/web تحمل تعليماتِها؛ والتوأمُ: ملفُّ الجذر لا يحمل شيئاً.
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { folderInstructions } from "../src/folder-instructions"
import { stripChildEnv } from "../../tools/src/env-strip"

function tree() {
  const root = mkdtempSync(join(tmpdir(), "abdo-folder-"))
  mkdirSync(join(root, "apps", "web", "src"), { recursive: true })
  writeFileSync(join(root, "AGENTS.md"), "ROOT-RULES-1100\n")
  writeFileSync(join(root, "README.md"), "# root\n")
  writeFileSync(join(root, "apps", "web", "AGENTS.md"), "# This is NOT the framework you know\nNEXT-RULES-2200: read the bundled docs first.\n")
  writeFileSync(join(root, "apps", "web", "CLAUDE.md"), "@AGENTS.md\n")
  writeFileSync(join(root, "apps", "web", "src", "page.tsx"), "export default function Page() { return null }\n")
  return root
}

test("unit: the folder's file once, never the root's, never a bare @-reference, never outside the project", () => {
  const root = tree()
  try {
    const loaded = new Set<string>()
    const first = folderInstructions(root, join(root, "apps", "web", "src", "page.tsx"), loaded)
    expect(first.map((d) => d.file)).toEqual(["apps/web/AGENTS.md"])
    expect(first[0]!.text).toContain("NEXT-RULES-2200")
    expect(folderInstructions(root, join(root, "apps", "web", "src", "page.tsx"), loaded)).toEqual([])
    expect(folderInstructions(root, join(root, "README.md"), new Set())).toEqual([])
    expect(folderInstructions(join(root, "apps"), join(root, "README.md"), new Set())).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

async function exec(readTarget: string) {
  const seen: string[] = []
  const replies = [`نفّذ: read ${readTarget}`, "done."]
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const content = replies[Math.min(seen.length, replies.length - 1)]!
    const payload = await request.json() as { stream?: boolean; messages?: unknown[] }
    seen.push(JSON.stringify(payload.messages ?? []))
    if (payload.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const project = tree()
  const home = mkdtempSync(join(tmpdir(), "abdo-folder-home-")), settings = join(home, "settings.json")
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "read-only", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "exec", "Look at the page", "--json", "--quiet", "--project", project, "--mode", "read-only"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "2" },
    stdout: "pipe", stderr: "pipe",
  })
  const [, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  server.stop(true)
  rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true })
  return { all: seen.join("\n"), stderr }
}

test("live: reading a file under apps/web brings apps/web/AGENTS.md to the model with that result", async () => {
  const r = await exec("apps/web/src/page.tsx")
  expect(r.all, r.stderr.slice(-600)).toContain("export default function Page")
  expect(r.all).toContain("📌 تعليماتُ المجلّد «apps/web/AGENTS.md»")
  expect(r.all).toContain("NEXT-RULES-2200")
}, 120_000)

test("live, the twin: a root-level read brings no folder layer", async () => {
  const r = await exec("README.md")
  expect(r.all, r.stderr.slice(-600)).toContain("# root")
  expect(r.all).not.toContain("📌 تعليماتُ المجلّد")
  expect(r.all).not.toContain("NEXT-RULES-2200")
}, 120_000)
