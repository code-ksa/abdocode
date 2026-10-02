import { describe, expect, test } from "bun:test"
import { modelOutputViolation, truncatedWriteLine, truncatedWriteTarget } from "../src/model-output-guard"

describe("model output completeness gate", () => {
  test("rejects native and compatible output-budget truncation", () => {
    for (const reason of ["length", "max_tokens"]) {
      const failure = modelOutputViolation(reason)
      expect(failure).toContain("لم يُنفّذ أي اقتراح جزئي")
      expect(failure).not.toContain("نفّذ:")
    }
  })
  test("rejects interruptions even if a provider reported stop", () => {
    expect(modelOutputViolation("stop", true)).toContain("انقطع البث")
  })
  test("accepts complete provider responses", () => {
    expect(modelOutputViolation("stop")).toBeUndefined()
    expect(modelOutputViolation("end_turn")).toBeUndefined()
  })
})

// 10-02 — measured live: a whole-page write (25k chars) was cut at the generation cap twice in a row, each time told «shorten the reply» —
// and the model sent the same whole write again. A reply cut while writing a file names the file and gives the alternative.
describe("a reply cut while writing a whole file", () => {
  test("names the file and points to edit instead of the same whole write", () => {
    const partial = "نفّذ: write src/app/page.tsx <<<\nimport Link from \"next/link\"\nexport default function Home() {"
    expect(truncatedWriteTarget(partial)).toBe("src/app/page.tsx")
    const failure = modelOutputViolation("length", false, partial)!
    expect(failure).toBe(truncatedWriteLine("src/app/page.tsx"))
    expect(failure).toContain("«src/app/page.tsx» كاملاً")
    expect(failure).toContain("edit")
    expect(failure).toContain("لم يُكتب شيء")
    expect(failure).not.toContain("نفّذ:")
    // the narrated form too
    expect(truncatedWriteTarget("⚙ write a.css <<<\n:root{")).toBe("a.css")
  })
  test("twins: a cut reply that is not a write keeps the old line; a complete write is no violation", () => {
    expect(modelOutputViolation("length", false, "نفّذ: read a.ts\nسأقرأ ثمّ")).toContain("اختصر الرد")
    expect(modelOutputViolation("length")).toContain("اختصر الرد")
    expect(modelOutputViolation("stop", false, "نفّذ: write a.ts <<<\nx")).toBeUndefined()
    // prose mentioning write is not a write call
    expect(truncatedWriteTarget("سأستخدم write لاحقاً")).toBeUndefined()
  })
  test("both call sites pass the partial text, and the epoch cap is the output reserve", () => {
    const cli = require("node:fs").readFileSync(new URL("../src/cli.ts", import.meta.url), "utf-8") as string
    expect(cli).toContain('modelOutputViolation(decoded.finishReason, false, "text" in decoded && typeof decoded.text === "string" ? decoded.text : "")')
    expect(cli).toContain("modelOutputViolation(finishReason, false, partial)")
    expect(cli).toContain("const AGENT_EPOCH_OUTPUT_TOKENS = 16_384")
  })
})
