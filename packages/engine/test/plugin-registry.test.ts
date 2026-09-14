import { describe, expect, test } from "bun:test"
import {
  PLUGINS,
  PLUGIN_NAMES,
  PluginInventory,
  RULE_MAX_CHARS,
  RULE_MAX_COMPARISONS,
  catalogFor,
  descriptorFor,
  describePlugins,
  envPinName,
  evaluateRule,
  metaOn,
  neutralPluginContext,
  parseRule,
  pluginContext,
  resolveEnvPins,
  resolvePlugin,
  resolvePlugins,
  validatePluginsPatch,
  type ParsedRule,
} from "../src/plugin-registry"

// خريطة الاستعادة القديمة بنصّها — كانت حرفاً مكتوباً بيدٍ في index.html
// ومثبَّتة في serve-wiring (:95/:99/:216/:320/:321). صارت تُولَّد من الأوصاف،
// فبقي الحرف هنا حارساً على الافتراضات نفسها: أيّ انزلاقٍ في قيمةٍ أو غيابُ
// اسمٍ يسقط هذا الاختبار.
const LEGACY_RESET_MAP =
  "denialBreaker: false, unattendedDeny: true, standingGrants: false, inboundGuard: true, mcpClient: false, delegation: false, reviewer: false, activity: false, walls: true, verifier: false, toolVerdict: true, trailCompaction: true, miner: true, readCompaction: true, cacheAccounting: true, resumeIntent: true, turnBudget: true, receiptFixtures: true, intentField: false"
// صفوف سبرنت القشرة الثلاثة (IDEA 7/8/9) — تُضاف إلى الحرف القديم ولا تُبدّله:
// أيّ انزلاقٍ في افتراضٍ **قديم** يبقى يسقط الاختبار كما كان.
const SHELL_SPRINT_ROWS = "approvalTakeover: true, trajectory: true, deliverables: false"
// S14 — صفّ الإدخال المُعان للأسرار: يُضاف ولا يُبدّل ما قبله.
const SECRET_INTAKE_ROW = "secretIntake: true"
// S13.1/S13.2 — صفّا الوعي: يُضافان ولا يُبدّلان ما قبلهما.
// S13.3 — صفّ الوعي العام يُلحق بهما ولا يُبدّلهما.
const AWARENESS_ROWS = "sessionAwareness: true, projectAwareness: true, generalAwareness: true"
// ألواحُ قشرة 2026-09-03. كلاهما **مطفأٌ افتراضاً**: لوحُ الطرفيّة يغيّر
// الواجهة، ولوحُ الخوادم يغيّر **عمرَ العمليات** (تبقى بين الأدوار) — وما
// يغيّر سلوكاً يبدأ مطفأً، ونصُّ إطفائه يقول ما يفتحه حرفياً.
const PANEL_ROWS = "terminalPanel: true, serversPanel: false, tasksPanel: true"
// د2 — المحرّك الدلاليّ يبدأ مشتغلاً: فهمٌ حتميّ بلا نموذجٍ ولا شبكة، والمعطَّل بايتاً كما كان.
const SEMANTIC_ROWS = "semanticFrame: true, semanticInfer: false"
// ذ3 — الدروسُ المقيَّدة بالمشروع تبدأ مشتغلة: قياسٌ من إيصالاتٍ بلا نموذجٍ ولا شبكة، والمعطَّل بايتاً كما كان.
const LESSON_ROWS = "lessons: true"
// ذ5 — العدّادُ المحلي يبدأ مشتغلاً: ملفٌّ على قرص المستخدم وحده، والمعطَّل بايتاً كما كان.
const METER_ROWS = "usageMeter: true"

const ctx = pluginContext({ rail: "thin", platform: "win32", lane: "agent", mode: "auto", provider: "ollama" })
const parsed = (text: string): ParsedRule => {
  const rule = parseRule(text)
  if (typeof rule === "string") throw new Error(`expected a parsed rule, got refusal: ${rule}`)
  return rule
}

