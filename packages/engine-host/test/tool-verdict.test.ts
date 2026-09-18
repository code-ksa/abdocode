import { describe, expect, test } from "bun:test"
import {
  REASONS,
  ToolVerdictLedger,
  VERDICT_OK,
  resolveDispatch,
  verdictFailed,
  verdictIsBreakage,
  type ToolVerdict,
  type ToolVerdictReason,
} from "../src/tool-verdict"
import { idempotencyKeyFor, resolveDispatch as barrelResolveDispatch } from "../src"

const here = import.meta.dir

describe("tool verdict vocabulary", () => {
  test("every ShellFailureClass literal in builtin-tools/src/shell.ts is a ToolVerdictReason (runtime pin)", async () => {
    const source = await Bun.file(`${here}/../../builtin-tools/src/shell.ts`).text()
    const start = source.indexOf("export type ShellFailureClass =")
    expect(start).toBeGreaterThan(-1)
    const rest = source.slice(start)
    const blankLine = rest.search(/\r?\n[ \t]*\r?\n/u)
    expect(blankLine).toBeGreaterThan(0)
    const block = rest.slice(0, blankLine)
    const literals = [...block.matchAll(/^[ \t]*\|[ \t]*"([^"]+)"/gmu)].map((match) => match[1]!)
    expect(literals.length).toBeGreaterThanOrEqual(7)
    const accepted = new Set<string>(REASONS)
    for (const literal of literals) expect({ literal, accepted: accepted.has(literal) }).toEqual({ literal, accepted: true })
  })

  test("the contracts failure codes we reuse still exist verbatim in contracts/src/failure.ts", async () => {
    const failure = await Bun.file(`${here}/../../contracts/src/failure.ts`).text()
    expect(failure).toContain('"policy_denied"')
    expect(failure).toContain('"tool_not_permitted"')
    const accepted = new Set<string>(REASONS)
    expect(accepted.has("policy_denied")).toBe(true)
    expect(accepted.has("tool_not_permitted")).toBe(true)
    expect(new Set(REASONS).size).toBe(REASONS.length)
  })
})

describe("resolveDispatch — the single normalization point", () => {
  test("a bare string yields no verdict and no key (absence is never coerced to ok)", () => {
    expect(resolveDispatch("x")).toEqual({ output: "x", verdict: undefined, idempotencyKey: undefined, mutated: undefined })
  })
  test("a result object without verdict yields verdict undefined", () => {
    const resolved = resolveDispatch({ output: "x" })
    expect(resolved.output).toBe("x")
    expect(resolved.verdict).toBeUndefined()
    expect(resolved.idempotencyKey).toBeUndefined()
  })
  test("a result with a verdict passes it through by reference, with its key", () => {
    const verdict: ToolVerdict = { ok: false, reason: "timeout", denied: false, detail: "30s" }
    const resolved = resolveDispatch({ output: "x", verdict, idempotencyKey: "idem:command::npm test:" })
    expect(resolved.verdict).toBe(verdict)
    expect(resolved.idempotencyKey).toBe("idem:command::npm test:")
    expect(resolveDispatch({ output: "y", verdict: VERDICT_OK }).verdict).toBe(VERDICT_OK)
  })
  test("a host-declared mutation rides through beside a failing verdict; absence stays undefined, never fabricated", () => {
    const refusedButWritten = resolveDispatch({ output: "x", verdict: { ok: false, reason: "guard_refused", denied: true }, mutated: true })
    expect(refusedButWritten.mutated).toBe(true)
    expect(refusedButWritten.verdict).toEqual({ ok: false, reason: "guard_refused", denied: true })
    expect(resolveDispatch({ output: "x" }).mutated).toBeUndefined()
    expect(resolveDispatch({ output: "x", verdict: VERDICT_OK }).mutated).toBeUndefined()
    expect(resolveDispatch("x").mutated).toBeUndefined()
  })
  test("the barrel re-exports the same function and the contracts idempotency key builder", () => {
    expect(barrelResolveDispatch).toBe(resolveDispatch)
    expect(idempotencyKeyFor({ kind: "file_edit", target: "a.ts", payloadDigest: "d", scope: "s" })).toBe("idem:file_edit:s:a.ts:d")
  })
})

