/**
 * 10-01 — ما يُحمل من القراءات إلى الحقبة التالية. مقيس: Sprint 14 قرأ ~89 ألفَ حرف في الحقبة الأولى، والحاملُ القديم (آخرُ 20 ألفاً)
 * أسقط أوّلَ القراءات فأُعيدت بالترتيب نفسِه حتى حارس التكرار.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { READ_CARRY_CHARS, carriedReads } from "../src/text-agent-loop"

const receipt = (cmd: string, size: number, fill = "x"): string => `نتيجة موثقة لـ«${cmd}»:\n${fill.repeat(size)}`

describe("carried reads", () => {
  test("the measured epoch: eleven reads, ~89k chars — whole receipts newest-first up to the budget, reading order kept, the rest named", () => {
    const files = [["read ABDO-SPRINTS.md", 14_000], ["read docs/design-style-reference.md", 6_600], ["read src/app/globals.css", 14_000], ["read src/app/layout.tsx", 4_000], ["read src/components/layout/header.tsx", 9_000], ["read src/components/ui/sidebar.tsx", 8_000], ["read src/app/page.tsx", 12_000], ["read src/app/models/page.tsx", 11_000], ["read src/components/layout/footer.tsx", 3_000], ["read src/app/chat/page.tsx", 4_000], ["read tailwind.config.ts", 3_000]] as const
    const receipts = files.map(([cmd, n]) => receipt(cmd, n))
    const total = receipts.reduce((s, r) => s + r.length, 0)
    expect(total).toBeGreaterThan(85_000)
    const carried = carriedReads(receipts)
    // كلُّ إيصالٍ محمولٍ كاملٌ — لا قطعَ من الوسط.
    for (const r of receipts) if (carried.includes(r.split("\n", 1)[0]! + "\n")) expect(carried).toContain(r)
    // الأحدثُ محمولٌ، والأقدمُ مسمّى، والترتيبُ ترتيبُ القراءة.
    expect(carried).toContain("نتيجة موثقة لـ«read tailwind.config.ts»")
    expect(carried).toContain("ولم تُحمل لضيق السياق")
    expect(carried).toContain("read ABDO-SPRINTS.md")
    expect(carried.indexOf("read src/app/page.tsx»")).toBeLessThan(carried.indexOf("read tailwind.config.ts»"))
    expect(carried.length).toBeLessThan(READ_CARRY_CHARS + 600)
    // التوأم: الحاملُ القديم يحمل أقلَّ من ربع ذلك ويقطع إيصالاً من وسطه.
    const old = receipts.join("\n\n").slice(-20_000)
    expect(old.startsWith("نتيجة موثقة")).toBe(false)
    expect(carried.length).toBeGreaterThan(old.length * 2)
  })
  test("a repeated read of the same command is carried once — its latest copy", () => {
    const carried = carriedReads([receipt("read a.ts", 10, "1"), receipt("read b.ts", 10, "2"), receipt("read a.ts", 10, "3")])
    expect(carried.match(/read a\.ts/gu)?.length).toBe(1)
    expect(carried).toContain("3333333333")
    expect(carried).not.toContain("1111111111")
    expect(carried.indexOf("read b.ts")).toBeLessThan(carried.indexOf("read a.ts"))
  })
  test("under the budget everything is carried with no note; one receipt larger than the budget is named, not cut", () => {
    expect(carriedReads([receipt("read a.ts", 100), receipt("read b.ts", 100)])).not.toContain("لم تُحمل")
    const huge = carriedReads([receipt("read big.json", READ_CARRY_CHARS + 10), receipt("read small.ts", 50)])
    expect(huge).toContain("read small.ts")
    expect(huge).toContain("أعد قراءةَ ما تحتاجه منها وحده: read big.json")
    expect(huge.length).toBeLessThan(400)
    expect(carriedReads([])).toBe("")
  })
  test("the epoch memory uses it", () => {
    const src = readFileSync(join(import.meta.dir, "../src/text-agent-loop.ts"), "utf8")
    expect(src).toContain("${carriedReads(readReceipts, options.readCarryChars ?? READ_CARRY_CHARS)}")
    expect(src).not.toContain('readReceipts.join("\\n\\n").slice(-20_000)')
  })
})