describe("plugin registry — the table", () => {
  test("names are unique, and the declared set is exactly the panel toggles plus the three governing keys", () => {
    const names = PLUGINS.map((d) => d.name)
    expect(new Set(names).size).toBe(names.length)
    expect(PLUGIN_NAMES.size).toBe(names.length)
    // العدد يُشتقّ من الجدول لا يُثبَّت رقماً: اثنا عشر صفّاً كانت في اللوحة
    // (بعد S13.0-b/-c) + صفّ حقل النيّة (S13.0-g) + ثلاثة صفوف سبرنت القشرة
    // (IDEA 7/8/9) + صفّ الإدخال المُعان للأسرار (S14) + ثلاثة مفاتيح حاكمة.
    // + صفّا وعي الجلسة ووعي المشروع (S13.1/S13.2).
    // + صفّ الوعي العام (S13.3).
    // + صفّ المحرّك الدلاليّ (د2 — 2026-09-06).
    // + صفّ الدروس المقيَّدة بالمشروع (ذ3 — 2026-09-06).
    // + صفّ العدّاد المحلي (ذ5 — 2026-09-06).
    expect(names.filter((n) => descriptorFor(n)!.meta !== true)).toHaveLength(33)
    expect(names.filter((n) => descriptorFor(n)!.meta === true)).toEqual(["settingsSeam", "inventory", "rules"])
  })

  test("the generated reset map carries exactly the legacy defaults (order unified on the panel order, values untouched)", () => {
    const generated = PLUGINS.filter((d) => d.meta !== true).map((d) => `${d.name}: ${d.defaultOn}`)
    expect([...generated].sort()).toEqual([...LEGACY_RESET_MAP.split(", "), ...PANEL_ROWS.split(", "), ...SHELL_SPRINT_ROWS.split(", "), SECRET_INTAKE_ROW, ...AWARENESS_ROWS.split(", "), ...SEMANTIC_ROWS.split(", "), ...LESSON_ROWS.split(", "), ...METER_ROWS.split(", ")].sort())
    // ولا صفَّ قديمٍ سقط ولا انزلق افتراضُه: الحرف القديم يبقى محتوىً فرعياً.
    for (const row of LEGACY_RESET_MAP.split(", ")) expect(generated).toContain(row)
    // ترتيب اللوحة (المرئيّ) هو الترتيب الوحيد الآن — كان يختلف عن ترتيب
    // خريطة الاستعادة في موضع trailCompaction وحده.
    expect(generated.join(", ")).toBe(
      "denialBreaker: false, unattendedDeny: true, standingGrants: false, inboundGuard: true, mcpClient: false, delegation: false, reviewer: false, activity: false, terminalPanel: true, serversPanel: false, tasksPanel: true, walls: true, verifier: false, toolVerdict: true, miner: true, readCompaction: true, trailCompaction: true, cacheAccounting: true, resumeIntent: true, turnBudget: true, receiptFixtures: true, intentField: false, approvalTakeover: true, trajectory: true, deliverables: false, secretIntake: true, sessionAwareness: true, projectAwareness: true, generalAwareness: true, semanticFrame: true, semanticInfer: false, lessons: true, usageMeter: true",
    )
    // المفاتيح الحاكمة تُلحق بالخريطة بافتراضاتها.
    expect(PLUGINS.filter((d) => d.meta === true).map((d) => `${d.name}: ${d.defaultOn}`).join(", "))
      .toBe("settingsSeam: true, inventory: true, rules: true")
  })

  test("«مسجَّلة لا قابلة للاستدعاء» is declared, not hidden: after S13.5 no row is left without a reader", () => {
    // كانتا `swarm` و`reviewer`. S13.5 أعطاهما قارئَين حقيقيَّين (وصحّح اسم
    // الأولى إلى `delegation`)، فصار الجرد يقول الصدق في الاتجاهين: لا صفَّ
    // معلَناً بلا قارئ، ولا صفَّ يُوسم موصولاً وهو ليس كذلك.
    expect(PLUGINS.filter((d) => !d.wired).map((d) => d.name)).toEqual([])
    expect(PLUGINS.filter((d) => d.site === "none")).toEqual([])
    for (const d of PLUGINS) expect(d.wired).toBe(d.site !== "none")
    // القياس 2026-09-02 كان: لوحة النشاط تُرسم بلا استشارة المفتاح — فموضعها
    // «لا قارئ». مع سبرنت المسلَّمات صارت القشرة تقرؤه فعلاً على ready/settings،
    // فقُلب الوصف في التغيير نفسه: جردٌ يكذب في الاتجاه المعاكس («موصول» وهو
    // ليس كذلك) أسوأ من الثغرة التي كان يبلّغ عنها.
    expect(PLUGINS.filter((d) => d.site === "panel").map((d) => d.name)).toEqual(["activity", "terminalPanel", "serversPanel", "tasksPanel", "trajectory"])
    expect(descriptorFor("activity")).toMatchObject({ site: "panel", wired: true })
  })

  test("descriptor sites match the measured read timing of each reader", () => {
    const sites = Object.fromEntries(PLUGINS.map((d) => [d.name, d.site]))
    expect(sites).toMatchObject({
      walls: "turn", verifier: "turn", toolVerdict: "turn", miner: "turn", resumeIntent: "turn", turnBudget: "turn", receiptFixtures: "turn",
      readCompaction: "epoch", trailCompaction: "epoch",
      cacheAccounting: "call",
      settingsSeam: "door",
      // IDEA 7: يُقرأ عند كلّ بوابة أثر (نداء)، لا مرةً لكل دور.
      approvalTakeover: "call",
      // IDEA 8/9: اللسان قشرةٌ خالصة؛ والمسلَّمات تُقرأ مرةً لكل دور كأختها.
      trajectory: "panel", deliverables: "turn",
      // S13.1/S13.2: كلاهما يُقرأ مرةً لكل دور — الحقن والكتابة يستعملان
      // القيمة المقروءة نفسها، فلا يتبدّل السلوك وسط الدور.
      // S13.3: والوعي العام كذلك — يُقرأ مرةً لكل دور، فالقراءة في أوّله
      // والترقية في آخره بالقيمة نفسها.
      sessionAwareness: "turn", projectAwareness: "turn", generalAwareness: "turn",
    })
  })

  test("no descriptor invents a vault handle — settings never carry a secret", () => {
    for (const d of PLUGINS) expect(d.requiresVault).toEqual([])
  })
})

