import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSprintCount, sprintDone, sprintShow } from "../src/project-sprint-plan-guard"

// 10-10 (مقيس في مهمّة n8n): خطّةٌ عناوينُها «## S0 — …» كانت «بلا عناوين سبرنت مرقّمة» عند sprint show فلم يُغلق سبرنتٌ بالأداة قطّ.
const PLAN = [
  "# ABDO-SPRINTS.md — خطة استنساخ n8n.io",
  "## جدول التتبع",
  "| بند | الفئة | السبرنت |",
  "| Hero | الرئيسية | S1 |",
  "## S0 — التقاط المرجع (لا build)",
  "- الهدف: page save لكل صفحة",
  "## S1 — الأساس والبيانات",
  "- الهدف: Prisma + PostgreSQL",
  "## S2 — نظام التصميم",
  "- الهدف: globals.css",
  "## حالة السبرنتات",
  "| S0 | ✅ تم |",
  "",
].join("\n")

test("«## S<n> —» headings are sprints; a table cell «| S1 |» is not; sprint done closes only that sprint", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-sprint-s-"))
  try {
    writeFileSync(join(dir, "ABDO-SPRINTS.md"), PLAN)
    const shown = sprintShow(dir)
    expect(shown.split("\n").filter((l) => /^[○✓] /u.test(l)).map((l) => l.slice(2, 4))).toEqual(["S0", "S1", "S2"])
    expect(openSprintCount(dir)).toBe(3)
    const done = sprintDone(dir, 1, "npm run build PASS + prisma migrate applied")
    expect(done.ok).toBe(true)
    const after = readFileSync(join(dir, "ABDO-SPRINTS.md"), "utf-8")
    const s1 = after.slice(after.indexOf("## S1"), after.indexOf("## S2"))
    expect(s1).toContain("الحالة: مكتمل")
    expect(s1).toContain("الأدلة: npm run build PASS")
    expect(after.slice(after.indexOf("## S0"), after.indexOf("## S1"))).not.toContain("الحالة: مكتمل")
    expect(openSprintCount(dir)).toBe(2)
    expect(sprintDone(dir, 9, "evidence long enough").text).toContain("لا سبرنتَ برقم 9")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the twin: «سبرنت N» and «Sprint N» headings still work exactly as before", () => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-sprint-ar-"))
  try {
    writeFileSync(join(dir, "ABDO-SPRINTS.md"), "## سبرنت 1: الأساس\n- x\n## Sprint 2: pages\n- y\n")
    expect(sprintShow(dir).split("\n").length).toBe(2)
    expect(sprintDone(dir, 2, "probe / 200 and shot saved").ok).toBe(true)
    expect(openSprintCount(dir)).toBe(1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
