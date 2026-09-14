import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// ذ6 — الدفترُ التجاريّ على المحرّك الحقيقيّ: يُحسب من **العدّاد نفسِه** (لا ملفَّ ثانٍ ولا نداءَ إضافيّ) ويصل مع ملخّصه.
// ثلاثُ حالات: بلا خطّةٍ «غير مضبوط» فلا رقمَ يُخترع؛ وبأسعارٍ كاملةٍ الأربعةُ بالهللات؛ وبسعرٍ ناقصٍ لنموذجٍ استُعمل
// **يمتنع البيع** بالاسم — وهو التوأمُ الذي يمنع بيعاً بسعرٍ مخمَّن.

const ROOT = resolve(import.meta.dir, "../../..")

async function meter(settingsPatch: Record<string, unknown>): Promise<any> {
  const base = mkdtempSync(join(tmpdir(), "abdo-ledger-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(project, { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0" }))
  // عدّادٌ فيه نداءان على نموذجين — عينُ ما تكتبه `recordMeterEntry` في الحياة.
  const meterPath = join(base, "usage-meter.jsonl")
  writeFileSync(meterPath, [
    JSON.stringify({ at: new Date().toISOString(), provider: "cloud", model: "big", local: false, ms: 900, chargedInputTokens: 40_000, chargedOutputTokens: 20_000 }),
    JSON.stringify({ at: new Date().toISOString(), provider: "cloud", model: "small", local: false, ms: 400, chargedInputTokens: 30_000, chargedOutputTokens: 10_000 }),
  ].join("\n") + "\n")
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "read-only", project, routerGate: "off", ...settingsPatch }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), ABDO_USAGE_METER: meterPath, USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 60_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-1500)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "meter-get", requestId: "led-1" })
    await wait(() => frames.some((f) => f.kind === "meter-summary"))
    return frames.find((f) => f.kind === "meter-summary").summary
  } finally { child.kill(); await child.exited; await errors; for (let i = 0; i < 20; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } } }
}

test.skipIf(process.platform !== "win32")("the ledger rides the meter: unset says so, full prices give the four numbers in halalas, and a missing buy price refuses to sell by name", async () => {
  // (أ) بلا خطّةٍ ولا أسعار: «غير مضبوط» — ولا رقمَ يُخترع
  const unset = await meter({})
  expect(unset.status).toBe("available")
  expect(unset.ledger).toEqual({ state: "unset" })

  // (ب) أسعارٌ كاملةٌ وخطّة: الأربعةُ بالهللات (شراء 42+7=49، بيع 100k×2000/1e6=200، هامش 151)
  const priced = await meter({
    priceTable: [
      { ref: "cloud/big", buyInPerMillion: 300, buyOutPerMillion: 1500 },
      { ref: "cloud/small", buyInPerMillion: 100, buyOutPerMillion: 400 },
    ],
    sellPlan: { id: "pro", sellPerMillion: 2000, quotaHalalas: 5000 },
  })
  expect(priced.ledger.state).toBe("ok")
  expect(priced.ledger).toMatchObject({ buyHalalas: 49, sellHalalas: 200, marginHalalas: 151, tokens: 100_000, quota: "مفتوحة" })

  // (ج) سعرُ نموذجٍ استُعمل ناقص ⇒ يمتنع البيع بالاسم، ولا مبلغَ في الردّ
  const missing = await meter({
    priceTable: [{ ref: "cloud/big", buyInPerMillion: 300, buyOutPerMillion: 1500 }],
    sellPlan: { id: "pro", sellPerMillion: 2000 },
  })
  expect(missing.ledger.state).toBe("unavailable")
  expect(missing.ledger.why).toContain("cloud/small")
  expect(JSON.stringify(missing.ledger)).not.toMatch(/buyHalalas|sellHalalas/u)

  // (د) الحصّة: سقفٌ أدنى من البيع ⇒ رسالةٌ لا خطأ، والملخّصُ ما زال متاحاً
  const ceiling = await meter({
    priceTable: [
      { ref: "cloud/big", buyInPerMillion: 300, buyOutPerMillion: 1500 },
      { ref: "cloud/small", buyInPerMillion: 100, buyOutPerMillion: 400 },
    ],
    sellPlan: { id: "trial", sellPerMillion: 2000, quotaHalalas: 100 },
  })
  expect(ceiling.status).toBe("available")
  expect(ceiling.ledger.quota).toContain("الدورُ الجاري يكتمل")
}, 240_000)
