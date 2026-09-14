/**
 * P7 dialect contract — survey gaps 6 and 12.
 *
 * WHAT THESE COVER, AND WHY THEY NEED NO PROCESS. Gap 6 is about reading the
 * helper's payload out of a stdout stream that a Windows shell has been allowed
 * to touch: CRLF endings, a UTF-8 BOM, banner lines before the payload, noise
 * after it. That is a pure string contract, so it is tested as one — against
 * `readHelperPayload` directly, with synthetic streams. No helper is spawned, no
 * process is created, and the result does not depend on the integrity level of
 * the shell running it.
 *
 * THE NEGATIVE CONTROLS AT THE BOTTOM ARE EXECUTABLE AND RUN ON EVERY TEST
 * RUN (P7-R1). Each reads the real `src/helper-runner.ts` at test time,
 * removes exactly the guard under test from a copy — asserting the removal
 * actually matched, so a moved or deleted guard fails loudly instead of
 * silently passing — imports the mutated copy from a temp directory OUTSIDE
 * the repository, and asserts the mutated module loses the property the guard
 * provides. The mutated copy is never written into `src/`: an untracked file
 * left behind by a run that dies mid-test would block the merge gate.
 *
 * Gap 12 — the exit-code contract — needs real abnormal exits (a real crashed
 * child, a real timeout kill) and lives in
 * `dialect-exit-contract-medium.test.ts`, including its control NC-P7-12a.
 */
import { describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { readHelperPayload } from "../src/helper-runner"

const payload = `{"ok":true,"protocolVersion":10,"elevated":false}`

describe("gap 6 — the payload is found without assuming the dialect", () => {
  it("reads a plain LF stream", () => {
    expect(readHelperPayload(`${payload}\n`)?.protocolVersion).toBe(10)
  })

  it("reads a CRLF stream, which is what cmd and PowerShell actually produce", () => {
    expect(readHelperPayload(`${payload}\r\n`)?.protocolVersion).toBe(10)
  })

  it("skips a banner line that a parent shell printed first", () => {
    expect(readHelperPayload(`Microsoft Windows [Version 10.0.26200]\r\n\r\n${payload}\r\n`)?.ok).toBe(true)
  })

  it("skips shell noise printed AFTER the payload, which the old last-line reader could not", () => {
    // This is the case that motivated the change: the payload is no longer last.
    expect(readHelperPayload(`${payload}\r\nC:\\Windows>\r\n`)?.ok).toBe(true)
  })

  it("tolerates a UTF-8 BOM sitting after a banner rather than at the very start", () => {
    expect(readHelperPayload(`banner\r\n\uFEFF${payload}\r\n`)?.protocolVersion).toBe(10)
  })

  it("tolerates a leading BOM on the first and only line", () => {
    expect(readHelperPayload(`\uFEFF${payload}`)?.protocolVersion).toBe(10)
  })

  it("prefers the LAST payload when the helper emitted more than one", () => {
    const first = `{"ok":false,"protocolVersion":10}`
    expect(readHelperPayload(`${first}\r\n${payload}\r\n`)?.ok).toBe(true)
  })

  it("refuses a bare number as a response, however JSON-valid it is", () => {
    // A shell echoing an errorlevel must never become a HelperResponse.
    expect(readHelperPayload(`3\r\n`)).toBeUndefined()
  })

  it("refuses a JSON array as a response", () => {
    expect(readHelperPayload(`[1,2,3]\r\n`)).toBeUndefined()
  })

  it("refuses a JSON string as a response", () => {
    expect(readHelperPayload(`"ok"\r\n`)).toBeUndefined()
  })

  it("returns undefined rather than throwing when there is no JSON at all", () => {
    // The old reader threw a raw SyntaxError from inside probeHelperSelfReport,
    // which told the caller nothing about which helper or what it said.
    expect(readHelperPayload(`'helper' is not recognized as an internal command\r\n`)).toBeUndefined()
  })

  it("returns undefined for an empty stream", () => {
    expect(readHelperPayload("")).toBeUndefined()
  })

  it("does not mistake a truncated payload for a good one", () => {
    expect(readHelperPayload(`{"ok":true,"protocolVer`)).toBeUndefined()
  })
})

const HELPER_RUNNER_SOURCE = join(import.meta.dir, "..", "src", "helper-runner.ts")

/**
 * Read the real helper-runner source, remove exactly one guard from a copy,
 * and import the mutation from a temp directory outside the repository.
 * Fails loudly if `needle` does not occur exactly once: a control whose guard
 * text no longer exists must not silently pass.
 */
async function mutatedHelperRunner(needle: string, replacement: string) {
  // Normalize EOL before matching: the working tree is checked out CRLF on
  // Windows, but a template literal's cooked value holds LF, so the raw bytes
  // would never match a multi-line needle.
  const source = readFileSync(HELPER_RUNNER_SOURCE, "utf8").replace(/\r\n/g, "\n")
  expect(source.split(needle).length).toBe(2)
  const mutated = source.replace(needle, replacement)
  expect(mutated).not.toBe(source)
  const tmp = join(tmpdir(), `abdo-nc-${randomUUID()}.ts`)
  writeFileSync(tmp, mutated, "utf8")
  try {
    const mod = await import(pathToFileURL(tmp).href)
    return { mod, cleanup: () => rmSync(tmp, { force: true }) }
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

describe("negative controls — the guards, demonstrated load-bearing on every run", () => {
  it("NC-P7-6c: the object check is the single load-bearing refusal of scalars and arrays", async () => {
    // P7-R1 removed the `candidate[0] !== "{"` prefilter: no JSON text
    // beginning with "{" can parse as a non-object, so behind it this check
    // was dead code. Without the prefilter, the check is the ONE decision
    // refusing bare numbers, strings and arrays. Mutate it out and the
    // module accepts all three as a HelperResponse.
    const m = await mutatedHelperRunner(
      `      const parsed: unknown = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as HelperResponse
      }`,
      `      const parsed: unknown = JSON.parse(candidate)
      return parsed as HelperResponse`,
    )
    try {
      expect(readHelperPayload("3")).toBeUndefined()
      expect(m.mod.readHelperPayload("3")).toBe(3)
      expect(readHelperPayload(`"ok"`)).toBeUndefined()
      expect(m.mod.readHelperPayload(`"ok"`)).toBe("ok")
      expect(readHelperPayload("[1,2,3]")).toBeUndefined()
      expect(m.mod.readHelperPayload("[1,2,3]")).toEqual([1, 2, 3])
    } finally {
      m.cleanup()
    }
  })

  it("NC-P7-6a: the CR strip is load-bearing — but only for a CR inside the line", async () => {
    // Measured distinction, answering the question P7-R1 was given:
    // - CRLF line endings: NOT load-bearing territory for the strip. CR and
    //   BOM are both ES WhiteSpace, so the .trim() on the same line already
    //   recovers a payload with edge CR/BOM — every CRLF case above.
    expect(`\uFEFF${payload}\r`.trim()).toBe(payload)
    // - A raw CR BETWEEN JSON tokens is legal JSON whitespace, so the strip
    //   does not decide that case either.
    expect(JSON.parse(`{"ok":\rtrue}`)).toEqual({ ok: true })
    // - The one position .trim() cannot reach is a CR INSIDE the line. Raw
    //   control characters are invalid inside a JSON string, so the strip —
    //   which deletes the CR — is the difference between a payload and
    //   undefined. The control is built on exactly that case. (The BOM half
    //   of the expression is load-bearing the same way, and more broadly: a
    //   BOM between tokens is NOT legal JSON whitespace.)
    const m = await mutatedHelperRunner(
      `    const candidate = lines[i]!.replace(/\uFEFF/g, "").replace(/\\r/g, "").trim()`,
      `    const candidate = lines[i]!.replace(/\uFEFF/g, "").trim()`,
    )
    try {
      const interior = `{"note":"line1\rline2"}`
      expect(readHelperPayload(interior)?.note).toBe("line1line2")
      expect(m.mod.readHelperPayload(interior)).toBeUndefined()
    } finally {
      m.cleanup()
    }
  })
})

/**
 * The real-process half of gap 12 — a real timeout kill, a real non-zero exit
 * with valid JSON on stdout, a real exit-0 with unreadable stdout, and the
 * real helper under cmd.exe / powershell.exe parents — lives in
 * `dialect-exit-contract-medium.test.ts`, together with NC-P7-12a. A crash
 * you simulate is not a crash you have handled, so nothing here fakes it.
 */
