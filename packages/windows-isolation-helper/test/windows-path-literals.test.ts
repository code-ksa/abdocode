/**
 * CL-16A3 MEGA-1 §4c — the `String.raw` rule, enforced by a machine.
 *
 * THIS TEST EXISTS BECAUSE WRITING THE RULE DOWN FAILED THREE TIMES.
 *
 * In a JavaScript string literal `"C:\Windows\Temp"` does not contain the
 * characters anyone reading it sees. `\W` and `\T` are not escapes the language
 * knows, and an unrecognised escape silently yields the bare character — so that
 * literal IS the string `C:WindowsTemp`. Worse, some path segments ARE valid
 * escapes: `"C:\Program Files\nodejs"` embeds a real newline where `\n` appears,
 * and `"C:\temp"` embeds a TAB. Nothing warns. The value is simply wrong, and it
 * is wrong in a way that reads as correct in review and in a diff.
 *
 * The trap has now landed three separate times in this package:
 *
 *   1. B2A §0 — the original occurrence.
 *   2. The P3 accessibility correction.
 *   3. `run-scope.ts`, where the probe's default working directory was
 *      `"C:\Windows\Temp"` and therefore `C:WindowsTemp`. That one survived
 *      because no test ever exercised the branch that used it, which is the
 *      general shape of the problem: a broken constant in a not-yet-reached path
 *      is invisible until the day it is reached.
 *
 * After each one the response was to write "always use String.raw" in a document.
 * Three recurrences is enough evidence that a rule enforced by memory is not
 * enforced. So the source is scanned, and a violation fails the suite.
 *
 * WHAT IS CHECKED. One unambiguous shape: a drive designator followed by an ODD
 * number of backslashes (`"C:\…"`). A correctly written literal spells one
 * backslash as `\\`, so an odd run means a character is being eaten as an escape.
 * `String.raw` templates are exempt — that is what they are for. The reasoning
 * behind choosing this shape over two broader ones, and what it consciously does
 * not catch, is recorded at `driveWithOddBackslashRun` below.
 *
 * Comments are stripped first. Prose in this codebase talks about `C:\Windows`
 * constantly and correctly, and flagging documentation would make the rule
 * annoying enough to be disabled — which is how enforcement dies.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const PKG = join(import.meta.dir, "..")

/** Every `.ts`/`.rs`-adjacent source file we own, excluding build output. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "target" || name === "dist") continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (name.endsWith(".ts")) out.push(p)
  }
  return out
}

/**
 * Remove comments so documentation prose is not scanned.
 *
 * Deliberately simple: it does not attempt to be a JavaScript parser, and it can
 * mis-handle a `//` inside a string. That direction is SAFE — the worst case is
 * that a little extra text is treated as a comment and skipped, which can only
 * cause a missed violation, never a false accusation. A lint that cries wolf gets
 * turned off; one that is occasionally lenient still catches the recurrence.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ")
}

/** A quoted literal, with its raw source text and where it sits. */
interface Literal {
  readonly raw: string
  readonly rawPrefixed: boolean
  readonly line: number
}

interface CorpusLiteral {
  readonly file: string
  readonly literal: Literal
}

interface CorpusMeasurement {
  readonly files: number
  readonly lines: number
  readonly literals: CorpusLiteral[]
}

/**
 * Pull `"..."`, `'...'` and `` `...` `` literals out of already-decommented
 * source, recording whether a template was prefixed with `String.raw`.
 */
