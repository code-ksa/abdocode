import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { distillSkill, SKILL_SAVE_USAGE } from "../src/skill-distill"

// أ5/م7 (09-16) — النجاحُ فقط يُقطَّر: المرفوضُ والفاشلُ وأدواتُ الكود لا تدخل؛ الروابطُ والنصوصُ والملفّاتُ والنوافذُ تصير متغيّرات،
// والنصوصُ لا تُحفظ قيمةً (قد تكون اعتماداً)؛ وما يشبه اعتماداً في الناتج يُرفض كلُّه.

const ok = (command: string) => ({ command, verdict: { ok: true } })
const bad = (command: string) => ({ command, verdict: { ok: false } })
const NOW = new Date("2026-09-16T10:00:00Z")

describe("distillSkill", () => {
  test("a browser+desktop run becomes numbered steps with named variables; failures, refusals and code tools are dropped", () => {
    const out = distillSkill("publish-post", "نشرُ تدوينة", [
      ok("open https://blog.test/admin/new"),
      ok("page"),
      bad("tap r9"),
      ok("fill r4 عنوانُ التدوينة الجديدة"),
      ok("upload r6 renders/cover.png"),
      ok("select r7 Published"),
      ok("write notes.md <<< x"),
      ok("read package.json"),
      { command: "desk focus Notepad" },
      ok("desk type سطرٌ سرّيّ"),
      ok("open https://blog.test/admin/new"),
      ok("tap r8"),
    ], NOW)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error(out.why)
    expect(out.steps).toEqual([
      "open {{url_1}}",
      "page",
      "fill r4 {{text_1}}",
      "upload r6 {{file_1}}",
      "select r7 {{choice_1}}",
      "desk focus {{window_1}}",
      "desk type {{text_2}}",
      "open {{url_1}}",
      "tap r8",
    ])
    expect(out.variables).toEqual(["url_1", "text_1", "file_1", "choice_1", "window_1", "text_2"])
    expect(out.markdown).toContain("name: publish-post")
    expect(out.markdown).toContain("مثال: https://blog.test/admin/new")
    expect(out.markdown).not.toContain("سطرٌ سرّيّ") // النصوصُ لا تُحفظ
    expect(out.markdown).not.toContain("عنوانُ التدوينة")
    expect(out.markdown).not.toContain("write notes.md")
    expect(out.markdown).not.toContain("tap r9")
    expect(out.markdown).toContain("3. نفّذ: fill r4 {{text_1}}")
    expect(out.markdown).toContain("distilled: 2026-09-16T10:00:00.000Z — من 9 إيصالاً ناجحاً")
  })
  test("consecutive duplicates fold, and fewer than two steps is refused by name", () => {
    const one = distillSkill("x1", "", [ok("page"), ok("page")], NOW)
    expect(one.ok).toBe(false); if (!one.ok) expect(one.why).toContain("خطوتين فأكثر")
    const none = distillSkill("x2", "", [ok("read a.ts"), bad("open https://a.test")], NOW)
    expect(none.ok).toBe(false)
  })
  test("bad names and credential-looking output are refused", () => {
    expect(distillSkill("Bad Name", "", [ok("page"), ok("tap r1")], NOW)).toEqual({ ok: false, why: expect.stringContaining(SKILL_SAVE_USAGE) })
    const leak = distillSkill("leak", "", [ok("open https://a.test/?token=sk-ABCDEFGHIJKLMNOP123456"), ok("page")], NOW)
    expect(leak.ok).toBe(false); if (!leak.ok) expect(leak.why).toContain("اعتماداً")
  })
})

describe("wiring", () => {
  test("skill save reads the turn's receipts, writes under .abdo/skills after the approval gate, and the catalogue advertises it", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")
    expect(cli).toContain("distillReceiptsPrev = distillReceipts\r\n      distillReceipts = allReceipts")
    expect(cli).toContain('if (head === "save") {')
    expect(cli).toContain('const dir = join(PROJECT_DIR, ".abdo", "skills", name)')
    expect(cli).toContain('if (spec.name === "skill" && /^save(?:\\s|$)/u.test(rest.trim())) {')
    expect(cli.indexOf('حفظُ خطوات هذا الدور مهارةً في .abdo/skills/')).toBeLessThan(cli.indexOf("return plain(await executeBody(framedBody, hooks))"))
    const catalogue = readFileSync(join(import.meta.dir, "..", "..", "tools", "src", "catalogue.ts"), "utf8")
    expect(catalogue).toContain("skill save <اسم> [:: وصف]")
  })
})