describe("plugin registry — resolution layers", () => {
  test("(a) an absent file resolves every name to its descriptor default", () => {
    const resolved = resolvePlugins(undefined, {})
    for (const d of PLUGINS) expect(resolved.effective[d.name]).toBe(d.defaultOn)
    expect(resolved.pins).toEqual({})
    expect(resolved.refusals).toEqual([])
  })

  test("(b) the file layer wins per key for booleans; an unknown key is ignored, never thrown", () => {
    const file = { walls: false, verifier: true, junk: true }
    const resolved = resolvePlugins(file, {})
    expect(resolved.effective.walls).toBe(false)
    expect(resolved.effective.verifier).toBe(true)
    expect(resolved.effective.miner).toBe(true)
    expect(resolved.effective.junk).toBeUndefined()
  })

  test("(b2) a non-boolean value is now OFF with a named why — the old `!== false` read it as ON", () => {
    const one = resolvePlugin({ walls: "yes" }, "walls", ctx, { rulesOn: true })
    expect(one.effective).toBe(false)
    expect(one.why).toBe("invalid-value")
    expect(one.configured).toBe("invalid")
    // ولا يعود إلى الافتراض (walls افتراضه مفعَّل) — الفشل مُغلق لا مفتوح.
    expect(descriptorFor("walls")!.defaultOn).toBe(true)
    for (const junk of [0, 1, "false", "", null, [], { on: true }, { when: 5 }]) {
      expect(resolvePlugin({ miner: junk }, "miner", ctx, { rulesOn: true }).effective).toBe(false)
    }
  })

  test("(c) an env pin outranks the file when the seam is on, and is reported by name", () => {
    const resolved = resolvePlugins({ walls: true }, { ABDO_PLUGIN_WALLS: "0" })
    expect(resolved.effective.walls).toBe(false)
    expect(resolved.pins.walls).toEqual({ value: false, env: "ABDO_PLUGIN_WALLS" })
    const one = resolvePlugin({ walls: true }, "walls", ctx, { rulesOn: true, pins: resolved.pins })
    expect(one.why).toBe("pinned-env")
    expect(one.pin).toBe("ABDO_PLUGIN_WALLS")
    expect(one.configured).toBe("true")
    // والمقلوب: مفتاحٌ افتراضه معطَّل يُثبَّت مفعَّلاً.
    expect(resolvePlugins({}, { ABDO_PLUGIN_VERIFIER: "1" }).effective.verifier).toBe(true)
  })

  test("(d2) NO governing key is pinnable — the panel may never advertise a pin the loop ignores", () => {
    // القارئ الحقيقيّ للمفاتيح الثلاثة هو `metaOn` (ملف + افتراض، بلا سياقٍ ولا
    // تثبيت). فتثبيتٌ يُقبل هنا كان يُعرض مربّعاً مقفلاً «مطفأً» بينما تُقيَّم
    // القواعد ويُسجَّل الجرد: فشلٌ **مفتوح** في مفتاح مشغّل.
    for (const d of PLUGINS.filter((p) => p.meta === true)) {
      for (const raw of ["0", "1"]) {
        const key = envPinName(d.name)
        const resolved = resolvePlugins({}, { [key]: raw })
        expect(resolved.pins[d.name]).toBeUndefined()
        expect(resolved.refusals.some((r) => r.startsWith(`${key} لا يُثبَّت من البيئة`))).toBe(true)
        // وهذا هو الشرط الحاسم: المعروض = ما تعمل به الحلقة، لا أقلّ ولا أكثر.
        expect(resolved.effective[d.name]).toBe(metaOn({}, d.name as "settingsSeam" | "inventory" | "rules"))
        expect(describePlugins({ plugins: {} }, { [key]: raw }).effective[d.name]).toBe(metaOn({}, d.name as "settingsSeam" | "inventory" | "rules"))
      }
    }
    // وبالملموس: `ABDO_PLUGIN_RULES=0` لا يُطفئ القواعد سرّاً.
    const pinnedRules = resolvePlugins({ miner: { when: "rail == thin" } }, { ABDO_PLUGIN_RULES: "0" }, ctx)
    expect(pinnedRules.effective.rules).toBe(true)
    expect(pinnedRules.effective.miner).toBe(true)
    // ولا تُطبَّق التثبيتات على مفتاحٍ حاكم حتى لو مُرِّرت يدوياً إلى المحلِّل.
    const forced = resolvePlugin({}, "rules", ctx, { rulesOn: true, pins: { rules: { value: false, env: "ABDO_PLUGIN_RULES" } } })
    expect(forced.effective).toBe(true)
    expect(forced.why).toBe("default")
    expect(forced.pin).toBeUndefined()
  })

  test("(d3) a malformed plugins namespace is named, not silently discarded", () => {
    for (const junk of ["x", 42, [], null]) {
      const resolved = resolvePlugins(junk, {})
      expect(resolved.refusals).toContain("فضاء plugins ليس كائناً {اسم: true/false} — أُهمل كلّه، وكل مفتاحٍ على افتراضه")
      expect(describePlugins({ plugins: junk }, {}).refusals[0]).toStartWith("فضاء plugins ليس كائناً")
    }
    // والغياب ليس تشويهاً: لا رفض حين لا فضاء أصلاً.
    expect(resolvePlugins(undefined, {}).refusals).toHaveLength(0)
    expect(resolvePlugins({}, {}).refusals).toHaveLength(0)
  })

  test("(d) a malformed pin is refused by name and never applied; the seam itself is not pinnable", () => {
    const bad = resolvePlugins({}, { ABDO_PLUGIN_WALLS: "maybe" })
    expect(bad.pins.walls).toBeUndefined()
    expect(bad.effective.walls).toBe(true)
    expect(bad.refusals).toHaveLength(1)
    expect(bad.refusals[0]).toContain("ABDO_PLUGIN_WALLS")
    expect(bad.refusals[0]).toContain("ليس 0/1")
    const seam = resolvePlugins({}, { ABDO_PLUGIN_SETTINGS_SEAM: "0" })
    expect(seam.pins.settingsSeam).toBeUndefined()
    expect(seam.effective.settingsSeam).toBe(true)
    expect(seam.refusals[0]).toContain("ABDO_PLUGIN_SETTINGS_SEAM")
    // وحدة الاسم: camelCase ⇒ SNAKE_UPPER.
    expect(envPinName("toolVerdict")).toBe("ABDO_PLUGIN_TOOL_VERDICT")
    expect(envPinName("walls")).toBe("ABDO_PLUGIN_WALLS")
    expect(envPinName("readCompaction")).toBe("ABDO_PLUGIN_READ_COMPACTION")
    expect(resolveEnvPins({ ABDO_PLUGIN_TOOL_VERDICT: "1" }).pins.toolVerdict).toEqual({ value: true, env: "ABDO_PLUGIN_TOOL_VERDICT" })
  })

  test("(e) with the seam off the env layer does not exist at all", () => {
    const resolved = resolvePlugins({ settingsSeam: false, walls: true }, { ABDO_PLUGIN_WALLS: "0", ABDO_PLUGIN_MINER: "junk" })
    expect(resolved.pins).toEqual({})
    expect(resolved.refusals).toEqual([])
    expect(resolved.effective.walls).toBe(true)
  })

  test("(h) the revision is read only when the seam is on, and only when it is a safe non-negative integer", () => {
    expect(describePlugins({ pluginsRevision: 7 }, {}).revision).toBe(7)
    expect(describePlugins({}, {}).revision).toBe(0)
    expect(describePlugins({ pluginsRevision: -1 }, {}).revision).toBe(0)
    expect(describePlugins({ pluginsRevision: 1.5 }, {}).revision).toBe(0)
    expect(describePlugins({ pluginsRevision: "7" }, {}).revision).toBe(0)
    expect(describePlugins({ plugins: { settingsSeam: false }, pluginsRevision: 7 }, {}).revision).toBe(0)
    const view = describePlugins({ plugins: { walls: false } }, { ABDO_PLUGIN_MINER: "0" })
    expect(view.descriptors).toBe(PLUGINS)
    expect(view.effective.walls).toBe(false)
    expect(view.pins.miner).toEqual({ value: false, env: "ABDO_PLUGIN_MINER" })
    expect(view.seam).toBe(true)
    expect(view.rules).toBe(true)
  })

  test("(i) the settings door reports the context it judged in, and judges in the caller's context", () => {
    // بلا وسيط سياق كانت `os` تُثبَّت على «other» — سياقٌ لا يقع في أيّ دور —
    // فتُعرض قاعدة `os == windows` معطَّلةً على ويندوز بينما يقرؤها كلُّ دور
    // مفعَّلة، واللوحة تعلن عكس ما سيفعله المحرّك.
    const settings = { plugins: { miner: { when: "os == windows" }, walls: { when: "rail == thin" } } }
    expect(describePlugins(settings, {}).context).toEqual(neutralPluginContext())
    expect(describePlugins(settings, {}).effective.miner).toBe(false)
    const onWindows = describePlugins(settings, {}, neutralPluginContext("win32"))
    expect(onWindows.context.os).toBe("windows")
    expect(onWindows.effective.miner).toBe(true)
    // وتطابقُ الباب مع القراءة الحيّة على المحور الوحيد المعروف خارج الدور.
    const live = new PluginInventory(settings.plugins, neutralPluginContext("win32"), { inventoryOn: true, rulesOn: true })
    expect(live.read("miner", "turn")).toBe(onWindows.effective.miner)
    // أمّا المحاور التي لا تُعرف إلا بدورٍ جارٍ فتبقى على المحايد المُعلَن —
    // والقشرة تقرؤه من `context` فتقول «حسب سياق الدور» بدل ادّعاء قيمة.
    expect(onWindows.context.rail).toBe("strict")
    expect(onWindows.effective.walls).toBe(false)
    expect(resolvePlugin(settings.plugins, "walls", ctx, { rulesOn: true }).effective).toBe(true)
  })

  test("a governing key is boolean-only and fails closed on anything else", () => {
    expect(metaOn(undefined, "inventory")).toBe(true)
    expect(metaOn({ inventory: false }, "inventory")).toBe(false)
    expect(metaOn({ inventory: "yes" }, "inventory")).toBe(false)
    expect(metaOn({ rules: { when: "rail == thin" } }, "rules")).toBe(false)
    expect(resolvePlugin({ rules: { when: "rail == thin" } }, "rules", ctx, { rulesOn: true }).why).toBe("rule-invalid")
  })
})

