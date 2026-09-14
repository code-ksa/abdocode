/**
 * D12 — قشرة الطرفية الكاملة، «مثل كوديكس» بأمر المالك: شاشة بديلة، مدوّنةٌ
 * فوق حلقة S138، سطرُ إدخالٍ حيّ، وسطرُ حالةٍ يحمل النمطَ والعملَ الجاري.
 *
 * القلب هنا **دوالّ صرفة**: (حالة، مقاس) ← إطار، و(حالة، مفتاح) ← (حالة،
 * فعل). الحلقة التفاعلية في cli.ts قشرةٌ رقيقة فوقهما — فما يُقاس في
 * الدخان هو ما يعمل في الطرفية، لا نسخةٌ اختبارية منه. وقرارات المفاتيح
 * ليست لنا: Esc وCtrl+C والتوسعة كلّها تمرّ بآلات S138 المُثبتة.
 */

import { Shell } from "./shell"
import { Turns } from "./turns"

export interface TuiState {
  readonly ring: Shell.Ring
  readonly input: string
  readonly outbox: Turns.OutboxState
  readonly mode: Shell.ApprovalMode
  readonly machine: Shell.ShellState
  readonly lastCtrlCAtMs: number | undefined
  readonly workingSinceMs: number | undefined
  readonly notice: string
  readonly turnCounter: number
}

export const initial = (): TuiState => ({
  ring: Shell.ring(500),
  input: "",
  outbox: { kind: "idle" },
  mode: "read-only",
  machine: { kind: "idle" },
  lastCtrlCAtMs: undefined,
  workingSinceMs: undefined,
  notice: "",
  turnCounter: 0,
})

// ---------------------------------------------------------------------------
// المفاتيح — كل قرارٍ يملكه عقدٌ مُثبت، وهذه الدالة توصيلٌ لا تشريع
// ---------------------------------------------------------------------------

export type TuiAction =
  | { readonly kind: "none" }
  | { readonly kind: "submit"; readonly turn: Turns.Turn }
  | { readonly kind: "quit" }

export type Key =
  | { readonly kind: "char"; readonly char: string }
  | { readonly kind: "enter" }
  | { readonly kind: "backspace" }
  | { readonly kind: "escape" }
  | { readonly kind: "ctrl-c" }
  | { readonly kind: "shift-tab" }

const MODE_CYCLE: readonly Shell.ApprovalMode[] = ["read-only", "auto", "full-access"]

export const onKey = (state: TuiState, key: Key, nowMs: number): { readonly state: TuiState; readonly action: TuiAction } => {
  switch (key.kind) {
    case "char":
      return { state: { ...state, input: state.input + key.char, notice: "" }, action: { kind: "none" } }
    case "backspace": {
      // بتر بالجرافيم لا بوحدات UTF-16 — حذفُ حرفٍ عربيّ لا يشطر عنقوده
      const clusters = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(state.input)]
      return {
        state: { ...state, input: clusters.slice(0, -1).map((c) => c.segment).join("") },
        action: { kind: "none" },
      }
    }
    case "enter": {
      const body = state.input.trim()
      if (body.length === 0) return { state, action: { kind: "none" } }
      const turn: Turns.Turn = { id: `turn-${state.turnCounter + 1}-${nowMs}`, body }
      const submitted = Turns.submit(state.outbox, turn)
      if (!submitted.ok) return { state: { ...state, notice: submitted.why }, action: { kind: "none" } }
      return {
        state: {
          ...state,
          outbox: submitted.state,
          input: "",
          turnCounter: state.turnCounter + 1,
          machine: { kind: "working", lastPrompt: body },
          workingSinceMs: nowMs,
          ring: Shell.push(state.ring, `أنت ▸ ${body}`),
        },
        action: { kind: "submit", turn },
      }
    }
    case "escape": {
      const verdict = Shell.onEscape(state.machine)
      if (verdict.action.kind === "interrupt")
        return {
          state: { ...state, machine: verdict.state, notice: "المقاطعة مطلوبة — المحرّك يُتمّ دوره الجاري ولا يُقتل خلسةً" },
          action: { kind: "none" },
        }
      if (verdict.action.kind === "recall")
        return { state: { ...state, machine: verdict.state, input: verdict.action.prompt }, action: { kind: "none" } }
      return { state: { ...state, machine: verdict.state }, action: { kind: "none" } }
    }
    case "ctrl-c": {
      const verdict = Shell.onCtrlC(state.lastCtrlCAtMs, nowMs)
      if (verdict.action === "quit") return { state, action: { kind: "quit" } }
      return {
        state: { ...state, lastCtrlCAtMs: verdict.at, notice: "اضغط Ctrl+C ثانيةً خلال ثانيتين للخروج" },
        action: { kind: "none" },
      }
    }
    case "shift-tab": {
      // ضغطة المفتاح هي «يد المشغّل» في الطرفية — تكافئ نقرة مبدّل كوديكس
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(state.mode) + 1) % MODE_CYCLE.length]
      const change = Shell.changeMode(state.mode, next, true)
      return change.ok
        ? { state: { ...state, mode: change.mode, notice: "" }, action: { kind: "none" } }
        : { state: { ...state, notice: change.why }, action: { kind: "none" } }
    }
  }
}

