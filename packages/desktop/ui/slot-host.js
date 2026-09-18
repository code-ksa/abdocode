// ../engine/src/shells/slots.ts
var ANCHORS = Object.freeze([
  "composer.bar",
  "transcript.node",
  "tab.strip",
  "settings.section",
  "activity.section",
  "rail.icons",
  "header.actions",
  "dock.inline-end",
  "dock.inline-start",
  "dock.block-end",
  "dock.block-start"
]);
var isAnchor = (name) => typeof name === "string" && ANCHORS.includes(name);
var FROZEN = Object.freeze([]);
var empty = () => Object.freeze({ entries: FROZEN, seq: 0 });
var asText = (value) => typeof value === "string" ? value : "";
var register = (state, input) => {
  const id = asText(input.id).trim();
  if (id.length === 0)
    return { state, refused: "مساهمة بلا معرّف — لا تُسجَّل" };
  const feature = asText(input.feature).trim();
  if (feature.length === 0)
    return { state, refused: `مساهمة بلا ميزة مالكة: "${id}"` };
  const anchor = asText(input.anchor);
  if (!isAnchor(anchor))
    return { state, refused: `مرساة غير معروفة: "${anchor}"` };
  if (state.entries.some((entry2) => entry2.id === id))
    return { state, refused: `تسجيل مكرّر لنقطة التعليق: "${id}"` };
  const order = typeof input.order === "number" && Number.isFinite(input.order) ? input.order : 0;
  const seq = state.seq + 1;
  const entry = Object.freeze({ id, anchor, feature, order, seq });
  return {
    state: Object.freeze({ entries: Object.freeze([...state.entries, entry]), seq }),
    mounted: id
  };
};
var unregister = (state, id) => {
  const key = asText(id);
  if (!state.entries.some((entry) => entry.id === key))
    return { state };
  return {
    state: Object.freeze({ entries: Object.freeze(state.entries.filter((entry) => entry.id !== key)), seq: state.seq }),
    torn: key
  };
};
var slot = (state, anchor) => Object.freeze(state.entries.filter((entry) => entry.anchor === anchor).sort((a, b) => a.order === b.order ? a.seq - b.seq : a.order - b.order));
var has = (state, id) => state.entries.some((entry) => entry.id === asText(id));
var mountedIds = (state, feature) => Object.freeze(state.entries.filter((entry) => feature === undefined || entry.feature === feature).map((entry) => entry.id));

// ../engine/src/shells/slot-host.ts
var message = (error) => error instanceof Error ? error.message : String(error);

class SlotHost {
  anchorOf;
  state = empty();
  live = new Map;
  constructor(anchorOf) {
    this.anchorOf = anchorOf;
  }
  register(contribution) {
    const folded = register(this.state, contribution);
    if (folded.refused !== undefined)
      return folded.refused;
    const anchor = this.anchorOf(contribution.anchor) ?? null;
    if (anchor === null)
      return `مرساة غير موجودة في القشرة: "${contribution.anchor}"`;
    const document = anchor.ownerDocument;
    if (document === null)
      return `مرساة بلا وثيقة: "${contribution.anchor}"`;
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-slot", contribution.id);
    const ordered = slot(folded.state, contribution.anchor);
    const index = ordered.findIndex((entry) => entry.id === contribution.id);
    const after = ordered.slice(index + 1).find((entry) => this.live.get(entry.id)?.anchor === anchor);
    anchor.insertBefore(wrapper, after === undefined ? null : this.live.get(after.id).wrapper);
    const listeners = [];
    const bind = (target, type, handler) => {
      target.addEventListener(type, handler);
      listeners.push({ target, type, handler });
    };
    const record = { wrapper, anchor, listeners, teardown: undefined };
    this.state = folded.state;
    this.live.set(contribution.id, record);
    try {
      record.teardown = contribution.mount(wrapper, bind) ?? undefined;
    } catch (error) {
      this.state = unregister(this.state, contribution.id).state;
      this.live.delete(contribution.id);
      for (const entry of listeners)
        entry.target.removeEventListener(entry.type, entry.handler);
      record.anchor.removeChild(wrapper);
      return `تركيب "${contribution.id}" سقط: ${message(error)}`;
    }
    return;
  }
  relocate(id, target) {
    const record = this.live.get(id);
    if (record === undefined || !has(this.state, id))
      return `مساهمة غير مركّبة: "${id}"`;
    if (target == null || typeof target.appendChild !== "function" || typeof target.removeChild !== "function") {
      return `وجهة نقل غير صالحة: "${id}"`;
    }
    if (target.ownerDocument === null || target.ownerDocument !== record.wrapper.ownerDocument) {
      return `نقل بين وثيقتين مرفوض: "${id}"`;
    }
    if (target === record.wrapper || record.wrapper.contains?.(target))
      return `وجهة النقل داخل المساهمة نفسها: "${id}"`;
    if (target === record.anchor)
      return;
    try {
      target.appendChild(record.wrapper);
      record.anchor = target;
      return;
    } catch (error) {
      return `نقل "${id}" سقط: ${message(error)}`;
    }
  }
  unregister(id) {
    const record = this.live.get(id);
    this.state = unregister(this.state, id).state;
    if (record === undefined)
      return;
    let failure;
    const teardown = record.teardown;
    record.teardown = undefined;
    try {
      teardown?.();
    } catch (error) {
      failure = `مفكِّك "${id}" سقط: ${message(error)}`;
    }
    for (const entry of record.listeners)
      entry.target.removeEventListener(entry.type, entry.handler);
    record.listeners.length = 0;
    record.anchor.removeChild(record.wrapper);
    this.live.delete(id);
    return failure;
  }
  unregisterFeature(feature) {
    const failures = [];
    for (const id of mountedIds(this.state, feature)) {
      try {
        const failure = this.unregister(id);
        if (failure !== undefined)
          failures.push(failure);
      } catch (error) {
        failures.push(`هدم "${id}" سقط: ${message(error)}`);
      }
    }
    return failures;
  }
  has(id) {
    return has(this.state, id);
  }
  mounted(feature) {
    return mountedIds(this.state, feature);
  }
  order(anchor) {
    return Object.freeze(slot(this.state, anchor).map((entry) => entry.id));
  }
  liveListeners() {
    let count = 0;
    for (const record of this.live.values())
      count += record.listeners.length;
    return count;
  }
}
export {
  isAnchor,
  SlotHost,
  ANCHORS
};