describe("plugin registry — the closed rule grammar", () => {
  test("accepts only the documented shapes", () => {
    expect(typeof parseRule("rail == thin")).toBe("object")
    expect(typeof parseRule("os != windows && lane == agent")).toBe("object")
    expect(typeof parseRule("rail == strict || rail == medium")).toBe("object")
    expect(typeof parseRule("mode == read-only")).toBe("object")
    expect(typeof parseRule("provider == deepseek")).toBe("object")
  })

  test("refuses everything outside the grammar, each by name", () => {
    for (const bad of [
      "weather == sunny",
      "rail == thinn",
      "rail === thin",
      "(rail == thin)",
      "!rail == thin",
      'rail == "thin"',
      "rail == thin && ",
      "rail == thin & os == linux",
      "railthin",
      "rail==thin",
      42,
      undefined,
      { when: "rail == thin" },
      "",
      "   ",
      `rail == ${"x".repeat(RULE_MAX_CHARS)}`,
      new Array(RULE_MAX_COMPARISONS + 1).fill("rail == thin").join(" && "),
    ]) {
      const refusal = parseRule(bad)
      expect(typeof refusal).toBe("string")
      expect(refusal as string).toStartWith("قاعدة plugins:")
    }
    // سقفُ المقارنات يجب أن يكون **قابلاً للبلوغ**: أقصر مقارنة ١١ محرفاً
    // والواصل ٤، فـ«ن» مقارنة = 15ن−4 محرفاً. مع سقفٍ ثمانٍ كانت التاسعة
    // (١٣١ محرفاً) يقطعها سقفُ الطول أوّلاً، فبقي الفرع ميتاً بلا تغطية —
    // والاختبار الذي سمّاه كان يمرّ على رسالة الطول. سبعٌ تجعله يقع.
    const reachable = new Array(RULE_MAX_COMPARISONS + 1).fill("os == other").join(" && ")
    expect(reachable.length).toBeLessThanOrEqual(RULE_MAX_CHARS)
    expect(parseRule(reachable)).toBe(`قاعدة plugins: أكثر من ${RULE_MAX_COMPARISONS} مقارنات`)
    expect(typeof parseRule(new Array(RULE_MAX_COMPARISONS).fill("os == other").join(" && "))).toBe("object")
    expect(parseRule("weather == sunny") as string).toContain("مفتاح غير معروف «weather»")
    expect(parseRule("rail == thinn") as string).toContain("ليست من قيم «rail»")
    expect(parseRule("!rail == thin") as string).toContain("النفي ممنوع")
    expect(parseRule("(rail == thin)") as string).toContain("الأقواس")
    expect(parseRule("rail === thin") as string).toContain("مقارنٌ غير معروف")
  })

  test("&& binds tighter than || — «a && b || c» is «(a && b) || c»", () => {
    const rule = parsed("rail == thin && lane == agent || os == linux")
    expect(evaluateRule(rule, pluginContext({ rail: "thin", lane: "agent", platform: "win32" }))).toBe(true)
    expect(evaluateRule(rule, pluginContext({ rail: "thin", lane: "chat", platform: "win32" }))).toBe(false)
    expect(evaluateRule(rule, pluginContext({ rail: "strict", lane: "chat", platform: "linux" }))).toBe(true)
    expect(evaluateRule(parsed("os != windows"), pluginContext({ platform: "win32" }))).toBe(false)
    expect(evaluateRule(parsed("os != windows"), pluginContext({ platform: "darwin" }))).toBe(true)
  })

  test("the context normalises fail-closed: unknown platform/rail/mode fall to the narrowest", () => {
    expect(pluginContext({})).toEqual({ rail: "strict", os: "other", lane: "chat", mode: "read-only", provider: "unknown" })
    expect(pluginContext({ platform: "freebsd", rail: "hyper", mode: "god", lane: "worker", provider: "Bad Name" }))
      .toEqual({ rail: "strict", os: "other", lane: "chat", mode: "read-only", provider: "unknown" })
    expect(neutralPluginContext("linux").os).toBe("linux")
  })

  test("a rule resolves fail-closed at every failure: invalid ⇒ false, rules off ⇒ false — never the default", () => {
    const on = { rulesOn: true }
    expect(resolvePlugin({ verifier: { when: "rail == thin" } }, "verifier", ctx, on)).toMatchObject({ effective: true, why: "rule-true" })
    expect(resolvePlugin({ verifier: { when: "rail == strict" } }, "verifier", ctx, on)).toMatchObject({ effective: false, why: "rule-false" })
    // walls افتراضه مفعَّل — والقاعدة المعطوبة لا تُعيده إليه.
    expect(resolvePlugin({ walls: { when: "weather == sunny" } }, "walls", ctx, on)).toMatchObject({ effective: false, why: "rule-invalid" })
    expect(resolvePlugin({ walls: { when: "rail == thin" } }, "walls", ctx, { rulesOn: false })).toMatchObject({ effective: false, why: "rules-disabled" })
    expect(resolvePlugin(undefined, "nope", ctx, on)).toMatchObject({ effective: false, why: "unknown-plugin" })
    expect(resolvePlugin(undefined, "verifier", ctx, on)).toMatchObject({ effective: false, why: "default" })
    expect(resolvePlugin({ verifier: true }, "verifier", ctx, on)).toMatchObject({ effective: true, why: "explicit" })
  })
})

