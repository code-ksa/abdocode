/**
 * 10-11 (مقيس على n8n-clone): المحكّمُ رأى «S15 — SEO والبحث» عنواناً بلا بنودٍ ولا بوّابة (الخطّةُ تكتب «- **بوابة**:»)
 * فطالب بميزة بحث وحجب الاكتمال. يُقاس على ما يصله: openSprintsSummary وجملةُ الحكم في cli.
 */
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSprintsSummary } from "../src/project-sprint-plan-guard"

const plan = (gateLine: string) => `# خطّة n8n-clone

## S14 — Templates
الحالة: مكتمل
الأدلة: audit: PASS

## S15 — SEO والبحث
- metadata لكل صفحة (عنوان ≤60، وصف 50–160، canonical، Open Graph).
- sitemap.xml، robots.txt، llms.txt، JSON-LD للكيان.
${gateLine}

## S16 — التحقق النهائي والتسليم
- \`npm run build\` ثم \`audit\` على كل مسارات البناء.
- **بوابة**: كل بوابات السبرنتات السابقة موثقة بإيصالاتها.
`

const summaryOf = (gateLine: string) => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-sprint-judge-"))
  try { writeFileSync(join(dir, "ABDO-SPRINTS.md"), plan(gateLine)); return openSprintsSummary(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test("the judge gets each open sprint's written items and its «- **بوابة**:» gate — not the title alone", () => {
  const s = summaryOf("- **بوابة**: `seo` PASS على الصفحات العامة.")
  const s15 = s.split("\n").find((l) => l.includes("S15"))!
  expect(s15).toContain("بنودُه: metadata لكل صفحة")
  expect(s15).toContain("sitemap.xml، robots.txt، llms.txt")
  expect(s15).toContain("بوّابتُه: `seo` PASS على الصفحات العامة.")
  // the gate line is not repeated as an item
  expect(s15.split("بنودُه:")[1]!.split("بوّابتُه:")[0]).not.toContain("seo` PASS")
  expect(s).not.toContain("S14")
})

test("the twin: the old «بوابة القبول:» form still reads, and «بوّابة» with shadda too", () => {
  expect(summaryOf("بوابة القبول: `seo` PASS").split("\n").find((l) => l.includes("S15"))).toContain("بوّابتُه: `seo` PASS")
  expect(summaryOf("- **بوّابة**: `seo` PASS").split("\n").find((l) => l.includes("S15"))).toContain("بوّابتُه: `seo` PASS")
})

test("cli tells the judge to rule on the written items and gate, never on title words", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
  expect(cli).toContain("كلٌّ ببنوده وبوّابته ودليله:\\n${sprintsDue || \"—\"}\\nاحكم على بنود كلّ سبرنتٍ وبوّابته المكتوبة أعلاه وحدها")
})
