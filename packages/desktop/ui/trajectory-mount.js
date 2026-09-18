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

// ../engine/src/shells/trajectory-mount.ts
var exports_trajectory_mount = {};
__export(exports_trajectory_mount, {
  view: () => view,
  tab: () => tab,
  VIEW_ID: () => VIEW_ID,
  TrajectoryMount: () => exports_trajectory_mount,
  Trajectory: () => exports_trajectory,
  TAB_ID: () => TAB_ID
});

// ../engine/src/shells/trajectory.ts
var exports_trajectory = {};
__export(exports_trajectory, {
  turns: () => turns,
  rows: () => rows,
  fold: () => fold,
  epochOfEvent: () => epochOfEvent,
  empty: () => empty,
  classifyEvent: () => classifyEvent,
  begin: () => begin,
  Trajectory: () => exports_trajectory,
  DEFAULT_CAP: () => DEFAULT_CAP
});
var DEFAULT_CAP = 24;
var empty = (cap = DEFAULT_CAP) => Object.freeze({ turns: new Map, order: Object.freeze([]), cap: cap > 0 ? cap : DEFAULT_CAP });
var blank = (turnId) => ({
  turnId,
  tools: [],
  gates: [],
  toolFrames: 0,
  eventFrames: 0,
  lastEpoch: 0
});
var GATE_PREFIXES = Object.freeze([
  ["\uD83D\uDCD0 أحكام الأدوات", "coverage"],
  ["\uD83D\uDCB3", "cloud"],
  ["✓ نقطة حفظ الحقبة", "checkpoint"],
  ["\uD83D\uDCD3", "miner"],
  ["\uD83C\uDFAF", "intent"],
  ["⏱", "turn-budget"],
  ["\uD83D\uDD70", "turn-budget"],
  ["\uD83D\uDEAA", "gate"],
  ["⛔", "wall"],
  ["\uD83D\uDD10 قرار الموافقة: ", "approval-decided"],
  ["\uD83D\uDD10 طلب موافقة", "approval-asked"],
  ["↻", "epoch"],
  ["⚠", "warning"],
  ["— المقيس", "meta"]
]);
var classifyEvent = (payload) => {
  for (const [prefix, kind] of GATE_PREFIXES)
    if (payload.startsWith(prefix))
      return kind;
  return "other";
};
var EPOCH_PATTERNS = Object.freeze([
  /^↻ حقبة (\d+)/u,
  /^✓ نقطة حفظ الحقبة (\d+)/u,
  /^📐 أحكام الأدوات ح(\d+)/u,
  /^🎯 نيّات الحقبة (\d+)/u,
  /الحقبة (\d+)/u
]);
var epochOfEvent = (payload) => {
  for (const pattern of EPOCH_PATTERNS) {
    const found = pattern.exec(payload);
    if (found !== null) {
      const value = Number(found[1]);
      if (Number.isSafeInteger(value) && value >= 0)
        return value;
    }
  }
  return;
};
var withTurn = (store, turnId, next) => {
  const turns = new Map(store.turns);
  const known = turns.has(turnId);
  turns.set(turnId, next);
  let order = known ? store.order.slice() : [...store.order, turnId];
  while (order.length > store.cap) {
    const oldest = order[0];
    order = order.slice(1);
    turns.delete(oldest);
  }
  return Object.freeze({ turns, order: Object.freeze(order), cap: store.cap });
};
var asText = (value) => typeof value === "string" ? value : "";
var asEpoch = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
var begin = (store, turnId, body) => {
  if (typeof turnId !== "string" || turnId.length === 0)
    return store;
  const trace = store.turns.get(turnId) ?? blank(turnId);
  return withTurn(store, turnId, { ...trace, body });
};
var fold = (store, frame, nowMs) => {
  const kind = asText(frame.kind);
  const turnId = asText(frame.turnId);
  if (turnId.length === 0)
    return store;
  const trace = store.turns.get(turnId) ?? blank(turnId);
  if (kind === "rails") {
    return withTurn(store, turnId, { ...trace, rails: { tier: asText(frame.tier), reason: asText(frame.reason) } });
  }
  if (kind === "model-route") {
    return withTurn(store, turnId, { ...trace, route: { lane: asText(frame.lane), ref: asText(frame.ref) } });
  }
  if (kind === "tool") {
    const epoch = asEpoch(frame.epoch);
    const row = {
      cmd: asText(frame.cmd),
      epoch,
      acceptance: frame.acceptance === true,
      ...typeof frame.intent === "string" ? { intent: frame.intent } : {},
      startedAt: nowMs
    };
    return withTurn(store, turnId, {
      ...trace,
      tools: [...trace.tools, row],
      toolFrames: trace.toolFrames + 1,
      lastEpoch: epoch
    });
  }
  if (kind === "tool-result") {
    const cmd = asText(frame.cmd);
    const epoch = asEpoch(frame.epoch);
    const index = trace.tools.findIndex((row) => row.cmd === cmd && row.endedAt === undefined);
    const verdict = frame.verdict;
    const completion = {
      endedAt: nowMs,
      ...verdict !== undefined && typeof verdict === "object" ? { verdict } : {},
      ...typeof frame.idempotencyKey === "string" ? { idempotencyKey: frame.idempotencyKey } : {},
      outputHead: asText(frame.output).slice(0, 160)
    };
    const tools = index >= 0 ? trace.tools.map((row, i) => i === index ? { ...row, ...completion } : row) : [...trace.tools, { cmd, epoch, acceptance: frame.acceptance === true, ...completion }];
    return withTurn(store, turnId, { ...trace, tools, lastEpoch: epoch === 0 ? trace.lastEpoch : epoch });
  }
  if (kind === "event") {
    const text = asText(frame.payload);
    const epoch = epochOfEvent(text) ?? trace.lastEpoch;
    const row = { kind: classifyEvent(text), text, epoch };
    return withTurn(store, turnId, { ...trace, gates: [...trace.gates, row], eventFrames: trace.eventFrames + 1 });
  }
  if (kind === "done") {
    const outcome = frame.outcome === "checkpointed" ? "checkpointed" : "completed";
    return withTurn(store, turnId, { ...trace, outcome: trace.outcome === "interrupted" ? "interrupted" : outcome });
  }
  if (kind === "interrupted")
    return withTurn(store, turnId, { ...trace, outcome: "interrupted" });
  if (kind === "unresolved")
    return withTurn(store, turnId, { ...trace, outcome: "unresolved" });
  if (kind === "refused")
    return withTurn(store, turnId, { ...trace, outcome: "failed" });
  return store;
};
var duration = (row) => row.startedAt === undefined || row.endedAt === undefined ? "—" : `+${Math.max(0, (row.endedAt - row.startedAt) / 1000).toFixed(1)}s`;
var rows = (store, turnId) => {
  const trace = store.turns.get(turnId);
  if (trace === undefined)
    return;
  const numbers = new Set;
  for (const row of trace.tools)
    numbers.add(row.epoch);
  for (const row of trace.gates)
    numbers.add(row.epoch);
  const epochs = [...numbers].sort((a, b) => a - b).map((epoch) => ({
    epoch,
    tools: trace.tools.filter((row) => row.epoch === epoch).map((row) => ({
      cmd: row.cmd,
      glyph: row.verdict === undefined ? "·" : row.verdict.ok ? "✓" : "✕",
      reason: row.verdict !== undefined && !row.verdict.ok ? row.verdict.reason ?? "" : "",
      denied: row.verdict !== undefined && row.verdict.ok === false && row.verdict.denied === true,
      duration: duration(row),
      acceptance: row.acceptance,
      ...row.intent === undefined ? {} : { intent: row.intent },
      ...row.outputHead === undefined ? {} : { outputHead: row.outputHead }
    })),
    gates: trace.gates.filter((row) => row.epoch === epoch)
  }));
  return {
    turnId: trace.turnId,
    ...trace.body === undefined ? {} : { body: trace.body },
    ...trace.rails === undefined ? {} : { rails: trace.rails },
    ...trace.route === undefined ? {} : { route: trace.route },
    ...trace.outcome === undefined ? {} : { outcome: trace.outcome },
    eventsOnly: trace.tools.length === 0 && trace.eventFrames > 0,
    epochs
  };
};
var turns = (store) => store.order.slice().reverse();

