import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { probeProvider, type ProbeDeps, type ProbeProvider } from "../src/provider-probe"

// البند 13 من جرد هيرمس/أوبن‑كلاو — «المفتاحُ لا يُحفظ بل يُقاس» (2026-09-27).

const QWEN: ProbeProvider = { id: "qwen-token-plan", local: false, models: ["qwen3.7-plus", "qwen3.7-max"], vaultKey: "abdocode-qwen-token-plan" }
const deps = (status: number | Error, hasKey = true, sent: string[] = []): ProbeDeps => ({
  provider: (id) => (id === QWEN.id ? QWEN : id === "ollama" ? { id: "ollama", local: true, models: ["qwen3"] } : undefined),
  hasKey: async () => hasKey,
  send: async (_provider, model) => { sent.push(model); if (status instanceof Error) throw status; return { status } },
  now: (() => { let t = 1000; return () => (t += 5) })(),
})

test("every outcome has a named verdict, and a missing key sends nothing", async () => {
  expect(await probeProvider("qwen-token-plan", deps(200))).toMatchObject({ ok: true, verdict: "ok", model: "qwen3.7-plus", status: 200 })
  expect(await probeProvider("qwen-token-plan", deps(401))).toMatchObject({ ok: false, verdict: "credential", status: 401 })
  expect(await probeProvider("qwen-token-plan", deps(403))).toMatchObject({ ok: false, verdict: "credential" })
  expect(await probeProvider("qwen-token-plan", deps(429))).toMatchObject({ ok: false, verdict: "rate-limited", status: 429 })
  expect(await probeProvider("qwen-token-plan", deps(503))).toMatchObject({ ok: false, verdict: "provider-unavailable" })
  expect((await probeProvider("qwen-token-plan", deps(new Error("socket hang up")))).verdict).toBe("transport")
  const sent: string[] = []
  expect(await probeProvider("qwen-token-plan", deps(200, false, sent))).toMatchObject({ ok: false, verdict: "no-key" })
  expect(sent).toEqual([])
  expect((await probeProvider("ollama", deps(200))).verdict).toBe("local")
  expect((await probeProvider("ghost", deps(200))).verdict).toBe("unknown-provider")
  // النموذجُ الذي اختاره المشغّل يُسبر إن كان من المزوّد، وإلّا أوّلُ نماذجه — لا مرجعٌ مخترَع.
  const chosen: string[] = []
  await probeProvider("qwen-token-plan", deps(200, true, chosen), "qwen3.7-max")
  await probeProvider("qwen-token-plan", deps(200, true, chosen), "not-a-qwen-model")
  expect(chosen).toEqual(["qwen3.7-max", "qwen3.7-plus"])
})

test("the real engine answers an explicit probe always, and an automatic one only when plugins.providerProbe is on", async () => {
  for (const pluginOn of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), "abdo-provider-probe-"))
    const vault = join(home, "abdocode", "vault")
    mkdirSync(vault, { recursive: true })
    writeFileSync(join(vault, "abdocode-qwen-token-plan.sec"), "dpapi-v1:not-read-here")
    const settings = join(home, "settings.json")
    // 2026-09-28: المسبارُ التلقائيّ مفعَّلٌ افتراضاً، فالحالةُ المطفأة تُكتب صراحةً — لا بغياب المفتاح.
    writeFileSync(settings, JSON.stringify({ language: "en", mode: "read-only", plugins: { providerProbe: pluginOn } }))
    // Only the network effect is replaced in this isolated child: no key, host or provider is contacted.
    const preload = join(home, "fake-reach.ts")
    const calls = join(home, "calls.jsonl")
    writeFileSync(preload, `import { RustReachEffects } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../src/provider-effects.ts")).href)};
import { appendFileSync } from 'node:fs';
RustReachEffects.prototype.model = async function (request) {
  appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ provider: request.provider, url: request.url, maxTokens: JSON.parse(request.body).max_tokens ?? JSON.parse(request.body).max_completion_tokens }) + '\\n');
  return { status: 401, body: '{"error":{"message":"Incorrect API key provided"}}' };
};`)
    const env: Record<string, string | undefined> = { ...process.env, APPDATA: home, ABDO_VAULT_HOME: join(home, "abdocode"), USERPROFILE: home, HOME: home }
    delete env.ABDO_VAULT_SCRIPT
    delete env.ABDO_VAULT_DIR
    const child = Bun.spawn([process.execPath, "--preload", preload, "packages/engine/src/cli.ts", "serve"], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...env, ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: join(home, "state"), ABDO_SHELL_TOKEN: "probe-test", ABDO_FRAMED_STDIO: "1" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text(), decoder = new LocalJsonFrameDecoder(), frames: Record<string, any>[] = []
    const reading = (async () => { for await (const chunk of child.stdout) for (const frame of decoder.push(chunk)) frames.push(frame as Record<string, any>) })()
    const wait = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 15000
      while (!predicate()) { if (Date.now() > deadline) throw Error("Timed out: " + label); await Bun.sleep(10) }
    }
    const send = async (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
    const probes = () => frames.filter((f) => f.kind === "provider-probe")
    try {
      await send({ kind: "hello", shell: "desktop", token: "probe-test" })
      await wait(() => frames.some((f) => f.kind === "ready"), "ready")
      // تلقائيٌّ بعد الحفظ: يحترم المفتاح.
      await send({ kind: "provider-probe", provider: "qwen-token-plan", auto: true })
      if (pluginOn) await wait(() => probes().length === 1, "automatic probe with the key on")
      else { await Bun.sleep(1500); expect(probes()).toHaveLength(0) }
      // صريحٌ بضغطة: يُجاب دائماً، بسببٍ مسمّى ورمزِه، بلا جسد المزوّد.
      await send({ kind: "provider-probe", provider: "qwen-token-plan", model: "qwen3.7-plus" })
      await wait(() => probes().length === (pluginOn ? 2 : 1), "explicit probe")
      const verdict = probes().at(-1)!
      expect(verdict).toMatchObject({ kind: "provider-probe", provider: "qwen-token-plan", model: "qwen3.7-plus", ok: false, verdict: "credential", status: 401 })
      expect(JSON.stringify(frames)).not.toContain("Incorrect API key provided")
      const sentCalls = (await Bun.file(calls).text()).trim().split("\n").map((line) => JSON.parse(line))
      expect(sentCalls).toHaveLength(pluginOn ? 2 : 1)
      expect(sentCalls[0]).toMatchObject({ provider: "qwen-token-plan", maxTokens: 16 })
      // حقلٌ مجهولٌ أو مزوّدٌ بصيغةٍ خارج النمط يُرفض بالعقد لا يصل النداء.
      await send({ kind: "provider-probe", provider: "../qwen" })
      await wait(() => frames.some((f) => f.kind === "refused"), "invalid provider refused")
    } finally {
      child.kill()
      await child.exited
      await reading
      await stderr
      rmSync(home, { recursive: true, force: true })
    }
  }
}, 60000)
