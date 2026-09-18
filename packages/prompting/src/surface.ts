/**
 * Tool surface minimisation (Sprint 46).
 *
 * Every tool in the schema costs tokens on every single turn and costs accuracy
 * on every single call: a model choosing between forty tools chooses wrong more
 * often than one choosing between eight, and the wrong choice is usually a
 * plausible neighbour rather than an obvious error. So the surface narrows to
 * what the current mode and task can actually use.
 *
 * The part that is easy to get wrong is the part this sprint is really about.
 * "Fewer tools must be better" is an assumption, and a hidden tool is not a
 * smaller problem — it is a capability the agent no longer has, which shows up
 * as a task it cannot finish rather than as a call it got wrong. So the
 * reduction is MEASURED, and `evaluateSurfaceChange` reverts it when the
 * numbers do not support it. A narrowing that helps accuracy and costs
 * completion is a narrowing that lost.
 */
import type { InstructionScope } from "./instructions"

export interface ToolDescriptor {
  readonly name: string
  /** Roughly what this tool's schema costs in the request. */
  readonly schemaTokens: number
  /** Risk classes it can produce — the S20 vocabulary. */
  readonly classes: readonly string[]
  /** Tasks/keywords this tool is relevant to. */
  readonly tags: readonly string[]
  /** Never hidden, whatever the mode: the agent cannot work without it. */
  readonly essential?: boolean
}

export interface SurfaceRequest {
  readonly mode: InstructionScope
  /** What the run is trying to do, in the words that reached the agent. */
  readonly objective: string
  readonly tools: readonly ToolDescriptor[]
  /** Classes this mode permits at all (S25). A tool it cannot use is noise. */
  readonly allowedClasses?: readonly string[]
  /** Never narrow below this many tools. */
  readonly floor?: number
}

export interface Surface {
  readonly exposed: readonly ToolDescriptor[]
  readonly hidden: readonly { readonly name: string; readonly why: string }[]
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly savedTokens: number
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2)

/**
 * Narrow the surface.
 *
 * Two reasons to hide a tool, and only two, both of them checkable:
 *
 *   the mode cannot use it   a DEPLOY-only tool in EXPLORE is not a choice the
 *                            model should be asked to make; the mode gate would
 *                            refuse it anyway, so showing it only invites a
 *                            call that will be denied.
 *   nothing in the objective refers to it, and it is not essential.
 *
 * "The model probably will not need it" is NOT one of the reasons. That is a
 * prediction about the task, and a surface built on predictions removes the
 * tool the agent turns out to need.
 */
export function narrowSurface(request: SurfaceRequest): Surface {
  const floor = request.floor ?? 4
  const objectiveWords = new Set(words(request.objective))
  const tokensBefore = request.tools.reduce((sum, t) => sum + t.schemaTokens, 0)

  const scored = request.tools.map((tool) => {
    if (tool.essential === true) return { tool, keep: true, why: "essential" }
    if (
      request.allowedClasses !== undefined &&
      tool.classes.length > 0 &&
      !tool.classes.some((c) => request.allowedClasses!.includes(c))
    ) {
      return { tool, keep: false, why: `this mode permits none of ${tool.classes.join(", ")}, so the call would be refused anyway` }
    }
    const relevant = tool.tags.some((tag) => objectiveWords.has(tag.toLowerCase()))
    return relevant
      ? { tool, keep: true, why: "the objective mentions it" }
      : { tool, keep: false, why: `nothing in the objective refers to ${tool.tags.join("/") || tool.name}` }
  })

  let kept = scored.filter((s) => s.keep)
  const dropped = scored.filter((s) => !s.keep)

  // the floor protects against an objective phrased in words no tag matches,
  // which would otherwise leave an agent holding almost nothing
  if (kept.length < floor) {
    const restored = dropped
      .filter((d) => !d.why.includes("refused anyway"))
      .sort((a, b) => a.tool.schemaTokens - b.tool.schemaTokens)
      .slice(0, floor - kept.length)
    kept = [...kept, ...restored.map((r) => ({ ...r, keep: true, why: "restored by the floor" }))]
    for (const r of restored) dropped.splice(dropped.indexOf(r), 1)
  }

  const exposed = kept.map((k) => k.tool).sort((a, b) => a.name.localeCompare(b.name))
  const tokensAfter = exposed.reduce((sum, t) => sum + t.schemaTokens, 0)

  return {
    exposed,
    hidden: dropped.map((d) => ({ name: d.tool.name, why: d.why })),
    tokensBefore,
    tokensAfter,
    savedTokens: tokensBefore - tokensAfter,
  }
}

export interface SurfaceMeasurement {
  /** Correct tool selections / total selections. */
  readonly toolAccuracy: number
  /** Tasks completed / tasks attempted. */
  readonly completion: number
  readonly samples: number
}

export interface SurfaceVerdict {
  readonly keep: boolean
  readonly why: string
  readonly accuracyDelta: number
  readonly completionDelta: number
}

/**
 * Did the narrowing earn its place?
 *
 * The asymmetry is deliberate. An accuracy gain has to be real to be kept; a
 * completion LOSS reverts the change even when accuracy improved, because a
 * tool the agent cannot see is a task it cannot finish, and finishing is not a
 * metric that trades against tidiness.
 */
export function evaluateSurfaceChange(
  before: SurfaceMeasurement,
  after: SurfaceMeasurement,
  minSamples = 5,
): SurfaceVerdict {
  const accuracyDelta = after.toolAccuracy - before.toolAccuracy
  const completionDelta = after.completion - before.completion

  if (Math.min(before.samples, after.samples) < minSamples)
    return {
      keep: false,
      why: `${Math.min(before.samples, after.samples)} sample(s) is not a measurement — revert until it is measured properly`,
      accuracyDelta,
      completionDelta,
    }

  if (completionDelta < -0.01)
    return {
      keep: false,
      why:
        `completion fell ${(completionDelta * -100).toFixed(0)} points: a hidden tool is not a smaller problem, ` +
        `it is a capability the agent no longer has` +
        (accuracyDelta > 0 ? ` — accuracy rose ${(accuracyDelta * 100).toFixed(0)} points and does not buy this` : ""),
      accuracyDelta,
      completionDelta,
    }

  if (accuracyDelta <= 0.005 && completionDelta <= 0.005)
    return {
      keep: false,
      why: "neither accuracy nor completion moved — the narrowing bought tokens and nothing else, so it is not worth the capability risk",
      accuracyDelta,
      completionDelta,
    }

  return {
    keep: true,
    why: `accuracy ${accuracyDelta >= 0 ? "+" : ""}${(accuracyDelta * 100).toFixed(1)} points, completion ${completionDelta >= 0 ? "+" : ""}${(completionDelta * 100).toFixed(1)} points over ${after.samples} samples`,
    accuracyDelta,
    completionDelta,
  }
}
