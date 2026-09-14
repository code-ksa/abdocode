/**
 * Targeting and interaction (Sprints 62-64, 67-69).
 *
 * The owner's order is enforced here as a LADDER with a recorded rung. An
 * action starts at the top and may only descend after the rung above it has
 * been tried and has FAILED, in writing:
 *
 *   1. DOM / accessibility   role + name, which survive a restyle
 *   2. semantic click/fill   the provider does the pointing
 *   3. vision                only after a recorded semantic failure (Sprint 66)
 *   4. coordinates           last, and the target is re-verified before the
 *                            click lands (Sprint 67)
 *
 * Descending without a recorded failure is refused. Not discouraged — refused.
 * A ladder anybody can skip is a preference, and preferences lose to whatever
 * is shortest to write at 2am.
 */
import type { AxNode, BrowserProvider, DomNode } from "./provider"

export interface Target {
  readonly role: string
  readonly name: string
  /** Which one, when several match. Absent = there must be exactly one. */
  readonly nth?: number
}

export type Resolution =
  | { readonly kind: "resolved"; readonly node: AxNode; readonly how: "role_name" }
  | { readonly kind: "ambiguous"; readonly matches: readonly AxNode[]; readonly why: string }
  | { readonly kind: "not_found"; readonly why: string; readonly nearest: readonly string[] }

const flatten = (node: AxNode): AxNode[] => [node, ...node.children.flatMap(flatten)]

const normalise = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase()

/**
 * Find a node by role and accessible name.
 *
 * Ambiguity is a REFUSAL, not a coin flip. Two buttons named "Delete" mean the
 * caller has not said which record, and picking the first is how an agent
 * deletes the wrong row while every log line looks correct.
 *
 * A miss reports the nearest names, because "not found" without them sends the
 * agent to a screenshot — the rung it should reach last.
 */
export function resolveTarget(tree: AxNode, target: Target): Resolution {
  const all = flatten(tree)
  const matches = all.filter((n) => normalise(n.role) === normalise(target.role) && normalise(n.name) === normalise(target.name))

  if (matches.length === 0) {
    const nearest = all
      .filter((n) => normalise(n.role) === normalise(target.role) && n.name.length > 0)
      .map((n) => n.name)
      .slice(0, 5)
    return {
      kind: "not_found",
      why: `no ${target.role} named "${target.name}"`,
      nearest,
    }
  }

  if (matches.length > 1 && target.nth === undefined)
    return {
      kind: "ambiguous",
      matches,
      why: `${matches.length} elements match ${target.role} "${target.name}" — picking the first is how an agent deletes the wrong row while every log line looks correct`,
    }

  const node = target.nth === undefined ? matches[0]! : matches[target.nth]
  if (node === undefined)
    return { kind: "not_found", why: `only ${matches.length} match(es), so index ${target.nth} does not exist`, nearest: [] }

  return { kind: "resolved", node, how: "role_name" }
}

// --------------------------------------------------------------------------
// Sprint 62 — DOM-first inspection
// --------------------------------------------------------------------------

export interface PageQuestion {
  readonly kind: "text_present" | "element_state" | "field_value" | "url"
  readonly text?: string
  readonly target?: Target
}

export type Answer =
  | { readonly kind: "answered"; readonly value: string | boolean; readonly from: "dom" | "accessibility" }
  | { readonly kind: "unanswerable"; readonly why: string }

const domText = (node: DomNode): string =>
  [node.text ?? "", ...node.children.map(domText)].join(" ").replace(/\s+/g, " ").trim()

/**
 * Answer a question about the page from structure, never from a picture.
 *
 * `unanswerable` is a real outcome and it is what unlocks the next rung. A
 * question the DOM cannot answer is the recorded failure that Sprint 66 needs
 * before vision may be used — so the escalation is a consequence of a fact
 * rather than of an agent's mood.
 */
