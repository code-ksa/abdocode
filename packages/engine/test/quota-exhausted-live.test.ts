/**
 * نفادُ الرصيد ليس ازدحاماً — على المسار الحقيقيّ (حلقةُ الإعادة في المحرّك عبر exec). مقيس 2026-09-25: z.ai ردّ 429 برسالة
 * «Insufficient balance» فأعاد المحرّكُ سبعَ مرّاتٍ (~2.5 دقيقة) تحت «مزدحم». الآن: طلبٌ واحد، والسببُ يُقال.
 * والتوأم: 429 بلا كلمات النفاد يُعاد كما كان (ازدحامٌ حقيقيّ).
 */
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { stripChildEnv } from "../../tools/src/env-strip"

async function run(body: string) {
  let requests = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests += 1
    return new Response(body, { status: 429, headers: { "content-type": "application/json" } })
  } })
  const home = mkdtempSync(join(tmpdir(), "abdo-quota-")), project = join(home, "proj"), settings = join(home, "settings.json")
  mkdirSync(project, { recursive: true })
  writeFileSync(settings, JSON.stringify({
    language: "en", mode: "auto", modelRole: "agent", routerGate: "off", project, railPolicy: "thin", workMode: "basic",
    agentModel: "fx/model", chatModel: "fx/model",
    plugins: { projectAwareness: false, sessionAwareness: false, generalAwareness: false, verifier: false, reviewer: false, delegation: false, inventory: false },
    superAbdo: { enabled: false, inspectEnvironment: false, isolateChanges: false, verifyResults: false, independentReview: false, maxRepairPasses: 0 },
    customProviders: [{ id: "fx", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }],
  }))
  const t0 = Date.now()
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "exec", "say hi", "--json", "--quiet", "--project", project, "--no-extensions"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...stripChildEnv(process.env).env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), USERPROFILE: home, HOME: home, ABDO_VAULT_HOME: home, ABDO_MAX_AGENT_EPOCHS: "2", ABDO_MODEL_RETRY_FAST: "1" },
    stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
  return { requests, stdout, stderr, ms: Date.now() - t0 }
}

test("an exhausted balance is asked once and said as such — not retried as 'busy'", async () => {
  const r = await run('{"code":"1113","message":"Insufficient balance or no resource package. Please recharge."}')
  expect(r.requests, r.stderr.slice(-800)).toBe(1)
  expect(`${r.stdout}\n${r.stderr}`).toMatch(/quota exhausted|balance or quota/iu)
  expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/attempt 2\//u)
}, 120_000)

test("the twin: a plain 429 (busy) is still retried", async () => {
  const r = await run('{"error":"Too Many Requests"}')
  expect(r.requests, r.stderr.slice(-800)).toBeGreaterThan(1)
}, 180_000)
