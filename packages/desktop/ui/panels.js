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

// ../engine/src/shells/panels.ts
var exports_panels = {};
__export(exports_panels, {
  unseenIds: () => unseenIds,
  seen: () => seen,
  noticed: () => noticed,
  isDock: () => isDock,
  inDock: () => inDock,
  hasUnseen: () => hasUnseen,
  expand: () => expand,
  entryOf: () => entryOf,
  empty: () => empty,
  dock: () => dock,
  Panels: () => exports_panels,
  DOCKS: () => DOCKS
});
var DOCKS = Object.freeze(["inline-end", "inline-start", "block-end", "block-start"]);
var isDock = (value) => typeof value === "string" && DOCKS.includes(value);
var FROZEN = Object.freeze([]);
var empty = () => Object.freeze({ entries: FROZEN });
var asText = (value) => typeof value === "string" ? value : "";
var put = (state, entry) => Object.freeze({
  entries: Object.freeze(state.entries.some((e) => e.id === entry.id) ? state.entries.map((e) => e.id === entry.id ? entry : e) : [...state.entries, entry])
});
var entryOf = (state, id) => state.entries.find((entry) => entry.id === asText(id));
var dock = (state, id, next) => {
  const key = asText(id).trim();
  if (key.length === 0)
    return { state, refused: "لوحٌ بلا معرّف — لا يُرسى" };
  if (!isDock(next))
    return { state, refused: `منطقةُ إرساءٍ غير معروفة: "${asText(next)}"` };
  const current = entryOf(state, key);
  return {
    state: put(state, Object.freeze({
      id: key,
      dock: next,
      expanded: current?.expanded ?? false,
      unseen: current?.unseen ?? false
    }))
  };
};
var expand = (state, id, value) => {
  const key = asText(id).trim();
  const current = entryOf(state, key);
  if (current === undefined)
    return { state, refused: `لوحٌ غير مُرسىً: "${key}"` };
  return { state: put(state, Object.freeze({ ...current, expanded: value === true })) };
};
var noticed = (state, id, isOpen) => {
  const key = asText(id).trim();
  if (key.length === 0)
    return { state, refused: "حدثٌ بلا لوح — يُهمَل" };
  if (isOpen)
    return { state };
  const current = entryOf(state, key);
  const base = current ?? Object.freeze({ id: key, dock: "inline-end", expanded: false, unseen: false });
  return { state: put(state, Object.freeze({ ...base, unseen: true })) };
};
var seen = (state, id) => {
  const key = asText(id).trim();
  const current = entryOf(state, key);
  if (current === undefined || !current.unseen)
    return { state };
  return { state: put(state, Object.freeze({ ...current, unseen: false })) };
};
var hasUnseen = (state, id) => entryOf(state, id)?.unseen === true;
var unseenIds = (state) => Object.freeze(state.entries.filter((entry) => entry.unseen).map((entry) => entry.id));
var inDock = (state, area) => Object.freeze(state.entries.filter((entry) => entry.dock === area));
export {
  unseenIds,
  seen,
  noticed,
  isDock,
  inDock,
  hasUnseen,
  expand,
  entryOf,
  empty,
  dock,
  exports_panels as Panels,
  DOCKS
};
