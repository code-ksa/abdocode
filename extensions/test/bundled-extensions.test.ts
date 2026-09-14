/**
 * الحزمُ المضمَّنة مع عبدو كود — تُفحص بعقد الاستيراد نفسِه الذي يطبّقه سطحُ المكتب (Rust `Manifest` + `skill_metadata`):
 * مانيفستٌ بحقوله الخمسة فقط، معرّفٌ ≤16، مهاراتٌ بملفّ SKILL.md باسمٍ صالح ≤48 وحجمٍ ≤64KB، وحزمةٌ بلا مهاراتٍ مرفوضة.
 * وفوق العقد: كلُّ حزمةٍ منقولة تحمل LICENSE وNOTICE.md وFEATURES.md، والنثرُ لا يسمّي المنتجَ الأصليّ إلا في سطور الأصل
 * (الرخصُ والإشعارات وملاحظاتُ التغيير والروابط وسطورُ الحقوق) — «غيّر اسم أنثروبيك إلى عبدو كود» أمرُ المالك.
 * ولا ملفَّ فيه ما يشبه اعتماداً.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..", "bundled")
const ORIGINAL = new Set(["abdo-security"])
const ids = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
const OWNER_LIST = ["design", "rust-lsp", "productivity", "marketing", "engineering", "data", "finance", "product-mgmt", "pdf-viewer", "sales", "operations", "legal", "ent-search", "small-business", "human-resources", "customer-support", "bio-research", "agent-sdk-dev", "abdo-code-setup", "abdo-md-mgmt", "abdo-security", "code-modernize", "code-review", "code-simplifier", "commit-commands", "cwc-makers", "explain-style", "feature-dev", "frontend-design", "hookify", "learning-style", "math-olympiad", "mcp-server-dev", "mcp-tunnels", "playground", "plugin-dev", "pr-review-kit", "project-artifact", "ralph-loop", "skill-creator", "abdo-skills"]

const frontmatter = (text: string) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!m) return undefined
  const fields: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) { const k = line.match(/^([a-z]+):\s*(.*)$/); if (k) fields[k[1]] = k[2].trim() }
  return { fields, body: text.slice(m[0].length) }
}
/** سطرٌ يجوز فيه اسمُ الأصل: رخصة، إشعار، ملاحظةُ تغيير، رابط، حقوق. */
const originLine = (line: string) => /https?:\/\/|©|Copyright|All rights reserved|Apache|Modified by TechnologyKSA|anthropics\/|trademark|أنثروبيك|NOTICE|origin:/i.test(line)
const CREDENTIAL = /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-]{24,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9]{24,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{12,}/
// حارسُ المحرّك نفسُه (يرفض المهارةَ عند التحميل): كلُّ سطرٍ في كلّ مهارةٍ يجب أن يمرّ منه وإلا رُفضت المهارة وقتَ الاستعمال.
import { secretish } from "../../packages/engine/src/local-extensions"
/** مرآةُ حارس المستورِد في سطح المكتب (extensions_store.rs::secretish) — يُطبَّق على نصّ SKILL.md كاملاً وعلى الاسم والوصف عند الاستيراد. */
const rustSecretish = (value: string): boolean => {
  for (const m of value.matchAll(/-----BEGIN /g)) { const rest = value.slice(m.index! + 11); const head = rest.match(/^[A-Z ]*/)![0]; if (rest.slice(head.length).startsWith("PRIVATE KEY-----")) return true }
  const lower = value.toLowerCase()
  for (const m of lower.matchAll(/bearer /g)) { const token = lower.slice(m.index! + 7).replace(/^\s+/, "").match(/^[a-z0-9._-]*/)![0]; if (token.length >= 8) return true }
  return value.split(/[^A-Za-z0-9_-]+/).some((p) => (p.startsWith("sk-") && p.length >= 12) || (p.length >= 40 && /\d/.test(p) && /[A-Za-z]/.test(p)))
}

describe("الحزمُ المضمَّنة — عقدُ الاستيراد", () => {
  test("كلُّ اسمٍ طلبه المالك له حزمة، ولا حزمةَ بلا مانيفست", () => {
    for (const id of OWNER_LIST) expect(`${id}: ${ids.includes(id)}`).toBe(`${id}: true`)
    for (const id of ids) expect(`${id}: ${existsSync(join(ROOT, id, "abdocode-extension.json"))}`).toBe(`${id}: true`)
  })

  for (const id of ids) {
    test(`${id}: المانيفست بعقد Rust والمهاراتُ صالحة`, () => {
      const dir = join(ROOT, id)
      const manifest = JSON.parse(readFileSync(join(dir, "abdocode-extension.json"), "utf8")) as Record<string, unknown>
      expect(Object.keys(manifest).sort()).toEqual(["description", "id", "mcpServers", "name", "schemaVersion", "skills", "version"])
      expect(manifest.schemaVersion).toBe(1)
      expect(manifest.id).toBe(id)
      expect(/^[a-z0-9][a-z0-9-]{0,15}$/.test(String(manifest.id))).toBe(true)
      expect(String(manifest.name).length).toBeLessThanOrEqual(120)
      expect(String(manifest.description).length).toBeGreaterThan(0)
      expect(String(manifest.description).length).toBeLessThanOrEqual(1000)
      expect(String(manifest.version).length).toBeLessThanOrEqual(32)
      const skills = manifest.skills as string[]
      // حزمةٌ بلا مهاراتٍ ولا خوادم يرفضها سطحُ المكتب (extensions_store.rs:346).
      expect(`${id}: skills=${skills.length}`).not.toBe(`${id}: skills=0`)
      const names = new Set<string>()
      for (const rel of skills) {
        const file = join(dir, rel, "SKILL.md")
        expect(`${id}/${rel}: ${existsSync(file)}`).toBe(`${id}/${rel}: true`)
        expect(statSync(file).size).toBeLessThanOrEqual(64 * 1024)
        const text = readFileSync(file, "utf8")
        const fm = frontmatter(text)
        expect(`${id}/${rel}: frontmatter`).toBe(fm ? `${id}/${rel}: frontmatter` : `${id}/${rel}: missing`)
        const name = fm!.fields.name ?? ""
        expect(`${id}/${rel}: ${/^[a-z][a-z0-9-]{0,47}$/.test(name)}`).toBe(`${id}/${rel}: true`)
        expect(`${id}/${rel}: duplicate=${names.has(name)}`).toBe(`${id}/${rel}: duplicate=false`)
        names.add(name)
        expect((fm!.fields.description ?? "").length).toBeGreaterThan(10)
        expect(`${id}/${rel}: credential=${CREDENTIAL.test(text)}`).toBe(`${id}/${rel}: credential=false`)
        const engineHit = text.split(/\r?\n/).find((l) => secretish.test(l))
        expect(`${id}/${rel}: engine-secretish=${engineHit === undefined ? "none" : engineHit.trim().slice(0, 60)}`).toBe(`${id}/${rel}: engine-secretish=none`)
        expect(`${id}/${rel}: importer-secretish=${rustSecretish(text)}`).toBe(`${id}/${rel}: importer-secretish=false`)
        expect(`${id}/${rel}: importer-labels=${rustSecretish(String(manifest.name)) || rustSecretish(String(manifest.description)) || rustSecretish(fm!.fields.description ?? "")}`).toBe(`${id}/${rel}: importer-labels=false`)
        // إعادةُ التسمية: لا «Claude Code» ولا «Anthropic» في النثر خارج سطور الأصل.
        const leaks = text.split(/\r?\n/).filter((l) => /\bClaude Code\b|\bAnthropic\b/.test(l) && !originLine(l))
        expect(`${id}/${rel}: ${leaks.slice(0, 2).join(" | ")}`).toBe(`${id}/${rel}: `)
      }
    })

    test(`${id}: الرخصةُ والإشعارُ وملفُّ الميزات`, () => {
      const dir = join(ROOT, id)
      expect(existsSync(join(dir, "FEATURES.md"))).toBe(true)
      if (ORIGINAL.has(id)) { expect(existsSync(join(dir, "LICENSE.md"))).toBe(true); return }
      expect(existsSync(join(dir, "LICENSE"))).toBe(true)
      expect(/Apache License\s+Version 2\.0/.test(readFileSync(join(dir, "LICENSE"), "utf8"))).toBe(true)
      const notice = readFileSync(join(dir, "NOTICE.md"), "utf8")
      expect(notice).toContain("anthropics/")
      expect(/commit `[0-9a-f]{40}`/.test(notice)).toBe(true)
      expect(notice).toContain("Modified by TechnologyKSA")
    })
  }
})
