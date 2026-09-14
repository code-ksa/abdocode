import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { GoldenTrace } from "@abdo/schema/golden-trace"
import { parseConstrained, repairStats, promptSuspicion } from "../src/structured"

/**
 * The fifth golden trace: structured output.
 *
 * It lives here rather than with the other four because the code it captures
 * lives here. A golden trace kept away from its subject is a golden trace that
 * nobody updates when the subject moves.
 *
 * What it pins is the part that actually goes wrong in production: **which**
 * repairs a malformed model output needed, in which order, and whether the
 * result was clean, repaired or refused. "It parsed" is not the interesting
 * claim — a run whose outputs silently start needing three repairs each is a
 * model that has quietly degraded, and this is the artefact that makes that
 * visible instead of invisible.
 */

const GOLDEN = join(import.meta.dir, "golden", "structured-output.json")

const readGolden = () => (existsSync(GOLDEN) ? readFileSync(GOLDEN, "utf8").replaceAll("\r\n", "\n") : undefined)

const SAMPLES: readonly (readonly [string, string])[] = [
  ["already-json", '{"answer":"yes","count":2}'],
  ["fenced", '```json\n{"answer":"yes"}\n```'],
  ["prose-around-it", 'Sure! Here is the result:\n{"answer":"yes"}\nLet me know if that helps.'],
  ["trailing-comma", '{"answer":"yes",}'],
  ["unquoted-keys", "{answer: \"yes\"}"],
  ["single-quotes", "{'answer': 'yes'}"],
  ["several-at-once", "```json\n{answer: 'yes', extra: 1,}\n```"],
  ["not-json-at-all", "I cannot answer that."],
  ["truncated", '{"answer":"ye'],
]

const trace = () => {
  const recorder = GoldenTrace.recorder("structured-output")
  const outcomes = SAMPLES.map(([name, raw]) => {
    const outcome = parseConstrained(raw)
    recorder.record("parsed", {
      sample: name,
      kind: outcome.kind,
      // The repair list is the point: a change that starts needing more of them
      // is a regression the plain "did it parse" assertion cannot see.
      repairs: outcome.kind === "repaired" ? outcome.repairs : [],
      attempted: outcome.kind === "failed" ? outcome.attempted : [],
      value: outcome.kind === "failed" ? null : outcome.value,
    })
    return outcome
  })

  const stats = repairStats(outcomes)
  recorder.record("stats", { ...stats })
  recorder.record("suspicion", { ...promptSuspicion(stats) })
  return recorder.trace()
}

describe("golden trace — structured output", () => {
  test("the repair path is exactly what it was", () => {
    const verdict = GoldenTrace.verify(trace(), readGolden())
    if (verdict.ok) return
    if (GoldenTrace.updatesAllowed(process.env) && verdict.recorded !== undefined) {
      writeFileSync(GOLDEN, verdict.recorded, "utf8")
      throw new Error(`${verdict.why}\n\nRewrote ${GOLDEN} because ${GoldenTrace.UPDATE_ENV}=1. Review the diff and run again without it.`)
    }
    throw new Error(verdict.why)
  })

  test("the trace covers all three outcomes, or it is not covering the thing", () => {
    // A golden over nine clean parses would be stable, green, and evidence of
    // nothing about the repair machinery.
    const kinds = new Set(SAMPLES.map(([, raw]) => parseConstrained(raw).kind))
    expect([...kinds].sort()).toEqual(["clean", "failed", "repaired"])
  })
})
