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

// ../engine/src/shells/tasks-panel.ts
var exports_tasks_panel = {};
__export(exports_tasks_panel, {
  tasksPanel: () => tasksPanel,
  renderTasks: () => renderTasks,
  TasksPanelMount: () => exports_tasks_panel,
  TASKS_PANEL_ID: () => TASKS_PANEL_ID
});

// ../engine/src/shells/panel-frame.ts
var make = (document, tag, className) => {
  const node = document.createElement(tag);
  if (className !== undefined)
    node.className = className;
  return node;
};
var iconButton = (document, bind, label, title, onClick) => {
  const button = make(document, "button", "iconbtn");
  button.textContent = label;
  button.setAttribute("title", title);
  button.setAttribute("aria-label", title);
  button.setAttribute("type", "button");
  bind(button, "click", () => onClick());
  return button;
};
var panelFrame = (deps, host, bind) => {
  const root = make(deps.document, "section", deps.expanded ? "panel expanded" : "panel");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", deps.title);
  const header = make(deps.document, "header", "panel-head");
  if (deps.onDragStart !== undefined) {
    header.setAttribute("draggable", "true");
    bind(header, "dragstart", (event) => deps.onDragStart(event));
    if (deps.onDragEnd !== undefined)
      bind(header, "dragend", () => deps.onDragEnd());
  }
  const name = make(deps.document, "span", "panel-name");
  name.textContent = deps.title;
  header.appendChild(name);
  const group = make(deps.document, "div", "panel-actions");
  if (deps.action !== undefined) {
    group.appendChild(iconButton(deps.document, bind, deps.action.label, deps.action.title, deps.action.onClick));
  }
  if (deps.onPopout !== undefined) {
    group.appendChild(iconButton(deps.document, bind, "⧉", "افتح اللوح في نافذةٍ مستقلّة", deps.onPopout));
  }
  group.appendChild(iconButton(deps.document, bind, deps.expanded ? "⤡" : "⤢", deps.expanded ? "أعِد اللوح إلى مرساته" : "وسّع اللوح", () => deps.onExpand(!deps.expanded)));
  group.appendChild(iconButton(deps.document, bind, "✕", "أغلق اللوح", () => deps.onClose()));
  header.appendChild(group);
  const body = make(deps.document, "div", "panel-body");
  root.appendChild(header);
  root.appendChild(body);
  host.appendChild(root);
  return { root, body };
};

