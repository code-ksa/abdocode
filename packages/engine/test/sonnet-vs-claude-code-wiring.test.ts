import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Providers } from "@abdo/providers"
import { hasDeclaredImageInput } from "../../providers/src/images"
import { cacheDiscountFor } from "../src/token-budget"

// 10-14 — مقارنةٌ مع Claude Code بالنموذج نفسِه على المهمّة نفسِها، ثمّ إصلاحُ ما يجعل عبدو كود أبطأ أو أغلى.
// المهمّةُ m11 والحَكَمُ judge11 (16 بنداً) والنموذجُ claude-sonnet-5-5 لكليهما. المقيس (ث، نداءات، $ بسعر القائمة):
//   Claude Code                      16/16  215 ث  18 نداءً (22 أداة)  خبيئة 95٪   $0.57
//   عبدو كود قبل (نصّيّ، بلا خبيئة)   16/16  602 ث  63 نداءً            خبيئة 0٪    $5.61
//   + أدواتٌ أصليّة وخبيئة            16/16  556 ث  37                   90٪        $1.04
//   + طابورُ النداءات وgit-stage      16/16  385 ث  34 (بلا موجِّه)      92٪        $0.87
//   + عقدُ النداءات المتعدّدة          16/16  329 ث  24 (35 أداة)          92٪        $0.80
// ORIENT_SKIP_MEASURED: الموجِّهُ على النموذج نفسِه كان 31–37 ث قراءةً ثانية؛ بلا موجِّه 385 ث/34 نداءً مقابل 535–556 ث/37–66 به.

const ROOT = resolve(import.meta.dir, "..", "..")
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/gu, "\n")
const cli = read("engine", "src", "cli.ts")

describe("Anthropic: الصور والسعر", () => {
  test("Claude 5 (sonnet/opus/haiku/fable) يقبل الصور كعائلة 4 — كان يُرفض «لا يقبل الصور»", () => {
    const anthropic = Providers.provider("anthropic")!
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5", "claude-fable-5-1", "claude-sonnet-4-5"]) expect(hasDeclaredImageInput(anthropic, model)).toBe(true)
    expect(hasDeclaredImageInput(anthropic, "claude-instant-1")).toBe(false)
  })
  test("قراءةُ الخبيئة عند Anthropic بعُشر السعر — لا الخصم العامّ 0.25", () => {
    const saved = process.env.ABDO_CLOUD_CACHE_DISCOUNT
    delete process.env.ABDO_CLOUD_CACHE_DISCOUNT
    try { expect(cacheDiscountFor("anthropic")).toBe(0.1) } finally { if (saved !== undefined) process.env.ABDO_CLOUD_CACHE_DISCOUNT = saved }
  })
})

describe("المراجِعُ السحابيّ يرى الدليلَ كاملاً", () => {
  test("إيصالُ 2000 حرف يدخل كاملاً بمعامل السحابيّ ويُقصّ بالميزانيّة المحلّيّة — كان README يُقصّ فيُحجب الاكتمال", async () => {
    const { buildVerifierPrompt, CLOUD_VERIFIER_SCALE } = await import("../src/semantic-verifier")
    const readme = Array.from({ length: 40 }, (_, i) => `سطر ${i}: بندٌ من العقد`).join("\n").padEnd(2000, ".")
    const receipts = [{ command: "read README.md", output: readme }]
    expect(CLOUD_VERIFIER_SCALE).toBe(4)
    expect(buildVerifierPrompt("g", "a", receipts, undefined, CLOUD_VERIFIER_SCALE)).not.toContain("حُذف")
    expect(buildVerifierPrompt("g", "a", receipts)).toContain("حُذف")
  })
  test("المحكّمُ السحابيّ يأخذ المعامل، والمحلّيُّ على ميزانيّته", () => {
    expect(cli).toContain("const verifierScale = Providers.provider(resolveDecisionModel(selectedModel).provider)?.local === false ? CLOUD_VERIFIER_SCALE : 1")
    expect((cli.match(/diskNow\(verifierScale\), verifierScale\)/gu) ?? []).length).toBe(3)
  })
})

