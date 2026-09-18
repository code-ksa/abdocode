import { describe, expect, test } from "bun:test"
import { LEGACY_LINES as L } from "../src/prompt-legacy-lines"
import {
  LAYER_BUDGETS, LAYER_ORDER, composeSystem, environmentLine, humanBytes, isoDate, legacyBaseSystem, systemReceiptLine, truncationMarker,
  type ComposeInput, type LayerName,
} from "../src/prompt-composer"
import { nativeAgentLayers, nativeAgentSystem } from "../src/native-agent-tools"

/**
 * S1 (2026-09-17) — مُركِّبُ رسالة النظام.
 *
 * المسمارُ الأوّل **بايتاً بايت**: الذهبُ في `fixtures/prompt-composer/legacy-golden.json`
 * التُقط بتقييم تعبير `baseSystem` القديم من الإيداع `e7181a7c36` نفسِه (لا من
 * المُركِّب) — انظر `capture-legacy.ts`. الذهبُ نصٌّ داخل JSON كي لا يقلبه
 * `core.autocrlf` على ويندوز (ذاكرة kernel-gate-line-endings).
 *
 * ولأنّ الفحصَ السلبيّ («لا فرق») يمرّ فارغاً إن كان المقارنُ أعمى: توأمُه الإيجابيّ
 * يقلب مدخلاً واحداً ويثبت أنّ الفرق يُرى.
 */
interface Golden { readonly capturedFrom: string; readonly fixtures: readonly { readonly name: string; readonly input: ComposeInput; readonly golden: string }[] }
const golden: Golden = await Bun.file(new URL("./fixtures/prompt-composer/legacy-golden.json", import.meta.url)).json()
const cliSource = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
const fixture = (name: string): ComposeInput => golden.fixtures.find((f) => f.name === name)!.input

/** أسطرُ النصّ غيرُ الفارغة، مرتّبةً — للمقارنة كمجموعةٍ متعدّدة (multiset). */
const linesOf = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).sort()

describe("S1 — الهجرةُ بايتاً بايت: legacyBaseSystem يساوي السلسلةَ القديمة", () => {
  test("الذهبُ مأخوذ من الإيداع السابق للتغيير، ويغطّي التدريبَ مفعّلاً ومطفأً ومرحلةَ التخطيط والمسارَ الأصيل", () => {
    expect(golden.capturedFrom).toBe("e7181a7c36:packages/engine/src/cli.ts")
    const names = golden.fixtures.map((f) => f.name)
    expect(names).toContain("text-coaching-on")
    expect(names).toContain("text-coaching-off")
    expect(names).toContain("text-planning-sprint-required")
    expect(names).toContain("native-execution")
    expect(golden.fixtures.length).toBeGreaterThanOrEqual(3)
  })

  for (const entry of golden.fixtures) {
    test(`«${entry.name}»: البايتات نفسُها`, () => {
      const mine = Buffer.from(legacyBaseSystem(entry.input), "utf8")
      const want = Buffer.from(entry.golden, "utf8")
      // أوّلُ بايتٍ مختلف يُسمّى — لا «غير متساوٍ» بلا عنوان.
      const firstDiff = mine.findIndex((b, i) => want[i] !== b)
      expect(firstDiff === -1 && mine.length === want.length ? "equal" : `diff at byte ${firstDiff} of ${want.length}: …${entry.golden.slice(Math.max(0, firstDiff - 40), firstDiff + 40)}…`).toBe("equal")
      expect(mine.equals(want)).toBe(true)
    })
  }

  test("التوأمُ الإيجابيّ: قلبُ مدخلٍ واحد يغيّر البايتات (المقارنُ يرى)", () => {
    const on = golden.fixtures.find((f) => f.name === "text-coaching-on")!
    const flipped = legacyBaseSystem({ ...on.input, coaching: false })
    expect(flipped).not.toBe(on.golden)
    expect(flipped.length).toBeLessThan(on.golden.length)
    const planning = legacyBaseSystem({ ...on.input, planningPhase: true })
    expect(planning).not.toBe(on.golden)
    const native = legacyBaseSystem({ ...on.input, mode: "native" })
    expect(native).not.toBe(on.golden)
  })

  test("المسارُ الأصيل: nativeAgentSystem يسبك الطبقاتِ المسمّاةَ بترتيبه القديم — لا نسختان من النصّ", () => {
    for (const planning of [true, false]) for (const required of [true, false]) for (const intent of [true, false]) {
      const N = nativeAgentLayers(planning, required, intent, "أنت في نمط «تلقائي».\n")
      const all = [...N.identity, ...N.outputFormat, ...N.toolContract, ...N.policy, ...N.coaching].filter((line) => line.length > 0)
      expect(linesOf(nativeAgentSystem(planning, required, intent, "أنت في نمط «تلقائي».\n"))).toEqual([...all].sort())
    }
  })
})

