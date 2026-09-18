/**
 * S138 — the shell contract, Codex-style by owner's order.
 *
 * «مثل كوديكس في التصميم والميزات». Codex CLI's shell earns that request with
 * four disciplines, and each is expressible as PURE, TESTED logic that both
 * the CLI and the TUI consume — which is how the acceptance line "same events
 * and decisions as the CLI" becomes a property instead of a review item: there
 * is one decision module, so the two shells cannot disagree.
 *
 * WHAT THIS IS NOT: a fifth permission engine. The S117 inventory counted four
 * permission implementations as the estate's costliest duplication, and the
 * engine's `Permission.Effect` (allow | ask | deny) already decides. The
 * approval modes here are Codex's three PRESETS expressed as data over that
 * vocabulary — a mapping, not a judge. The engine keeps S114's law: silence is
 * refusal, and there is one door into authorisation.
 *
 * The four disciplines:
 *
 *   APPROVAL MODES   read-only / auto / full-access, switchable mid-session —
 *                    downward always, upward only by explicit operator action,
 *                    and never retroactively: a pending ask stays an ask.
 *   STATUS LINE      model · mode · cwd · context-left, composed as data so
 *                    both shells render the same truth, with bidi isolation
 *                    where Arabic project names meet LTR paths.
 *   TRANSCRIPT RING  bounded scroll: a cap, oldest dropped, and the drop is
 *                    ANNOUNCED as a line — silent truncation reads as "that is
 *                    everything", and it is not.
 *   INTERRUPT        Esc while working interrupts; Esc when idle recalls the
 *                    previous prompt for editing (Codex's Esc-Esc); Ctrl+C
 *                    twice quits. One state machine, consumed by both shells.
 */

// ---------------------------------------------------------------------------
// Approval modes — Codex's triad as data over the existing vocabulary
// ---------------------------------------------------------------------------

/** The engine's own vocabulary. Imported conceptually; restated as a type so
 * this module stays dependency-free for the CLI's sake. */
export type Effect = "allow" | "ask" | "deny"

export type ApprovalMode = "read-only" | "auto" | "full-access"

/** What a shell asks about. The categories Codex distinguishes. */
export type RequestKind =
  | "read"
  | "edit"
  | "command"
  | "network"
  | "outside-workspace"

/**
 * The three presets.
 *
 * `read-only`: the agent proposes, the operator disposes — everything that
 * changes anything asks. `auto` is Codex's workspace-write: edits and
 * commands inside the workspace run free, while the two escalations that
 * widen the blast radius — network, and anything outside the workspace —
 * still ask. `full-access` allows everything and exists for sandboxes and
 * owners who said so twice; nothing in it is `deny`, because a mode that
 * silently denies teaches the model to route around the shell.
 */
export const MODES: Readonly<Record<ApprovalMode, Readonly<Record<RequestKind, Effect>>>> = {
  "read-only": {
    read: "allow",
    edit: "ask",
    command: "ask",
    network: "ask",
    "outside-workspace": "ask",
  },
  auto: {
    read: "allow",
    edit: "allow",
    command: "allow",
    network: "ask",
    "outside-workspace": "ask",
  },
  "full-access": {
    read: "allow",
    edit: "allow",
    command: "allow",
    network: "allow",
    "outside-workspace": "allow",
  },
}

export const decide = (mode: ApprovalMode, kind: RequestKind): Effect => MODES[mode][kind]

export type ModeChange =
  | { readonly ok: true; readonly mode: ApprovalMode }
  | { readonly ok: false; readonly why: string }

const RANK: Readonly<Record<ApprovalMode, number>> = { "read-only": 0, auto: 1, "full-access": 2 }

/**
 * Change the mode mid-session.
 *
 * Downward is always allowed — narrowing what an agent may do needs nobody's
 * signature. Upward requires `operatorConfirmed`, which the shell sets ONLY
 * from a direct human action on the switcher (Codex's /approvals): a model
 * that can talk its shell into full-access has removed the shell.
 */
