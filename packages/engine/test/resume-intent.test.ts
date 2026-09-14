import { describe, expect, test } from "bun:test"
import { SqliteFactStore } from "@abdo/memory"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { classifyModelLane } from "@abdo/providers"
import { isResumeIntent, pickPriorGoal, priorGoalStatusLabel, resumeAnnouncement, resumeBrief } from "../src/resume-intent"

const BARE_RESUMES = [
  "اكمل من حيث توقفت",
  "واصل",
  "continue",
  "  أكمل من حيث انتهيت، من فضلك.  ",
  "يا عبدو كمّل الآن",
  "Resume where you left off please",
  "carry on",
  "كمل",
  "تابع",
  "من فضلك، اكمل",
]

describe("resume intent — آلية «اكمل من حيث توقفت»", () => {
  test("continuation completion survives reopening durable memory and stays scoped", () => {
    const folder = mkdtempSync(join(tmpdir(), "abdo-resume-lineage-"))
    const file = join(folder, "memory.sqlite")
    let store = new SqliteFactStore(file, () => 1_000)
    try {
      for (const [turn, status, resumedFrom] of [["first", "checkpointed", undefined], ["second", "checkpointed", "first"], ["final", "completed", "second"]]) {
        const fact = store.record({ projectId: "project-a", sessionId: "session-a", kind: "active_task", key: `turn:${turn}`, value: { goal: "Build the CRM", status, resumedFrom }, sourceEventIds: [turn!] })
        store.verify(fact.id)
      }
      store.close()
      store = new SqliteFactStore(file, () => 2_000)
      expect(pickPriorGoal(store.query({ projectId: "project-a", sessionId: "session-a", now: 2_000 }).facts)).toEqual({ goal: "Build the CRM", turnId: "final", status: "completed" })
      expect(pickPriorGoal(store.query({ projectId: "project-b", sessionId: "session-a", now: 2_000 }).facts)).toBeUndefined()
      expect(pickPriorGoal(store.query({ projectId: "project-a", sessionId: "session-b", now: 2_000 }).facts)).toBeUndefined()
    } finally {
      store.close()
      if (!resolve(folder).startsWith(resolve(tmpdir()) + "/") && !resolve(folder).startsWith(resolve(tmpdir()) + "\\")) throw new Error("Unexpected fixture path")
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test("a completed continuation closes its earlier checkpoints without closing unrelated work", () => {
    const facts = [
      {key:"turn:first",value:{goal:"Build CRM with tests",status:"checkpointed"}},
      {key:"turn:second",value:{goal:"Build CRM with tests",status:"checkpointed",resumedFrom:"first"}},
      {key:"turn:final",value:{goal:"Build CRM with tests",status:"completed",resumedFrom:"second"}},
    ];
    expect(pickPriorGoal(facts)).toEqual({goal:"Build CRM with tests",turnId:"final",status:"completed"});
    expect(pickPriorGoal([{key:"turn:other",value:{goal:"Fix invoice export",status:"checkpointed"}},...facts])?.turnId).toBe("other");
  })

  test("latest turn state wins and a mismatched continuation cannot hide another goal", () => {
    expect(pickPriorGoal([{key:"turn:a",value:{goal:"Build CRM",status:"running"}},{key:"turn:a",value:{goal:"Build CRM",status:"completed"}}])?.status).toBe("completed");
    expect(pickPriorGoal([{key:"turn:a",value:{goal:"Build CRM",status:"checkpointed"}},{key:"turn:b",value:{goal:"Other work",status:"completed",resumedFrom:"a"}}])?.turnId).toBe("a");
  })
  test("a bare resume instruction is a resume intent", () => {
    for (const body of BARE_RESUMES) expect(isResumeIntent(body)).toBe(true)
  })

  test("a resume verb followed by a goal is a goal, not a resume", () => {
    expect(isResumeIntent("أكمل خطة اسبرينتات إيدو جلوبال")).toBe(false)
    expect(isResumeIntent("اكمل: ابنِ صفحة الدورات")).toBe(false)
    expect(isResumeIntent("continue building the courses page")).toBe(false)
    expect(isResumeIntent("اكمل الاسبرنت")).toBe(false)
  })

  // R2-02: الحمولة حروفٌ وأرقام — معرّفٌ قصير أو رقم هدفٌ لا يُسقَط بصمت.
  test("a digit or short identifier after the verb is a payload — the turn stays a goal", () => {
    expect(isResumeIntent("اكمل S3")).toBe(false)
    expect(isResumeIntent("اكمل 2")).toBe(false)
    expect(isResumeIntent("اكمل ٢")).toBe(false)
    expect(isResumeIntent("continue #4")).toBe(false)
    expect(isResumeIntent("اكمل ok")).toBe(false)
  })

  // R2-01: الزينة وحدها لا تُطلق الاستئناف — لا فعل = لا استبدالٍ للهدف من الذاكرة.
  test("politeness or vocative decorations alone are not a resume intent", () => {
    expect(isResumeIntent("من فضلك")).toBe(false)
    expect(isResumeIntent("please")).toBe(false)
    expect(isResumeIntent("الآن")).toBe(false)
    expect(isResumeIntent("يا عبدو")).toBe(false)
    expect(isResumeIntent("ok please")).toBe(false)
    expect(isResumeIntent("يا عبدو من فضلك الآن")).toBe(false)
  })

  test("empty text and text without a resume verb are not resume intents", () => {
    expect(isResumeIntent("")).toBe(false)
    expect(isResumeIntent("   ")).toBe(false)
    expect(isResumeIntent("ok")).toBe(false)
    expect(isResumeIntent("ابنِ صفحة الدورات")).toBe(false)
    // «تابع» داخل كلمةٍ أطول ليس فعلاً مستقلاً.
    expect(isResumeIntent("المتابعة")).toBe(false)
    expect(isResumeIntent("pleased")).toBe(false)
  })

  // R2-03: قائمة أفعال واحدة — كلُّ استئنافٍ يُوجَّه إلى مسار الوكيل، لأنّه يرث بوابات البناء/الاختبار.
  test("every resume intent routes to the agent lane (one verb list, not two)", () => {
    for (const body of BARE_RESUMES) {
      expect(isResumeIntent(body)).toBe(true)
      expect(classifyModelLane(body)).toBe("agent")
    }
    expect(classifyModelLane("تابع خطة الاسبرنتات")).toBe("agent")
    expect(classifyModelLane("من فضلك")).toBe("chat")
    expect(classifyModelLane("ok")).toBe("chat")
  })

  test("pickPriorGoal takes the latest real turn goal and skips epoch facts and resume-goal turns", () => {
    const facts = [
      { key: "turn:t1", value: { goal: "ابنِ صفحة الدورات مع اختبارات", status: "completed" } },
      { key: "turn:t1:epoch:1", value: { goal: "ابنِ صفحة الدورات مع اختبارات", commands: [] } },
      { key: "build:passing", value: "npm run build ينجح" },
      { key: "turn:t2", value: { goal: "أكمل خطة اسبرينتات إيدو جلوبال", status: "checkpointed" } },
      { key: "turn:t2:epoch:1", value: { goal: "أكمل خطة اسبرينتات إيدو جلوبال", commands: [] } },
      { key: "turn:t3", value: { goal: "اكمل من حيث توقفت", status: "running" } },
      { key: "turn:t3:epoch:1", value: { goal: "اكمل من حيث توقفت", commands: [] } },
    ]
    expect(pickPriorGoal(facts)).toEqual({ goal: "أكمل خطة اسبرينتات إيدو جلوبال", turnId: "t2", status: "checkpointed" })
  })

  // R2-05: الحالة تُستهلَك — المعلّق يسبق المكتمل؛ والمكتمل وحده يُعاد بحالته لا يُخفى.
  test("pickPriorGoal prefers an unfinished goal over a newer completed one, and reports a lone completed goal", () => {
    const facts = [
      { key: "turn:t1", value: { goal: "ابنِ صفحة الدورات مع اختبارات", status: "checkpointed" } },
      { key: "turn:t2", value: { goal: "أصلح صفحة الاتصال", status: "completed" } },
    ]
    expect(pickPriorGoal(facts)).toEqual({ goal: "ابنِ صفحة الدورات مع اختبارات", turnId: "t1", status: "checkpointed" })
    expect(pickPriorGoal([{ key: "turn:t1", value: { goal: "هدف قديم", status: "completed" } }, { key: "turn:t2", value: { goal: "هدف أحدث", status: "completed" } }]))
      .toEqual({ goal: "هدف أحدث", turnId: "t2", status: "completed" })
    // بلا حالة = غير مختوم: يسبق المكتمل.
    expect(pickPriorGoal([{ key: "turn:t1", value: { goal: "هدف بلا حالة" } }, { key: "turn:t2", value: { goal: "هدف مكتمل", status: "completed" } }]))
      .toEqual({ goal: "هدف بلا حالة", turnId: "t1" })
  })

  // IDEA 4 (routerGate): a turn the front gate answered without tools is never a goal — «اكمل» after a
  // gate-answered greeting resumes the last REAL goal; an answered fact alone yields no goal at all.
  test("pickPriorGoal skips gate-answered turns and never returns one even when it is the only fact", () => {
    const answered = { key: "turn:b", value: { goal: "مرحبا", status: "answered", epochs: 0, commands: 0, stopReason: "gate-answered" } }
    expect(pickPriorGoal([{ key: "turn:a", value: { goal: "ابنِ الموقع", status: "completed" } }, answered]))
      .toEqual({ goal: "ابنِ الموقع", turnId: "a", status: "completed" })
    expect(pickPriorGoal([{ key: "turn:a", value: { goal: "ابنِ الموقع", status: "checkpointed" } }, answered]))
      .toEqual({ goal: "ابنِ الموقع", turnId: "a", status: "checkpointed" })
    expect(pickPriorGoal([answered])).toBeUndefined()
    expect(pickPriorGoal([answered, { key: "turn:c", value: { goal: "ما حالة المشروع؟", status: "answered" } }])).toBeUndefined()
    expect(priorGoalStatusLabel("answered")).toBe("أُجيب مباشرة")
  })

  test("pickPriorGoal ignores malformed values and returns undefined when no real goal exists", () => {
    expect(pickPriorGoal([])).toBeUndefined()
    expect(pickPriorGoal([{ key: "turn:t9", value: { goal: "واصل" } }])).toBeUndefined()
    expect(pickPriorGoal([{ key: "turn:t9", value: "نصّ لا كائن" }, { key: "turn:t8", value: { goal: 42 } }, { key: "turn:t7", value: { goal: "   " } }])).toBeUndefined()
    expect(pickPriorGoal([{ key: "turn:t9:epoch:2", value: { goal: "هدف حقيقي" } }])).toBeUndefined()
    // status اختياري: يُحذف حين ليس نصّاً.
    expect(pickPriorGoal([{ key: "turn:t5", value: { goal: "هدف حقيقي" } }])).toEqual({ goal: "هدف حقيقي", turnId: "t5" })
  })

  // R1-01: حقائق الأدوار موسومة بجلستها؛ استعلامٌ بلا جلسة يرفضها كلّها فلا يستأنف شيء.
  test("a turn fact recorded with a sessionId through SqliteFactStore is picked only by a session-scoped query", () => {
    const store = new SqliteFactStore(":memory:", () => 1_000)
    const projectId = "C:/projects/taalim"
    const started = store.record({
      projectId,
      sessionId: "sess-1",
      kind: "active_task",
      key: "turn:t1",
      value: { goal: "ابنِ صفحة الدورات مع اختبارات", status: "running", project: projectId },
      sourceEventIds: ["t1"],
    })
    store.verify(started.id)
    const finished = store.supersede(started.id, {
      projectId,
      sessionId: "sess-1",
      kind: "active_task",
      key: "turn:t1",
      value: { goal: "ابنِ صفحة الدورات مع اختبارات", status: "checkpointed", epochs: 2, commands: 5, stopReason: "budget" },
      sourceEventIds: ["t1"],
    })
    store.verify(finished.id)
    try {
      const scoped = store.query({ projectId, sessionId: "sess-1", now: 2_000 })
      expect(scoped.facts.map((f) => f.key)).toEqual(["turn:t1"])
      expect(pickPriorGoal(scoped.facts)).toEqual({ goal: "ابنِ صفحة الدورات مع اختبارات", turnId: "t1", status: "checkpointed" })
      // الفخّ المقيس: بلا جلسة تُرفض الحقيقة (scoped to session) ولا هدف يُستأنف.
      const unscoped = store.query({ projectId, now: 2_000 })
      expect(unscoped.facts).toHaveLength(0)
      expect(unscoped.rejected.some((r) => r.why.startsWith("scoped to session sess-1"))).toBe(true)
      expect(pickPriorGoal(unscoped.facts)).toBeUndefined()
      // جلسةٌ أخرى لا ترى هدف جلسةٍ غيرها.
      expect(pickPriorGoal(store.query({ projectId, sessionId: "sess-2", now: 2_000 }).facts)).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test("resumeBrief is one line naming the original goal and the hand-off files", () => {
    const brief = resumeBrief({ goal: "أكمل خطة اسبرينتات إيدو جلوبال", turnId: "t2" })
    expect(brief).toBe("↩ استئناف: الهدف الأصلي من الدور t2: «أكمل خطة اسبرينتات إيدو جلوبال». اقرأ ABDO-HANDOFF.md وNEXT_ACTION.md ثم واصل من أول سبرنت غير مكتمل بإيصالات حقيقية.\n")
    expect(brief.trimEnd().split("\n")).toHaveLength(1)
  })

  // R2-05: الحالة تُصرَّح بها للنموذج وللمشغّل.
  test("resumeBrief and resumeAnnouncement state the prior goal's status", () => {
    const checkpointed = { goal: "ابنِ صفحة الدورات", turnId: "t1", status: "checkpointed" }
    expect(resumeBrief(checkpointed)).toBe("↩ استئناف: الهدف الأصلي من الدور t1: «ابنِ صفحة الدورات». حالته: نقطة حفظ غير مكتملة. اقرأ ABDO-HANDOFF.md وNEXT_ACTION.md ثم واصل من أول سبرنت غير مكتمل بإيصالات حقيقية.\n")
    expect(resumeBrief({ ...checkpointed, status: "completed" })).toContain("حالته: مكتمل — تحقّق من NEXT_ACTION.md قبل إعادة العمل.")
    expect(resumeBrief({ ...checkpointed, status: "completed" }).trimEnd().split("\n")).toHaveLength(1)
    expect(resumeAnnouncement(checkpointed)).toBe("↩ استئناف الهدف الأصلي (الدور t1 · نقطة حفظ غير مكتملة): ابنِ صفحة الدورات")
    expect(resumeAnnouncement({ goal: "ابنِ صفحة الدورات", turnId: "t1" })).toBe("↩ استئناف الهدف الأصلي (الدور t1): ابنِ صفحة الدورات")
    expect(resumeAnnouncement({ goal: "x".repeat(200), turnId: "t1", status: "running" })).toBe(`↩ استئناف الهدف الأصلي (الدور t1 · لم يُختَم): ${"x".repeat(160)}`)
  })
})
