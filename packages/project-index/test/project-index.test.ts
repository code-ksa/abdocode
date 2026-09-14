import { describe, expect, test } from "bun:test"
import { extractSymbols, ProjectIndex } from "../src/index"

const FILE = `
import { x } from "y"

export function computeTotal(a: number) { return a }
export class InvoiceService {}
interface LineItem { qty: number }
type Money = { cents: number }
export const TAX_RATE = 0.15
enum Status { Open }
`

describe("symbol extraction", () => {
  test("finds functions, classes, interfaces, types, consts, enums", () => {
    const names = extractSymbols(FILE).map((s) => `${s.kind}:${s.name}`)
    expect(names).toContain("function:computeTotal")
    expect(names).toContain("class:InvoiceService")
    expect(names).toContain("interface:LineItem")
    expect(names).toContain("type:Money")
    expect(names).toContain("const:TAX_RATE")
    expect(names).toContain("enum:Status")
  })

  test("records line numbers", () => {
    const s = extractSymbols(FILE).find((s) => s.name === "computeTotal")!
    expect(s.line).toBe(4)
  })
})

describe("ProjectIndex — tiers", () => {
  test("exact path lookup by full path and basename", () => {
    const idx = new ProjectIndex()
    idx.upsert("src/billing/invoice.ts", FILE)
    expect(idx.lookupPath("src/billing/invoice.ts")).toEqual(["src/billing/invoice.ts"])
    expect(idx.lookupPath("invoice.ts")).toEqual(["src/billing/invoice.ts"])
  })

  test("exact symbol lookup", () => {
    const idx = new ProjectIndex()
    idx.upsert("a.ts", FILE)
    const r = idx.lookupSymbol("InvoiceService")
    expect(r).toHaveLength(1)
    expect(r[0]!.path).toBe("a.ts")
    expect(r[0]!.symbol!.kind).toBe("class")
  })

  test("full-text ranks by token frequency", () => {
    const idx = new ProjectIndex()
    idx.upsert("high.ts", "invoice invoice invoice total")
    idx.upsert("low.ts", "invoice total")
    const r = idx.fullText("invoice")
    expect(r[0]!.path).toBe("high.ts")
    expect(r[0]!.score).toBeGreaterThan(r[1]!.score)
  })

  test("ladder prefers path, then symbol, then fts", () => {
    const idx = new ProjectIndex()
    idx.upsert("computeTotal.ts", "// mentions computeTotal in text")
    idx.upsert("service.ts", FILE) // declares symbol computeTotal
    const r = idx.search("computeTotal")
    // the file literally named computeTotal.ts wins the path tier
    expect(r[0]!.tier).toBe("path")
    expect(r.some((x) => x.tier === "symbol" && x.path === "service.ts")).toBe(true)
  })
})

describe("ProjectIndex — stale-index guard", () => {
  test("unchanged content is a no-op (same revision)", () => {
    const idx = new ProjectIndex()
    const a = idx.upsert("f.ts", FILE)
    const b = idx.upsert("f.ts", FILE)
    expect(b.revision).toBe(a.revision)
  })

  test("modified file re-indexes: old symbol gone, new symbol found", () => {
    const idx = new ProjectIndex()
    idx.upsert("f.ts", "export function oldName() {}")
    expect(idx.lookupSymbol("oldName")).toHaveLength(1)
    expect(idx.isStale("f.ts", "export function newName() {}")).toBe(true)

    const updated = idx.upsert("f.ts", "export function newName() {}")
    expect(updated.revision).toBe(2)
    expect(idx.lookupSymbol("oldName")).toHaveLength(0) // stale symbol purged
    expect(idx.lookupSymbol("newName")).toHaveLength(1)
  })

  test("remove purges symbols and tokens", () => {
    const idx = new ProjectIndex()
    idx.upsert("f.ts", FILE)
    idx.remove("f.ts")
    expect(idx.size).toBe(0)
    expect(idx.lookupSymbol("InvoiceService")).toHaveLength(0)
    expect(idx.fullText("invoice")).toHaveLength(0)
  })
})
