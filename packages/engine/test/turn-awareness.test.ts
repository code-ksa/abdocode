import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TurnAwareness, projectMap } from "../src/turn-awareness"

const readReceipt = (digest: string) => `قرأت النواةُ الملفَّ وتحقّقت منه — بصمة المحتوى ${digest}…\n--- f ---\nx`

describe("turn awareness — S1", () => {
  test("records reads from receipts and names repeats in the brief", () => {
    const awareness = new TurnAwareness()
    awareness.observe("read package.json", readReceipt("aaaa1111aaaa1111"), 1)
    awareness.observe("read package.json", readReceipt("aaaa1111aaaa1111"), 3)
    awareness.observe("read ABDO-HANDOFF.md", readReceipt("bbbb2222bbbb2222"), 2)
    expect(awareness.repeatedReads()).toEqual(["package.json"])
    const brief = awareness.brief()
    expect(brief).toContain("package.json (قُرئ 2 مرات — لم يتغيّر)")
    expect(brief).toContain("ABDO-HANDOFF.md")
    expect(brief).toContain("لا تعِد قراءة")
  })

  // نيّةٌ بلا إيصال ليست معرفة: قراءة فاشلة (لا بصمة) لا تدخل الدفتر.
  test("ignores failed reads that carry no digest", () => {
    const awareness = new TurnAwareness()
    awareness.observe("read missing.ts", "الملفّ غير موجود: missing.ts", 1)
    expect(awareness.brief()).toBe("")
  })

  // مقطعان مختلفان من ملفٍ واحد ليسا قراءةً مكرّرة: الموجز لا يصدّ المقطع الثالث.
  test("distinct range reads of one file are separate records, not a repeated read", () => {
    const awareness = new TurnAwareness()
    awareness.observe("read src/a.ts 1 20", readReceipt("eeee5555eeee5555"), 1)
    awareness.observe("read src/a.ts 21 40", readReceipt("eeee5555eeee5555"), 1)
    expect(awareness.repeatedReads()).toEqual([])
    const brief = awareness.brief()
    expect(brief).not.toContain("قُرئ 2 مرات")
    expect(brief).toContain("src/a.ts 1 20")
    expect(brief).toContain("src/a.ts 21 40")
    // ولا يختلط المقطع بالملفّ كاملاً
    awareness.observe("read src/a.ts", readReceipt("eeee5555eeee5555"), 2)
    expect(awareness.repeatedReads()).toEqual([])
  })

  test("only an identical range re-read counts as repeated, whitespace-normalised", () => {
    const awareness = new TurnAwareness()
    awareness.observe("read src/a.ts 1 20", readReceipt("eeee5555eeee5555"), 1)
    awareness.observe("read  src/a.ts  1 20", readReceipt("eeee5555eeee5555"), 2)
    expect(awareness.repeatedReads()).toEqual(["src/a.ts 1 20"])
    expect(awareness.brief()).toContain("src/a.ts 1 20 (قُرئ 2 مرات — لم يتغيّر)")
  })

  test("a write invalidates the whole-file read and every range read of that file, and no other", () => {
    const awareness = new TurnAwareness()
    awareness.observe("read src/a.ts", readReceipt("eeee5555eeee5555"), 1)
    awareness.observe("read src/a.ts 1 20", readReceipt("eeee5555eeee5555"), 1)
    awareness.observe("read src/a.ts.bak 1 20", readReceipt("ffff6666ffff6666"), 1)
    awareness.observe("edit src/a.ts :: old => new", "✍ src/a.ts — كتابة ذرّية", 2)
    const brief = awareness.brief()
    expect(brief).toContain("كتبتَ: src/a.ts")
    expect(brief).not.toContain("src/a.ts 1 20")
    expect(brief).not.toMatch(/قرأتَ: [^\n]*src\/a\.ts(?:،|\n)/u)
    expect(brief).toContain("src/a.ts.bak 1 20")
  })

  test("a write invalidates the prior read of the same file", () => {
    const awareness = new TurnAwareness()
    awareness.observe("read app/lib/db.ts", readReceipt("cccc3333cccc3333"), 1)
    awareness.observe("edit app/lib/db.ts :: old => new", "✍ app/lib/db.ts — كتابة ذرّية", 2)
    expect(awareness.brief()).toContain("كتبتَ: app/lib/db.ts")
    expect(awareness.brief()).not.toContain("قُرئ")
  })

  test("brief stays inside its budget and the ledger inside its cap", () => {
    const awareness = new TurnAwareness(15)
    for (let i = 0; i < 40; i++) awareness.observe(`read file-${i}.ts`, readReceipt("dddd4444dddd4444"), i)
    expect(awareness.brief(300).length).toBeLessThanOrEqual(302)
  })

  test("empty awareness injects nothing", () => {
    expect(new TurnAwareness().brief()).toBe("")
  })
})

describe("project map — S1 cold start", () => {
  test("maps manifests and sources deterministically, skipping build output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-map-"))
    mkdirSync(join(dir, "app", "lib"), { recursive: true })
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true })
    writeFileSync(join(dir, "package.json"), "{}")
    writeFileSync(join(dir, "tsconfig.json"), "{}")
    writeFileSync(join(dir, "app", "page.tsx"), "export default () => null")
    writeFileSync(join(dir, "app", "lib", "db.ts"), "export {}")
    writeFileSync(join(dir, "node_modules", "x", "index.js"), "")
    const map = await projectMap(dir)
    expect(map).toContain("package.json")
    expect(map).toContain("app/page.tsx")
    expect(map).toContain("app/lib/db.ts")
    expect(map).not.toContain("node_modules")
    expect(map).toContain("لا تخمّن غيرها")
  })

  test("an empty directory yields no map rather than a fabricated one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-empty-"))
    expect(await projectMap(dir)).toBe("")
  })
})
