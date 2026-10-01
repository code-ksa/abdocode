/**
 * 09-30 — مقيس: «Sprint 0» أُغلق بـ«page / renders with Header and Hero sections» ولم تُقَس الصفحةُ بعد آخر تعديل.
 * 10-01 — مقيس: «كلُّ السبرنتات مغلقة» والبناءُ مكسور — Sprint 12 بلا قياسٍ مسمّى، وSprint 13 قاس بـprobe على خادم dev.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { mergeUiClock, newEvidenceClock, noteEvidence, readUiClock, sprintEvidenceRefusal, writeUiClock } from "../src/sprint-evidence"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

const MEASURED = "npm run build passes, npm test passes, page / renders with Header and Hero sections"
const EDIT = "write src/app/page.tsx <<<\nexport default function Home() { return null }"
const GREEN_BUILD = "▲ Next.js 14.2.26 ✓ Compiled successfully ✓ Generating static pages (40/40) Route (app)"
const RED_BUILD = "✓ Compiled successfully Failed to compile. ./src/app/apps/page.tsx:92:80 Type error: Type '{ className: string; title: string; }'"

describe("every claim in sprint evidence needs its own measurement after the last code edit", () => {
  test("the measured Sprint 0 claim, with build and test run but no page measured, is refused for the page", () => {
    const clock = newEvidenceClock()
    noteEvidence(clock, EDIT, true, 100)
    noteEvidence(clock, "run npm run build", true, 200, GREEN_BUILD)
    noteEvidence(clock, "run npm test", true, 300, "ℹ tests 1 ℹ pass 1 ℹ fail 0")
    expect(sprintEvidenceRefusal(MEASURED, clock)).toContain("probe")
  })

  test("build, test and page all measured after the edit let it close; a page measured before the edit does not", () => {
    const after = newEvidenceClock()
    noteEvidence(after, EDIT, true, 100)
    noteEvidence(after, "run npm run build", true, 200, GREEN_BUILD)
    noteEvidence(after, "run npm test", true, 250, "ℹ tests 1 ℹ pass 1 ℹ fail 0")
    noteEvidence(after, "probe / /models", true, 300)
    expect(sprintEvidenceRefusal(MEASURED, after)).toBeUndefined()

    const stale = newEvidenceClock()
    noteEvidence(stale, "page", true, 100)
    noteEvidence(stale, "edit src/app/page.tsx :: a => b", true, 200)
    expect(sprintEvidenceRefusal("الصفحة ترد 200 وتظهر البطاقات", stale)).toContain("سبق آخرَ تعديل")
  })

  test("10-01: Sprint 12's evidence names no measurement and is refused", () => {
    const why = sprintEvidenceRefusal("أنشأنا صفحات /ori, /docs, /pricing وحسّنا صفحة /apps مع بيانات حقيقية وتصفية متقدمة. جميع الصفحات العامة المتبقية مكتملة.", newEvidenceClock())
    expect(why).toContain("لا يسمّي قياساً")
  })

  test("10-01: a build claim measured only by probes on a dev server is refused; a failed build does not count", () => {
    const devOnly = newEvidenceClock()
    noteEvidence(devOnly, "write src/app/apps/page.tsx <<<\nexport default function Apps() { return null }", true, 100)
    noteEvidence(devOnly, "probe /api/health /api/apps", true, 200)
    expect(sprintEvidenceRefusal("البناء ناجح و ✓ 200 http://127.0.0.1:3000/api/apps", devOnly)).toContain("خادمُ dev لا يفحص الأنواع")

    const red = newEvidenceClock()
    noteEvidence(red, "write src/app/apps/page.tsx <<<\nexport default function Apps() { return null }", true, 100)
    noteEvidence(red, "run npm run build", true, 200, RED_BUILD)
    expect(red.buildAt).toBe(0)
    expect(sprintEvidenceRefusal("npm run build ✓", red)).toContain("نجاحَ البناء")
  })

  test("the twins: build-only evidence with a green build passes; failed receipts and docs edits do not move the clock", () => {
    const clock = newEvidenceClock()
    noteEvidence(clock, "probe /", false, 100)
    expect(clock.pageAt).toBe(0)
    noteEvidence(clock, "run npm run build", true, 150, GREEN_BUILD)
    noteEvidence(clock, "write docs/notes.md <<<\n# x", true, 300)
    expect(clock.codeAt).toBe(0)
    expect(sprintEvidenceRefusal("npm run build ✓", clock)).toBeUndefined()
    noteEvidence(clock, "run npm test", true, 400, "ℹ tests 1 ℹ pass 0 ℹ fail 1")
    expect(clock.testAt).toBe(0)
  })

  test("the engine refuses before it writes the plan, and every observed receipt feeds the clock with its output", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    const refusal = cli.indexOf("const unmeasured = sprintEvidenceRefusal(evidence, sprintEvidence, { web })")
    const write = cli.indexOf("return sprintDone(PROJECT_DIR, Number.parseInt(num ?? \"\", 10), evidence).text")
    expect(refusal).toBeGreaterThan(0)
    expect(write).toBeGreaterThan(refusal)
    expect(cli.slice(refusal, write)).toContain("if (unmeasured !== undefined) return unmeasured")
    const observer = cli.indexOf("const observeAcceptanceReceipt = (command: string, output: string, verdict?: ToolVerdict): string | undefined => {")
    expect(cli.indexOf("noteEvidence(sprintEvidence, command, verdict?.ok !== false, Date.now(), output)", observer) - observer).toBeLessThan(300)
  })
})

// 10-01 (Q4) — مشروعُ ويب: سبرنتٌ عدّل واجهةً يُغلق بـaudit PASS بعد آخر تعديلٍ لها.
describe("web projects close a UI sprint only after audit PASS", () => {
  const PASS = "audit: PASS — 3 صفحة × 5 عرض (360/390/412/768/1366) · 0 خطأ · 2 تحذير"
  const FAIL = "audit: FAIL — 3 صفحة × 5 عرض (360/390/412/768/1366) · 42 خطأ · 11 تحذير\n✕ / @360 · overflow: 445>360"
  const measured = (): ReturnType<typeof newEvidenceClock> => {
    const clock = newEvidenceClock()
    noteEvidence(clock, "write src/components/layout/header.tsx <<<\nexport function Header() { return null }", true, 100)
    noteEvidence(clock, "run npm run build", true, 200, GREEN_BUILD)
    noteEvidence(clock, "probe /", true, 300)
    return clock
  }
  test("UI edited, build and page measured, no audit ⇒ refused in a web project, accepted outside one", () => {
    expect(sprintEvidenceRefusal(MEASURED.replace(", npm test passes", ""), measured(), { web: true })).toContain("ولم يمرّ audit بعد آخر تعديلٍ لها")
    expect(sprintEvidenceRefusal(MEASURED.replace(", npm test passes", ""), measured(), { web: false })).toBeUndefined()
  })
  test("audit FAIL after the edit is named; audit PASS after the edit closes it; a later UI edit reopens the gate", () => {
    const clock = measured()
    noteEvidence(clock, "audit / /models", true, 400, FAIL)
    expect(sprintEvidenceRefusal("npm run build ✓, probe / 200", clock, { web: true })).toContain("وآخرُ audit بعد التعديل حكمُه FAIL")
    noteEvidence(clock, "audit / /models", true, 500, PASS)
    expect(sprintEvidenceRefusal("npm run build ✓, probe / 200", clock, { web: true })).toBeUndefined()
    noteEvidence(clock, "edit src/app/globals.css :: a => b", true, 600)
    noteEvidence(clock, "run npm run build", true, 700, GREEN_BUILD)
    noteEvidence(clock, "probe /", true, 800)
    expect(sprintEvidenceRefusal("npm run build ✓, probe / 200", clock, { web: true })).toContain("ولم يمرّ audit بعد آخر تعديلٍ لها")
  })
  test("a backend-only edit does not demand audit; PASS counts only from the report head", () => {
    const clock = newEvidenceClock()
    noteEvidence(clock, "edit src/app/api/models/route.ts :: a => b", true, 100)
    noteEvidence(clock, "run npm run build", true, 200, GREEN_BUILD)
    expect(clock.uiAt).toBe(0)
    expect(sprintEvidenceRefusal("npm run build ✓", clock, { web: true })).toBeUndefined()
    noteEvidence(clock, "write src/app/page.tsx <<<\nx", true, 300)
    noteEvidence(clock, "audit /", true, 400, "تعذّر: audit: PASS لم يُقَس")
    expect(clock.auditAt).toBe(0)
  })
})

// 10-01 (Q4) — كلُّ «اكمل» محرّكٌ جديد: دورٌ عدّل الواجهة ثمّ خرج، ودورٌ تالٍ بساعةٍ صفريّة كان يُغلق السبرنتَ بلا audit.
describe("the UI clock crosses processes", () => {
  test("turn A edits the UI and exits; turn B, fresh, still needs audit PASS — and gets it from a PASS it ran itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "ui-clock-"))
    try {
      const file = join(dir, "state", "p.json")
      const a = newEvidenceClock()
      noteEvidence(a, "write src/components/layout/header.tsx <<<\nx", true, 1_000)
      writeUiClock(file, a)
      const b = newEvidenceClock()
      noteEvidence(b, "run npm run build", true, 2_000, "✓ Compiled successfully Route (app)")
      expect(sprintEvidenceRefusal("npm run build ✓", b, { web: true })).toBeUndefined()
      mergeUiClock(b, readUiClock(file))
      expect(b.uiAt).toBe(1_000)
      expect(sprintEvidenceRefusal("npm run build ✓", b, { web: true })).toContain("ولم يمرّ audit")
      noteEvidence(b, "audit /", true, 3_000, "audit: PASS — 1 صفحة × 5 عرض · 0 خطأ · 0 تحذير")
      writeUiClock(file, b)
      const c = newEvidenceClock()
      mergeUiClock(c, readUiClock(file))
      expect(sprintEvidenceRefusal("npm run build ✓", { ...c, buildAt: 4_000 }, { web: true })).toBeUndefined()
      expect(readUiClock(join(dir, "missing.json"))).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  test("the engine merges the saved clock before it judges, and saves when a receipt moves it", () => {
    const cli = readFileSync(join(import.meta.dir, "../src/cli.ts"), "utf8")
    const merge = cli.indexOf("mergeUiClock(sprintEvidence, readUiClock(uiClockFile()))\r\n        const unmeasured")
    expect(merge).toBeGreaterThan(0)
    expect(cli).toContain("writeUiClock(uiClockFile(), sprintEvidence)")
  })
})