describe("وقتٌ ونداءاتٌ كانت تُهدر", () => {
  test("الموجِّهُ يُتخطّى حين يكون على نموذج الدور نفسِه في العائلة المقيسة، ويبقى حين يكون أقدر", () => {
    expect(cli).toContain("const orientSelf = orientModel.ref === selectedModel.ref && ORIENT_SELF_SUFFICIENT_PROVIDERS.has(selectedModel.provider)")
    expect(cli).toContain("if (!orientSelf) try {")
    expect(cli).toContain('const ORIENT_SELF_SUFFICIENT_PROVIDERS: ReadonlySet<string> = new Set(["anthropic"])')
  })
  test("قشرةُ سطر الأوامر لا تنتظر متصفّحَ سطح مكتبٍ لا يأتي (عشر ثوانٍ قبل كلّ فتحٍ أوّل)", () => {
    expect(cli).toContain('for (let attempt = 0; attempt < (shellKind === "cli" ? 1 : 40); attempt++) {')
  })
  test("git-stage بعدّة مسارات نداءٌ واحد (كان يُعاد ملفّاً ملفّاً — 12 نداءً)، والمسارُ الموجود بمسافةٍ يبقى واحداً", () => {
    expect(cli).toContain("const paths = !/\\s/u.test(rest) || existsSync(resolve(PROJECT_DIR, rest)) ? [rest] : rest.split(/\\s+/u).filter((p) => p.length > 0)")
    expect(cli).toContain("for (const path of paths) staged.push(await runAdapterV(\"git-change\", \"git_change\", { action, path }")
  })
  test("«run … --bg» في آخر الأمر يُشغَّل خلفيّاً كما في أوّله — كان الخادمُ يبقى في المقدّمة حتى مهلة التشغيل", () => {
    expect(cli).toContain("const trailingBg = !/^--bg\\s+/u.test(effectiveRest) && /\\s--bg\\s*$/u.test(effectiveRest)")
    expect(cli).toContain("if (trailingBg) effectiveRest = `--bg ${effectiveRest.replace(/\\s--bg\\s*$/u, \"\").trim()}`")
    const trailing = /\s--bg\s*$/u
    expect(trailing.test("$env:PORT='3111'; npm start --bg")).toBe(true)
    expect(trailing.test("npm run build -- --bgcolor")).toBe(false)
  })
  test("بوّابةُ الاختبارات بعد إعلان الاكتمال: الخضراءُ تُبقي الإعلانَ بلا نداء نموذج (كالبناء والتدقيق) — ثلاثةُ مسارات", () => {
    expect(cli).toContain("pending = `run ${ownTestCommand}`\n            // 10-14".replace(/\n/gu, cli.includes("\r\n") ? "\r\n" : "\n"))
    const marked = cli.match(/pending = `run \$\{(?:ownTestCommand|verifyTestCommand)\}`\r?\n(?:\s+\/\/[^\n]*\r?\n)?\s+gateOnlyContinuation = true/gu) ?? []
    expect(marked).toHaveLength(3)
  })
  test("المحكّمُ الدلاليّ يُطلق مع المراجعة المستقلّة (المدخلُ نفسُه) ويُنتظر في موضعه — لا متتاليَين", () => {
    expect(cli).toContain("if (verifierOn && verifierRejections < 2) earlyVerdict = startVerifier()")
    expect(cli).toContain("if (earlyVerdict !== undefined) verdict = await earlyVerdict")
    expect(cli.indexOf("earlyVerdict = startVerifier()")).toBeLessThan(cli.indexOf("review = parseSuperAbdoReview(reply)"))
  })
  test("العاملُ المقيم يُسقط مفاتيحَه بعد حفظ مفتاحٍ (المسبار)، والمخبوءُ يُعاد قراءتُه بعد خمس دقائق (مفتاحٌ حُذف من عمليّةٍ أخرى)", () => {
    expect(cli).toContain("      REACH.resetTransport()\n".replace(/\n/gu, cli.includes("\r\n") ? "\r\n" : "\n"))
    expect(cli.indexOf("REACH.resetTransport()")).toBeGreaterThan(cli.indexOf('if (frame.kind === "provider-probe") {'))
    const rust = readFileSync(join(ROOT, "kernel", "bins", "abdo-tool-worker", "src", "provider.rs"), "utf8")
    expect(rust).toContain("const SECRET_TTL: std::time::Duration = std::time::Duration::from_secs(300);")
    expect(rust).toContain(".is_some_and(|(_, at)| at.elapsed() > SECRET_TTL)")
  })
  test("عقدُ النداءات المتعدّدة يُمرَّر للعائلة المقيسة وحدها", () => {
    expect(cli).toContain('multiCall: nativeTools && nativeMultiCall(selected.provider)')
  })
})
