/**
 * إيصالٌ فشل لا يُروى نجاحاً — مقيس 2026-09-27 على وكيلَين متوازيَين: كتابةُ الثاني رُفضت
 * («journal writer is busy … nothing was executed»)، ومع ذلك قال موجزُ الطفل «كتبتَ: beta.txt»،
 * وعدّها التقريرُ «منفَّذة: 1 · المرفوضة: 0»، فبنى الأبُ على ملفٍّ غير موجود.
 */
import { expect, test } from "bun:test"
import { runTextAgentLoop } from "@abdo/engine-host"
import { BUILTIN_AGENT_FILES, buildAgentCatalogue, findAgent } from "../src/agent-definitions"
import { renderDelegateReport, runDelegatedAgent } from "../src/delegation"
import { TurnAwareness } from "../src/turn-awareness"

const builder = findAgent(buildAgentCatalogue([...BUILTIN_AGENT_FILES]), "builder")!

test("awareness records a write only when its verdict proved success", () => {
  const awareness = new TurnAwareness()
  awareness.observe("write beta.txt <<<", "رُفض/فشل المحوّل: effect_barrier_not_recorded", 1, false)
  expect(awareness.brief()).not.toContain("beta.txt")
  // التوأمُ الإيجابيّ: الكتابةُ الناجحة تدخل «كتبتَ».
  awareness.observe("write alpha.txt <<<", "⚙ write alpha.txt", 1, true)
  expect(awareness.brief()).toContain("كتبتَ: alpha.txt")
  expect(awareness.brief()).not.toContain("beta.txt")
})

test("a child's refused write is reported as failed with its reason, not as simply executed", async () => {
  for (const ok of [false, true]) {
    const replies = ["نفّذ: write beta.txt <<<\nBBB", "انتهيت."]
    const report = await runDelegatedAgent({
      agent: builder,
      task: "اكتب ملفّ beta",
      depth: 1,
      ask: async () => replies.shift() ?? "انتهيت.",
      dispatch: async () => ok
        ? { output: "⚙ write beta.txt", verdict: { ok: true } }
        : { output: "رُفض/فشل المحوّل: effect_barrier_not_recorded", verdict: { ok: false, reason: "admission_refused", denied: false, detail: "journal writer is busy" } },
      runLoop: runTextAgentLoop,
      maxRounds: 2,
      maxEpochs: 1,
    })
    const text = renderDelegateReport(report)
    expect(report.commands).toHaveLength(1)
    if (ok) {
      expect(report.failures).toEqual([])
      // لا سطرَ فشلٍ حين لا فشل — شكلُ التقرير القديم كما هو.
      expect(text).not.toContain("فشلت")
    } else {
      expect(report.failures).toHaveLength(1)
      expect(text).toContain("الأدوات المنفَّذة: 1 · فشلت: 1 · المرفوضة: 0")
      expect(text).toContain("⚠ فشلت: write beta.txt <<< — admission_refused: journal writer is busy")
    }
  }
})
