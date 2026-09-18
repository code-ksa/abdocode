import { describe, expect, test } from "bun:test"
import { ProductTools as Tools } from "@abdo/tools"
import * as Providers from "@abdo/providers"
import { nativeToolDefinition, nativeToolReply, nativeAgentSystem } from "../src/native-agent-tools"
import { policyLine } from "../src/tool-vocabulary"
import { BUILTIN_AGENT_FILES, buildAgentCatalogue, describeAgents, describeAgentsBrief } from "../src/agent-definitions"
import { HarnessRegistry } from "@abdo/prompting"
import { MODES, type ApprovalMode, type RequestKind } from "../src/shells/shell"

const cliSource = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
const shellSource = await Bun.file(new URL("../../desktop/ui/index.html", import.meta.url)).text()

const effectOf = (name: string): RequestKind | undefined => Tools.TOOLS.find((tool) => tool.name === name)?.effect
const localCallable = Tools.TOOLS.filter((tool) => tool.agentCallable && tool.cloudOnly !== true)
const asHarness = (tool: { name: string; usage: string; summary: string }) => ({
  legalName: tool.name,
  usage: tool.usage,
  description: tool.summary,
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
}) as never

/**
 * العطلُ الذي جاء منه هذا الملفّ (مقيس 2026-09-03، من جلسة المالك نفسها):
 * المتصفّحُ والبحثُ «لا يعملان»، وردُّ النموذج «لا أملك القدرة على تصفّح
 * الإنترنت». والسببُ لم يكن نثراً كاذباً وحده — بل **كتالوجاً مبتوراً**:
 * المسارُ الأصيل (وهو الافتراضيّ لنموذجنا المحلّي) كان يُعلن ٧ أدواتٍ من ٢٥.
 * فالنموذجُ كان صادقاً، والقشرةُ هي التي كذبت عليه.
 *
 * كلُّ فحصٍ هنا سلبيُّ الشكل («لا يسقط»، «لا يقول») فله **توأمٌ إيجابي**
 * يثبت أن الشيء يُنتَج أصلاً — وإلا مرّ الفحصُ وهو فارغ.
 */
