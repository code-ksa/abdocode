var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// ../engine/src/shells/shell.ts
var exports_shell = {};
__export(exports_shell, {
  truncate: () => truncate,
  statusLine: () => statusLine,
  splitCommandLine: () => splitCommandLine,
  ring: () => ring,
  render: () => render,
  push: () => push,
  onEscape: () => onEscape,
  onCtrlC: () => onCtrlC,
  isolate: () => isolate,
  decide: () => decide,
  changeMode: () => changeMode,
  Shell: () => exports_shell,
  MODES: () => MODES,
  CTRL_C_WINDOW_MS: () => CTRL_C_WINDOW_MS
});
var MODES = {
  "read-only": {
    read: "allow",
    edit: "ask",
    command: "ask",
    network: "ask",
    "outside-workspace": "ask"
  },
  auto: {
    read: "allow",
    edit: "allow",
    command: "allow",
    network: "ask",
    "outside-workspace": "ask"
  },
  "full-access": {
    read: "allow",
    edit: "allow",
    command: "allow",
    network: "allow",
    "outside-workspace": "allow"
  }
};
var decide = (mode, kind) => MODES[mode][kind];
var RANK = { "read-only": 0, auto: 1, "full-access": 2 };
var changeMode = (current, requested, operatorConfirmed) => {
  if (RANK[requested] <= RANK[current])
    return { ok: true, mode: requested };
  if (!operatorConfirmed) {
    return {
      ok: false,
      why: `widening ${current} → ${requested} needs the operator's own hand on the switcher — a model that can talk its shell into ${requested} has removed the shell`
    };
  }
  return { ok: true, mode: requested };
};
var MODE_LABEL = {
  "read-only": "read-only",
  auto: "auto",
  "full-access": "full access"
};
var isolate = (text) => /[؀-ۿ]/.test(text) ? `⁨${text}⁩` : text;
var tail = (directory) => {
  const parts = directory.replaceAll("\\", "/").split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? directory;
};
var statusLine = (status) => {
  const segments = [
    isolate(status.model),
    MODE_LABEL[status.mode],
    isolate(tail(status.directory)),
    `${Math.round(status.contextLeft * 100)}% context left`
  ];
  if (status.working !== undefined) {
    const seconds = Math.max(0, Math.floor((status.working.nowMs - status.working.startedAtMs) / 1000));
    segments.push(`working ${seconds}s · esc to interrupt`);
  }
  return segments.join(" · ");
};
var ring = (capacity) => {
  if (!Number.isInteger(capacity) || capacity < 2) {
    throw new RangeError("a transcript ring needs room for at least one line and the drop marker");
  }
  return { lines: [], dropped: 0, capacity };
};
var push = (current, ...added) => {
  const lines = [...current.lines, ...added];
  const overflow = Math.max(0, lines.length - (current.capacity - 1));
  return {
    lines: lines.slice(overflow),
    dropped: current.dropped + overflow,
    capacity: current.capacity
  };
};
var render = (current) => current.dropped === 0 ? current.lines : [`⋯ ${current.dropped} earlier lines`, ...current.lines];
var segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
var truncate = (text, maxGraphemes) => {
  const clusters = [...segmenter.segment(text)].map((segment) => segment.segment);
  if (clusters.length <= maxGraphemes)
    return text;
  return `${clusters.slice(0, Math.max(0, maxGraphemes - 1)).join("")}…`;
};
var onEscape = (state) => {
  switch (state.kind) {
    case "working":
      return { state: { kind: "interrupting", lastPrompt: state.lastPrompt }, action: { kind: "interrupt" } };
    case "interrupting":
      return { state, action: { kind: "none" } };
    case "idle":
      return state.lastPrompt === undefined ? { state, action: { kind: "none" } } : { state, action: { kind: "recall", prompt: state.lastPrompt } };
  }
};
var CTRL_C_WINDOW_MS = 2000;
var onCtrlC = (lastCtrlCAtMs, nowMs) => lastCtrlCAtMs !== undefined && nowMs - lastCtrlCAtMs <= CTRL_C_WINDOW_MS ? { action: "quit", at: nowMs } : { action: "warn", at: nowMs };
var splitCommandLine = (line) => {
  const parts = [];
  let current = "";
  let quote;
  for (const character of line) {
    if (quote !== undefined) {
      if (character === quote)
        quote = undefined;
      else
        current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current.length > 0)
    parts.push(current);
  return parts;
};
export {
  truncate,
  statusLine,
  splitCommandLine,
  ring,
  render,
  push,
  onEscape,
  onCtrlC,
  isolate,
  decide,
  changeMode,
  exports_shell as Shell,
  MODES,
  CTRL_C_WINDOW_MS
};
