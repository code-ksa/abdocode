/**
 * Golden traces for engine flows.
 *
 * S117's equivalence claim and S130's cut condition both name "golden traces",
 * and on 2026-08-23 a survey found there were none in the repository at all —
 * the only `golden` was the contract-frame test in `abdo-contracts`. Two
 * sprints were blocked on an artefact nobody had built. This is the artefact.
 *
 * # The failure mode a golden test is born with
 *
 * The obvious implementation regenerates the fixture when it does not match.
 * That is not a test: it is a program that writes down whatever happened and
 * then agrees with it. Every behaviour change passes, including the ones that
 * are bugs, and the file's git history becomes a log of accidents nobody read.
 *
 * So: comparison never writes. Regeneration is a separate, deliberate act
 * gated on `ABDO_UPDATE_GOLDEN=1`, it prints what it is about to change, and a
 * **missing fixture is a failure** rather than an invitation. A golden file
 * that appears on first run is a golden file nobody ever reviewed.
 *
 * # Nondeterminism is refused, not scrubbed
 *
 * The other way golden traces rot is that somebody makes them stable by
 * scrubbing until nothing is left. Here a field that looks nondeterministic —
 * a timestamp, a random id, a temp path — makes canonicalization **fail by
 * name**, and the only way past it is to declare that field volatile at the
 * recording site. The declaration is in the diff when it changes; a regex that
 * quietly ate the field is not.
 *
 * It lives in `@abdo/schema` for the same reason the token estimator does: it
 * has no dependencies, and everything that needs it — the engine, the prompting
 * layer, the context compiler — must be able to reach it without one package
 * having to depend on another just to compare a trace.
 */

export interface TraceEntry {
  readonly step: number
  readonly kind: string
  readonly detail: Readonly<Record<string, unknown>>
}

export interface Trace {
  readonly flow: string
  readonly entries: readonly TraceEntry[]
}

export interface Recorder {
  readonly record: (kind: string, detail?: Readonly<Record<string, unknown>>) => void
  readonly trace: () => Trace
}

/**
 * Values that must never appear in a trace, because they differ every run.
 *
 * Each pattern is named so the failure says which one fired: "looks like a
 * timestamp" is actionable, "does not match the golden" is not.
 */
const VOLATILE_SHAPES: readonly (readonly [string, RegExp])[] = [
  ["an ISO timestamp", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/],
  ["a UUID", /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ["a long hex id", /^[0-9a-f]{24,}$/i],
  ["a temp path", /(?:\/tmp\/|[A-Za-z]:\\+Users\\+[^\\]+\\+AppData|\\Temp\\|\/var\/folders\/)/],
  ["an absolute Windows path", /^[A-Za-z]:[\\/]/],
]

export const recorder = (flow: string): Recorder => {
  const entries: TraceEntry[] = []
  return {
    record: (kind, detail) => {
      entries.push({ step: entries.length, kind, detail: detail ?? {} })
    },
    trace: () => ({ flow, entries }),
  }
}

/** Marks a value as deliberately volatile. It is replaced, and the fact is visible. */
export const volatileValue = (label: string) => `<volatile:${label}>`

const isVolatileMarker = (value: unknown) => typeof value === "string" && value.startsWith("<volatile:")

const scan = (value: unknown, path: string, problems: string[]): void => {
  if (isVolatileMarker(value)) return
  if (typeof value === "string") {
    for (const [name, shape] of VOLATILE_SHAPES) {
      if (shape.test(value)) problems.push(`${path} looks like ${name}: ${JSON.stringify(value.slice(0, 60))}`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scan(entry, `${path}[${index}]`, problems))
    return
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) scan(entry, `${path}.${key}`, problems)
  }
}

const sortedJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortedJson(entry)]),
    )
  }
  return value
}

export type Canonical = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly why: string }

/**
 * The trace as stable text, or a refusal naming what is unstable about it.
 *
 * Key order is sorted so a refactor that reorders an object literal does not
 * read as a behaviour change. Entry order is not sorted — the order things
 * happened in is the thing being captured.
 */
export const canonical = (trace: Trace): Canonical => {
  const problems: string[] = []
  scan(trace.entries, "trace", problems)
  if (problems.length > 0) {
    return {
      ok: false,
      why: `the trace carries values that change every run, so it can never be golden:\n  ${problems.join("\n  ")}\n  Wrap each with volatileValue(label) at the recording site if that is intended.`,
    }
  }
  return { ok: true, text: `${JSON.stringify(sortedJson({ flow: trace.flow, entries: trace.entries }), null, 2)}\n` }
}

export type Verdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly why: string; readonly recorded?: string; readonly expected?: string }

/** First line that differs, with context. A whole-file diff buries the change. */
const firstDifference = (recorded: string, expected: string) => {
  const left = recorded.split("\n")
  const right = expected.split("\n")
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] !== right[index]) {
      return `line ${index + 1}:\n  golden:   ${right[index] ?? "<end of file>"}\n  recorded: ${left[index] ?? "<end of file>"}`
    }
  }
  return "the files differ only in trailing whitespace"
}

/**
 * Compare a trace against its golden text.
 *
 * `expected === undefined` means the fixture is missing, and that is a failure.
 * A harness that creates the file it was supposed to check passes on its first
 * run for every flow, correct or not.
 */
export const verify = (trace: Trace, expected: string | undefined): Verdict => {
  const rendered = canonical(trace)
  if (!rendered.ok) return { ok: false, why: rendered.why }
  if (expected === undefined) {
    return {
      ok: false,
      why: `no golden trace on disk for "${trace.flow}". Review the recorded trace and commit it deliberately; a golden file that appears by itself is one nobody read.`,
      recorded: rendered.text,
    }
  }
  if (rendered.text !== expected) {
    return {
      ok: false,
      why: `the "${trace.flow}" flow no longer matches its golden trace.\n${firstDifference(rendered.text, expected)}`,
      recorded: rendered.text,
      expected,
    }
  }
  return { ok: true }
}

/** Set to `1` to allow regeneration. Deliberately awkward, and read once. */
export const UPDATE_ENV = "ABDO_UPDATE_GOLDEN"

export const updatesAllowed = (env: Readonly<Record<string, string | undefined>>) => env[UPDATE_ENV] === "1"

export * as GoldenTrace from "./golden-trace"