describe("S1 — الطبقاتُ المسمّاة: الأسطرُ نفسُها، ترتيبٌ ثابت، ميزانيّةٌ لكلّ طبقة", () => {
  test("الترتيبُ الثابت عشرُ طبقاتٍ والرأسُ الثابت أوّلاً", () => {
    expect([...LAYER_ORDER]).toEqual(["identity", "environment", "tool-contract", "policy", "semantic-frame", "playbook-hint", "skill", "project", "output-format", "coaching"])
    for (const name of LAYER_ORDER) expect(LAYER_BUDGETS[name]).toBeGreaterThan(0)
  })

  for (const entry of golden.fixtures) {
    test(`«${entry.name}»: التركيبُ الطبقيّ يعيد ترتيبَ أسطر السلسلة القديمة نفسِها بلا زيادةٍ ولا نقصان`, () => {
      const composed = composeSystem(entry.input)
      // السطرُ القديم الوحيد الذي كان يجمع جملتين (تدريب + لغة) يُفصل في الطبقات؛ المقارنةُ تفصله في الأصل أيضاً.
      const legacy = legacyBaseSystem(entry.input).replace(L.coachSuggestNext + L.replyLanguage, `${L.coachSuggestNext.trimEnd()}\n${L.replyLanguage}`)
      expect(linesOf(composed.text)).toEqual(linesOf(legacy))
      // لا طبقةَ تُقصّ على المثبّتات القائمة — الميزانيّاتُ فوق المقيس بهامش
      expect(composed.layers.every((layer) => !layer.truncated)).toBe(true)
      // (ب) لا جملةَ تظهر مرّتين
      const lines = composed.text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)
      expect(new Set(lines).size).toBe(lines.length)
      // الإيصالُ يحمل كلَّ طبقةٍ بترتيبها والبايتاتُ مجموعُها يساوي النصّ
      expect(composed.layers.map((layer) => layer.name)).toEqual([...LAYER_ORDER])
      expect(composed.layers.reduce((sum, layer) => sum + layer.bytes, 0)).toBe(Buffer.byteLength(composed.text, "utf8"))
      expect(composed.layers.map((layer) => layer.text).join("")).toBe(composed.text)
    })
  }

  test("الرأسُ الثابت (هويّة، عقدُ الأدوات، سياسة) يسبق المتغيّرَ بالدور (الإطار، المهارة، المشروع، صيغةُ الخرج، التدريب)", () => {
    const input: ComposeInput = { ...fixture("text-coaching-on"), semanticFrame: "لغة: ar · لهجة: gulf 80%", playbookHint: "عمليّة «deploy» — الدليل عند t_intent", skill: "SKILL-BODY\n", project: "\nActive project root: C:\\p\\demo.\n" }
    const text = composeSystem(input).text
    const at = (needle: string) => { const i = text.indexOf(needle); expect(i).toBeGreaterThanOrEqual(0); return i }
    expect(text.startsWith(L.identityWho)).toBe(true)
    expect(at(L.identityWho) < at("{{tool-catalogue}}")).toBe(true)
    expect(at("{{tool-catalogue}}") < at("أنت في نمط")).toBe(true)
    expect(at("أنت في نمط") < at("لغة: ar · لهجة: gulf")).toBe(true)
    expect(at("لغة: ar · لهجة: gulf") < at("t_intent")).toBe(true)
    expect(at("t_intent") < at("SKILL-BODY")).toBe(true)
    expect(at("SKILL-BODY") < at("Active project root")).toBe(true)
    expect(at("Active project root") < at(L.contractOneTool)).toBe(true)
    expect(at(L.contractOneTool) < at(L.coachNoCompany)).toBe(true)
    // والرأسُ بايتاً واحد بين دورين يختلفان في الإطار والمشروع — هذا ما يصيبه كاشُ المزوّد
    const other = composeSystem({ ...input, semanticFrame: "لغة: en", project: "\nActive project root: C:\\p\\other.\n" })
    const head = (t: string) => t.slice(0, t.indexOf("أنت في نمط"))
    expect(head(other.text)).toBe(head(text))
  })

  test("(أ) طبقةُ البيئة حتميّةٌ وقصيرة: ما غاب لا يُذكر، ولا تُخمَّن لغةٌ ولا لهجة", () => {
    expect(environmentLine(undefined)).toBe("")
    const full = environmentLine({ os: "Windows", shell: "Windows PowerShell 5.1", projectName: "demo-site", language: "ar", dialect: "gulf" })
    expect(full).toBe("البيئة: النظام Windows؛ الصدفة Windows PowerShell 5.1؛ المشروع «demo-site»؛ لغة الطلب ar؛ اللهجة gulf.\n")
    expect(environmentLine({ os: "Linux", shell: "bash" })).toBe("البيئة: النظام Linux؛ الصدفة bash.\n")
    expect(environmentLine({ os: "Linux", shell: "bash", language: "unknown", dialect: "unknown" })).toBe("البيئة: النظام Linux؛ الصدفة bash.\n")
    const composed = composeSystem({ ...fixture("text-coaching-off"), environment: { os: "Windows", shell: "Windows PowerShell 5.1", projectName: "demo-site" } })
    const env = composed.layers.find((layer) => layer.name === "environment")!
    expect(env.text).toContain("«demo-site»")
    expect(env.bytes).toBeLessThan(LAYER_BUDGETS.environment)
    // بلا مدخل بيئة: صفرُ بايت، لا سطرٌ فارغ
    expect(composeSystem(fixture("text-coaching-off")).layers.find((layer) => layer.name === "environment")!.bytes).toBe(0)
    // والحتميّة: المدخلُ نفسُه يعطي البايتاتِ نفسَها
    expect(composeSystem({ ...fixture("text-coaching-off"), environment: { os: "Windows", shell: "Windows PowerShell 5.1" } }).text).toBe(composeSystem({ ...fixture("text-coaching-off"), environment: { os: "Windows", shell: "Windows PowerShell 5.1" } }).text)
  })

  test("(أ٢) S11 — تاريخُ اليوم ISO في طبقة البيئة: يُذكر حين يصل صالحاً، ولا يُخمَّن ولا يُقبل مشوَّهاً، وcli.ts يمرّره من ساعة المحرّك", () => {
    // مقيس 2026-09-18: النموذجُ كتب 2026-02-23 في تقريرٍ لأنّ رسالةَ النظام لم تحمل اليوم.
    expect(environmentLine({ os: "Linux", shell: "bash", today: "2026-09-18" })).toBe("البيئة: النظام Linux؛ الصدفة bash؛ تاريخ اليوم 2026-09-18.\n")
    expect(environmentLine({ os: "Linux", shell: "bash", today: "18/09/2026" })).toBe("البيئة: النظام Linux؛ الصدفة bash.\n")
    expect(environmentLine({ os: "Linux", shell: "bash", today: "" })).toBe("البيئة: النظام Linux؛ الصدفة bash.\n")
    // التاريخُ المحلّيّ لا UTC — ساعةُ المستخدم؛ والصفرُ يُحشى.
    expect(isoDate(new Date(2026, 8, 5, 23, 59))).toBe("2026-09-05")
    expect(isoDate(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01")
    // الطبقةُ المركَّبة تحمله داخل ميزانيّتها.
    const env = composeSystem({ ...fixture("text-coaching-off"), environment: { os: "Windows", shell: "Windows PowerShell 5.1", today: "2026-09-18" } }).layers.find((layer) => layer.name === "environment")!
    expect(env.text).toContain("تاريخ اليوم 2026-09-18")
    expect(env.truncated).toBe(false)
    // cli.ts يمرّره من ساعة المحرّك في كلّ تركيب — لا من النموذج.
    expect(cliSource).toContain("today: isoDate(new Date())")
  })

  test("(ب) عقدُ «نفّذ:» — أداةٌ واحدة لكلّ ردّ — في طبقة صيغة الخرج وحدها ومرّةً واحدة", () => {
    for (const name of ["text-coaching-on", "text-coaching-off", "text-planning-sprint-required"]) {
      const composed = composeSystem(fixture(name))
      const output = composed.layers.find((layer) => layer.name === "output-format")!
      expect(output.text).toContain(L.contractOneTool)
      expect(output.text).toContain(L.contractReadBundle)
      expect(output.text).toContain(L.replyLanguage)
      expect(composed.text.split(L.contractOneTool).length - 1).toBe(1)
      for (const layer of composed.layers) if (layer.name !== "output-format") expect(layer.text).not.toContain("كل رد يستدعي أداة واحدة")
    }
    // والمسارُ الأصيل: قاعدةُ «أداة واحدة في الرد» في صيغة الخرج أيضاً
    const native = composeSystem(fixture("native-execution")).layers.find((layer) => layer.name === "output-format")!
    expect(native.text).toContain("أداة واحدة في الرد")
  })

  test("(ج) أسطرُ التدريب تحت rails.coaching وحده: مطفأً = طبقةٌ صفرُ بايت، مفعّلاً = كلُّها في طبقة التدريب لا خارجها", () => {
    const off = composeSystem(fixture("text-coaching-off"))
    expect(off.layers.find((layer) => layer.name === "coaching")!.bytes).toBe(0)
    const coachingLines = [L.coachNoCompany, L.coachLocateProject, L.coachStaleContext, L.coachNextMinimal, L.coachNextLatest, L.coachNoFabrication, L.coachComputeExpectation, L.coachKeepGoal, L.coachSuggestNext.trimEnd()]
    for (const line of coachingLines) expect(off.text).not.toContain(line)
    const on = composeSystem(fixture("text-coaching-on"))
    const coaching = on.layers.find((layer) => layer.name === "coaching")!
    for (const line of coachingLines) { expect(coaching.text).toContain(line); for (const layer of on.layers) if (layer.name !== "coaching") expect(layer.text).not.toContain(line) }
    // التخطيط: وصفةُ Next تسقط من التدريب كما كانت تسقط
    const planning = composeSystem(fixture("text-planning-sprint-required")).layers.find((layer) => layer.name === "coaching")!
    expect(planning.text).not.toContain(L.coachNextMinimal)
    expect(planning.text).toContain(L.coachNoFabrication)
  })

  test("الميزانيّة تعضّ: طبقةٌ فوق سقفها تُقصّ عند حدّ سطرٍ بعلامةٍ صريحة، وتُحسب بايتاتُها المبثوثة", () => {
    const line = `${"س".repeat(200)}\n`
    const project = Array.from({ length: 120 }, (_, i) => `${i}:${line}`).join("")
    expect(Buffer.byteLength(project, "utf8")).toBeGreaterThan(LAYER_BUDGETS.project)
    const composed = composeSystem({ ...fixture("text-coaching-off"), project })
    const layer = composed.layers.find((l) => l.name === "project")!
    expect(layer.truncated).toBe(true)
    expect(layer.bytes).toBeLessThanOrEqual(LAYER_BUDGETS.project)
    expect(layer.bytes).toBe(Buffer.byteLength(layer.text, "utf8"))
    // القصُّ عند حدّ سطر: آخرُ سطرٍ مُبقى كامل، والعلامةُ تليه وتسمّي الأرقام
    const body = layer.text.slice(0, layer.text.indexOf("⚠ طبقة"))
    expect(body.endsWith("\n")).toBe(true)
    expect(body.split("\n").filter((l) => l.length > 0).every((l) => /^\d+:س{200}$/u.test(l))).toBe(true)
    expect(layer.text.endsWith(truncationMarker("project", Buffer.byteLength(body, "utf8"), Buffer.byteLength(project, "utf8"), LAYER_BUDGETS.project))).toBe(true)
    expect(composed.text).toContain("⚠ طبقة «project» قُصّت")
    // الإيصالُ يسمّي القصّ
    expect(systemReceiptLine(composed.layers)).toContain("project 16k ⚠قُصّت")
    // سطرٌ أوّل أكبرُ من الميزانيّة كلِّها: العلامةُ وحدها، لا قطعٌ من وسط السطر
    const huge = composeSystem({ ...fixture("text-coaching-off"), semanticFrame: "ع".repeat(600) }).layers.find((l) => l.name === "semantic-frame")!
    expect(huge.truncated).toBe(true)
    expect(huge.text.startsWith("⚠ طبقة «semantic-frame»")).toBe(true)
    expect(huge.text).not.toContain("عع")
  })

  test("سطرُ الإيصال: الطبقاتُ غيرُ الفارغة بأحجامها والكتالوجُ إن قِيس والمجموعُ محسوب", () => {
    expect(humanBytes(412)).toBe("412b"); expect(humanBytes(1_234)).toBe("1.2k"); expect(humanBytes(1_000)).toBe("1k"); expect(humanBytes(12_345)).toBe("12k")
    const composed = composeSystem({ ...fixture("text-coaching-on"), environment: { os: "Windows", shell: "Windows PowerShell 5.1", projectName: "demo" } })
    const receipt = systemReceiptLine(composed.layers, 3_100)
    expect(receipt.startsWith("نظام: identity ")).toBe(true)
    expect(receipt).toContain("environment ")
    expect(receipt).toContain("tool-contract ")
    expect(receipt).toContain("output-format ")
    expect(receipt).toContain("coaching ")
    expect(receipt).toContain("كتالوج 3.1k")
    expect(receipt).not.toContain("skill ")
    expect(receipt).not.toContain("semantic-frame ")
    const total = composed.layers.reduce((sum, layer) => sum + layer.bytes, 0) + 3_100
    expect(receipt.endsWith(`= ${humanBytes(total)}`)).toBe(true)
    // الترتيبُ في الإيصال هو ترتيبُ الطبقات
    const names = receipt.slice("نظام: ".length).split(" · ").map((part) => part.split(" ")[0]) as LayerName[]
    const order = names.filter((name) => (LAYER_ORDER as readonly string[]).includes(name))
    expect(order).toEqual([...LAYER_ORDER].filter((name) => composed.layers.find((layer) => layer.name === name)!.bytes > 0))
  })

  test("cli.ts يسبك النظامَ بالمُركِّب ويبثّ الإيصالَ 🧾 مرّةً في الدور", () => {
    expect(cliSource).toContain("const composed = hooks.conversationMode === 'chat' ? undefined : composeSystem({")
    expect(cliSource).toContain("hooks.onSystemComposed?.(systemReceiptLine(composed.layers, catalogueBytes))")
    // مرّةً في الدور: قفلٌ يُصفَّر مع الدور، وخطّافٌ لا يُبثّ للأطفال ولا للمراجِع ولا للمدقّق
    expect(cliSource).toContain("let systemReceiptSent = false")
    expect(cliSource).toContain("onSystemComposed: (receipt) => { if (systemReceiptSent) return; systemReceiptSent = true; void emitEvent(turn.id, `🧾 ${receipt}`).catch(() => undefined) },")
    expect(cliSource).toContain("if (composed !== undefined && hooks.reviewSystem === undefined && hooks.childAgent === undefined && hooks.toolAllowlist === undefined)")
    // البيئةُ من المقيس: المنصّة والصدفة واسمُ المشروع ولغةُ الإطار ولهجتُه
    expect(cliSource).toContain('shell: process.platform === "win32" ? "Windows PowerShell 5.1" : "bash"')
    expect(cliSource).toContain("language: hooks.semanticFrame?.language.language, dialect: hooks.semanticFrame?.dialect.dialect")
    expect(cliSource).toContain("get semanticFrame() { return semanticFrameValue },")
    // لم يبقَ سبكٌ يدويّ لذيل النظام
    expect(cliSource).not.toContain("baseSystem + projectBootstrapInstruction(")
    expect(cliSource).not.toContain("legacyBaseSystem(composeInput)")
  })
})