export const changeMode = (
  current: ApprovalMode,
  requested: ApprovalMode,
  operatorConfirmed: boolean,
): ModeChange => {
  if (RANK[requested] <= RANK[current]) return { ok: true, mode: requested }
  if (!operatorConfirmed) {
    return {
      ok: false,
      why: `widening ${current} → ${requested} needs the operator's own hand on the switcher — a model that can talk its shell into ${requested} has removed the shell`,
    }
  }
  return { ok: true, mode: requested }
}

// ---------------------------------------------------------------------------
// The status line — one truth, rendered twice
// ---------------------------------------------------------------------------

export interface ShellStatus {
  readonly model: string
  readonly mode: ApprovalMode
  readonly directory: string
  /** 0..1 — how much of the context window remains. */
  readonly contextLeft: number
  readonly working?: { readonly startedAtMs: number; readonly nowMs: number }
}

/** Codex's mode labels, as the operator reads them. */
const MODE_LABEL: Readonly<Record<ApprovalMode, string>> = {
  "read-only": "read-only",
  auto: "auto",
  "full-access": "full access",
}

/**
 * FSI/PDI bidi isolation.
 *
 * An Arabic segment dropped raw into an LTR status line drags separators and
 * numbers into RTL order — the estate's satori lesson one layer up. Isolates
 * scope the reordering to the segment, so `مشروعي · auto · 65%` renders with
 * the separators where both shells put them.
 */
export const isolate = (text: string): string =>
  /[؀-ۿ]/.test(text) ? `⁨${text}⁩` : text

/** The last path segment; a status line is a reminder, not a file manager. */
const tail = (directory: string): string => {
  const parts = directory.replaceAll("\\", "/").split("/").filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? directory
}

export const statusLine = (status: ShellStatus): string => {
  const segments = [
    isolate(status.model),
    MODE_LABEL[status.mode],
    isolate(tail(status.directory)),
    `${Math.round(status.contextLeft * 100)}% context left`,
  ]
  if (status.working !== undefined) {
    const seconds = Math.max(0, Math.floor((status.working.nowMs - status.working.startedAtMs) / 1000))
    segments.push(`working ${seconds}s · esc to interrupt`)
  }
  return segments.join(" · ")
}

// ---------------------------------------------------------------------------
// The transcript ring — bounded, with the drop announced
// ---------------------------------------------------------------------------

export interface Ring {
  readonly lines: readonly string[]
  readonly dropped: number
  readonly capacity: number
}

export const ring = (capacity: number): Ring => {
  if (!Number.isInteger(capacity) || capacity < 2) {
    throw new RangeError("a transcript ring needs room for at least one line and the drop marker")
  }
  return { lines: [], dropped: 0, capacity }
}

/**
 * Append lines, dropping the oldest past capacity.
 *
 * The drop is never silent: `render` prefixes the marker. A shell that trims
 * its scrollback without saying so shows a transcript that reads as complete
 * — the same lie the stream cursor refuses as a gap, made of thrift instead
 * of packet loss.
 */
export const push = (current: Ring, ...added: readonly string[]): Ring => {
  const lines = [...current.lines, ...added]
  const overflow = Math.max(0, lines.length - (current.capacity - 1))
  return {
    lines: lines.slice(overflow),
    dropped: current.dropped + overflow,
    capacity: current.capacity,
  }
}

export const render = (current: Ring): readonly string[] =>
  current.dropped === 0 ? current.lines : [`⋯ ${current.dropped} earlier lines`, ...current.lines]

// ---------------------------------------------------------------------------
// Arabic-safe truncation — graphemes, never bytes
// ---------------------------------------------------------------------------

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * Truncate by graphemes with an ellipsis.
 *
 * `slice` cuts UTF-16 units and shears Arabic ligature clusters and emoji in
 * half — the byte-versus-character trap that already bit the team kernel's
 * message limit, here at display width instead of payload size.
 */