// ../engine/src/shells/tasks-panel.ts
var TASKS_PANEL_ID = "panel:tasks";
var MODE_EN = Object.freeze({ "أساسيّ": "basic", "أقوى": "stronger", "أقوى+": "stronger+", "أقصى": "max" });
var AGENT_STATE_AR = Object.freeze({
  running: "يعمل",
  complete: "أتمّ",
  budget: "نفدت الميزانية",
  aborted: "قوطع",
  failed: "تعثّر",
  stalled: "توقّف"
});
var make2 = (document, tag, className) => {
  const node = document.createElement(tag);
  if (className !== undefined)
    node.className = className;
  return node;
};
var STATE_AR = Object.freeze({
  running: "يجري",
  completed: "تمّ",
  interrupted: "قوطع",
  unresolved: "بلا تمام",
  checkpointed: "نقطة حفظ"
});
var rendered = new WeakMap;
var renderTasks = (document, list, rows, language = "ar") => {
  const expanded = new Set((rendered.get(list) ?? []).filter((n) => n.open).map((n) => n.id));
  for (const previous of rendered.get(list) ?? [])
    list.removeChild(previous);
  const mine = [];
  rendered.set(list, mine);
  if (rows.length === 0) {
    const blank = make2(document, "span", "act-empty");
    blank.textContent = "لا مهمّةَ جارية";
    list.appendChild(blank);
    mine.push(blank);
    return;
  }
  for (const row of [...rows].sort((a, b) => Number(b.state === "running") - Number(a.state === "running"))) {
    const item = make2(document, "details", `task-row task-${row.state}`);
    item.id = "task-" + row.turnId;
    if (expanded.has(item.id))
      item.setAttribute("open", "");
    const head = make2(document, "summary", "task-head");
    const title = make2(document, "span", "task-title");
    title.textContent = row.title;
    const state = make2(document, "span", "task-state");
    state.textContent = (language === "en" ? row.state : STATE_AR[row.state]) + (row.duration === undefined ? "" : ` · ${row.duration}`);
    head.appendChild(title);
    head.appendChild(state);
    const meta = make2(document, "div", "task-meta");
    meta.textContent = `${row.epochs} حقبة · ${row.tools} أداة` + (row.failed > 0 ? ` · ${row.failed} سقطت` : "");
    if (language === "en")
      meta.textContent = `${row.epochs} epochs · ${row.tools} tools` + (row.failed ? ` · ${row.failed} failed` : "");
    if (row.mode !== undefined && row.mode.length > 0)
      meta.textContent += language === "en" ? ` · mode ${MODE_EN[row.mode] ?? row.mode}` : ` · وضع «${row.mode}»`;
    item.appendChild(head);
    item.appendChild(meta);
    if (row.agents !== undefined && row.agents.length > 0) {
      const strip = make2(document, "div", "task-agents");
      for (const agent of row.agents) {
        const wrap = make2(document, "details", "task-agent-wrap");
        wrap.id = `task-agent-${row.turnId}-${agent.id}`;
        const chip = make2(document, "summary", "task-agent");
        chip.setAttribute("data-state", agent.state);
        chip.setAttribute("data-kind", agent.kind);
        chip.setAttribute("title", agent.task);
        const dot = make2(document, "span", "task-agent-dot");
        const name = make2(document, "span", "task-agent-name");
        name.textContent = agent.name + (agent.epoch !== undefined && agent.state === "running" ? ` · ${agent.epoch}` : "");
        chip.appendChild(dot);
        chip.appendChild(name);
        const detail = make2(document, "div", "task-agent-detail");
        const stateText = language === "en" ? agent.state : AGENT_STATE_AR[agent.state] ?? agent.state;
        detail.textContent = `${agent.kind === "team" ? language === "en" ? "team" : "فريق" : language === "en" ? "delegate" : "تفويض"} · ${stateText}
${agent.task}` + (agent.detail ? `
${agent.detail}` : "");
        wrap.appendChild(chip);
        wrap.appendChild(detail);
        strip.appendChild(wrap);
      }
      item.appendChild(strip);
    }
    for (const step of row.steps || []) {
      const card = make2(document, "details", "task-step"), caption = make2(document, "summary", "task-step-title"), output = make2(document, "pre", "task-step-output");
      caption.textContent = step.state + " " + step.cmd;
      output.textContent = step.output;
      card.appendChild(caption);
      card.appendChild(output);
      item.appendChild(card);
    }
    list.appendChild(item);
    mine.push(item);
  }
};
var tasksPanel = (deps) => ({
  id: TASKS_PANEL_ID,
  anchor: deps.anchor,
  feature: "tasksPanel",
  order: 30,
  mount: (host, bind) => {
    const frame = panelFrame({
      document: deps.document,
      title: "المهامّ",
      onExpand: deps.onExpand,
      onClose: deps.onClose,
      expanded: deps.expanded,
      ...deps.onPopout === undefined ? {} : { onPopout: deps.onPopout },
      ...deps.onDragStart === undefined ? {} : { onDragStart: deps.onDragStart },
      ...deps.onDragEnd === undefined ? {} : { onDragEnd: deps.onDragEnd }
    }, host, bind);
    const list = make2(deps.document, "div", "panel-list");
    list.id = "taskrows";
    renderTasks(deps.document, list, []);
    frame.body.appendChild(list);
    deps.attach(list);
    return () => deps.attach(null);
  }
});
export {
  tasksPanel,
  renderTasks,
  exports_tasks_panel as TasksPanelMount,
  TASKS_PANEL_ID
};
