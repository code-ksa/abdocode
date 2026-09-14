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

// packages/engine/src/shells/servers-panel.ts
var exports_servers_panel = {};
__export(exports_servers_panel, {
  serversPanel: () => serversPanel,
  renderServers: () => renderServers,
  ServersPanelMount: () => exports_servers_panel,
  SERVERS_PANEL_ID: () => SERVERS_PANEL_ID
});

// packages/engine/src/shells/panel-frame.ts
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

// packages/engine/src/shells/servers-panel.ts
var SERVERS_PANEL_ID = "panel:servers";
var make2 = (document, tag, className) => {
  const node = document.createElement(tag);
  if (className !== undefined)
    node.className = className;
  return node;
};
var STATE_AR = Object.freeze({
  measuring: "يُقاس…",
  up: "يعمل",
  down: "غير عامل"
});
var rendered = new WeakMap;
var renderServers = (document, list, rows, open, bind) => {
  for (const previous of rendered.get(list) ?? [])
    list.removeChild(previous);
  const mine = [];
  rendered.set(list, mine);
  if (rows.length === 0) {
    const blank = make2(document, "span", "act-empty");
    blank.textContent = "لا خادمَ مُدارٌ في هذه الجلسة";
    list.appendChild(blank);
    mine.push(blank);
    return;
  }
  for (const row of rows) {
    const item = make2(document, "div", `srv-row srv-${row.state}`);
    const name = make2(document, "span", "srv-name");
    name.textContent = row.name;
    const port = make2(document, "span", "srv-port");
    port.textContent = ":" + String(row.port);
    const state = make2(document, "span", "srv-state");
    state.textContent = STATE_AR[row.state] + (row.why === undefined ? "" : ` — ${row.why}`);
    item.appendChild(name);
    item.appendChild(port);
    item.appendChild(state);
    if (row.state === "up") {
      const go = make2(document, "button", "iconbtn");
      go.textContent = "↗";
      go.setAttribute("type", "button");
      go.setAttribute("title", `افتح ${row.name} في متصفّح عبدو`);
      go.setAttribute("aria-label", `افتح ${row.name} في متصفّح عبدو`);
      bind(go, "click", () => open(row));
      item.appendChild(go);
    }
    list.appendChild(item);
    mine.push(item);
  }
};
var serversPanel = (deps) => ({
  id: SERVERS_PANEL_ID,
  anchor: deps.anchor,
  feature: "serversPanel",
  order: 20,
  mount: (host, bind) => {
    const frame = panelFrame({
      document: deps.document,
      title: "الخوادم",
      action: { label: "⟳", title: "أعِد القياس", onClick: deps.refresh },
      onExpand: deps.onExpand,
      onClose: deps.onClose,
      ...deps.onPopout === undefined ? {} : { onPopout: deps.onPopout },
      ...deps.onDragStart === undefined ? {} : { onDragStart: deps.onDragStart },
      ...deps.onDragEnd === undefined ? {} : { onDragEnd: deps.onDragEnd },
      expanded: deps.expanded
    }, host, bind);
    const list = make2(deps.document, "div", "panel-list");
    list.id = "serverrows";
    renderServers(deps.document, list, [], deps.open, bind);
    frame.body.appendChild(list);
    deps.attach(list);
    deps.refresh();
    return () => deps.attach(null);
  }
});
export {
  serversPanel,
  renderServers,
  exports_servers_panel as ServersPanelMount,
  SERVERS_PANEL_ID
};
