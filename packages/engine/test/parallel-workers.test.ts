import { describe, expect, test } from "bun:test"
import { PARALLEL_MAX, mergeBranchRefusal, parseParallelTasks, renderParallelReport } from "../src/parallel-workers"

// 09-29 — فكرةُ Verdent على نظامنا: عمّالٌ متوازون في worktrees عبر exec --worktree، والدمجُ قرارٌ صريح.
describe("parallel workers — parsing", () => {
  test("a <<< block gives one task per line, numbering stripped, comments ignored; inline || also works", () => {
    expect(parseParallelTasks("parallel <<<\n1. أنشئ صفحة /about بنصٍّ تعريفيّ واختبرها\n# تعليق\n2) أضف مسار /api/health يعيد {ok:true}\n")).toEqual([
      "أنشئ صفحة /about بنصٍّ تعريفيّ واختبرها",
      "أضف مسار /api/health يعيد {ok:true}",
    ])
    expect(parseParallelTasks("parallel اكتب اختبارات لوحدة math في test/math.test.js || اكتب README يشرح التشغيل والاختبار")).toHaveLength(2)
  })

  test("refuses fewer than two, more than the cap, duplicates, and tasks too short to delegate", () => {
    expect(parseParallelTasks("parallel <<<\nمهمّةٌ واحدة كاملة الوصف هنا")).toContain("مهمّتين")
    const many = Array.from({ length: PARALLEL_MAX + 1 }, (_, i) => `مهمّة رقم ${i} بوصفٍ كافٍ للتفويض`).join("\n")
    expect(parseParallelTasks(`parallel <<<\n${many}`)).toContain(String(PARALLEL_MAX))
    expect(parseParallelTasks("parallel <<<\nمهمّة مكرّرة بوصفٍ كافٍ\nمهمّة مكرّرة بوصفٍ كافٍ")).toContain("متطابقتان")
    expect(parseParallelTasks("parallel <<<\nقصيرة\nمهمّة أخرى بوصفٍ كافٍ للتفويض")).toContain("أقصر")
  })
})

describe("parallel workers — report and merge guard", () => {
  test("the report names each worker's branch, files and summary, and lists merge commands only for committed branches", () => {
    const text = renderParallelReport([
      { task: "صفحة about", outcome: "completed", durationMs: 61_000, toolCount: 7, failedTools: 0, branch: "abdocode/task-1a2b3c4d", commit: "abc1234", changedFiles: ["src/app/about/page.tsx"], answer: "أُنشئت الصفحة.", gates: "بوابات القبول: البناء ✓ نجح" },
      { task: "health", outcome: "checkpointed", stop: "turn_budget", durationMs: 120_000, toolCount: 3, failedTools: 1, branch: "abdocode/task-9f8e7d6c", changedFiles: [], answer: "" },
      { task: "x", outcome: "error", durationMs: 10, toolCount: 0, failedTools: 0, changedFiles: [], answer: "", reason: "--worktree يحتاج مستودعَ git" },
    ])
    expect(text).toContain("عمّالٌ متوازون: 3")
    expect(text).toContain("[1] completed · 7 أداة · 61 ث")
    expect(text).toContain("الفرع: abdocode/task-1a2b3c4d @ abc1234 · الملفّات: src/app/about/page.tsx")
    expect(text).toContain("[2] checkpointed (turn_budget) · 3 أداة (1 فشلت)")
    expect(text).toContain("بلا إيداع")
    expect(text).toContain("⚠ --worktree يحتاج مستودعَ git")
    expect(text).toContain("للدمج (واحداً واحداً، وابنِ/اختبر بعد كلّ دمج): merge abdocode/task-1a2b3c4d")
    expect(text).not.toContain("merge abdocode/task-9f8e7d6c")
  })

  test("merge accepts only worker branches", () => {
    expect(mergeBranchRefusal("abdocode/task-1a2b3c4d")).toBeUndefined()
    expect(mergeBranchRefusal("main")).toContain("ليس فرعَ عاملٍ")
    expect(mergeBranchRefusal("abdocode/task-1a2b3c4d; rm -rf")).toBeDefined()
  })
})
