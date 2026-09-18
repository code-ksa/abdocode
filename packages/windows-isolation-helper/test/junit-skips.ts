/**
 * P5c2-FINAL-RC3 §5 — read the IDENTITIES of the tests bun skipped.
 *
 * Gate 8 has to compare skips as a SET, and bun's text summary gives only a
 * count: "2 skip" is identical whether the two skipped tests are the two that
 * are allowed to skip or two entirely different ones. The JUnit reporter is the
 * only output that names them, so the suite is run with it as well as the text
 * reporter and this parses the result.
 *
 * MEASURED, not assumed — bun 1.3.14 writes:
 *
 *   <testcase name="deep skip" classname="inner group &amp;gt; outer group" ...>
 *     <skipped />
 *   </testcase>
 *   <testcase name="a todo" ...><skipped message="TODO" /></testcase>
 *
 * Two traps live in that shape:
 *
 *  1. `classname` lists describes INNERMOST FIRST, the reverse of the
 *     `outer > inner > test` order bun's own `(fail)` lines use and the order a
 *     human writes an identity in. It is reversed here so one convention holds
 *     everywhere.
 *  2. The separator is DOUBLE-ESCAPED. bun escapes `>` to `&gt;` and then
 *     escapes that string's `&` again, so the attribute reads `&amp;gt;`. One
 *     decode pass leaves a literal `&gt;` that no split on `>` would find.
 *
 * A `todo` is reported as a skip with `message="TODO"`, so the two are separated
 * here rather than conflated: Gate 8 tolerates named skips and no todos at all.
 */

export interface JUnitSkips {
  /** Full identities of genuinely skipped tests: `outer > inner > name`. */
  readonly skipped: string[]
  /** Full identities of `todo` tests, which Gate 8 requires to be empty. */
  readonly todo: string[]
}

/** XML entities, decoded twice where bun double-escaped the separator. */
function decode(s: string): string {
  const once = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
  const first = once(s)
  // Only if a decoded entity is still sitting there — never blanket-decode
  // twice, which would eat a literal `&amp;` in a test name.
  return /&(lt|gt|quot|apos|amp);/.test(first) ? once(first) : first
}

/** `classname` is innermost-first; an identity reads outermost-first. */
function identityOf(classname: string, name: string): string {
  const groups = decode(classname)
    .split(">")
    .map((g) => g.trim())
    .filter((g) => g !== "")
    .reverse()
  return [...groups, decode(name).trim()].join(" > ")
}

const TESTCASE = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
const ATTR = (block: string, key: string): string => new RegExp(`\\b${key}="([^"]*)"`).exec(block)?.[1] ?? ""

export function parseJUnitSkips(xml: string): JUnitSkips {
  const skipped: string[] = []
  const todo: string[] = []
  for (const m of xml.matchAll(TESTCASE)) {
    const attrs = m[1] ?? ""
    const body = m[3] ?? ""
    const skip = /<skipped\b([^>]*)\/?>/.exec(body)
    if (!skip) continue
    const identity = identityOf(ATTR(attrs, "classname"), ATTR(attrs, "name"))
    if (/message="TODO"/i.test(skip[1] ?? "")) todo.push(identity)
    else skipped.push(identity)
  }
  return { skipped: skipped.sort(), todo: todo.sort() }
}