export const truncate = (text: string, maxGraphemes: number): string => {
  const clusters = [...segmenter.segment(text)].map((segment) => segment.segment)
  if (clusters.length <= maxGraphemes) return text
  return `${clusters.slice(0, Math.max(0, maxGraphemes - 1)).join("")}…`
}

// ---------------------------------------------------------------------------
// Interrupt — one state machine for both shells
// ---------------------------------------------------------------------------

export type ShellState =
  | { readonly kind: "idle"; readonly lastPrompt?: string }
  | { readonly kind: "working"; readonly lastPrompt: string }
  | { readonly kind: "interrupting"; readonly lastPrompt: string }

export type KeyAction =
  | { readonly kind: "none" }
  | { readonly kind: "interrupt" }
  | { readonly kind: "recall"; readonly prompt: string }
  | { readonly kind: "quit" }

export interface KeyVerdict {
  readonly state: ShellState
  readonly action: KeyAction
}

/**
 * What Escape does — Codex's semantics, one implementation.
 *
 *   working       -> request the interrupt, once; a second Esc while
 *                    interrupting is NOT a harder kill, because "press it
 *                    twice to really mean it" trains operators to double-tap,
 *                    and a double-tap that lands after the interrupt completed
 *                    would cancel the NEXT turn.
 *   idle + prompt -> recall the previous prompt for editing (Esc-Esc flow).
 *   idle, nothing -> nothing.
 */
export const onEscape = (state: ShellState): KeyVerdict => {
  switch (state.kind) {
    case "working":
      return { state: { kind: "interrupting", lastPrompt: state.lastPrompt }, action: { kind: "interrupt" } }
    case "interrupting":
      return { state, action: { kind: "none" } }
    case "idle":
      return state.lastPrompt === undefined
        ? { state, action: { kind: "none" } }
        : { state, action: { kind: "recall", prompt: state.lastPrompt } }
  }
}

/**
 * Ctrl+C twice quits; once warns. The window is the caller's clock, passed in
 * rather than read here, because a decision module with its own clock cannot
 * be tested without one.
 */
export const CTRL_C_WINDOW_MS = 2_000

export const onCtrlC = (
  lastCtrlCAtMs: number | undefined,
  nowMs: number,
): { readonly action: "warn" | "quit"; readonly at: number } =>
  lastCtrlCAtMs !== undefined && nowMs - lastCtrlCAtMs <= CTRL_C_WINDOW_MS
    ? { action: "quit", at: nowMs }
    : { action: "warn", at: nowMs }

/**
 * سطرُ أمرٍ ← أجزاؤه، **باحترام الاقتباس**.
 *
 * القسمةُ بالمسافات وحدها تكسر مساراً فيه مسافة (`C:/Program Files/x`) إلى
 * جزأين، فيُشغَّل أمرٌ غيرُ الذي كُتب — وهذا يقع في **خوادم MCP** حيث الأمرُ
 * يحمل مسارَ مجلّدٍ عادةً. والخطأُ لا يظهر في الواجهة: يظهر بفشلِ عمليّةٍ لا
 * يفهم المستخدمُ سببَه. فالقسمةُ منطقٌ يُختبر لا سطرٌ في صفحة، ونتيجتُها
 * تُعرض على المستخدم قبل الحفظ.
 *
 * قاعدةٌ واحدة: علامةُ اقتباسٍ (مفردةٌ أو مزدوجة) تفتح مقطعاً وتغلقه، ولا
 * تدخل الناتج. واقتباسٌ لم يُغلق يُغلق عند نهاية النصّ — رفضُ السطر كلِّه
 * لخطأٍ مطبعيٍّ أقسى من قبولِ ما هو ظاهرٌ للعين.
 */
export const splitCommandLine = (line: string): readonly string[] => {
  const parts: string[] = []
  let current = ""
  let quote: string | undefined
  for (const character of line) {
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (/\s/u.test(character)) {
      if (current.length > 0) { parts.push(current); current = "" }
      continue
    }
    current += character
  }
  if (current.length > 0) parts.push(current)
  return parts
}

export * as Shell from "./shell"