describe("سطحُ الوكيل يقول الحقيقة", () => {
  test("كلُّ أداةٍ يستطيع الوكيل نداءها لها شكلٌ أصيل — لا سقوطَ صامت", () => {
    // التوأمُ الإيجابي: القائمةُ ليست فارغة، وإلا مرّ الفحصُ بلا أن يفحص شيئاً.
    expect(localCallable.length).toBeGreaterThanOrEqual(25)
    const missing = localCallable.filter((tool) => nativeToolDefinition(asHarness(tool)) === undefined)
    expect(missing.map((tool) => tool.name)).toEqual([])
  })

  test("أدواتُ المتصفّح والبحث تصل النموذجَ فعلاً في نداءٍ مبنيّ بالمزوّد الحيّ", () => {
    const native = localCallable.map((tool) => nativeToolDefinition(asHarness(tool))!).filter(Boolean)
    const request = Providers.prepareChatRequest({
      provider: Providers.provider("ollama")!,
      model: "qwen9b-gpu-32k:latest",
      system: "s",
      messages: [{ role: "user", content: "افتح صفحة" }],
      tools: native,
      stream: false,
      nativeTools: true,
      credentialOwner: "caller",
      contextTokens: 32_000,
      maxOutputTokens: 2_000,
    } as never) as { toolBindings: readonly { legalName: string }[] }
    const bound = request.toolBindings.map((binding) => binding.legalName)
    // السبعةُ التي سقطت في جلسة المالك — تُسمّى واحدةً واحدة كي يقول الفشلُ أيُّها سقط.
    for (const name of ["search", "ui", "page", "open", "tap", "fill", "fetch"]) expect(bound).toContain(name)
    expect(bound.length).toBe(localCallable.length)
  })

  test("أداةٌ بلا وسائط أمرُها اسمُها وحده — لا «undefined» مُلحَقة", () => {
    const names = new Map([["abdo_page", "page"], ["abdo_search", "search"]])
    const turn = {
      truncated: false,
      finishReason: "stop",
      text: "أقرأ الصفحة",
      calls: [{ name: "abdo_page", input: {} }],
    }
    const reply = nativeToolReply(turn as never, names)
    if (typeof reply === "string") throw new Error(reply)
    expect(reply.command).toBe("page")
    expect(reply.command).not.toContain("undefined")
    // والتوأمُ الإيجابي: أداةٌ ذاتُ وسيطٍ ما زالت تحمل وسيطَها.
    const withArg = nativeToolReply(
      { truncated: false, finishReason: "stop", text: "أبحث", calls: [{ name: "abdo_search", input: { input: "طقس الرياض" } }] } as never,
      names,
    )
    if (typeof withArg === "string") throw new Error(withArg)
    expect(withArg.command).toBe("search طقس الرياض")
  })

  test("سطرُ السياسة يتبع النمطَ النافذ — و«صلاحية كاملة» لا تدّعي شبكةً مقفلة", () => {
    const all = localCallable.map((tool) => tool.name)
    const line = (mode: ApprovalMode) => policyLine(mode, all, effectOf)
    // قراءةٌ فقط: الأربعةُ غيرُ القراءة تُذكر — والتوأمُ الإيجابي أنها تُذكر فعلاً.
    expect(line("read-only")).toContain("الشبكة والمتصفّح")
    expect(line("read-only")).toContain("تعديل الملفّات")
    // تلقائي: الشبكةُ تُذكر، والتعديلُ لا — فالجملةُ تفرّق بين النمطين حقاً.
    expect(line("auto")).toContain("الشبكة والمتصفّح")
    expect(line("auto")).not.toContain("تعديل الملفّات")
    // صلاحيةٌ كاملة: **الجملةُ التي أوقعت المالك** لا تُقال، ويُقال بديلُها.
    expect(line("full-access")).not.toContain("الشبكة")
    expect(line("full-access")).toContain("كلُّ ما في سقفك من أدوات يمرّ بلا استئذان")
    for (const mode of ["read-only", "auto", "full-access"] as const) {
      expect(line(mode)).toContain("أنت في نمط")
      expect(line(mode)).not.toContain("مقفلة")
    }
  })

  test("صنفٌ لا تبلغه أداةٌ معلَنة لا يُذكر — السقفُ يقصّ النثرَ كما يقصّ الإذن", () => {
    const readers = Tools.TOOLS.filter((tool) => tool.agentCallable && tool.effect === "read").map((tool) => tool.name)
    expect(readers.length).toBeGreaterThan(0)
    const line = policyLine("read-only", readers, effectOf)
    expect(line).not.toContain("الشبكة")
    expect(line).not.toContain("تنفيذ الأوامر")
    expect(line).toContain("كلُّ ما في سقفك من أدوات يمرّ بلا استئذان")
  })

  test("الجملةُ مشتقّةٌ من جدول الأنماط نفسِه: كلُّ «ask» فيه يظهر وكلُّ «allow» يغيب", () => {
    // هذا هو فحصُ الاشتقاق: لو صارت الجملةُ ثلاثَ سلاسلَ مكتوبةٍ باليد لمرّ ما
    // سبق وسقط هذا — لأنه يقرأ الجدولَ الحاكم ويقارن به حرفاً بحرف.
    const all = localCallable.map((tool) => tool.name)
    const AR: Record<RequestKind, string> = {
      read: "القراءة",
      edit: "تعديل الملفّات",
      command: "تنفيذ الأوامر",
      network: "الشبكة والمتصفّح",
      "outside-workspace": "ما خارج مجلّد المشروع",
    }
    // الحضورُ وحده لا يكفي: صنفٌ يظهر في **الفقرة الخطأ** يعيد إنتاج عطل
    // المالك بالضبط (يُقال «ممنوع» لِما يمرّ). فتُقسَم الجملةُ إلى فقرتيها
    // ويُسأل عن العضويّة لا عن الورود.
    const clauses = (line: string) => {
      const askAt = line.indexOf("يحتاج موافقةً صريحة:")
      const denyAt = line.indexOf("ممنوعٌ فيه:")
      const cut = (from: number) => {
        if (from < 0) return ""
        const rest = [askAt, denyAt].filter((i) => i > from)
        return line.slice(from, rest.length > 0 ? Math.min(...rest) : undefined)
      }
      return { ask: cut(askAt), deny: cut(denyAt) }
    }
    for (const mode of Object.keys(MODES) as ApprovalMode[]) {
      const line = policyLine(mode, all, effectOf)
      const { ask, deny } = clauses(line)
      for (const kind of Object.keys(AR) as RequestKind[]) {
        if (!all.some((name) => effectOf(name) === kind)) continue
        const effect = MODES[mode][kind]
        const where = `${mode}/${kind}: ask=${ask.includes(AR[kind])} deny=${deny.includes(AR[kind])}`
        if (effect === "ask") expect(where).toBe(`${mode}/${kind}: ask=true deny=false`)
        if (effect === "deny") expect(where).toBe(`${mode}/${kind}: ask=false deny=true`)
        if (effect === "allow") expect(where).toBe(`${mode}/${kind}: ask=false deny=false`)
      }
    }
  })

  test("المسارانِ كلاهما يحملان السطر: الأصيلُ (الافتراضيّ محلياً) والنصّي", () => {
    const policy = policyLine("full-access", ["search"], effectOf)
    expect(nativeAgentSystem(false, false, false, policy)).toContain("صلاحية كاملة")
    // والنصّيُّ يستدعيه من المصدر نفسِه لا بجملةٍ ثانية.
    expect(cliSource).toContain("const policy = policyLine(hooks.approvalMode ?? \"read-only\", advertisedNames, effectOf)")
    expect(cliSource).toContain("get approvalMode() { return currentMode }")
    // السطحانِ اللذانِ يبلغانِ النموذجَ فعلاً — رسالةُ النظام ونصُّ `docs
    // safety` — لا يدّعي أيٌّ منهما قفلاً ثابتاً. (التعليقُ التاريخيّ يصف
    // العطلَ بصيغة الماضي ولا يبلغ النموذج، فلا يُحسب سطحاً.)
    expect(cliSource).not.toContain("الشبكة مقفلة افتراضياً")
    const safety = cliSource.slice(cliSource.indexOf("safety:"), cliSource.indexOf("packages:"))
    expect(safety).toContain("يحدّده نمط الجلسة")
    expect(safety).not.toContain("مقفلة")
  })

  test("القشرةُ تنسب قراءاتِها إلى نفسها — فلا يُقال عن موصولٍ «لم يُقرأ»", () => {
    expect(shellSource).toContain("const shellPluginReads = new Set()")
    expect(shellSource).toContain("shellPluginReads.add(name)")
    expect(shellSource).toContain("shellPluginReads.has(e.name)")
    expect(shellSource).toContain("قُرئ في القشرة: ")
    // التوأمُ الإيجابي: `activity` يُقرأ في القشرة فعلاً — ولولا ذلك لكان
    // الصفُّ الجديد فرعاً ميتاً يمرّ فحصُه وهو لا يشتعل أبداً.
    expect(shellSource).toContain('pluginOn("activity")')
    // ويبقى «مُعلَن ولم يُقرأ» قائماً لمن لا قارئَ له — لا يُمحى الصنف.
    expect(shellSource).toContain("مُعلَن ولم يُقرأ: ")
  })

  test("وصفُ أداةِ التفويض يسع أضيقَ هيئةٍ نشحنها — وإلا سقطت الأداةُ صامتة", () => {
    // العطلُ المقيس: الوصفُ المُركَّب بلغ 728 حرفاً وسقفُ هيئة qwen — هيئةُ
    // نموذجنا المحلّي — 512. والهيئةُ **لا تقصّ الوصف بل تُسقط الأداة كلَّها**
    // عمداً. فكانت `delegate` تختفي من الكتالوج كلّما فُعِّل مفتاحُها.
    // الفحصُ يقيس مقابل **أضيقِ** سقفٍ مشحون، فوكيلٌ خامسٌ يُضاف يُحمِّره هنا
    // بدل أن يُسقط الأداةَ في الحقل بلا خبر.
    const catalogue = buildAgentCatalogue(BUILTIN_AGENT_FILES)
    expect(catalogue.agents.length).toBeGreaterThan(0)
    const spec = Tools.TOOLS.find((tool) => tool.name === "delegate")!
    const composed = `${spec.summary}\nالوكلاء المتاحون:\n${describeAgentsBrief(catalogue)}`
    const caps = ["qwen-style", "abdo-native", "codex-style", "deepseek-style", "claude-style"]
      .map((id) => HarnessRegistry.get(id)?.document.tools.descriptionMaxChars)
      .filter((n): n is number => typeof n === "number")
    expect(caps.length).toBeGreaterThanOrEqual(4)
    const tightest = Math.min(...caps)
    expect(`${composed.length} chars vs tightest cap ${tightest}: ${composed.length <= tightest}`)
      .toBe(`${composed.length} chars vs tightest cap ${tightest}: true`)
    // والتوأمُ الإيجابي: الصيغةُ الكاملة **تتجاوز** السقف فعلاً — فالفحصُ
    // أعلاه يقيس فرقاً حقيقيّاً لا يمرّ على أيّ صياغةٍ كانت.
    const full = `${spec.summary}\nالوكلاء المتاحون:\n${describeAgents(catalogue)}`
    expect(full.length).toBeGreaterThan(tightest)
    // والقشرةُ تستدعي المُوجَزة لا الكاملة.
    expect(cliSource).toContain("describeAgentsBrief(delegableAgents())")
  })

  test("خرجُ الأمر يُبثّ وهو يُكتب — ولا يُعرض مرّتين", () => {
    // كان المُطلِق يستنزف الأنبوبَين كاملَين ثمّ يُعيد النصَّ بعد الخروج،
    // فما تراه القشرةُ «بثّاً» إعادةُ عرضٍ لنصٍّ اكتمل: دوّارةٌ تدور بلا سبيلٍ
    // إلى تمييز بناءٍ بطيءٍ من أمرٍ معلّق.
    expect(cliSource).toContain("streamedLive = true")
    expect(cliSource).toContain("onOutput: (chunk: { text: string })")
    // وما بُثَّ حيّاً لا يُعاد: بلا هذا الشرط يُكتب الخرجُ مرّتين — وهو عيبٌ
    // يراه المستخدم فوراً ولا يراه أيُّ اختبارٍ يفحص العائد وحده.
    expect(cliSource).toContain("if (!streamedLive) for (const line of lines)")
  })
})
