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

// ../engine/src/shells/deliverables-mount.ts
var exports_deliverables_mount = {};
__export(exports_deliverables_mount, {
  row: () => row,
  ROW_ID: () => ROW_ID,
  DeliverablesMount: () => exports_deliverables_mount,
  Deliverables: () => exports_deliverables
});

// ../engine/src/shells/deliverables.ts
var exports_deliverables = {};
__export(exports_deliverables, {
  render: () => render,
  fold: () => fold,
  empty: () => empty,
  Deliverables: () => exports_deliverables
});
var empty = () => Object.freeze({ rows: Object.freeze([]) });
var asText = (value) => typeof value === "string" ? value : "";
var merge = (existing, row) => row.op === "skipped" && (existing.op === "write" || existing.op === "edit") ? { ...existing, ...row, op: existing.op } : { ...existing, ...row };
var upsert = (rows, row) => {
  const index = rows.findIndex((existing) => existing.key === row.key);
  if (index < 0)
    return [...rows, row];
  return rows.map((existing, i) => i === index ? merge(existing, row) : existing);
};
var fold = (state, frame) => {
  const kind = asText(frame.kind);
  const turnId = asText(frame.turnId);
  if (kind === "browse") {
    const url = asText(frame.url);
    if (url.length === 0)
      return state;
    return Object.freeze({ rows: Object.freeze(upsert(state.rows, { key: `url:${url}`, kind: "url", label: url, turnId })) });
  }
  if (kind === "tool-result") {
    const verdict = frame.verdict;
    if (verdict === undefined || verdict === null || verdict.ok !== true)
      return state;
    const locations = frame.locations;
    if (!Array.isArray(locations) || locations.length === 0)
      return state;
    let rows = state.rows;
    for (const raw of locations) {
      if (typeof raw !== "object" || raw === null)
        continue;
      const location = raw;
      if (location.kind === "file") {
        const path = asText(location.path);
        const op = location.op;
        if (path.length === 0 || op !== "write" && op !== "edit" && op !== "skipped")
          continue;
        rows = upsert(rows, { key: `file:${path}`, kind: "file", label: path, turnId, op });
      } else if (location.kind === "server") {
        const url = asText(location.url);
        if (url.length === 0)
          continue;
        rows = upsert(rows, { key: `server:${url}`, kind: "server", label: url, turnId, live: true });
      }
    }
    return rows === state.rows ? state : Object.freeze({ rows: Object.freeze(rows) });
  }
  if (kind === "done" || kind === "interrupted" || kind === "unresolved" || kind === "refused") {
    if (turnId.length === 0)
      return state;
    let touched = false;
    const rows = state.rows.map((row) => {
      if (row.kind !== "server" || row.turnId !== turnId || row.live !== true)
        return row;
      touched = true;
      return { ...row, live: false };
    });
    return touched ? Object.freeze({ rows: Object.freeze(rows) }) : state;
  }
  return state;
};
var GLYPH = Object.freeze({
  write: "✎",
  edit: "✎",
  skipped: "⏭",
  server: "⚙",
  url: "\uD83C\uDF10"
});
var render = (state) => state.rows.map((row) => ({
  glyph: row.kind === "file" ? GLYPH[row.op ?? "write"] ?? "✎" : GLYPH[row.kind] ?? "•",
  label: row.label,
  badge: row.kind === "server" ? row.live === true ? "حيّ" : "أُوقف" : row.op === "skipped" ? "بلا تغيير" : ""
}));

// ../engine/src/shells/deliverables-mount.ts
var ROW_ID = "deliverables:row";
var make = (document, tag, className) => {
  const node = document.createElement(tag);
  if (className !== undefined)
    node.className = className;
  return node;
};
var row = (deps) => ({
  id: ROW_ID,
  anchor: "activity.section",
  feature: "deliverables",
  order: 10,
  mount: (host) => {
    const section = make(deps.document, "div", "act-sect");
    const head = make(deps.document, "h4");
    head.textContent = "المسلَّمات";
    const list = make(deps.document, "div", "act-list");
    list.id = "delivrows";
    const blank = make(deps.document, "span", "act-empty");
    blank.textContent = "لا مسلَّمات بعد";
    list.appendChild(blank);
    section.appendChild(head);
    section.appendChild(list);
    host.appendChild(section);
    const wasHidden = deps.generalSection === null ? undefined : deps.generalSection.hidden;
    if (deps.generalSection !== null)
      deps.generalSection.hidden = true;
    deps.attach(list);
    return () => {
      if (deps.generalSection !== null)
        deps.generalSection.hidden = wasHidden;
      deps.attach(null);
    };
  }
});
export {
  row,
  ROW_ID,
  exports_deliverables_mount as DeliverablesMount,
  exports_deliverables as Deliverables
};
