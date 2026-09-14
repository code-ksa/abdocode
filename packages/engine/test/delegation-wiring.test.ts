/**
 * S13.5 — الوصل: الوحدات النقيّة خضراء لا يكفي.
 *
 * حزمةٌ نقيّةٌ غير موصولة بالحلقة ليست قدرةً حيّة (المسح 2026-09-02). هذا
 * الملفّ يثبت أن `cli.ts` يصل بها فعلاً: السجلّ الواحد يعلن الأداة، والمفتاحان
 * الميتان صار لهما قارئ، والسقف يقصّ الإعلان، والأدواتُ الخارجيّة تُعلَن،
 * ومسارُ التحرير النصّيّ يمرّ بوحدة التطابق وحدها.
 */
import { describe, expect, test } from "bun:test"
import { ProductTools } from "@abdo/tools"
import { PLUGINS, descriptorFor } from "../src/plugin-registry"
import { DELEGATE_TOOL, MAX_DELEGATION_DEPTH } from "../src/delegation"
import { AGENT_DIR } from "../src/agent-definitions"

const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
const externalSource = await Bun.file(new URL("../src/mind/external.ts", import.meta.url)).text()

describe("S13.5 — الأداة في السجلّ الواحد", () => {
  test("delegate معلَنةٌ بصنفها ومنفّذها، ويعلنها الكتالوج المحقون", () => {
    expect(ProductTools.tool(DELEGATE_TOOL)).toMatchObject({ name: "delegate", effect: "read", agentCallable: true, runner: "delegate" })
    expect(ProductTools.catalogue(false)).toContain("delegate <وكيل> :: <المهمّة>")
    expect(ProductTools.catalogue(true)).toContain("delegate <وكيل> :: <المهمّة>")
  })

  test("المُوزِّع يخدمها من المواصفة لا بتخمين الاسم، ومرّةً واحدة", () => {
    expect(source).toContain('case "delegate": {')
    // هـ2 (2026-09-07): ثلاثةُ أبوابٍ إلى الحلقة الواحدة — delegate الفرديّ، وteam المتوازي، والوكيلُ الموجِّه قبل الحقبة الأولى.
    expect(source.match(/runDelegatedAgent\(\{/gu)).toHaveLength(3)
    // مُوزِّعٌ واحد: الطفل يستدعي `dispatchToolV` نفسها لا نسخةً ثانية.
    expect(source).toContain("dispatch: async (command, nativeCall) => dispatchToolV(")
  })

  test("سقفُ العمق يُقاس في القشرة، ويُنقص في finally مهما جرى", () => {
    expect(source).toContain("let delegationDepth = 0")
    expect(source).toContain("if (delegationDepth >= MAX_DELEGATION_DEPTH) {")
    expect(source).toContain("delegationDepth += 1")
    expect(source).toContain("delegationDepth -= 1")
    expect(source).toContain("} finally {")
    expect(MAX_DELEGATION_DEPTH).toBe(1)
  })

  test("وكلاءُ المنتَج يُقرآن من دليل التثبيت لا من جذر مشروع العميل", () => {
    expect(source).toContain("const dir = join(STATE_ROOT, AGENT_DIR)")
    expect(source).not.toContain("join(PROJECT_DIR, AGENT_DIR)")
    expect(AGENT_DIR).not.toContain("/")
  })
})

describe("S13.5 — المفتاحان الميتان صار لهما قارئ", () => {
  test("لا صفَّ معلَناً بلا قارئ بعد اليوم، والاسمُ صُحّح إلى ما يفعله", () => {
    expect(PLUGINS.filter((d) => !d.wired)).toEqual([])
    expect(PLUGINS.map((d) => d.name)).not.toContain("swarm")
    expect(descriptorFor("delegation")).toMatchObject({ defaultOn: false, applies: "next-turn", site: "call", wired: true })
    expect(descriptorFor("reviewer")).toMatchObject({ defaultOn: false, applies: "next-turn", site: "call", wired: true })
  })

  test("الوصفان يقولان ما يفعله المفتاح وما يعنيه إطفاؤه", () => {
    expect(descriptorFor("delegation")!.description).toContain("المعطَّل = الأداة لا تُعلَن ولا تُوزَّع")
    expect(descriptorFor("reviewer")!.description).toContain("المعطَّل = الوكيل غائبٌ عن الكتالوج")
    // ولا وعدَ بسربٍ متوازٍ لا وجود له.
    expect(descriptorFor("delegation")!.label).not.toContain("سرب")
  })

  test("القارئان حقيقيّان: التوزيع والإعلان يسألان delegation، والكتالوج يسأل reviewer", () => {
    expect(source).toContain('if (!pluginOnNow("delegation")) {')
    expect(source).toContain('const delegationOn = pluginOnNow("delegation")')
    expect(source).toContain('const reviewerOn = pluginOnNow("reviewer")')
    // هـ2 (2026-09-07): أربعةُ قرّاء — الإعلان، وdelegate، وteam، والوكيلُ الموجِّه (مطفأٌ = لا موجِّهَ ولا فريق، ويُقال).
    expect(source.match(/pluginOnNow\("delegation"\)/gu)).toHaveLength(4)
    expect(source.match(/pluginOnNow\("reviewer"\)/gu)).toHaveLength(1)
  })
})

describe("S13.5 — الإعلان يساوي الإذن", () => {
  test("سقفُ الوكيل يقصّ كتالوج النموذج (الثغرة «أ» مغلقة)", () => {
    expect(source).toContain("const allowlist = hooks.toolAllowlist")
    expect(source).toContain("const withinAllowlist = (name: string): boolean => allowlist === undefined || allowlist.includes(name)")
    // هـ٢ (2026-09-07): وteam معها — لا تُعلَن في وضعٍ لا يوازي (قاعدةُ delegate نفسُها: لا أداةَ معروضةٌ لا تعمل)، والطفلُ لا يراها بالسقف نفسه.
    expect(source).toContain(".filter((tool) => withinAllowlist(tool.name) && (tool.name !== DELEGATE_TOOL || (delegationOn && allowlist === undefined)) && (tool.name !== TEAM_TOOL || (delegationOn && allowlist === undefined && workProfile(loadSettings().workMode).parallelAgents >= 2)))")
    // والطفلُ لا يرى أداةَ التفويض أبداً — سقفُ العمق في الإعلان أيضاً.
    expect(source).toContain("readonly toolAllowlist?: readonly string[]")
  })

  test("الأدواتُ الخارجيّة تُعلَن كما تُوزَّع (الثغرة «ب» مغلقة)", () => {
    expect(source).toContain("for (const external of advertisedExternalTools()) {")
    expect(source).toContain("if (!withinAllowlist(external.name)) continue")
    // والقائمةُ **دالّةٌ حيّة** لا لقطة: مصدرٌ واحدٌ يُسجَّل مرّةً بجوار الخريطة
    // نفسها التي يخدمها `externalTool`، فلا موضعَ تحديثٍ يُنسى ولا مزوّدٌ ميتٌ
    // يبقى معلَناً (هو يُفرغ أدواته عن نفسه). ولا لقطةَ بقيت في الملفّ.
    expect(source).toContain("setExternalToolSource(() => [...externals.values()].flatMap((s) => s.tools()))")
    expect(source.match(/setExternalToolSource\(/gu)).toHaveLength(1)
    expect(source).not.toContain("setAdvertisedExternalTools")
    // والصيغةُ تُنسب حيث يُنسب الاسم (`mind/external.ts`) لا هنا — وإلّا رمى
    // `@abdo/harness` فسقط كلُّ نداءٍ في الدور لمجرّد أن مزوّداً كتب صيغته
    // بمفرداته العارية. تطبيعٌ واحد، في الموضع الذي يملك النسبة.
    expect(source).not.toContain("namespacedUsage")
    expect(externalSource).toContain("export const namespacedUsage")
    expect(externalSource).toContain("usage: typeof r.usage === \"string\" ? namespacedUsage(name, r.usage)")
  })
})

describe("S13.5 — إصلاح عيب التحرير موصولٌ في المسارين", () => {
  test("المسار النصّيّ يمرّ بوحدة التطابق، ولا استبدالَ بسلسلةٍ بقي", () => {
    expect(source).toContain("const plan = parseEditCommand(rest)")
    expect(source).toContain("const applied = applyEdit(before, plan)")
    // م11 (09-14): الرفضُ يحمل ذيلَ التصعيد؛ الحكمُ (رفض/خطأ صيغة) كما كان.
    expect(source).toContain("if (!applied.ok) { const why = applied.why + editRefusals.refused(turnId, checked0.abs, railTier, before.length); return applied.occurrences > 1 ? refused(why) : invalid(why) }")
    // الطفرة (د): لو عاد الاستبدال الصامت لسقط هذا.
    expect(source).not.toContain("before.replace(oldText.trim(), newText.trim())")
    expect(source).not.toContain('before.includes(oldText.trim())')
  })

  test("المسار المنظَّم يتكلّم المفردات نفسها — لا عدُّ مواضعَ ثانٍ", () => {
    expect(source).toContain("countOccurrences(before, old) !== 1")
    expect(source).not.toContain("before.split(old).length !== 2")
    // ذ9ب (2026-09-06): medit يستعمل applyEdit نفسَه حزمةً حزمة — المفرداتُ واحدة، والعدُّ ثلاثة لا اثنان.
    expect(source.match(/applyEdit\(/gu)).toHaveLength(3)
  })

  test("الصيغة المعلَنة للنموذج تحمل الراية — فالمعلَن هو المسموح", () => {
    expect(ProductTools.tool("edit")!.usage).toBe("edit <ملف> [--all] :: قديم => جديد")
    expect(ProductTools.tool("edit")!.summary).toContain("فريد")
  })
})