describe("plugin registry — the door", () => {
  test("unknown names, non-booleans and bad rules are refused by name", () => {
    expect(validatePluginsPatch("x", true)).toBe("plugins يحتاج كائناً {اسم: true/false}")
    expect(validatePluginsPatch([], true)).toBe("plugins يحتاج كائناً {اسم: true/false}")
    expect(validatePluginsPatch({ walls: true, miner: false }, true)).toBeUndefined()
    const unknown = validatePluginsPatch({ nope: true }, true)!
    expect(unknown).toStartWith("plugins: إضافة غير معروفة: nope — المعروف:")
    for (const d of PLUGINS) expect(unknown).toContain(d.name)
    expect(validatePluginsPatch({ walls: "on" }, true)).toBe("plugins.walls يحتاج true أو false")
    expect(validatePluginsPatch({ walls: 1 }, true)).toBe("plugins.walls يحتاج true أو false")
    expect(validatePluginsPatch({ walls: null }, true)).toBe("plugins.walls يحتاج true أو false")
    expect(validatePluginsPatch({ verifier: { when: "rail == thin" } }, true)).toBeUndefined()
    expect(validatePluginsPatch({ verifier: { when: "weather == sunny" } }, true)).toContain("plugins.verifier: قاعدة plugins: مفتاح غير معروف")
    expect(validatePluginsPatch({ verifier: { when: "rail == thin" } }, false)).toBe("plugins.verifier: قواعد الشرط معطَّلة — فعّل plugins.rules أولاً")
    expect(validatePluginsPatch({ rules: { when: "os == windows" } }, true)).toBe("plugins.rules: المفاتيح الحاكمة تقبل نعم/لا فقط")
    expect(validatePluginsPatch({ inventory: { when: "os == windows" } }, true)).toBe("plugins.inventory: المفاتيح الحاكمة تقبل نعم/لا فقط")
    // سرٌّ لا يركب فضاء الإضافات مهما كان الاسم — كل قيمةٍ ليست منطقيّة أو
    // شرطاً تُرفض قبل القرص (حارس SECRETISH شبكةٌ ثانية لا أولى).
    expect(validatePluginsPatch({ verifier: "sk-abcdefghijklmnop" }, true)).toBe("plugins.verifier يحتاج true أو false")
    // `{when: <ليس نصّاً>}` شرطٌ حاضرٌ بقيمةٍ ليست نصّاً — لا «شرطٌ فارغ». طيُّه
    // إلى "" كان يسمّي السبب الخطأ في وحدةٍ كلُّ غرضها تسمية السبب الصحيح.
    for (const junk of [5, true, null, [], {}]) {
      expect(validatePluginsPatch({ walls: { when: junk } }, true)).toBe("plugins.walls: قاعدة plugins: الشرط نصٌّ لا غير")
    }
    expect(validatePluginsPatch({ walls: { when: "" } }, true)).toBe("plugins.walls: قاعدة plugins: شرطٌ فارغ")
    // والحلُّ يُغلق عليها كذلك: معطَّلة، ولا نصَّ شرطٍ يُعرض لها في اللوحة.
    const notText = resolvePlugin({ walls: { when: 5 } }, "walls", ctx, { rulesOn: true })
    expect(notText).toMatchObject({ effective: false, configured: "rule", why: "rule-invalid" })
    expect(notText.rule).toBeUndefined()
    expect(catalogFor({ walls: { when: 5 } }, true).find((r) => r.name === "walls"))
      .toMatchObject({ configured: "rule", valid: false, why: "قاعدة plugins: الشرط نصٌّ لا غير" })
  })

  test("the catalogue reports configured state and rule validity without any turn context", () => {
    const rows = catalogFor({ walls: false, verifier: { when: "rail == thin" }, miner: { when: "weather == sunny" }, toolVerdict: "yes" }, true)
    expect(rows).toHaveLength(PLUGINS.length)
    expect(rows.map((r) => r.name)).toEqual(PLUGINS.map((d) => d.name))
    expect(rows.find((r) => r.name === "walls")).toMatchObject({ configured: "false", valid: true })
    expect(rows.find((r) => r.name === "verifier")).toMatchObject({ configured: "rule", rule: "rail == thin", valid: true })
    expect(rows.find((r) => r.name === "miner")).toMatchObject({ configured: "rule", valid: false })
    expect(rows.find((r) => r.name === "toolVerdict")).toMatchObject({ configured: "invalid", valid: false })
    expect(rows.find((r) => r.name === "readCompaction")).toMatchObject({ configured: "absent", valid: true })
    expect(catalogFor({ verifier: { when: "rail == thin" } }, false).find((r) => r.name === "verifier")).toMatchObject({ valid: false })
    expect(rows.find((r) => r.name === "delegation")).toMatchObject({ wired: true, site: "call" })
  })
})

