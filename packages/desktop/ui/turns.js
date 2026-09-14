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

// ../engine/src/shells/turns.ts
var exports_turns = {};
__export(exports_turns, {
  submit: () => submit,
  resumeFrom: () => resumeFrom,
  reoffer: () => reoffer,
  ledger: () => ledger,
  fold: () => fold,
  admit: () => admit,
  acknowledge: () => acknowledge,
  Turns: () => exports_turns
});
var submit = (state, turn) => {
  if (state.kind === "offering") {
    return {
      ok: false,
      why: `turn ${state.turn.id} is still in flight — one framed entry means one turn at a time, and what to do about the pending one is the operator's decision, not a queue's`
    };
  }
  return { ok: true, state: { kind: "offering", turn } };
};
var reoffer = (state) => state.kind === "offering" ? state.turn : undefined;
var acknowledge = (state, turnId) => {
  if (state.kind !== "offering" || state.turn.id !== turnId)
    return state;
  return { kind: "acknowledged", turn: state.turn };
};
var ledger = () => ({ admitted: new Map, nextSeq: 1 });
var admit = (state, turn) => {
  const existing = state.admitted.get(turn.id);
  if (existing !== undefined) {
    return { ledger: state, admission: { turnId: turn.id, seq: existing, fresh: false } };
  }
  const seq = state.nextSeq;
  return {
    ledger: { admitted: new Map([...state.admitted, [turn.id, seq]]), nextSeq: seq + 1 },
    admission: { turnId: turn.id, seq, fresh: true }
  };
};
var fold = (seen, events) => {
  const fresh = [];
  let cursor = seen;
  for (const event of events) {
    if (event.seq <= cursor)
      continue;
    if (event.seq !== cursor + 1) {
      return {
        ok: false,
        why: `the stream jumped from ${cursor} to ${event.seq} — a gap is a conversation that did not happen, and rendering around it lies by omission`
      };
    }
    fresh.push(event);
    cursor = event.seq;
  }
  return { ok: true, seen: cursor, fresh };
};
var resumeFrom = (seen) => seen + 1;
export {
  submit,
  resumeFrom,
  reoffer,
  ledger,
  fold,
  admit,
  acknowledge,
  exports_turns as Turns
};