export async function askPage(provider: BrowserProvider, question: PageQuestion): Promise<Answer> {
  if (question.kind === "url") return { kind: "answered", value: await provider.currentUrl(), from: "dom" }

  if (question.kind === "text_present") {
    const text = domText(await provider.dom())
    if (question.text === undefined) return { kind: "unanswerable", why: "no text was given to look for" }
    return { kind: "answered", value: normalise(text).includes(normalise(question.text)), from: "dom" }
  }

  if (question.target === undefined) return { kind: "unanswerable", why: "the question names no element" }
  const resolution = resolveTarget(await provider.accessibility(), question.target)
  if (resolution.kind !== "resolved")
    return {
      kind: "unanswerable",
      why: `${resolution.why}${resolution.kind === "not_found" && resolution.nearest.length > 0 ? ` (nearest: ${resolution.nearest.join(", ")})` : ""}`,
    }

  if (question.kind === "field_value") {
    const value = (await provider.readValue(resolution.node.nodeId)) ?? resolution.node.value
    return value === undefined
      ? { kind: "unanswerable", why: "the element has no readable value" }
      : { kind: "answered", value, from: "accessibility" }
  }

  return { kind: "answered", value: resolution.node.disabled !== true, from: "accessibility" }
}

// --------------------------------------------------------------------------
// Sprints 64, 68 — semantic click and fill
// --------------------------------------------------------------------------

export type ActionOutcome =
  | { readonly kind: "done"; readonly how: "semantic"; readonly nodeId: string }
  | { readonly kind: "failed"; readonly why: string; readonly resolution: Resolution }

export async function clickSemantic(provider: BrowserProvider, target: Target): Promise<ActionOutcome> {
  const resolution = resolveTarget(await provider.accessibility(), target)
  if (resolution.kind !== "resolved") return { kind: "failed", why: resolution.why, resolution }
  if (resolution.node.disabled === true)
    return { kind: "failed", why: `${target.role} "${target.name}" is disabled`, resolution }
  await provider.clickNode(resolution.node.nodeId)
  return { kind: "done", how: "semantic", nodeId: resolution.node.nodeId }
}

export interface FillOutcome {
  readonly kind: "done" | "mismatch" | "failed"
  readonly why: string
  readonly wrote?: string
  readonly readBack?: string
}

/**
 * Type into a field and READ IT BACK.
 *
 * This is Sprint 68's whole content, and it is not paranoia. Arabic input
 * through a browser passes an IME, a bidi algorithm, a framework's controlled
 * input, and a form serialiser, and every one of them has a documented way of
 * changing what the user typed. A fill that does not verify is a fill that
 * reports success for text nobody sent.
 *
 * The comparison is codepoint by codepoint on the RAW strings — no
 * normalisation, no trim — because normalising before comparing hides exactly
 * the corruption this is looking for. A field that legitimately trims is a
 * field whose expected value should say so.
 */
export async function fillAndVerify(provider: BrowserProvider, target: Target, text: string): Promise<FillOutcome> {
  const resolution = resolveTarget(await provider.accessibility(), target)
  if (resolution.kind !== "resolved") return { kind: "failed", why: resolution.why }

  await provider.typeInto(resolution.node.nodeId, text)
  const readBack = await provider.readValue(resolution.node.nodeId)

  if (readBack === undefined) return { kind: "failed", why: "the field could not be read back, so nothing is known about what landed" }
  if (readBack === text) return { kind: "done", why: `${[...text].length} codepoint(s) landed exactly`, wrote: text, readBack }

  const wroteCodes = [...text].map((c) => c.codePointAt(0)!.toString(16))
  const readCodes = [...readBack].map((c) => c.codePointAt(0)!.toString(16))
  const firstDiff = wroteCodes.findIndex((c, i) => c !== readCodes[i])
  return {
    kind: "mismatch",
    why:
      `what landed differs at codepoint ${firstDiff < 0 ? wroteCodes.length : firstDiff}: ` +
      `wrote U+${(wroteCodes[firstDiff] ?? "").toUpperCase()}, read U+${(readCodes[firstDiff] ?? "").toUpperCase()} ` +
      `(${wroteCodes.length} written, ${readCodes.length} read)`,
    wrote: text,
    readBack,
  }
}

/**
 * Directional marks a bidi-unaware pipeline inserts or drops.
 *
 * Listed so a mismatch report can say "this is a bidi control character" rather
 * than printing an invisible difference and leaving a human to guess.
 */
export const BIDI_MARKS: readonly string[] = ["‎", "‏", "‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩"]

export const describeBidi = (text: string): string[] =>
  BIDI_MARKS.filter((m) => text.includes(m)).map((m) => `U+${m.codePointAt(0)!.toString(16).toUpperCase()}`)

// --------------------------------------------------------------------------
// Sprint 67 — the coordinate fallback, guarded
// --------------------------------------------------------------------------

export interface CoordinateRequest {
  readonly x: number
  readonly y: number
  /** What the agent believes is there. Re-checked before the click lands. */
  readonly expect: Target
}

