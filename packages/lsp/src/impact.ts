/**
 * Impact analysis and test selection (Sprint 43).
 *
 * "Run the tests that matter" is usually implemented as a guess: the test file
 * whose name resembles the changed file. That guess is right often enough to be
 * trusted and wrong exactly when it matters — the test that would have caught
 * the break is two packages away and shares no part of the name.
 *
 * So the selection is DERIVED from the symbol graph, and when the graph cannot
 * reach far enough it says so and the answer is "run everything". A selection
 * that quietly narrowed is worse than no selection: the suite goes green in
 * less time and the caller believes something that was never checked.
 */
import { impactedFiles, type SymbolGraph } from "./graph"

export interface ImpactReport {
  /** Files reached from the changed symbols. */
  readonly affected: readonly string[]
  /** Test files among them, and tests covering them. */
  readonly tests: readonly string[]
  /** True when the traversal hit its depth bound — the list may be short. */
  readonly truncated: boolean
  readonly depthReached: number
  /** The honest instruction to the caller. */
  readonly recommendation: "run_selected" | "run_everything"
  readonly why: string
}

const isTestFile = (uri: string): boolean => /(^|[\\/])(test|tests|__tests__)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/.test(uri)

/**
 * Which tests to run for a change.
 *
 * Two things force `run_everything`, and both are cases where the honest answer
 * is "I do not know enough to narrow this":
 *
 *   - the traversal was truncated, so there may be affected files nobody listed
 *   - no test file was reached at all, which usually means the graph is thin
 *     rather than that the change is untested
 */
export function selectTests(
  graph: SymbolGraph,
  changedSymbols: readonly string[],
  options: { maxDepth?: number; allTests?: readonly string[] } = {},
): ImpactReport {
  const { files, truncated, depthReached } = impactedFiles(graph, changedSymbols, options.maxDepth ?? 5)
  const tests = files.filter(isTestFile)

  if (truncated) {
    return {
      affected: files,
      tests,
      truncated,
      depthReached,
      recommendation: "run_everything",
      why: `the impact traversal stopped at depth ${depthReached} with work still queued — a selection derived from a truncated graph would look complete and would not be`,
    }
  }

  if (graph.gaps.length > 0) {
    return {
      affected: files,
      tests,
      truncated,
      depthReached,
      recommendation: "run_everything",
      why: `the graph has ${graph.gaps.length} gap(s) (${graph.gaps[0]!.why}) — files nobody could analyse cannot be excluded from the impact`,
    }
  }

  if (tests.length === 0) {
    return {
      affected: files,
      tests,
      truncated,
      depthReached,
      recommendation: "run_everything",
      why: "no test file is reachable from the change, which is more often a thin graph than an untested change",
    }
  }

  return {
    affected: files,
    tests,
    truncated,
    depthReached,
    recommendation: "run_selected",
    why: `${tests.length} test file(s) reachable from ${changedSymbols.length} changed symbol(s) across ${files.length} affected file(s), depth ${depthReached}`,
  }
}

/**
 * The list a change is required to carry.
 *
 * Sprint 43's gate says every change is accompanied by its affected set. This
 * renders it, including the reasons a selection was refused, so the sentence in
 * the evidence pack is derived rather than written by whoever closed the sprint.
 */
export function formatImpact(report: ImpactReport): string {
  const lines = [
    `affected  ${report.affected.length} file(s)${report.truncated ? " (TRUNCATED)" : ""}`,
    `tests     ${report.tests.length > 0 ? report.tests.join(", ") : "(none reachable)"}`,
    `decision  ${report.recommendation}`,
    `why       ${report.why}`,
  ]
  return lines.join("\n")
}
