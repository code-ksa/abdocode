import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

test("a blocked credential reader does not block real framed settings, usage or interrupt, and repeated requests coalesce", async () => {
  const home = mkdtempSync(join(tmpdir(), "abdo-vault-status-live-"))
  const settings = join(home, "settings.json"), released = join(home, "release"), probes = join(home, "probes.jsonl"), preload = join(home, "delay-vault.ts")
  writeFileSync(settings, JSON.stringify({ language: "en", mode: "read-only" }))
  // Replace only the credential-read dependency in this isolated child process.
  // No product test hook, real vault, secret, network call or fake frame handler.
  writeFileSync(preload, `import { RustReachEffects } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../src/provider-effects.ts")).href)};
import {appendFileSync,existsSync} from 'node:fs';
RustReachEffects.prototype.hasCredential=async function(provider){
 appendFileSync(${JSON.stringify(probes)},JSON.stringify(provider)+'\\n');
 while(!existsSync(${JSON.stringify(released)}))await Bun.sleep(10);
 if(provider==='openai')throw Error('DELAYED_VAULT_DIAGNOSTIC_MUST_NOT_ESCAPE');
 return provider==='deepseek';
};`)
  const child = Bun.spawn([process.execPath, "--preload", preload, "packages/engine/src/cli.ts", "serve"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "vault-status-test", ABDO_FRAMED_STDIO: "1", ABDO_VAULT_HOME: home, USERPROFILE: home, HOME: home },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder(), frames: Record<string, any>[] = []
  const reading = (async () => { for await (const chunk of child.stdout) for (const frame of decoder.push(chunk)) frames.push(frame as Record<string, any>) })()
  const wait = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 5000
    while (!predicate()) {
      if (Date.now() > deadline) throw Error("Timed out: " + label + "; frames=" + JSON.stringify(frames).slice(-1000))
      await Bun.sleep(10)
    }
  }
  const send = async (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
  try {
    await send({ kind: "hello", shell: "desktop", token: "vault-status-test" })
    await wait(() => frames.some(f => f.kind === "ready"), "ready")
    await send({ kind: "vault-status" })
    await wait(() => existsSync(probes), "credential reader entered")
    for (let i = 0; i < 25; i++) await send({ kind: "vault-status" })
    await send({ kind: "settings-get", requestId: "while-vault-blocked" })
    await send({ kind: "usage-get", requestId: "while-vault-blocked" })
    await send({ kind: "interrupt", turnId: "not-running" })
    await wait(() => frames.some(f => f.kind === "settings" && f.requestId === "while-vault-blocked"), "settings while credential probe blocked")
    await wait(() => frames.some(f => f.kind === "usage-summary" && f.requestId === "while-vault-blocked"), "usage while credential probe blocked")
    await wait(() => frames.some(f => f.kind === "refused"), "interrupt while credential probe blocked")
    expect(existsSync(released)).toBe(false)
    expect(readFileSync(probes, "utf8").trim().split("\n")).toHaveLength(1)
    expect(frames.filter(f => f.kind === "vault-status")).toHaveLength(0)
    writeFileSync(released, "release fixture read")
    await wait(() => frames.some(f => f.kind === "vault-status"), "credential snapshot")
    const snapshots = frames.filter(f => f.kind === "vault-status")
    expect(snapshots).toHaveLength(1)
    const status = snapshots[0]!.status as { provider: string; hasKey: boolean }[]
    expect(status.find(row => row.provider === "deepseek")).toEqual({ provider: "deepseek", hasKey: true })
    expect(status.find(row => row.provider === "openai")).toEqual({ provider: "openai", hasKey: false })
    const called = readFileSync(probes, "utf8").trim().split("\n").map(line => JSON.parse(line))
    expect(called).toEqual(status.map(row => row.provider))
    expect(new Set(called).size).toBe(called.length)
    expect(status.every(row => Object.keys(row).sort().join() === "hasKey,provider" && typeof row.hasKey === "boolean")).toBe(true)
    expect(JSON.stringify(frames)).not.toContain("DELAYED_VAULT_DIAGNOSTIC_MUST_NOT_ESCAPE")
  } finally {
    writeFileSync(released, "release fixture during cleanup")
    child.kill()
    await child.exited
    await reading
    await stderr
    rmSync(home, { recursive: true, force: true })
  }
}, 20000)