export type CoordinateOutcome =
  | { readonly kind: "clicked"; readonly why: string }
  | { readonly kind: "refused"; readonly why: string }

/**
 * Click a pixel — after proving the thing you meant is still under it.
 *
 * The re-verification is the entire point. A coordinate is computed from a
 * snapshot, and between the snapshot and the click a banner loads, a font
 * settles, a list re-sorts. The click then lands on whatever moved into that
 * space, and the log says the agent clicked "Save".
 *
 * So the target is resolved again, its box is compared, and a move of more than
 * a couple of pixels REFUSES rather than adjusts. Adjusting silently would make
 * this a retry loop that eventually clicks something.
 */
export async function clickAtGuarded(
  provider: BrowserProvider,
  request: CoordinateRequest,
  tolerancePx = 2,
): Promise<CoordinateOutcome> {
  const resolution = resolveTarget(await provider.accessibility(), request.expect)
  if (resolution.kind !== "resolved")
    return { kind: "refused", why: `the expected ${request.expect.role} "${request.expect.name}" is not on the page any more: ${resolution.why}` }

  const box = resolution.node.box
  if (box === undefined)
    return { kind: "refused", why: "the element has no box, so there is nothing to compare the coordinate against" }

  const inside =
    request.x >= box.x - tolerancePx &&
    request.x <= box.x + box.width + tolerancePx &&
    request.y >= box.y - tolerancePx &&
    request.y <= box.y + box.height + tolerancePx

  if (!inside)
    return {
      kind: "refused",
      why:
        `(${request.x}, ${request.y}) is no longer inside ${request.expect.role} "${request.expect.name}" ` +
        `(now at ${box.x},${box.y} ${box.width}x${box.height}) — something moved after the coordinate was computed, and clicking anyway lands on whatever took its place`,
    }

  await provider.clickAt(request.x, request.y)
  return { kind: "clicked", why: `verified ${request.expect.role} "${request.expect.name}" still covers (${request.x}, ${request.y})` }
}

// --------------------------------------------------------------------------
// Sprint 69 — scroll, drag, upload, dialogs
// --------------------------------------------------------------------------

export type DialogKind = "alert" | "confirm" | "prompt" | "beforeunload" | "file_chooser"

export interface DialogPolicy {
  /** What to do with each kind. A dialog with no policy BLOCKS. */
  readonly handlers: Readonly<Partial<Record<DialogKind, "accept" | "dismiss">>>
}

export type DialogOutcome =
  | { readonly kind: "handled"; readonly action: "accept" | "dismiss"; readonly why: string }
  | { readonly kind: "blocked"; readonly why: string }

/**
 * Decide what happens to a dialog.
 *
 * A dialog with no declared policy BLOCKS rather than being dismissed. The
 * tempting default — dismiss everything so automation never stalls — silently
 * answers "are you sure you want to delete this?" and the run continues as if
 * nothing was asked.
 */
export function handleDialog(kind: DialogKind, policy: DialogPolicy): DialogOutcome {
  const action = policy.handlers[kind]
  if (action === undefined)
    return {
      kind: "blocked",
      why: `a ${kind} dialog appeared and no policy covers it — dismissing by default silently answers "are you sure?" and the run continues as if nothing was asked`,
    }
  return { kind: "handled", action, why: `${kind} handled by declared policy: ${action}` }
}

export interface UploadRequest {
  readonly target: Target
  readonly files: readonly { readonly path: string; readonly bytes: number }[]
  readonly maxBytes?: number
}

export type UploadOutcome = { readonly kind: "ready"; readonly files: readonly string[] } | { readonly kind: "refused"; readonly why: string }

/**
 * Prepare an upload through the file chooser rather than the OS dialog.
 *
 * The gate asks for an upload with no human intervention, and the way to get
 * that is to never let a native dialog open: the chooser is intercepted and the
 * paths are supplied. An agent that reaches the OS dialog has already lost,
 * because there is nothing on the other side of it that it can drive.
 */
export function prepareUpload(request: UploadRequest): UploadOutcome {
  if (request.files.length === 0) return { kind: "refused", why: "no files were given" }
  const limit = request.maxBytes ?? 100 * 1024 * 1024
  const tooBig = request.files.filter((f) => f.bytes > limit)
  if (tooBig.length > 0)
    return { kind: "refused", why: `${tooBig.map((f) => f.path).join(", ")} exceed the ${limit}-byte upload limit` }
  return { kind: "ready", files: request.files.map((f) => f.path) }
}
