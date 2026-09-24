/**
 * س0 · جردُ `mind/flow.ts` — وهو **أهمُّ الثلاثة للخطّة**.
 *
 * أخطرُ فخٍّ في ممارسات الرسوم البيانيّة 2026: «العقدةُ تُعاد من أوّلها عند الاستئناف،
 * فلا أثرَ جانبيّاً قبل المقاطعة». وجوابُه مكتوبٌ هنا منذ زمن:
 *
 *   إيصالٌ مكتملٌ ببصمةٍ مطابقة ⇦ **يُتخطّى** (إعادتُه هي الكتابةُ المزدوجة)
 *   خطوةٌ مغيِّرةٌ نتيجتُها **مجهولة** ⇦ **تُردّ إلى المصالحة، ولا تُعاد على أمل**
 *   قراءةٌ مجهولةُ النتيجة ⇦ تُعاد (القراءةُ مرّتين هي الصنفُ الرخيص من المجهول)
 *
 * مكتوبٌ، **وبلا اختبارٍ واحد** حتّى هذا الملفّ. فالخطّةُ التي تبني الاستئنافَ عليه
 * كانت تبني على وعد. هذه مساميرُ توصيف: تُشغّل القواعدَ الخمس وتقيس ما تفعله.
 */
import { describe, expect, test } from "bun:test"
import { build, rerun, STEP_LIMIT, validateManifest, type Flow, type Receipt, type SkillManifest } from "../src/mind/flow"

const NOW = 1_800_000_000_000

const manifest = (id: string, effect: SkillManifest["effect"], over: Partial<SkillManifest> = {}): SkillManifest => ({
  id, version: "1.0.0", digest: `d-${id}`, capabilities: ["fs.read"], effect, expiresAt: NOW + 86_400_000, ...over,
})

const registry = (...entries: SkillManifest[]) =>
  new Map(entries.map((m) => [`${m.id}@${m.version}`, m] as const))

const voucher = { vouched: () => true }
const noVoucher = { vouched: () => false }

const flow = (steps: Flow["steps"], over: Partial<Flow> = {}): Flow => ({
  id: "f1", steps, envelope: ["fs.read", "fs.write"], signers: ["owner"], ...over,
})

const step = (id: string, skillId: string, dependsOn: string[] = []) => ({ id, skillId, skillVersion: "1.0.0", dependsOn })

describe("س0 · flow.build — يُبنى كلُّه أو لا يُبنى (لا نصفُ تشغيل)", () => {
  const reg = registry(manifest("read", "read"), manifest("write", "mutate", { capabilities: ["fs.write"] }))

  test("التدفّقُ السليم يُبنى ويعيد ترتيباً (التوأمُ الإيجابيّ)", () => {
    const v = build(flow([step("s1", "read"), step("s2", "write", ["s1"])]), reg, voucher, NOW)
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.order).toEqual(["s1", "s2"])
  })

  test("الفارغُ يُرفض، والمتجاوزُ للسقف يُرفض بذكر الرقم", () => {
    expect(build(flow([]), reg, voucher, NOW).ok).toBe(false)
    const many = Array.from({ length: STEP_LIMIT + 1 }, (_, i) => step(`s${i}`, "read"))
    const big = build(flow(many), reg, voucher, NOW)
    expect(big.ok).toBe(false)
    if (!big.ok) expect(big.why).toContain(String(STEP_LIMIT))
  })

  test("الدورةُ تُرفض — عبر مدقّق S132 نفسِه لا بمدقّقٍ ثانٍ", () => {
    const cyc = build(flow([step("a", "read", ["b"]), step("b", "read", ["a"])]), reg, voucher, NOW)
    expect(cyc.ok).toBe(false)
    if (!cyc.ok) expect(cyc.why).toContain("->")
  })

  test("مهارةٌ منتهية، أو خارج الغلاف، أو بلا توقيع — كلُّها تُرفض قبل أن يجري شيء", () => {
    const expired = registry(manifest("read", "read", { expiresAt: NOW - 1 }))
    expect(build(flow([step("s1", "read")]), expired, voucher, NOW).ok).toBe(false)

    const outside = registry(manifest("read", "read", { capabilities: ["net.any"] }))
    expect(build(flow([step("s1", "read")]), outside, voucher, NOW).ok).toBe(false)

    expect(build(flow([step("s1", "read")]), reg, noVoucher, NOW).ok).toBe(false)

    // ومهارةٌ ليست في السجلّ أصلاً: الغيابُ رفضٌ لا إذن.
    expect(build(flow([step("s1", "ghost")]), reg, voucher, NOW).ok).toBe(false)
  })
})