// ---------------------------------------------------------------------------
// الأحداث القادمة من التنفيذ — نفس أشكال serve، فالقشرتان تقرآن لغةً واحدة
// ---------------------------------------------------------------------------

export const onLines = (state: TuiState, lines: readonly string[]): TuiState => ({
  ...state,
  ring: Shell.push(state.ring, ...lines),
})

export const onSettled = (state: TuiState, turnId: string): TuiState => {
  let outbox = state.outbox
  if (outbox.kind !== "idle" && outbox.turn.id === turnId) {
    outbox = Turns.acknowledge(outbox, turnId)
    outbox = { kind: "idle" }
  }
  const lastPrompt = state.machine.kind === "idle" ? state.machine.lastPrompt : state.machine.lastPrompt
  return { ...state, outbox, machine: { kind: "idle", lastPrompt }, workingSinceMs: undefined }
}

// ---------------------------------------------------------------------------
// الإطار — (حالة، مقاس) ← أسطر جاهزة للرسم، بلا أي ANSI هنا
// ---------------------------------------------------------------------------

const fit = (text: string, cols: number): string => Shell.truncate(text, Math.max(1, cols - 1))

export const frame = (state: TuiState, cols: number, rows: number, nowMs: number): readonly string[] => {
  const out: string[] = []
  out.push(fit("عبدو كود — نواة Rust وحزم rust-main (Shift+Tab للنمط · Esc للمقاطعة/الاسترجاع · Ctrl+C مرّتين للخروج)", cols))
  out.push("─".repeat(Math.max(1, cols - 1)))

  const transcriptRows = Math.max(1, rows - 5)
  const rendered = Shell.render(state.ring)
  // القصّ للمقاس يُعلن مثل إسقاط الحلقة — شاشةٌ تُخفي بصمت تكذب بالإغفال
  const visible =
    rendered.length > transcriptRows
      ? [`⋯ ${rendered.length - (transcriptRows - 1)} سطراً أعلى`, ...rendered.slice(-(transcriptRows - 1))]
      : rendered
  for (const line of visible) out.push(fit(line, cols))
  while (out.length < transcriptRows + 2) out.push("")

  out.push("─".repeat(Math.max(1, cols - 1)))
  out.push(fit(`▸ ${state.input}`, cols))
  const status = Shell.statusLine({
    model: "عبدو المحلي 9B",
    mode: state.mode,
    directory: "المشروع",
    contextLeft: 1,
    working: state.workingSinceMs === undefined ? undefined : { startedAtMs: state.workingSinceMs, nowMs },
  })
  out.push(fit(state.notice.length > 0 ? `${status} · ⚠ ${state.notice}` : status, cols))
  return out
}

export * as Tui from "./tui"
