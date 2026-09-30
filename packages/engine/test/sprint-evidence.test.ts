/**
 * 09-30 — مقيس: «Sprint 0» أُغلق بـ«page / renders with Header and Hero sections» ولم تُقَس الصفحةُ بعد آخر تعديل.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { newEvidenceClock, noteEvidence, sprintEvidenceRefusal } from "../src/sprint-evidence"

const MEASURED = "npm run build passes, npm test passes, page / renders with Header and Hero sections"

describe("sprint done needs a page measured after the last code edit when it claims one", () => {
  test("the measured claim, with only build and test run, is refused and names the missing measurement", () => {
    const clock = newEvidenceClock()
    noteEvidence(clock, "write src/components/layout/header.tsx <<<\nexport const Header = () => null", true, 100)
    noteEvidence(clock, "run npm run build", true, 200)
    noteEvidence(clock, "run npm test", true, 300)
    const why = sprintEvidenceRefusal(MEASURED, clock)
    expect(why).toContain("probe")
    expect(why).toContain("page/shot")
  })

  test("a page measured after the edit lets it close; one measured before the edit does not", () => {
    const after = newEvidenceClock()
    noteEvidence(after, "write src/app/page.tsx <<<\nexport default function Home() { return null }", true, 100)
    noteEvidence(after, "probe / /models", true, 200)
    expect(sprintEvidenceRefusal(MEASURED, after)).toBeUndefined()

    const stale = newEvidenceClock()
    noteEvidence(stale, "page", true, 100)
    noteEvidence(stale, "edit src/app/page.tsx :: a => b", true, 200)
    expect(sprintEvidenceRefusal("الصفحة ترد 200 وتظهر البطاقات", stale)).toContain("سبق آخرَ تعديل")
  })

  test("the twins: evidence that claims no page passes; failed receipts and docs edits do not move the clock", () => {
    const clock = newEvidenceClock()
    expect(sprintEvidenceRefusal("npm run build ✓ و npm test 1/1 ✓", clock)).toBeUndefined()
    noteEvidence(clock, "probe /", false, 100)
    expect(clock.pageAt).toBe(0)
    noteEvidence(clock, "shot", true, 200)
    noteEvidence(clock, "write docs/notes.md <<<\n# x", true, 300)
    expect(clock.codeAt).toBe(0)
    expect(sprintEvidenceRefusal(MEASURED, clock)).toBeUndefined()
  })

  test("the engine refuses before it writes the plan, and every observed receipt feeds the clock", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    const refusal = cli.indexOf("const unmeasured = sprintEvidenceRefusal(evidence, sprintEvidence)")
    const write = cli.indexOf("return sprintDone(PROJECT_DIR, Number.parseInt(num ?? \"\", 10), evidence).text")
    expect(refusal).toBeGreaterThan(0)
    expect(write).toBeGreaterThan(refusal)
    expect(cli.slice(refusal, write)).toContain("if (unmeasured !== undefined) return unmeasured")
    const observer = cli.indexOf("const observeAcceptanceReceipt = (command: string, output: string, verdict?: ToolVerdict): string | undefined => {")
    expect(cli.indexOf("noteEvidence(sprintEvidence, command, verdict?.ok !== false)", observer) - observer).toBeLessThan(300)
  })
})