function literals(src: string): Literal[] {
  const out: Literal[] = []
  const lines = src.split(/\r?\n/)
  for (const [i, line] of lines.entries()) {
    // Each quote style, scanned separately. Backslash-escaped terminators are
    // honoured so a literal is not cut short at `\"`.
    // P9/P10 gap 9 fix (2026-08-04): the template flag comes from WHICH pattern
    // matched, never from scanning the matched text. The old
    // `m[0].includes("\`")` misclassified any QUOTED literal that merely
    // contained a backtick as a template, took its body from the wrong capture
    // group, and scanned an empty string — making backtick-carrying literals
    // (exactly the PS-mangling artifact gap 9 hunts) invisible to every rule.
    const patterns: { re: RegExp; template: boolean }[] = [
      { re: /"((?:[^"\\\n]|\\.)*)"/g, template: false },
      { re: /'((?:[^'\\\n]|\\.)*)'/g, template: false },
      { re: /(String\.raw)?`((?:[^`\\]|\\.)*)`/g, template: true },
    ]
    for (const { re, template } of patterns) {
      for (const m of line.matchAll(re)) {
        const body = template ? (m[2] ?? "") : (m[1] ?? "")
        out.push({ raw: body, rawPrefixed: template && m[1] === "String.raw", line: i + 1 })
      }
    }
  }
  return out
}

/**
 * The defect, stated precisely: a DRIVE DESIGNATOR followed by an ODD run of
 * backslashes. `C:\\` is one real backslash and correct; `C:\` is an escape
 * eating the next character.
 *
 * Two earlier, looser versions of this check were rejected for producing false
 * positives on correct code — first by treating a leading backslash as a UNC
 * path (which made every `"\n"` a violation), then by flagging any odd run
 * anywhere inside a literal that happened to also contain a path (which caught
 * multi-line templates mixing a path with a newline). Both would have made the
 * rule irritating enough to switch off, and a disabled lint enforces nothing.
 *
 * FORMER KNOWN LIMIT, closed at Medium 2026-08-04 (P7 gap 8): a literal whose
 * drive designator is correct but which breaks in a LATER segment
 * (`"C:\\Program Files\nodejs"`) is now caught by
 * `wholePathLaterSegmentViolation` below — scoped to literals that are a whole
 * Windows path, never by broadening this designator rule.
 */
function driveWithOddBackslashRun(raw: string): string | undefined {
  // The drive letter must NOT be preceded by another letter or digit. Without
  // that guard, ordinary English prose ending in a colon matches: `"proofs:\n"`
  // reads as drive `s:` followed by a single backslash. Four such false
  // positives, all in report-formatting strings.
  for (const m of raw.matchAll(/(?:^|[^A-Za-z0-9])([A-Za-z]:)(\\+)/g)) {
    if ((m[2] ?? "").length % 2 === 1) {
      const at = m.index ?? 0
      return raw.slice(at, at + 24)
    }
  }
  return undefined
}

/**
 * P7/P8 gap 8, closed at Medium 2026-08-04 — the LATER-SEGMENT check, scoped by
 * STRUCTURE instead of broadened by regex.
 *
 * Two broad versions of this rule died of false positives (see above), and a
 * third — checking the narrowed rule against the literal's INTERPRETED value —
 * flagged 114 correct literals in the High session, because in the cooked value
 * of `"C:\\Windows"` the double backslash has already collapsed to one and every
 * correct path looks broken. The domain of this scanner is the RAW SOURCE TEXT,
 * where a correctly spelled backslash is exactly `\\` and an odd run is exactly
 * a character being eaten. That distinction — source syntax, not interpreted
 * path content — is what makes this version hold where three attempts failed.
 *
 * SCOPE, the actual fix: the odd-run test is applied to every backslash run only
 * when the ENTIRE literal parses as a Windows path — an anchored grammar of
 * drive designator + backslash-separated segments of filename-legal characters.
 * `"C:\\Program Files\nodejs"` is inside the scope (its raw text is nothing but
 * a path) and its second run has length 1: caught. A prose sentence, a regex
 * pattern with `*`/`?`/`(`, a format string mixing a path with `\n`-as-newline
 * and more prose — none of these parse as a whole path, so none acquire new
 * ways to be flagged. Out-of-scope literals keep exactly the drive-designator
 * rule they had before.
 *
 * No allowlist, no executable-name inference, fully deterministic: the decision
 * is a function of the literal's own characters.
 */
function wholePathLaterSegmentViolation(raw: string): string | undefined {
  // Whole-literal grammar: drive designator, then backslash-run + segment
  // pairs, optionally a trailing run. Segment characters are those legal in
  // Windows file names (no backslash, and none of  / : * ? " < > | ), plus no
  // raw control characters.
  if (!/^[A-Za-z]:(?:\\+[^\\/:*?"<>|\x00-\x1f]+)+\\*$/.test(raw)) return undefined
  for (const m of raw.matchAll(/\\+/g)) {
    if (m[0].length % 2 === 1) {
      const at = m.index ?? 0
      return raw.slice(Math.max(0, at - 12), at + 12)
    }
  }
  return undefined
}

/** NC-P7-8a: the deliberately-wrong designator-only version of the gap-8 rule. */
function wholePathDesignatorOnlyViolation(raw: string): string | undefined {
  if (!/^[A-Za-z]:(?:\\+[^\\/:*?"<>|\x00-\x1f]+)+\\*$/.test(raw)) return undefined
  const firstRun = raw.match(/^[A-Za-z]:(\\+)/)?.[1]
  if (!firstRun || firstRun.length % 2 === 0) return undefined
  return firstRun
}

/** NC-P7-8b: the rejected broad rule, which flags odd runs in any literal. */
function anyOddBackslashRunViolation(raw: string): string | undefined {
  for (const m of raw.matchAll(/\\+/g)) {
    if (m[0].length % 2 === 1) return m[0]
  }
  return undefined
}

function shippedPathViolation(raw: string): string | undefined {
  return driveWithOddBackslashRun(raw) ?? wholePathLaterSegmentViolation(raw) ?? dialectMangledPathViolation(raw)
}

/** The real source corpus. This test file is excluded because it owns broken fixtures. */
function measureRealCorpus(): CorpusMeasurement {
  let lines = 0
  const entries: CorpusLiteral[] = []
  const files = sourceFiles(PKG).filter((file) => !file.endsWith("windows-path-literals.test.ts"))
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    lines += source.split(/\r?\n/).length
    for (const literal of literals(stripComments(source))) {
      if (!literal.rawPrefixed) entries.push({ file, literal })
    }
  }
  return { files: files.length, lines, literals: entries }
}

/**
 * P9/P10 gap 9 — dialect-specific mangling, scoped exactly like gap 8: the
 * checks apply only to literals that are structurally a path, so prose and
 * patterns acquire no new ways to be flagged.
 *
 * Three artifact families a dialect-specific spawner can leave in source:
 *
 *  - UNC prefixes. A correctly written UNC literal is `\\\\server\\share` in
 *    source (leading run of FOUR). A leading run of exactly TWO cooks to one
 *    backslash — a rooted path, historically the fatal false positive, so it
 *    is OUT of scope. A literal that otherwise parses as a UNC path gets the
 *    same even-run rule as a drive path: any odd run is an eaten escape.
 *  - cmd `%VAR%` artifacts. This package spawns the helper with NO shell, so
 *    a `%name%` inside a whole-path literal can never expand — it would be
 *    used literally, which is never what the author meant.
 *  - PowerShell backtick escapes. A backtick inside a whole-path literal is
 *    the residue of a PS heredoc eating an escape (the `` `n `` family) —
 *    NTFS-legal, and never intentional here.
 */