describe("🔑 س0 · flow.rerun — قاعدةُ الانهيار التي تبني عليها خطّةُ الاستئناف", () => {
  const reg = registry(manifest("read", "read"), manifest("write", "mutate", { capabilities: ["fs.write"] }), manifest("pay", "spend", { capabilities: ["fs.write"] }))
  const f = flow([step("s1", "read"), step("s2", "write", ["s1"]), step("s3", "read", ["s2"])])
  const order = ["s1", "s2", "s3"]
  const receipt = (stepId: string, skillId: string, state: Receipt["state"]): Receipt => ({ stepId, skillDigest: `d-${skillId}`, state })
  const kindOf = (r: ReturnType<typeof rerun>, id: string) => r.dispositions.find((d) => d.stepId === id)?.kind

  test("إيصالٌ مكتملٌ ببصمةٍ مطابقة ⇦ يُتخطّى — إعادتُه هي الكتابةُ المزدوجة", () => {
    const r = rerun(f, order, reg, [receipt("s1", "read", "done"), receipt("s2", "write", "done"), receipt("s3", "read", "done")])
    expect(r.skips).toBe(3)
    expect(r.runs).toBe(0)
    expect(r.refusals).toBe(0)
  })

  test("🔑 خطوةٌ مغيِّرةٌ نتيجتُها مجهولة ⇦ **تُردّ إلى المصالحة** ولا تُعاد على أمل", () => {
    const r = rerun(f, order, reg, [receipt("s1", "read", "done"), receipt("s2", "write", "unknown")])
    expect(kindOf(r, "s2")).toBe("refuse")
    const why = r.dispositions.find((d) => d.stepId === "s2")
    if (why?.kind === "refuse") expect(why.why).toContain("reconciliation")
    // والإنفاقُ مثلُ التغيير — لا يُعاد على أمل.
    const g = flow([step("p1", "pay")])
    const rp = rerun(g, ["p1"], reg, [receipt("p1", "pay", "unknown")])
    expect(rp.refusals).toBe(1)
  })

  test("التوأمُ الإيجابيّ: قراءةٌ مجهولةُ النتيجة **تُعاد** — القاعدةُ ليست «ارفض كلَّ مجهول»", () => {
    const r = rerun(f, order, reg, [receipt("s1", "read", "unknown")])
    expect(kindOf(r, "s1")).toBe("run")
    expect(r.refusals).toBe(0)
  })

  test("إيصالٌ ببصمةٍ أخرى ليس إيصالاً — يُعاد هو وكلُّ ما بعده", () => {
    const r = rerun(f, order, reg, [
      { stepId: "s1", skillDigest: "d-OTHER", state: "done" },
      receipt("s2", "write", "done"),
      receipt("s3", "read", "done"),
    ])
    expect(kindOf(r, "s1")).toBe("run")
    expect(kindOf(r, "s2")).toBe("run")   // إبطالٌ متعدٍّ
    expect(kindOf(r, "s3")).toBe("run")
    expect(r.skips).toBe(0)
  })

  test("بلا إيصالٍ ⇦ يُشغَّل، والإبطالُ يسري إلى ما بعده", () => {
    const r = rerun(f, order, reg, [])
    expect(r.runs).toBe(3)
  })

  test("والردُّ يُبطِل ما بعده أيضاً: خطوةٌ خلف مصالحةٍ لا تُتخطّى بإيصالها القديم", () => {
    const r = rerun(f, order, reg, [receipt("s1", "read", "done"), receipt("s2", "write", "unknown"), receipt("s3", "read", "done")])
    expect(kindOf(r, "s2")).toBe("refuse")
    expect(kindOf(r, "s3")).toBe("run")
  })
})

describe("س0 · flow.validateManifest — البيانُ يُفحص لا يُصدَّق", () => {
  test("البيانُ السليم يمرّ (التوأمُ الإيجابيّ)", () => {
    const v = validateManifest({ id: "a", version: "1.0.0", digest: "d", capabilities: ["fs.read"], effect: "read", expiresAt: NOW })
    expect(v.ok).toBe(true)
  })

  test("حقلٌ زائدٌ أو ناقصٌ أو أثرٌ مجهول يُرفض", () => {
    expect(validateManifest({ id: "a", version: "1.0.0", digest: "d", capabilities: [], effect: "read", expiresAt: NOW, extra: 1 }).ok).toBe(false)
    expect(validateManifest({ id: "a", version: "1.0.0", digest: "d", capabilities: [] }).ok).toBe(false)
    expect(validateManifest({ id: "a", version: "1.0.0", digest: "d", capabilities: [], effect: "explode", expiresAt: NOW }).ok).toBe(false)
  })
})
