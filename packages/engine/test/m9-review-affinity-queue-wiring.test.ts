// م9ح/م9ز/م9هـ — مسامير أسلاك cli.ts: الطابورُ يغلّف قطاعَ الكتابة كلَّه، وبصمةُ الجلسة تُضبط حيث تتغيّر الجلسة وتمرّ في الطلب
// ما لم تُطفأ، وحارةُ المراجعة كلمةُ مشغّلٍ قبل كلمات نقاط الرجوع وتنادي العدساتِ بلا أدوات.
import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()
const ui = await Bun.file(new URL("../../desktop/ui/native-local-settings.js", import.meta.url)).text()

describe("م9هـ — write queue wiring", () => {
  test("runWriteToolV derives the key, announces the wait before it, and runs the whole unqueued section inside the queue", () => {
    expect(source).toContain('import { FileMutationQueue, queueWaitLine } from "./file-mutation-queue"')
    const wrapper = source.indexOf("const runWriteToolV = async (word: string, body: string, turnId: string, hooks: AskHooks, nativeCall?: NativeAgentCall)")
    const unqueued = source.indexOf("const runWriteToolUnqueued = async (word: string, body: string, turnId: string, _hooks: AskHooks, nativeCall?: NativeAcall".replace("NativeAcall", "NativeAgentCall"))
    expect(wrapper).toBeGreaterThan(0); expect(unqueued).toBeGreaterThan(wrapper)
    const section = source.slice(wrapper, unqueued)
    expect(section).toContain("const ahead = writeQueue.pending(key)")
    expect(section.indexOf("if (ahead > 0) await emitEvent(turnId, queueWaitLine(target, ahead))")).toBeLessThan(section.indexOf("return writeQueue.run(key, () => runWriteToolUnqueued(word, body, turnId, hooks, nativeCall))"))
    // القطاعُ القديم (خطُّ الأساس ⇦ البوّابة ⇦ فحصُ القرص ⇦ الأثر) يعيش داخل الدالّة المغلَّفة وحدها
    const baseline = source.indexOf("const baseline = word === \"write\" ? diskBefore : before", unqueued)
    expect(baseline).toBeGreaterThan(unqueued)
    expect(source.match(/writeQueue\.run\(/gu) ?? []).toHaveLength(1)
    // لا نداءَ مباشراً للمغلَّفة من خارج الغلاف (الموزِّع ينادي runWriteToolV)
    expect(source.match(/runWriteToolUnqueued\(/gu) ?? []).toHaveLength(2) // مساران داخل الغلاف وحدهما (التعريف `= async (`)
    expect(source.match(/const runWriteToolUnqueued = async \(/gu) ?? []).toHaveLength(1)
    expect(source).toContain("return runWriteToolV(spec.name, body, turnId, hooks, nativeCall)")
  })
})

describe("م9ز — session affinity wiring", () => {
  test("module-level id derived by hashing, set at both session-change sites, sent in the main request unless the setting is off", () => {
    expect(source).toContain('let sessionAffinityId = ""')
    expect(source).toContain('const sessionAffinityFor = (sessionId: string): string => `abdo-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`')
    expect(source.match(/sessionAffinityId = sessionAffinityFor\(currentSession\)/gu) ?? []).toHaveLength(2)
    expect(source.match(/currentSession = `s-\$\{Date\.now\(\)\}`/gu) ?? []).toHaveLength(2)
    expect(source).toContain("...(sessionAffinityId.length > 0 && loadSettings().sessionAffinity !== false ? { sessionAffinity: sessionAffinityId } : {}),")
    // على مستوى الوحدة لا داخل serve — فخُّ turnFamilies (module-scope-vs-serve-scope-in-cli)
    expect(/^let sessionAffinityId = ""/mu.test(source)).toBe(true)
  })
  test("the setting exists, is validated, and has a row in the desktop privacy panel", () => {
    expect(source).toContain("  sessionAffinity?: boolean")
    expect(source).toContain('"sellPlan", "sessionAffinity"])')
    expect(source).toContain('if (value.sessionAffinity !== undefined && typeof value.sessionAffinity !== "boolean") return "sessionAffinity يحتاج قيمة منطقية"')
    expect(ui).toContain("snap.settings.sessionAffinity!==false,v=>api.applyRuntimeSettings({sessionAffinity:v})")
  })
})

describe("م9ح — review lane wiring", () => {
  test("«review» is an operator word before the checkpoint words, reads changes from the checkpoint or git, and asks each lens without tools", () => {
    expect(source).toContain('import { buildReviewPrompt, judgeReview, parseReviewFindings, renderReviewReport, REVIEW_LENSES, REVIEW_SYSTEM, reviewDiffText, type ReviewChange } from "./review-lane"')
    expect(source).toContain('import { gitChanges, gitState } from "./git-state"')
    const review = source.indexOf("const review = /^\\/?review(?:\\s+(\\S+))?$/iu.exec(turn.body.trim()) ?? /^راجع (?:تغييراتي|التغييرات)(?:\\s+(\\S+))?$/u.exec(turn.body.trim())")
    const checkpointsWord = source.indexOf("if (/^\\/?checkpoints$/iu.test(turn.body.trim())")
    expect(review).toBeGreaterThan(0); expect(checkpointsWord).toBeGreaterThan(review)
    const block = source.slice(review, checkpointsWord)
    expect(block).toContain("changes = checkpoints.changes(currentSession, chosen, PROJECT_DIR)")
    expect(block).toContain("changes = gitChanges(PROJECT_DIR)")
    expect(block).toContain("if (changes.length === 0) return { answer:")
    expect(block).toContain("REVIEW_LENSES.map(async (lens) => {")
    expect(block).toContain("{ ...hooks, onDelta: undefined, toolAllowlist: [], reviewSystem: REVIEW_SYSTEM }, [], turnSelection)")
    expect(block).toContain("const outcome = judgeReview(findings)")
    expect(block).toContain("return { answer: renderReviewReport(outcome, diff), completed: true }")
    // الكلفةُ تُقال قبل الإنفاق؛ والحكمُ يحمله التقريرُ وحده (مقيس حيّاً 09-14: كان يظهر مرّتين حدثاً ثمّ صدرَ التقرير)
    expect(block.indexOf("ثلاثةُ نداءات")).toBeLessThan(block.indexOf("await ask("))
    expect(block).not.toContain("await emitEvent(turn.id, outcome.line)")
    expect(block).toContain("return { answer: renderReviewReport(outcome, diff), completed: true }")
  })
})
