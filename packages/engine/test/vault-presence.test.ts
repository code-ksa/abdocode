import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { ensureShippedVault, shippedVaultPresence } from "../src/vault"

// حضورُ المفاتيح في الخزنة المشحونة يُقرأ من ملفّها — والعطلُ الذي أوجبه (2026-09-27):
// قائمةُ النماذج وحالةُ الخزنة كانتا تنتظران ~7.5 ثانية، PowerShell لكلّ مزوّد.

const WORKER = resolve(import.meta.dir, "../../kernel/target/release/abdo-tool-worker.exe")

test("shipped vault presence answers from the store the worker reads, and refuses to guess an owner vault", () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-vault-presence-"))
  try {
    const env = { ABDO_VAULT_HOME: home }
    const located = ensureShippedVault(env)
    if ("refusal" in located) throw Error(located.refusal)
    mkdirSync(located.store, { recursive: true })
    writeFileSync(join(located.store, "abdocode-qwen-token-plan.sec"), "dpapi-v1:not-read-here")
    const presence = shippedVaultPresence(["abdocode-qwen-token-plan", "abdocode-deepseek", "../escape", "ABDOCODE-QWEN-TOKEN-PLAN"], env)
    expect(presence).toBeDefined()
    expect([...presence!]).toEqual([
      ["abdocode-qwen-token-plan", true],
      ["abdocode-deepseek", false],
      ["../escape", false],
      ["ABDOCODE-QWEN-TOKEN-PLAN", false],
    ])
    // المحرّكُ يُعلن المشحونَ في ABDO_VAULT_SCRIPT لعامله: ما زال مشحوناً، ويُجاب من الملفّ.
    expect(shippedVaultPresence(["abdocode-qwen-token-plan"], { ...env, ABDO_VAULT_SCRIPT: located.script, ABDO_VAULT_DIR: located.store })?.get("abdocode-qwen-token-plan")).toBe(true)
    // وABDO_VAULT_DIR الصريح هو ما يقرؤه السكربت — لا جذرُ البيت.
    const elsewhere = join(home, "elsewhere")
    mkdirSync(elsewhere)
    expect(shippedVaultPresence(["abdocode-qwen-token-plan"], { ...env, ABDO_VAULT_DIR: elsewhere })?.get("abdocode-qwen-token-plan")).toBe(false)
    // خزنةُ المالك الحقّة: لا يُفترض شكلُها.
    const owner = join(home, "owner.ps1")
    writeFileSync(owner, "exit 1\r\n")
    expect(shippedVaultPresence(["abdocode-qwen-token-plan"], { ...env, ABDO_VAULT_SCRIPT: owner })).toBeUndefined()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the real engine reports a stored key in the models menu and vault status without a worker per provider, agreeing with the worker", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-vault-presence-live-"))
  const vault = join(home, "abdocode", "vault")
  mkdirSync(vault, { recursive: true })
  writeFileSync(join(vault, "abdocode-qwen-token-plan.sec"), "dpapi-v1:not-read-here")
  const settings = join(home, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "en", mode: "read-only" }))
  const env = { ...process.env, APPDATA: home, ABDO_VAULT_HOME: join(home, "abdocode"), USERPROFILE: home, HOME: home }
  delete env.ABDO_VAULT_SCRIPT
  delete env.ABDO_VAULT_DIR
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "vault-presence-test", ABDO_FRAMED_STDIO: "1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder(), frames: Record<string, any>[] = []
  const reading = (async () => { for await (const chunk of child.stdout) for (const frame of decoder.push(chunk)) frames.push(frame as Record<string, any>) })()
  const wait = async (predicate: () => boolean, label: string, ms: number) => {
    const deadline = Date.now() + ms
    while (!predicate()) {
      if (Date.now() > deadline) throw Error("Timed out: " + label)
      await Bun.sleep(5)
    }
  }
  const send = async (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
  try {
    await send({ kind: "hello", shell: "desktop", token: "vault-presence-test" })
    await wait(() => frames.some(f => f.kind === "ready"), "ready", 15000)
    let started = performance.now()
    await send({ kind: "models" })
    await wait(() => frames.some(f => f.kind === "models"), "models", 5000)
    const modelsMs = performance.now() - started
    started = performance.now()
    await send({ kind: "vault-status" })
    await wait(() => frames.some(f => f.kind === "vault-status"), "vault-status", 5000)
    const statusMs = performance.now() - started
    const groups = frames.find(f => f.kind === "models")!.groups as { provider: string; hasKey: boolean }[]
    const status = frames.find(f => f.kind === "vault-status")!.status as { provider: string; hasKey: boolean }[]
    // التوأمُ الإيجابيّ: المفتاحُ المخزَّن يُرى، والغائبُ لا.
    expect(groups.find(g => g.provider === "qwen-token-plan")?.hasKey).toBe(true)
    expect(status.find(r => r.provider === "qwen-token-plan")?.hasKey).toBe(true)
    expect(status.filter(r => r.hasKey).map(r => r.provider)).toEqual(["qwen-token-plan"])
    // كان ~7.5 ثانية لكلٍّ منهما على هذا الجهاز؛ السقفُ هنا يمسك عودةَ PowerShell لكلّ مزوّد.
    expect(modelsMs).toBeLessThan(2500)
    expect(statusMs).toBeLessThan(1500)
    // والجوابُ نفسُه من العامل الحقيقيّ بعقد الخزنة المشحونة — لا حكمان يفترقان.
    if (await Bun.file(WORKER).exists()) {
      for (const provider of ["qwen-token-plan", "deepseek"]) {
        const run = Bun.spawn([WORKER, "provider-has", provider], {
          env: { ...env, ABDO_VAULT_SCRIPT: join(home, "abdocode", "vault.ps1"), ABDO_VAULT_DIR: vault },
          stdout: "pipe", stderr: "pipe",
        })
        const answer = await new Response(run.stdout).text()
        expect(await run.exited).toBe(0)
        expect(answer === "1").toBe(status.find(r => r.provider === provider)!.hasKey)
      }
    }
  } finally {
    child.kill()
    await child.exited
    await reading
    await stderr
    rmSync(home, { recursive: true, force: true })
  }
}, 40000)
