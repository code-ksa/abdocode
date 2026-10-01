/**
 * 10-01 — مقيس (الدور 20): «اكمل» قرأ ثمانيةَ ملفّاتٍ وخُتم «مكتملاً» والسبرنتُ مفتوح. دورُ استئنافٍ على خطّةٍ لا يُختم وما أُغلق منها شيء.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isResumeIntent } from "../src/resume-intent"

const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")

describe("a resume turn on a sprint plan cannot finish with nothing closed", () => {
  test("the gate sits after the advance edge and before the independent review, bounded per turn", () => {
    const advance = cli.indexOf("const advance = sprintAdvance(PROJECT_DIR, sprintOpenAtStart)")
    const gate = cli.indexOf("if (isResumeIntent(turn.body) && sprintOpenAtStart !== undefined && sprintOpenAtStart > 0 && unclosedSprintNudges < 2 && (openSprintCount(PROJECT_DIR) ?? 0) >= sprintOpenAtStart) {")
    const review = cli.indexOf("if (superActive) {", gate)
    expect(advance).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(advance)
    expect(review).toBeGreaterThan(gate)
    expect(cli.slice(gate, review)).toContain("sprint done <رقمه>")
    expect(cli.slice(gate, review)).toContain("continue")
  })

  test("it is the resume intent that arms it — an ordinary task in a project with a plan is not forced to close sprints", () => {
    expect(isResumeIntent("اكمل")).toBe(true)
    expect(isResumeIntent("كمل")).toBe(true)
    expect(isResumeIntent("أصلح زر الدخول في صفحة المفاتيح")).toBe(false)
    expect(isResumeIntent("add a dark mode toggle")).toBe(false)
  })
})
