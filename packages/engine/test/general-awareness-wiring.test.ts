import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ProductTools } from "@abdo/tools"
import { SqliteFactStore } from "@abdo/memory"
import { descriptorFor } from "../src/plugin-registry"
import { GENERAL_STORE_FILE, PROMOTION_RULE } from "../src/general-awareness"
import { LAYER_LABEL, RECALL_NOTHING, RECALL_UNREAD } from "../src/awareness-index"
import { mergeProjectAwareness } from "../src/project-awareness"

// الوحدتان مختبَرتان نقيّتين في general-awareness.test وawareness-index.test؛
// هذا الملفّ يثبت أن `cli.ts` **يصل** بهما: حزمةٌ نقيّةٌ خضراء غير موصولة
// بالحلقة ليست قدرةً حيّة (المسح 2026-09-02).
const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

describe("S13.3 — المفتاح يمرّ بسجلّ المكوّنات وحده", () => {
  test("البطاقة معلَنةٌ بموصولٍ صادق وموضع قراءةٍ مقيس", () => {
    const descriptor = descriptorFor("generalAwareness")!
    expect(descriptor).toMatchObject({ defaultOn: true, applies: "next-turn", site: "turn", wired: true })
    expect(descriptor.requiresVault).toEqual([])
    // ووصفُ اللوحة يقول القضيبَ العابر بنصّه — لا «ذاكرة مشتركة» عاريةً.
    expect(descriptor.description).toContain("مشروع")
    expect(descriptor.description).toContain("المعطَّل = لا قراءة ولا كتابة")
  })

  test("القراءة من الجرد لا من الإعدادات مباشرة، ومرةً واحدة لكل دور", () => {
    expect(source).toContain('const generalAwarenessOn = plugins.read("generalAwareness", "turn")')
    expect(source.match(/plugins\.read\("generalAwareness"/gu)).toHaveLength(1)
    expect(source).not.toContain("plugins?.generalAwareness")
    // الأمرُ خارج الدور يقرأ المفتاح لحظةَ النداء بالمحلّل نفسه.
    expect(source.match(/pluginOnNow\("generalAwareness"\)/gu)).toHaveLength(2)
  })
})

describe("S13.3 — المخزن في دليل التثبيت، والكتابة خلف المفتاح", () => {
  test("المسار من STATE_ROOT — ولا يُبنى من مجلَّد مشروعٍ أبداً", () => {
    expect(source).toContain("const GENERAL_STORE_PATH = join(STATE_ROOT, GENERAL_STORE_FILE)")
    expect(source.match(/join\(STATE_ROOT, GENERAL_STORE_FILE\)/gu)).toHaveLength(1)
    expect(source).not.toContain("join(PROJECT_DIR, GENERAL_STORE_FILE)")
    expect(source).not.toContain("join(turnProjectDir, GENERAL_STORE_FILE)")
    expect(GENERAL_STORE_FILE).not.toContain("/")
  })

  test("الطفرة (ج): الكتابة داخل شرط المفتاح، وكتابةٌ واحدة لا غير", () => {
    const guard = source.indexOf("      if (generalAwarenessOn) {")
    const write = source.indexOf("writeFileSync(GENERAL_STORE_PATH, serialiseGeneralStore(promotion.store), \"utf8\")", guard)
    expect(guard).toBeGreaterThan(0)
    expect(write).toBeGreaterThan(guard)
    expect(source.match(/writeFileSync\(GENERAL_STORE_PATH/gu)).toHaveLength(1)
    // ولا قراءةَ للمخزن خارج المفتاح: القارئان كلاهما مشروطان.
    expect(source).toContain('if (pluginOnNow("generalAwareness")) entries.push(...entriesFromGeneral(readGeneralStore()))')
    // Reading learned history into a request additionally requires the owner's
    // history privacy setting; the independent generation/write gate remains.
    // هـ1 (2026-09-07): والقضبانُ ثالثُ الأبواب — الرفيعُ (سحابيّ) لا يحقن الوعيَ العامّ بأمر المالك.
    expect(source).toContain('const generalAwareness = !generalAwarenessOn || !memorySearchEnabled || !railsAtTurn.generalAwareness ? "" : (() => {')
  })

  test("الطفرة (أ): القرارُ في وحدة القاعدة وحدها — لا مفردةَ رفضٍ ثانية في المحرّك", () => {
    expect(source.match(/promoteLessons\(/gu)).toHaveLength(1)
    expect(source).toContain("qualifiedPlaybookCandidates(fired, completed)")
    // التأهيل شرطٌ لا زينة: الكتيّب لا يُرقّى إلا في دورٍ اكتمل.
    expect(source).not.toContain("qualifiedPlaybookCandidates(fired, true)")
    // ورموزُ مشروع الدور تُمرَّر فعلاً، من المجلَّد المُجمَّد لا من الرابط المتحرّك.
    expect(source).toContain("projectTokens: projectTokensOf(turnProjectDir),")
    expect(source).not.toContain("projectTokensOf(PROJECT_DIR)")
    // ولا فحصَ رفضٍ يدويّ بجوار القاعدة يفترق عنها في أسبوع.
    expect(source).not.toContain("projectIdentifyingTokens(")
  })

  test("المعرفةُ العامّة تدخل المدخل بعد طبقات القياس، وبترويسة نسبها", () => {
    // هـ2 (2026-09-07): خلاصةُ الوكيل الموجِّه تلي رصدَ المشروع مباشرةً — قياسٌ عن هذا المشروع لا معرفةٌ عامّة.
    const first = source.indexOf("? `${projectOrientation}${orientationBrief}${projectAwareness}")
    expect(first).toBeGreaterThan(0)
    const line = source.slice(first, source.indexOf("`", first + 4) + 1)
    expect(line.indexOf("${generalAwareness}")).toBeGreaterThan(line.indexOf("${priorRecall}"))
    expect(line.indexOf("${generalAwareness}")).toBeLessThan(line.indexOf("${turn.body}"))
    // الحقن مرةً واحدة (الحقبة الأولى) كأخته وعي المشروع — لا مرةً لكل حقبة.
    expect(source.match(/\$\{generalAwareness\}/gu)).toHaveLength(1)
  })
})

describe("S13.4 — الأمر والأداة موصولان", () => {
  test("`awareness` أمرُ مشرفٍ في المُوجِّه النصّي وفي argv معاً — وليس أداةَ نموذج", () => {
    expect(source).toContain('case "awareness": return awarenessCommand()')
    // نهايةُ السطر ليست جزءاً من الدعوى: `core.autocrlf` يقرّرها لكلّ نسخة
    // عمل، وتثبيتُ `\r\n` حرفياً يُسقط الاختبار على نسخةٍ بـLF بلا عيبٍ واحد.
    expect(source).toMatch(/case "awareness":\r?\n\s+console\.log\(awarenessCommand\(\)\)/u)
    expect(source).toContain("  awareness      طبقات الوعي الأربع")
    expect(ProductTools.isTool("awareness")).toBe(false)
    expect(ProductTools.agentCallable("awareness")).toBe(false)
  })

  test("`recall` أداةٌ في السجلّ الواحد — والكتالوج الذي يراه النموذج يُصاغ منه", () => {
    const spec = ProductTools.tool("recall")!
    expect(spec).toBeDefined()
    expect(spec).toMatchObject({ name: "recall", effect: "read", agentCallable: true, runner: "framed" })
    expect(spec.cloudOnly).toBeUndefined()
    // الإعلان: الكتالوج المحقون في رسالة النظام مبنيٌّ من السجلّ، فوجودها فيه
    // هو عينُ إعلانها للنموذج (محلياً وسحابياً معاً).
    expect(ProductTools.catalogue(false)).toContain("recall <سؤال>")
    expect(ProductTools.catalogue(true)).toContain("recall <سؤال>")
  })

  test("التوزيع يمرّ بالمُوجِّه الواحد: `framed` ⇒ executeBody ⇒ recallCommand", () => {
    // ب11 — المسمارُ يُرفع لا يُحذف: الموضوعُ كلُّه ما زال يمرّ (`tail.join(" ")`)، وأُضيف إليه **نطاقُ القراءة**
    // (جلسةٌ حيّة وإذنُ الحسّاس) لأنّ الأداة كانت تُقدّم ملاحظاتِ «هذه المحادثة» في كلّ محادثةٍ أخرى.
    expect(source).toContain('case "recall": return recallCommand(tail.join(" "), activeSessionId === undefined ? undefined : { sessionId: activeSessionId, allowSensitive: loadSettings().sensitiveMemoryEnabled === true })')
    expect(source).toContain("  recall <سؤال>")
    // الموضوع كلّه لا كلمته الأولى (عيب توصيلٍ مدفوع في `aware` سابقاً).
    expect(source).not.toContain('case "recall": return recallCommand(tail[0]')
  })

  test("الطفرة (ب): الجواب من البحث وحده — لا نصَّ بديلاً يملأ الفراغ", () => {
    expect(source).toContain("return recallSearch(asked, now.entries, { unread: unreadReasons(now) }).text")
    expect(source.match(/recallSearch\(/gu)).toHaveLength(1)
    // نصّ الغياب يعيش في الوحدة لا في المحرّك: مفردةٌ واحدة لا نظيرتان.
    expect(source).not.toContain(RECALL_NOTHING)
  })

  test("الطفرة (د): الفهرس يُبنى بالبنّاء الذي يفحص الطرفين — لا جدولَ يدويّ", () => {
    expect(source).toContain("const index = buildAwarenessIndex({ projectId: resolve(PROJECT_DIR), entries: now.entries })")
    expect(source.match(/buildAwarenessIndex\(/gu)).toHaveLength(1)
    // والطبقةُ غير المفتوحة تُمرَّر إلى العرض فتُقال، لا تُطبع صفراً كاذباً.
    expect(source).toContain("renderAwarenessIndex(index, 4000, now.unread)")
  })

  test("كلُّ طبقةٍ خلف مفتاحها — أداةُ النموذج لا تلتفّ على مفاتيح أخواتها", () => {
    // `recall` أداةٌ يناديها النموذج نفسه؛ فقراءتها لطبقةٍ مطفأة تحقن فيه عينَ
    // ما وعد المفتاحُ ألّا يُقرأ ولا يُحقن. القراءتان مشروطتان بالاسم.
    expect(source).toContain('const sessionOn = pluginOnNow("sessionAwareness")')
    expect(source).toContain('const projectOn = pluginOnNow("projectAwareness")')
    expect(source).toContain("if (!sessionOn) return")
    expect(source).toContain("if (!projectOn) unread.project =")
    // ولا قراءةَ لملفّ وعي المشروع خارج شرط مفتاحه.
    expect(source.match(/entriesFromProjectAwareness\(/gu)).toHaveLength(1)
    expect(source.match(/entriesFromSummary\(/gu)).toHaveLength(1)
  })

  test("الحقيقةُ تحمل جلستها إلى الجدول الرابط — والمسارُ الحيّ يُنتج الصفَّ الذي يختبره الفهرس", () => {
    // إسقاطُ `sessionId` هنا يُلغي نصفَ الجدول (مشروع↔جلسة↔حقائق) في الحيّ،
    // ويجعل سيناريو «جلسةٌ بلا خلاصة» غيرَ قابلٍ للحدوث خارج الاختبار.
    expect(source).toContain("...(fact.sessionId === undefined ? {} : { sessionId: fact.sessionId })")
    // والاستعلامُ لا يُقصي حقائقَ المشروع لأنها موسومةٌ بجلستها.
    // ب11 — الصفُّ ما زال يحمل جلستَه للجدول الرابط (المسمارُ أعلاه)، لكنّ **الصلاحيّة** تُقاس بالجلسة الحيّة حين
    // يقرأ النموذج: تمريرُ `fact.sessionId` كان يجعل كلَّ حقيقةٍ صالحةً لنفسها فيسقط نطاقُ «هذه المحادثة».
    expect(source).toContain("validFor(fact, { projectId, sessionId: scope === undefined ? fact.sessionId : scope.sessionId, now })")
    expect(source).toContain("const usable = scope === undefined ? scoped : withoutSensitive(scoped, scope.allowSensitive)")
  })

  test("طبقتا الذاكرة تُفتحان لأمر المشرف — و«لم تُقرأ» ليست «لا شيء مقيس»", () => {
    expect(source).toContain("const withAwarenessMemory = ")
    expect(source).toContain("if (currentMemory !== undefined) return use(currentMemory, undefined)")
    expect(source).toContain("const MEMORY_DB_PATH = join(STATE_ROOT, \"abdocode-memory.sqlite\")")
    // اتّصالٌ ثانٍ موجودٌ عمداً ومحصورٌ في هذا الباب وحده، ويُغلق بعده.
    expect(source.match(/new SqliteFactStore\(/gu)).toHaveLength(2)
    expect(source).toContain("opened.close()")
    expect(source).toContain('unread.turn = why ?? "الذاكرة الدائمة غير مفتوحة"')
  })

  test("مخزنٌ لا يُقرأ لا يُدهس: النسخةُ المجهولة ترفض الكتابة ولا تُمحى", () => {
    expect(source).toContain("const before = readGeneralStoreState()")
    expect(source).toContain("const promotion = !before.ok ? undefined : promoteLessons(before.store,")
    expect(source).toContain("رُفضت الكتابة في الوعي العام")
    // والقارئُ المتساهل لا يغذّي كتابةً: `parseGeneralStore` لم يعد هنا أصلاً.
    expect(source).not.toContain("promoteLessons(readGeneralStore()")
    expect(source).not.toContain("parseGeneralStore(")
  })

  test("أمرُ المشرف يطبع قاعدة الترقية بنصّها — العقد معروضٌ لا مخفيّ", () => {
    expect(source).toContain("PROMOTION_RULE.map((line) => `  ${line}`)")
    expect(PROMOTION_RULE.length).toBeGreaterThan(0)
  })

  test("الطبقات الأربع تُجمع من مصدرٍ واحد، والقشرةُ الحيّة تُعيد استعمال اتّصالها", () => {
    expect(source.match(/const awarenessEntriesNow = /gu)).toHaveLength(1)
    expect(source).toContain("currentMemory = durableMemory")
    for (const layer of ["entriesFromFacts(", "entriesFromSummary(", "entriesFromProjectAwareness(", "entriesFromGeneral("]) {
      expect(source, `الطبقة ${layer} غير موصولة`).toContain(layer)
    }
  })
})

// ---------------------------------------------------------------------------
// الحيّ لا المصدر — الأمر يُشغَّل على قرصٍ مبذور، ويُقرأ خرجه
// ---------------------------------------------------------------------------
//
// اختبارُ سلاسلِ المصدر يثبت أن السطر مكتوب، لا أنه يعمل. والعطلان اللذان
// أفلتا هنا كلاهما «مكتوبٌ ولا يعمل»: طبقتا الذاكرة كانتا صفراً دائماً خارج
// قشرة الخدمة (لا اتّصال)، وحقائقُ المشروع كانت صفراً دائماً حتى داخلها
// (استعلامٌ بلا جلسة يرفض كلّ حقيقةٍ موسومةٍ بجلسة). فهنا نبذر قرصاً ونسأله.

const ROOT = resolve(import.meta.dir, "../../..")
const scratch = mkdtempSync(join(tmpdir(), "abdo-awareness-live-"))
afterAll(() => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* التنظيف لا يُسقط اختباراً */ } })

const PROJECT = join(scratch, "proj")
const PROJECT_ID = resolve(PROJECT)
const FACT_TEXT = "npm run build ينجح ويصرّف بلا أخطاء إطلاقاً"
const SUMMARY_TEXT = "أُصلح انهيار البحث في صفحة النتائج"
const AWARENESS_TEXT = "الترحيل يعمل على القاعدة المحليّة بلا تدخّل"

mkdirSync(PROJECT, { recursive: true })
{
  const store = new SqliteFactStore(join(scratch, "abdocode-memory.sqlite"))
  const fact = store.record({ projectId: PROJECT_ID, sessionId: "s-1", kind: "project_fact", key: "build:passing", value: FACT_TEXT, sourceEventIds: ["evt-1"] })
  store.verify(fact.id)
  const summary = store.record({
    projectId: PROJECT_ID,
    sessionId: "s-1",
    kind: "project_fact",
    key: "session:s-1:summary",
    value: { sections: { done: [{ text: SUMMARY_TEXT, status: "measured" }] }, epochs: [1] },
    sourceEventIds: ["evt-2"],
  })
  store.verify(summary.id)
  store.close()
  const merged = mergeProjectAwareness("", { facts: [AWARENESS_TEXT], traps: [] })
  if ("refused" in merged) throw new Error(merged.refused)
  writeFileSync(join(PROJECT, "ABDO-AWARENESS.md"), merged.text, "utf8")
}

const runCli = (args: readonly string[], extra: Record<string, string> = {}): string => {
  const result = Bun.spawnSync([process.execPath, "packages/engine/src/cli.ts", ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      ABDO_CODE_STATE_DIR: scratch,
      ABDO_PROJECT: PROJECT,
      USERPROFILE: scratch,
      HOME: scratch,
      ...extra,
    },
  })
  return new TextDecoder().decode(result.stdout)
}

describe("S13.4 — الحيّ: `recall` و`awareness` من argv يقرآن الطبقات فعلاً", () => {
  test("حقيقةٌ موسومةٌ بجلستها تُسترجَع خارج قشرة الخدمة، بنسبها", () => {
    const out = runCli(["recall", "هل ينجح البناء"])
    expect(out).toContain(FACT_TEXT)
    expect(out).toContain(LAYER_LABEL.turn)
    expect(out).not.toContain(RECALL_NOTHING)
  })

  test("خلاصةُ الجلسة ووعيُ المشروع يُقرآن أيضاً — والوصلات تُبنى بطرفَيها", () => {
    expect(runCli(["recall", "انهيار البحث"])).toContain(SUMMARY_TEXT)
    expect(runCli(["recall", "الترحيل والقاعدة"])).toContain(AWARENESS_TEXT)
    const index = runCli(["awareness"])
    expect(index).toContain("project→session")
    expect(index).toContain("session→summary")
    expect(index).toContain("project→fact")
    expect(index).toContain("project→awareness")
  })

  test("المفتاحُ المطفأ يطفئ طبقته في `recall` — ويُقال «لم تُقرأ» لا «لا شيء مقيس»", () => {
    const noProject = runCli(["recall", "الترحيل والقاعدة"], { ABDO_PLUGIN_PROJECT_AWARENESS: "0" })
    expect(noProject).not.toContain(AWARENESS_TEXT)
    expect(noProject).toContain(RECALL_UNREAD)
    const noSession = runCli(["recall", "انهيار البحث"], { ABDO_PLUGIN_SESSION_AWARENESS: "0" })
    expect(noSession).not.toContain(SUMMARY_TEXT)
    expect(noSession).toContain(RECALL_UNREAD)
    // والحقيقةُ نفسها ما زالت تُقرأ: الإطفاء لطبقته وحدها لا لما جاوره.
    expect(runCli(["recall", "هل ينجح البناء"], { ABDO_PLUGIN_PROJECT_AWARENESS: "0" })).toContain(FACT_TEXT)
  })

  test("سؤالٌ عن غير المقيس يعود غياباً — لا أقربَ سطرٍ موجود", () => {
    const out = runCli(["recall", "ما هو المنفذ في الخادم"])
    expect(out).toContain(RECALL_NOTHING)
    expect(out).not.toContain(FACT_TEXT)
    expect(out).not.toContain(SUMMARY_TEXT)
    expect(out).not.toContain(AWARENESS_TEXT)
  })
})