// ../engine/src/shells/trajectory-mount.ts
var TAB_ID = "trajectory:tab";
var VIEW_ID = "trajectory:view";
var make = (document, tag, className) => {
  const node = document.createElement(tag);
  if (className !== undefined)
    node.className = className;
  return node;
};
var tab = (deps) => ({
  id: TAB_ID,
  anchor: "tab.strip",
  feature: "trajectory",
  order: 10,
  mount: (host, bind) => {
    const node = make(deps.document, "button");
    node.id = "trajtab";
    node.textContent = "مسار";
    bind(node, "click", () => deps.toggle());
    bind(deps.chatTab, "click", () => deps.showChat());
    host.appendChild(node);
    deps.attach(node);
    return () => deps.attach(null);
  }
});
var view = (deps) => ({
  id: VIEW_ID,
  anchor: "transcript.node",
  feature: "trajectory",
  order: 10,
  mount: (host, bind) => {
    const node = make(deps.document, "section");
    node.id = "trajectory";
    node.hidden = true;
    node.setAttribute("aria-label", "مسار الدور");
    const bar = make(deps.document, "div", "traj-bar");
    const label = make(deps.document, "label");
    label.setAttribute("for", "trajturn");
    label.textContent = "الدور";
    const picker = make(deps.document, "select");
    picker.id = "trajturn";
    bind(picker, "change", () => deps.pick(typeof picker.value === "string" ? picker.value : ""));
    const body = make(deps.document, "div");
    body.id = "trajbody";
    bar.appendChild(label);
    bar.appendChild(picker);
    node.appendChild(bar);
    node.appendChild(body);
    host.appendChild(node);
    deps.attach(node);
    return () => {
      const showing = node.hidden !== true;
      deps.attach(null);
      if (showing)
        deps.restoreChat();
    };
  }
});
export {
  view,
  tab,
  VIEW_ID,
  exports_trajectory_mount as TrajectoryMount,
  exports_trajectory as Trajectory,
  TAB_ID
};