describe("verdict predicates", () => {
  test("a policy denial fails the loop but is not breakage for walls/miner", () => {
    const denied: ToolVerdict = { ok: false, reason: "policy_denied", denied: true }
    expect(verdictFailed(denied)).toBe(true)
    expect(verdictIsBreakage(denied)).toBe(false)
  })
  test("a non-denied failure is both a loop failure and breakage; ok is neither", () => {
    const broken: ToolVerdict = { ok: false, reason: "nonzero_exit", denied: false }
    expect(verdictFailed(broken)).toBe(true)
    expect(verdictIsBreakage(broken)).toBe(true)
    expect(verdictFailed(VERDICT_OK)).toBe(false)
    expect(verdictIsBreakage(VERDICT_OK)).toBe(false)
    const reason: ToolVerdictReason = "isolation_refused"
    expect(verdictIsBreakage({ ok: false, reason, denied: true })).toBe(false)
  })
})

describe("ToolVerdictLedger", () => {
  test("counts explicit vs inferred over ALL results and names the inferred tools", () => {
    const ledger = new ToolVerdictLedger()
    ledger.observe("run npm test", VERDICT_OK)
    ledger.observe("run rm -rf dist", { ok: false, reason: "policy_denied", denied: true })
    ledger.observe("write a.ts <<<\nx", { ok: false, reason: "ledger_unsettled", denied: false })
    ledger.observe("list .", undefined)
    ledger.observe("grep foo src", undefined)
    const snapshot = ledger.snapshot()
    expect(snapshot).toEqual({
      total: 5,
      explicit: 3,
      inferred: 2,
      inferredTools: ["list", "grep"],
      denied: 1,
      failed: 1,
      byReason: { policy_denied: 1, ledger_unsettled: 1 },
      unmapped: 0,
    })
    const line = ledger.line(2)
    expect(line).toContain("📐 أحكام الأدوات ح2:")
    expect(line).toContain("صريح=3/5")
    expect(line).toContain("مستنتَج=2 (أدوات: list,grep)")
    expect(line).toContain("رفض سياسة=1")
    expect(line).toContain("فشل=1")
    expect(line).toContain("أسباب=policy_denied×1,ledger_unsettled×1")
    expect(line).toContain("غير ممطوط=0")
  })
  test("zero results renders a dash, never a coverage of 1.0", () => {
    const ledger = new ToolVerdictLedger()
    expect(ledger.line(1)).toBe("📐 أحكام الأدوات ح1: —")
    expect(ledger.snapshot().total).toBe(0)
  })
  test("unmapped increments only when flagged, and reset clears the epoch", () => {
    const ledger = new ToolVerdictLedger()
    ledger.observe("git status", { ok: false, reason: "tool_failed", denied: false })
    expect(ledger.snapshot().unmapped).toBe(0)
    ledger.observe("git status", { ok: false, reason: "tool_failed", denied: false }, true)
    expect(ledger.snapshot().unmapped).toBe(1)
    expect(ledger.snapshot().failed).toBe(2)
    expect(ledger.line(3)).toContain("غير ممطوط=1")
    ledger.reset()
    expect(ledger.snapshot()).toEqual({ total: 0, explicit: 0, inferred: 0, inferredTools: [], denied: 0, failed: 0, byReason: {}, unmapped: 0 })
    expect(ledger.line(4)).toBe("📐 أحكام الأدوات ح4: —")
  })
  test("an inferred tool is listed once even when it repeats", () => {
    const ledger = new ToolVerdictLedger()
    ledger.observe("list .", undefined)
    ledger.observe("list src", undefined)
    expect(ledger.snapshot().inferredTools).toEqual(["list"])
    expect(ledger.line(1)).toContain("صريح=0/2")
  })
})
