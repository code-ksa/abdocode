import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSprintCount, sprintPlanReady, sprintPlanWriteViolation, sprintProgressViolation, sprintPlanTemplate } from "../src/project-sprint-plan-guard"

const project = () => mkdtempSync(join(tmpdir(), "abdo-sprints-"))
const completePlan = "# منتج Next.js عربي RTL لشركة السعادة مع SQLite ولوحة الإدارة وتواصل العملاء\n" + Array.from({ length: 8 }, (_, index) => `## سبرنت ${index + 1}\nالحالة: [ ]\nبوابة القبول: npm run ${index === 7 ? "build" : "test"} وHTTP 200\nالأدلة: نتيجة Playwright أو vitest وفحص المتصفح\n${"نطاق واضح للعمل المطلوب. ".repeat(9)}`).join("\n") + "\n## الاستئناف\nABDO-HANDOFF.md\nNEXT_ACTION"

describe("autonomous sprint plan guard", () => {
  test("a valid plan with unfinished sprints cannot be mistaken for a finished product", () => {
    const projectDir = project()
    writeFileSync(join(projectDir, "ABDO-SPRINTS.md"), completePlan)
    expect(sprintPlanReady(projectDir, true)).toBe(true)
    expect(sprintProgressViolation(projectDir, true)).toContain("سبرنت 1")
    expect(sprintProgressViolation(projectDir, false)).toBeUndefined()
  })

  // IDEA 10 (turn budget grace): the open-sprint count shares the section splitter and status
  // regexes with sprintProgressViolation — extracting them must not drift either reading.
  test("openSprintCount counts every open sprint on the complete plan and agrees with the progress guard", () => {
    const projectDir = project()
    writeFileSync(join(projectDir, "ABDO-SPRINTS.md"), completePlan)
    expect(openSprintCount(projectDir)).toBe(8)
    expect(sprintProgressViolation(projectDir, true)).toContain("سبرنت 1")
    let sevenDone = completePlan
    for (let i = 0; i < 7; i++) sevenDone = sevenDone.replace("الحالة: [ ]", "الحالة: [x]")
    writeFileSync(join(projectDir, "ABDO-SPRINTS.md"), sevenDone)
    expect(openSprintCount(projectDir)).toBe(1)
    expect(sprintProgressViolation(projectDir, true)).toContain("سبرنت 8")
    writeFileSync(join(projectDir, "ABDO-SPRINTS.md"), completePlan.replaceAll("الحالة: [ ]", "الحالة: مكتمل."))
    expect(openSprintCount(projectDir)).toBe(0)
  })

  test("openSprintCount is undefined when the plan is missing or unreadable — absence is no evidence, so no grace", () => {
    const projectDir = project()
    expect(openSprintCount(projectDir)).toBeUndefined()
    const notADir = join(projectDir, "file.txt")
    writeFileSync(notADir, "x")
    expect(openSprintCount(notADir)).toBeUndefined()
  })

  test("recognizes Arabic not-complete and missing status as unfinished", () => {
    for (const status of ["الحالة: غير مكتمل.", "الحالة: not completed", "حقل مفقود"]) {
      const projectDir = project()
      writeFileSync(join(projectDir, "ABDO-SPRINTS.md"), completePlan.replace("الحالة: [ ]", status))
      expect(sprintProgressViolation(projectDir, true)).toContain("سبرنت 1")
    }
  })

  test("requires a resumable handoff even when every status is marked complete", () => {
    const projectDir = project()
    writeFileSync(join(projectDir, "ABDO-SPRINTS.md"), completePlan.replaceAll("الحالة: [ ]", "الحالة: مكتمل."))
    expect(sprintProgressViolation(projectDir, true)).toContain("NEXT_ACTION")
    writeFileSync(join(projectDir, "ABDO-HANDOFF.md"), "NEXT_ACTION: review receipts")
    expect(sprintProgressViolation(projectDir, true)).toBeUndefined()
  })

  test("one completed sprint never hides later pending work", () => {
    const projectDir = project()
    writeFileSync(join(projectDir, "ABDO-SPRINTS.md"), completePlan.replace("الحالة: [ ]", "الحالة: [x]"))
    expect(sprintProgressViolation(projectDir, true)).toContain("سبرنت 2")
  })

  test("requires the plan as the first write when qualification enables it", () => {
    const projectDir = project()
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "app/page.tsx", after: "export default function Page(){ return <main /> }" }, true)).toContain("أول كتابة")
  })

  test("rejects a ceremonial plan without autonomous acceptance structure", () => {
    const projectDir = project()
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: "# سبرنت 1\nسننجز الموقع" }, true)).toContain("مختصرة")
  })

  test("accepts a durable multi-sprint plan and then unlocks product writes", () => {
    const projectDir = project()
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "./ABDO-SPRINTS.md", after: completePlan }, true)).toBeUndefined()
    writeFileSync(join(projectDir, "ABDO-SPRINTS.md"), completePlan)
    expect(sprintPlanReady(projectDir, true)).toBe(true)
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "app/page.tsx", after: "export default function Page(){ return <main /> }" }, true)).toBeUndefined()
  })

  test("does not affect ordinary runs", () => {
    const projectDir = project()
    expect(sprintPlanReady(projectDir, false)).toBe(true)
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "app/page.tsx", after: "x" }, false)).toBeUndefined()
  })

  test("rejects one giant sprint that hides the whole product behind one gate", () => {
    const projectDir = project()
    const paths = Array.from({ length: 20 }, (_, index) => `- \`app/feature-${index}/page.tsx\``).join("\n")
    const plan = completePlan.replace("نطاق واضح للعمل المطلوب.", `${paths}\nنطاق واضح للعمل المطلوب.`)
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toContain("أكبر")
  })

  test("rejects parallel Prisma and JSON stores without one named source of truth", () => {
    const projectDir = project()
    const plan = completePlan + "\nprisma/schema.prisma\ndb.json"
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toContain("مصدر حقيقة واحد")
  })

  test("rejects fabricated completion in the initial empty-project plan", () => {
    const projectDir = project()
    const plan = completePlan.replace("الحالة: [ ]", "الحالة: ✅ مكتمل")
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toContain("قبل وجود أي إيصال")
  })

  test("does not confuse an Arabic not-complete status with completion", () => {
    const projectDir = project()
    const plan = completePlan.replaceAll("الحالة: [ ]", "**الحالة:** غير مكتمل")
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toBeUndefined()
  })

  test("rejects descriptive-only gates that cannot prove completion", () => {
    const projectDir = project()
    const plan = completePlan.replaceAll(/npm run (?:build|test) وHTTP 200/g, "يعمل بشكل صحيح").replaceAll(/نتيجة Playwright أو vitest وفحص المتصفح/g, "يعمل بشكل صحيح")
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toContain("وصفية")
  })

  test("revalidates the durable plan before unlocking product writes", () => {
    const projectDir = project()
    writeFileSync(join(projectDir, "ABDO-SPRINTS.md"), completePlan.replace("Next.js", "تطبيق"))
    expect(sprintPlanReady(projectDir, true)).toBe(false)
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "package.json", after: "{}" }, true)).toContain("Next.js")
  })

  test("rejects a mixed App Router and Pages Router architecture", () => {
    const projectDir = project()
    const plan = completePlan + "\napp/page.tsx\npages/admin.tsx"
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toContain("Pages Router")
  })

  test("recognizes numbered sprint titles without Markdown heading markers", () => {
    const projectDir = project()
    const plan = completePlan.replaceAll("## سبرنت", "سبرنت")
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toBeUndefined()
  })

  test("accepts the natural indefinite Arabic admin-dashboard wording", () => {
    const projectDir = project()
    const plan = completePlan.replace("لوحة الإدارة", "لوحة إدارة")
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toBeUndefined()
  })

  // الحادثة الحية (إيدو جلوبال 2026-09-02): خطة مشروع Next قائم داخل pnpm
  // workspace، بلا كلمتَي «Next.js» و«لوحة الإدارة» وبأدلة `pnpm --filter … build`،
  // رُفضت لأن النثر اكتُشف AssemblyScript. المستودع يقرّر الحزمة ويُسقط ثوابت
  // المشروع الجديد؛ الأدلة المرشَّحة تُعدّ.
  test("an existing Next workspace plan passes without greenfield anchors; the same prose is refused for an empty project", () => {
    const block = (n: number) =>
      `## سبرنت ${n} — تحديث واجهة ${n}\n` +
      "الهدف والنطاق: تحسين واجهة تطبيق الويب في apps/web ضمن المستودع القائم بلا قاعدة بيانات.\n" +
      "الحالة: غير مكتملة.\n" +
      "بوابة القبول: نجاح نفّذ: run pnpm --filter @taalim/web build وظهور الصفحة بـHTTP 200.\n" +
      "الأدلة: إيصال نفّذ: run pnpm --filter @taalim/web build وإيصال Invoke-WebRequest يعيد HTTP 200.\n" +
      "ABDO-HANDOFF.md: يُحدَّث بالحالة الحقيقية وأوامر التشغيل.\n" +
      "NEXT_ACTION: الانتقال إلى السبرنت التالي.\n\n"
    const plan = "# خطة تطبيق الويب عربي RTL\n\nالمخزن ومصدر الحقيقة: ملفات المصدر في المستودع.\n\n" + [1, 2, 3, 4, 5, 6, 7].map(block).join("")
    expect(plan.length).toBeGreaterThan(1_200)
    const repo = project()
    mkdirSync(join(repo, "apps", "web"), { recursive: true })
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "mono", private: true }))
    writeFileSync(join(repo, "apps", "web", "package.json"), JSON.stringify({ name: "web", dependencies: { next: "^16.2.0" } }))
    expect(sprintPlanWriteViolation({ projectDir: repo, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toBeUndefined()
    // مشروع فارغ: النثر هو المصدر، وثوابت المشروع الجديد تُلزم.
    expect(sprintPlanWriteViolation({ projectDir: project(), normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toContain("ثوابت")
  })

  test("rejects external search in the independent project plan", () => {
    const projectDir = project()
    const plan = completePlan + "\nاستخدم ABDO_SEARCH للبحث الخارجي"
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)).toContain("البحث الخارجي")
  })

  test("rejects an oversized plan that consumes the work window", () => {
    const projectDir = project()
    const plan = completePlan + "\n" + "تفصيل غير لازم ".repeat(1_200)
    const violation = sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: plan }, true)
    expect(violation).toContain("متضخمة")
    expect(violation).toContain("الحد 14000")
    expect(violation).toContain("Next.js")
  })

  // S6: القالب الذي يُملى عند الرفض يجب أن يجتاز الحارس كلّه بنفسه.
  test("the offered sprint-plan template passes the guard it is offered by", () => {
    const projectDir = project()
    const tpl = sprintPlanTemplate("عيادة نور")
    expect(sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: tpl }, true)).toBeUndefined()
  })
})
