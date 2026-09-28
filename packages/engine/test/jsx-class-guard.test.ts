// حارسُ Tailwind بلا Tailwind — بلاغُ المالك 2026-09-28: أسماءٌ دلاليّة رُفضت «أصناف Tailwind كثيرة» ثلاثَ مرّات.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { definedCssClasses, tailwindUtilityCount, TAILWIND_REFUSAL_THRESHOLD } from "../src/jsx-class-guard"

describe("tailwindUtilityCount", () => {
  test("semantic class names that merely resemble Tailwind are not counted (the measured false positive)", () => {
    const page = `export default function Page(){return <main className="page"><header className="hero"><h1 className="text-title">x</h1></header>
      <section className="items-list"><div className="bg-card text-muted px-card"><span className="justify-note gap-note rounded-card shadow-card grid-cols-note">y</span></div></section></main>}`
    expect(tailwindUtilityCount(page, new Set())).toBeLessThan(TAILWIND_REFUSAL_THRESHOLD)
  })
  test("real Tailwind scales are counted and cross the threshold", () => {
    const page = `<div className="flex items-center justify-between gap-4 px-6 py-3 rounded-xl shadow-lg bg-slate-900 text-white text-sm md:px-8 hover:bg-slate-800">`
    expect(tailwindUtilityCount(page, new Set())).toBeGreaterThanOrEqual(TAILWIND_REFUSAL_THRESHOLD)
  })
  test("classes the project defines in its own CSS are never counted", () => {
    const dir = mkdtempSync(join(tmpdir(), "abdo-jsx-guard-"))
    mkdirSync(join(dir, "src", "app"), { recursive: true })
    writeFileSync(join(dir, "src", "app", "globals.css"), ".px-6{padding:0 1.5rem}.py-3{padding:.75rem 0}.rounded-xl{border-radius:12px}.shadow-lg{box-shadow:none}.gap-4{gap:1rem}.items-center{align-items:center}.justify-between{justify-content:space-between}.text-sm{font-size:14px}.bg-slate-900{background:#000}.text-white{color:#fff}.hover\\:bg-slate-800:hover{background:#111}.md\\:px-8{padding:0}")
    const defined = definedCssClasses(dir)
    expect(defined.has("px-6")).toBe(true)
    const page = `<div className="flex items-center justify-between gap-4 px-6 py-3 rounded-xl shadow-lg bg-slate-900 text-white text-sm md:px-8 hover:bg-slate-800">`
    expect(tailwindUtilityCount(page, defined)).toBeLessThan(TAILWIND_REFUSAL_THRESHOLD)
  })
})
