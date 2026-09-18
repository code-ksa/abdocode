import { describe, expect, test } from "bun:test"
import { ProductTools } from "@abdo/tools"
import { buildAgentCatalogue, BUILTIN_AGENT_FILES, findAgent } from "../src/agent-definitions"
import { childToolRefusal } from "../src/delegation"
import { describeWorkProfile, isWorkMode, superAbdoUnderWorkMode, TEAM_TOOL, WORK_MODES, workProfile } from "../src/work-mode"

describe("هـ2 — سلّمُ الأوضاع ", () => {
  test("الأربعةُ بالترتيب، والمجهولُ أساسيّ لا ترخّص", () => {
    expect(WORK_MODES).toEqual(["basic", "strong", "stronger", "max"])
    expect(workProfile(undefined).mode).toBe("basic")
    expect(workProfile("ultra").mode).toBe("basic")
    expect(workProfile(42).mode).toBe("basic")
    expect(workProfile(undefined).reason).toContain("الافتراضيّ")
    expect(isWorkMode("max")).toBe(true); expect(isWorkMode("ultra")).toBe(false)
  })

  test("كلُّ درجةٍ تزيد على ما قبلها ولا تنقص — وأوّلُ وكيلٍ في أيّ وضعٍ فوق الأساسيّ هو الموجِّه", () => {
    const [basic, strong, stronger, max] = WORK_MODES.map((m) => workProfile(m))
    expect(basic!.orientationAgent).toBe(false); expect(basic!.parallelAgents).toBe(0); expect(basic!.independentReview).toBe(false)
    expect(strong!.orientationAgent).toBe(true); expect(strong!.parallelAgents).toBe(0); expect(strong!.independentReview).toBe(true)
    expect(stronger!.orientationAgent).toBe(true); expect(stronger!.parallelAgents).toBe(4)
    expect(max!.parallelAgents).toBeGreaterThan(stronger!.parallelAgents)
    expect(max!.adversarialRefute).toBe(true)
  })

  test("الوصفُ يقول ما يجري فعلاً: «أقصى» صار يفنّد عدائيّاً (هـ3) فلم يبقَ في وصفه وعدٌ غير مبنيّ", () => {
    expect(describeWorkProfile(workProfile("max"))).toContain("تفنيدٌ عدائيّ بثلاث عدسات")
    for (const mode of WORK_MODES) expect(describeWorkProfile(workProfile(mode))).not.toContain("غير مبنيّ")
    expect(describeWorkProfile(workProfile("basic"))).toContain("وكيلٌ واحد")
    expect(describeWorkProfile(workProfile("stronger"))).toContain("حتى 4")
  })

  test("احتواءُ الطفل: لا يفوّض فردياً، ولا يفرّق فريقاً إلا قارئٌ أعلنه (09-16)، ولا يمسّ لوحَ الخطّة، وسقفُ أدواته يمنع ما لم يعلنه", () => {
    const catalogue = buildAgentCatalogue([...BUILTIN_AGENT_FILES])
    const planner = findAgent(catalogue, "planner")!
    // التوأمُ الوحدويّ لاختبار الفريق الحيّ: الحارسُ نفسُه يمنع الكتابةَ عن وكيلٍ لا يعلنها (الحلقةُ تُسقطها قبل التوزيع فلا تظهر رفضاً).
    expect(childToolRefusal(planner, "write", 1)).toContain("لا يعلنها في سقفه")
    expect(childToolRefusal(planner, "delegate", 1)).toContain("لا يفوّض")
    // team لقارئٍ لم يعلنها (recaller): الغيابُ رفضٌ لا إذن؛ ولكاتبٍ أعلنها: القارئ وحده يوازي؛ وplanner يعلنها فيمرّ.
    expect(childToolRefusal(findAgent(catalogue, "recaller")!, TEAM_TOOL, 1)).toContain("لا يعلنها في سقفه")
    expect(childToolRefusal(planner, TEAM_TOOL, 1)).toBeUndefined()
    const builder = findAgent(catalogue, "builder")!
    expect(childToolRefusal({ ...builder, tools: [...builder.tools, TEAM_TOOL], callable: new Set([...builder.callable, TEAM_TOOL]) }, TEAM_TOOL, 1)).toContain("القارئ وحده")
    expect(childToolRefusal(planner, "plan", 1)).toContain("لوحُ الخطّة ملكُ الدور")
    // والإيجابيّ: ما أعلنه سقفُه يمرّ
    for (const word of planner.tools) expect(childToolRefusal(planner, word, 1)).toBeUndefined()
  })

  test("إيقافُ تشغيلٍ خلفيّ أثرٌ لا قراءة — وإلا صار وكيلُ «قراءةٍ فقط» يقتل عمليّات الدور", () => {
    expect(ProductTools.tool("stop")!.effect).toBe("command")
    expect(ProductTools.tool("logs")!.effect).toBe("read")
    // وأداةُ الفريق تُعلَن بأثرِ قراءةٍ لأنّ أثرَها الحقيقيّ يقع في أدوات أطفالها، كلٌّ ببوّابته
    expect(ProductTools.tool(TEAM_TOOL)!.effect).toBe("read")
  })

  test("Super Abdo تحت الوضع: يُفعَّل التحقّقُ والمراجعة في القويّة، ولا يُطفأ ما فعّله المستخدم في الأساسيّ", () => {
    const off = Object.freeze({ enabled: false, inspectEnvironment: true, isolateChanges: true, verifyResults: false, independentReview: false, maxRepairPasses: 2 })
    const on = Object.freeze({ ...off, enabled: true, verifyResults: true, independentReview: true })
    expect(superAbdoUnderWorkMode(off, workProfile("basic"))).toBe(off)
    expect(superAbdoUnderWorkMode(on, workProfile("basic"))).toBe(on)
    const strong = superAbdoUnderWorkMode(off, workProfile("strong"))
    expect(strong.enabled && strong.verifyResults && strong.independentReview).toBe(true)
    expect(strong.maxRepairPasses).toBe(2)
  })
})