function dialectMangledPathViolation(raw: string): string | undefined {
  const drivePath = /^[A-Za-z]:(?:\\+[^\\/:*?"<>|\x00-\x1f]+)+\\*$/.test(raw)
  // UNC scope: leading run of 3+ backslashes, then filename-legal segments.
  // (A leading run of exactly 2 is a rooted path once cooked — out of scope.)
  const uncMatch = raw.match(/^(\\{3,})[^\\/:*?"<>|\x00-\x1f]+(?:\\+[^\\/:*?"<>|\x00-\x1f]+)*\\*$/)
  if (!drivePath && !uncMatch) return undefined
  if (uncMatch) {
    // Every run must be even, INCLUDING the leader (four = a real `\\`).
    for (const m of raw.matchAll(/\\+/g)) {
      if (m[0].length % 2 === 1) return raw.slice(Math.max(0, (m.index ?? 0) - 12), (m.index ?? 0) + 12)
    }
  }
  const pct = raw.match(/%[A-Za-z_][A-Za-z0-9_]*%/)
  if (pct) return pct[0]
  const tick = raw.indexOf("`")
  if (tick >= 0) return raw.slice(Math.max(0, tick - 8), tick + 8)
  return undefined
}

describe("Windows path literals cannot silently lose their backslashes", () => {
  test("NON-VACUITY: the scanner catches the exact defect that shipped three times", () => {
    // The real line from `run-scope.ts`, before it was corrected.
    const bad = String.raw`const cwd = "C:\Windows\Temp"`
    const found = literals(bad).filter((l) => !l.rawPrefixed && driveWithOddBackslashRun(l.raw))
    expect(found.length).toBe(1)

    // And the nastier variant, where the mangling is a real control character.
    const worse = String.raw`const p = "C:\Program Files\nodejs\node.exe"`
    expect(literals(worse).filter((l) => !l.rawPrefixed && driveWithOddBackslashRun(l.raw)).length).toBe(1)

    // Correctly written forms must NOT be flagged, or the rule is unusable.
    for (const ok of [String.raw`const a = "C:\\Windows\\Temp"`, "const b = String.raw`C:\\Windows\\Temp`", String.raw`const c = "no path here"`]) {
      expect(literals(ok).filter((l) => !l.rawPrefixed && driveWithOddBackslashRun(l.raw)).length, ok).toBe(0)
    }
  })

  test("NON-VACUITY, gap 8: the later-segment break is caught, and only inside whole-path literals", () => {
    // THE SURVEY'S REQUIRED FIXTURE: drive designator correct, a LATER segment
    // eaten — the case three attempts failed to catch without false positives.
    const laterBroken = String.raw`const p = "C:\\Program Files\nodejs"`
    const flagged = literals(laterBroken).filter((l) => !l.rawPrefixed && wholePathLaterSegmentViolation(l.raw))
    expect(flagged.length).toBe(1)

    // Deeper break, same shape.
    const deepBreak = String.raw`const q = "C:\\Users\\abdo\\AppData\temp\\x"`
    expect(literals(deepBreak).filter((l) => !l.rawPrefixed && wholePathLaterSegmentViolation(l.raw)).length).toBe(1)

    // The exact literals the High approximation falsely flagged 114 of: fully
    // correct whole paths must never be violations.
    for (const ok of [String.raw`const a = "C:\\Windows\\System32\\cmd.exe"`, String.raw`const b = "C:\\Windows"`, String.raw`const c = "C:\\Program Files\\nodejs\\node.exe"`, String.raw`const d = "C:\\"`]) {
      expect(literals(ok).filter((l) => !l.rawPrefixed && wholePathLaterSegmentViolation(l.raw)).length, ok).toBe(0)
    }

    // OUT OF SCOPE by structure, not by allowlist: prose, regex-ish patterns,
    // format strings mixing a path with an intentional newline, String.raw.
    for (const outOfScope of [
      String.raw`const m = "expected C:\\x at line:\n"`, // prose + newline: not a whole path (contains a space)
      String.raw`const r = "C:\\d+\\s*"`, // even runs everywhere: no violation to report
      String.raw`const s = "see C:\\Windows for details"`, // path embedded in prose
      "const t = String.raw`C:\\Windows\\Temp`", // raw template: exempt
      String.raw`const u = "not a path at all\n"`,
    ]) {
      expect(literals(outOfScope).filter((l) => !l.rawPrefixed && wholePathLaterSegmentViolation(l.raw)).length, outOfScope).toBe(0)
    }
  })

  test("NC-P7-8a: removing later-segment detection misses the survey fixture", () => {
    const fixture = literals(String.raw`const p = "C:\\Program Files\nodejs"`).find((literal) => !literal.rawPrefixed)
    expect(fixture).toBeDefined()
    expect(wholePathLaterSegmentViolation(fixture!.raw)).toBeDefined()
    expect(wholePathDesignatorOnlyViolation(fixture!.raw), "the designator-only mutation must miss the later break").toBeUndefined()
  })

  test("NC-P7-8b: broadening to every odd escaped run falsely flags the real corpus", () => {
    const corpus = measureRealCorpus()
    const shipped = corpus.literals.filter(({ literal }) => shippedPathViolation(literal.raw))
    const broadened = corpus.literals.filter(({ literal }) => anyOddBackslashRunViolation(literal.raw))
    console.info(
      `P7-GAP8-CORPUS files=${corpus.files} lines=${corpus.lines} literals=${corpus.literals.length} shipped=${shipped.length} broadened=${broadened.length}`,
    )
    expect(shipped, "the shipped scoped rules must remain clean on the real corpus").toEqual([])
    expect(broadened.length, "the rejected broad mutation must produce real-corpus false positives").toBeGreaterThan(0)
  })

  test("NC-P7-8c: without the non-vacuity fixture a blind rule passes the clean corpus", () => {
    const detectsNothing = (_raw: string): string | undefined => undefined
    const corpus = measureRealCorpus()
    const corpusViolations = corpus.literals.filter(({ literal }) => detectsNothing(literal.raw))
    const fixture = literals(String.raw`const p = "C:\\Program Files\nodejs"`).find((literal) => !literal.rawPrefixed)
    expect(fixture).toBeDefined()
    expect(detectsNothing(fixture!.raw), "the blind mutation must miss the required fixture").toBeUndefined()
    expect(corpusViolations, "a corpus-only gate is vacuously green when the rule detects nothing").toEqual([])
  })

  test("NON-VACUITY, gap 9: dialect-mangling artifacts are caught, and only inside path-shaped literals", () => {
    // A UNC literal with an eaten later-segment escape (run of 1 after the
    // correct leading four).
    const uncBroken = String.raw`const u = "\\\\server\\share\nested"`
    expect(literals(uncBroken).filter((l) => !l.rawPrefixed && dialectMangledPathViolation(l.raw)).length).toBe(1)
    // A cmd expansion artifact inside a whole path.
    const pctArtifact = String.raw`const p = "C:\\%TEMP%\\work"`
    expect(literals(pctArtifact).filter((l) => !l.rawPrefixed && dialectMangledPathViolation(l.raw)).length).toBe(1)
    // A PS backtick residue inside a whole path.
    const tickArtifact = "const t = \"C:\\\\logs\\\\run`nfinal\""
    expect(literals(tickArtifact).filter((l) => !l.rawPrefixed && dialectMangledPathViolation(l.raw)).length).toBe(1)

    // Correct forms and historical false-positive shapes stay silent:
    for (const ok of [
      String.raw`const a = "\\\\server\\share\\file.txt"`, // correct UNC
      String.raw`const b = "\n"`, // the shape that killed the first broad attempt
      String.raw`const c = "\\n"`, // rooted-path/escaped-n lookalike: out of scope
      String.raw`const d = "C:\\Windows\\System32\\cmd.exe"`, // correct drive path
      String.raw`const e = "50% done, saved to disk"`, // prose percent: not a path
      "const f = `select \\`col\\` from t`", // backtick in a non-path template
    ]) {
      expect(literals(ok).filter((l) => !l.rawPrefixed && dialectMangledPathViolation(l.raw)).length, ok).toBe(0)
    }
  })

  test("no source file contains an invisible C0 control character", () => {
    // A SECOND WAY THE SAME PATH GETS MANGLED, and `String.raw` does not save
    // you from it. A shell heredoc turned `Execution\v1` into `Execution` +
    // U+000B + `1` inside a `String.raw` template: the backslash was eaten by
    // the *shell*, not by JavaScript, so the raw-string exemption applied and
    // the drive-designator rule saw nothing wrong. The tests still passed,
    // because the constant was used consistently on both sides of the
    // comparison — which is exactly what makes it dangerous. It read as a real
    // path and was not one.
    //
    // Tab, CR and LF are legitimate. Every other C0 control character in source
    // is either a mistake or an obfuscation, and neither belongs here.
    const offenders: string[] = []
    for (const file of sourceFiles(PKG)) {
      const src = readFileSync(file, "utf8")
      for (const [i, line] of src.split(/\r?\n/).entries()) {
        for (const [j, ch] of [...line].entries()) {
          const n = ch.charCodeAt(0)
          const isC0 = n <= 8 || n === 0x0b || n === 0x0c || (n >= 0x0e && n <= 0x1f)
          if (isC0) offenders.push(`${file.slice(PKG.length + 1)}:${i + 1}:${j + 1} — U+${n.toString(16).padStart(4, "0")}`)
        }
      }
    }
    expect(offenders, `invisible control characters in source:\n${offenders.join("\n")}`).toEqual([])
  })

  test("no source file in this package contains a mangled Windows path literal", () => {
    const corpus = measureRealCorpus()
    const violations = corpus.literals.flatMap(({ file, literal }) => {
      const run = shippedPathViolation(literal.raw)
      return run ? [`${file.slice(PKG.length + 1)}:${literal.line} — "${run}" (write it with String.raw\`…\`, or double every backslash)`] : []
    })
    console.info(
      `P7-GAP8-SHIPPED files=${corpus.files} lines=${corpus.lines} literals=${corpus.literals.length} violations=${violations.length}`,
    )
    expect(violations, `Windows path literals whose backslashes are being consumed as escapes:\n${violations.join("\n")}`).toEqual([])
  })
})