describe("plugin registry — the per-turn inventory", () => {
  const build = (map: unknown, opts?: { inventoryOn?: boolean; rulesOn?: boolean }) =>
    new PluginInventory(map, ctx, { inventoryOn: opts?.inventoryOn ?? true, rulesOn: opts?.rulesOn ?? true })

  test("records the site, the count and the epochs of every real read", () => {
    const inventory = build({ verifier: true })
    expect(inventory.read("walls", "turn")).toBe(true)
    expect(inventory.read("verifier", "turn")).toBe(true)
    for (const epoch of [1, 2, 3]) inventory.read("readCompaction", "epoch", epoch)
    inventory.read("cacheAccounting", "call")
    inventory.read("cacheAccounting", "call")
    const snapshot = inventory.snapshot()
    expect(snapshot.map((row) => row.name)).toEqual(PLUGINS.map((d) => d.name))
    expect(snapshot.find((r) => r.name === "readCompaction")).toMatchObject({ reads: 3, readSite: "epoch", epochs: [1, 2, 3], effective: true })
    expect(snapshot.find((r) => r.name === "cacheAccounting")).toMatchObject({ reads: 2, readSite: "call" })
    expect(snapshot.find((r) => r.name === "verifier")).toMatchObject({ reads: 1, why: "explicit", effective: true })
  })

  test("the honesty line: declared-but-never-read rows appear with reads:0 and their true site", () => {
    const inventory = build(undefined)
    inventory.read("walls", "turn")
    const snapshot = inventory.snapshot()
    for (const name of ["delegation", "reviewer"]) {
      // موصولان بعد S13.5، وقارئُهما عند النداء لا عند بدء الدور — فصفرُهما
      // هنا صدقُ توقيتٍ لا «مُعلَنٌ بلا قارئ».
      expect(snapshot.find((r) => r.name === name)).toMatchObject({ reads: 0, site: "call", wired: true })
    }
    // موصولٌ في القشرة لا في المحرّك: صفره هنا صدقٌ لا اتّهام — قارئه هناك.
    // ومطفأٌ افتراضياً منذ 2026-09-04، فالمُثبَت `effective: false` بسبب
    // «default» — لا «مُعلَنٌ بلا قارئ». الفرقُ بين المطفأ وغير الموصول هو
    // ما كان هذا السطرُ نفسه يحرسه.
    expect(snapshot.find((r) => r.name === "activity")).toMatchObject({ effective: false, why: "default", site: "panel", wired: true })
    expect(snapshot.find((r) => r.name === "walls")).toMatchObject({ reads: 1, wired: true })
    // ولا يُتَّهم بالصمت مفتاحٌ يُقرأ: المفاتيح الحاكمة تُقرأ بـ`metaOn` خارج
    // المحلِّل، فبلا تسجيلٍ كانت تظهر بـreads:0 مع الثلاثة غير الموصولة —
    // قلبُ «مسجَّلة ≠ قابلة للاستدعاء» رأساً على عقب. لولا `note` لسقط هذا.
    for (const name of ["settingsSeam", "inventory", "rules"]) {
      expect(snapshot.find((r) => r.name === name)).toMatchObject({ reads: 0, wired: true })
    }
  })

  test("the meta keys are recorded where they are really read — they are read every turn, not never", () => {
    const inventory = build({ rules: false })
    for (const name of ["settingsSeam", "inventory", "rules"] as const) inventory.note(name, "turn")
    inventory.read("walls", "turn")
    const snapshot = inventory.snapshot()
    expect(snapshot.find((r) => r.name === "settingsSeam")).toMatchObject({ reads: 1, readSite: "turn", effective: true, why: "default" })
    expect(snapshot.find((r) => r.name === "inventory")).toMatchObject({ reads: 1, readSite: "turn", effective: true, why: "default" })
    // والقيمة المسجَّلة هي عين ما تعمل به الحلقة — لا حلٌّ ثانٍ قد يفترق عنه.
    expect(snapshot.find((r) => r.name === "rules")).toMatchObject({ reads: 1, readSite: "turn", effective: false, why: "explicit" })
    expect(inventory.note("rules", "turn")).toBe(metaOn({ rules: false }, "rules"))
    // «مُعلَن ولم يُقرأ» يبقى للثلاثة التي لا قارئ لها فعلاً — وحدها.
    const unread = snapshot.filter((r) => r.reads === 0).map((r) => r.name)
    expect(unread).toEqual(["denialBreaker", "unattendedDeny", "standingGrants", "inboundGuard", "mcpClient", "delegation", "reviewer", "activity", "terminalPanel", "serversPanel", "tasksPanel", "verifier", "toolVerdict", "miner", "readCompaction", "trailCompaction", "cacheAccounting", "resumeIntent", "turnBudget", "receiptFixtures", "intentField", "approvalTakeover", "trajectory", "deliverables", "secretIntake", "sessionAwareness", "projectAwareness", "generalAwareness", "semanticFrame", "semanticInfer", "lessons", "usageMeter"])
    expect(unread.filter((n) => descriptorFor(n)!.meta === true)).toEqual([])
    // والجرد المطفأ لا يسجّل ولا يكذب: يُعيد القيمة ولا يبني صفّاً.
    const off = build({}, { inventoryOn: false })
    expect(off.note("rules", "turn")).toBe(true)
    expect(off.snapshot()).toEqual([])
  })

  test("inventory OFF still resolves the value; it only stops recording (absence, not [])", () => {
    const inventory = build({ walls: false }, { inventoryOn: false })
    expect(inventory.enabled).toBe(false)
    expect(inventory.read("walls", "turn")).toBe(false)
    expect(inventory.read("miner", "turn")).toBe(true)
    expect(inventory.snapshot()).toEqual([])
  })

  test("rules OFF makes a saved rule resolve to false through the inventory too", () => {
    const inventory = build({ verifier: { when: "rail == thin" } }, { rulesOn: false })
    expect(inventory.read("verifier", "turn")).toBe(false)
    expect(inventory.snapshot().find((r) => r.name === "verifier")).toMatchObject({ effective: false, why: "rules-disabled" })
    const live = build({ verifier: { when: "rail == thin" } })
    expect(live.read("verifier", "turn")).toBe(true)
    expect(live.snapshot().find((r) => r.name === "verifier")).toMatchObject({ effective: true, why: "rule-true", rule: "rail == thin" })
  })

  test("an env pin reaches the loop through the inventory and is named in the row", () => {
    const pins = resolvePlugins({ walls: true }, { ABDO_PLUGIN_WALLS: "0" }).pins
    const inventory = new PluginInventory({ walls: true }, ctx, { inventoryOn: true, rulesOn: true, pins })
    expect(inventory.read("walls", "turn")).toBe(false)
    expect(inventory.snapshot().find((r) => r.name === "walls")).toMatchObject({ effective: false, why: "pinned-env", pin: "ABDO_PLUGIN_WALLS" })
  })
})
