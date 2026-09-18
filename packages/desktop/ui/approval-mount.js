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

// ../engine/src/shells/approval-mount.ts
var exports_approval_mount = {};
__export(exports_approval_mount, {
  seat: () => seat,
  SEAT_ID: () => SEAT_ID,
  ApprovalMount: () => exports_approval_mount,
  Approval: () => exports_approval
});

// ../engine/src/shells/approval.ts
var exports_approval = {};
__export(exports_approval, {
  pendingTurn: () => pendingTurn,
  fold: () => fold,
  escape: () => escape,
  empty: () => empty,
  choose: () => choose,
  Approval: () => exports_approval
});

// ../engine/src/approval-ledger.ts
var APPROVAL_DECIDED_PREFIX = "\uD83D\uDD10 قرار الموافقة: ";
var DECISION_TEXT = Object.freeze({
  approved: "سُمح",
  denied: "رُفض",
  interrupted: "أُلغي بالمقاطعة"
});
var decisionOfLine = (payload) => {
  if (typeof payload !== "string" || !payload.startsWith(APPROVAL_DECIDED_PREFIX))
    return;
  const tail = payload.slice(APPROVAL_DECIDED_PREFIX.length);
  for (const [decision, text] of Object.entries(DECISION_TEXT)) {
    if (tail.startsWith(`${text} — `) || tail === text)
      return decision;
  }
  return;
};

// ../engine/src/shells/approval.ts
var DIFF_CAP = 8;
var IDLE = Object.freeze({ kind: "idle" });
var empty = () => Object.freeze({ state: IDLE, diffs: Object.freeze([]) });
var same = (store) => ({ store });
var settle = (store, settled) => ({
  store: Object.freeze({ state: IDLE, diffs: store.diffs }),
  settled
});
var pendingTurn = (store) => store.state.kind === "idle" ? undefined : store.state.turnId;
var asText = (value) => typeof value === "string" ? value : "";
var fold = (store, frame) => {
  const kind = asText(frame.kind);
  const turnId = asText(frame.turnId);
  if (kind === "diff") {
    if (turnId.length === 0)
      return same(store);
    const diffs = store.diffs.includes(turnId) ? store.diffs : [...store.diffs, turnId].slice(-DIFF_CAP);
    const state = store.state.kind === "asked" && store.state.turnId === turnId ? { ...store.state, diffSeen: true } : store.state;
    return same(Object.freeze({ state, diffs: Object.freeze(diffs) }));
  }
  if (kind === "approval") {
    if (store.state.kind !== "idle" && turnId.length > 0 && store.state.turnId !== turnId)
      return { store, refused: "موافقة معلّقة أخرى — المقعد واحد" };
    if (turnId.length === 0)
      return { store, refused: "طلب موافقة بلا دور — لا يُعرض" };
    return same(Object.freeze({
      state: Object.freeze({
        kind: "asked",
        turnId,
        request: asText(frame.request),
        cls: asText(frame.class),
        mode: asText(frame.mode),
        diffSeen: store.diffs.includes(turnId)
      }),
      diffs: store.diffs
    }));
  }
  if (store.state.kind === "idle")
    return same(store);
  if (turnId !== store.state.turnId)
    return same(store);
  if (kind === "event") {
    const decision = decisionOfLine(frame.payload);
    if (decision !== undefined)
      return settle(store, decision);
    if (asText(frame.payload).startsWith(APPROVAL_DECIDED_PREFIX))
      return settle(store, "closed");
    return same(store);
  }
  if (kind === "done" || kind === "interrupted" || kind === "unresolved")
    return settle(store, "closed");
  return same(store);
};
var choose = (store, choice) => {
  if (store.state.kind !== "asked")
    return { store, refused: "لا موافقة معلّقة تُقرَّر" };
  return same(Object.freeze({
    state: Object.freeze({ ...store.state, kind: "deciding", choice }),
    diffs: store.diffs
  }));
};
var escape = (store) => store.state.kind === "asked" ? choose(store, "deny") : same(store);

// ../engine/src/shells/approval-mount.ts
var SEAT_ID = "approvalTakeover:seat";
var make = (document, tag, className) => {
  const node = document.createElement(tag);
  if (className !== undefined)
    node.className = className;
  return node;
};
var seat = (deps) => ({
  id: SEAT_ID,
  anchor: "composer.bar",
  feature: "approvalTakeover",
  order: 10,
  mount: (host, bind) => {
    const node = make(deps.document, "div");
    node.id = "approvalseat";
    node.hidden = true;
    const strip = make(deps.document, "div", "apv-strip");
    const scroll = make(deps.document, "div", "apv-scroll");
    scroll.setAttribute("role", "group");
    scroll.setAttribute("tabindex", "0");
    const row = make(deps.document, "div", "apv-row");
    const approve = make(deps.document, "button", "apv");
    approve.type = "button";
    approve.textContent = "✓ اسمح";
    const deny = make(deps.document, "button", "dny");
    deny.type = "button";
    deny.textContent = "✕ ارفض";
    const preview = make(deps.document, "button", "apv-preview");
    preview.type = "button";
    preview.hidden = true;
    preview.textContent = "المعاينة ▲";
    const state = make(deps.document, "span", "apv-state");
    bind(approve, "click", () => deps.act("approve"));
    bind(deny, "click", () => deps.act("deny"));
    bind(preview, "click", () => deps.reveal());
    row.appendChild(approve);
    row.appendChild(deny);
    row.appendChild(preview);
    row.appendChild(state);
    node.appendChild(strip);
    node.appendChild(scroll);
    node.appendChild(row);
    host.appendChild(node);
    deps.attach(node);
    return () => {
      deps.composer.classList.remove("approving");
      deps.attach(null);
    };
  }
});
export {
  seat,
  SEAT_ID,
  exports_approval_mount as ApprovalMount,
  exports_approval as Approval
};
