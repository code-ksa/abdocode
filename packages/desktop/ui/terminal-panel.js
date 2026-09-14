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

// ../engine/src/shells/terminal-panel.ts
var exports_terminal_panel = {};
__export(exports_terminal_panel, {
  terminalPanel: () => terminalPanel,
  TerminalPanelMount: () => exports_terminal_panel,
  TERMINAL_PANEL_ID: () => TERMINAL_PANEL_ID
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

// ../engine/src/shells/terminal-panel.ts
var TERMINAL_PANEL_ID = "panel:terminal";
var make2 = (document, tag, className) => {
  const node = document.createElement(tag);
  if (className !== undefined)
    node.className = className;
  return node;
};
var terminalPanel = (deps) => ({
  id: TERMINAL_PANEL_ID,
  anchor: deps.anchor,
  feature: "terminalPanel",
  order: 10,
  mount: (host, bind) => {
    const input = make2(deps.document, "input", "panel-input");
    input.setAttribute("placeholder", "أمرٌ يمرّ ببوّابة الموافقة…");
    input.setAttribute("aria-label", "أمرٌ جديد");
    input.setAttribute("spellcheck", "false");
    const send = {
      label: "▶",
      title: "نفّذ الأمر (يمرّ ببوّابة النمط)",
      onClick: () => {
        const text = (input.value ?? "").trim();
        if (text.length === 0)
          return;
        input.value = "";
        deps.submit(text);
      }
    };
    const frame = panelFrame({
      document: deps.document,
      title: deps.mountInteractive ? "Terminal" : "الطرفيّة",
      ...deps.mountInteractive ? {} : { action: send },
      onExpand: deps.onExpand,
      onClose: deps.onClose,
      ...deps.onPopout === undefined ? {} : { onPopout: deps.onPopout },
      ...deps.onDragStart === undefined ? {} : { onDragStart: deps.onDragStart },
      ...deps.onDragEnd === undefined ? {} : { onDragEnd: deps.onDragEnd },
      expanded: deps.expanded
    }, host, bind);
    if (deps.mountInteractive)
      return deps.mountInteractive(frame.body, deps.attach);
    const list = make2(deps.document, "div", "panel-list");
    list.id = "terminalrows";
    const blank = make2(deps.document, "span", "act-empty");
    blank.textContent = "لم يُنفَّذ أمرٌ في هذه الجلسة بعد";
    list.appendChild(blank);
    const row = make2(deps.document, "div", "panel-inputrow");
    row.appendChild(input);
    frame.body.appendChild(list);
    frame.body.appendChild(row);
    bind(input, "keydown", (event) => {
      const key = event.key;
      if (key === "Enter")
        send.onClick();
    });
    deps.attach(list);
    return () => deps.attach(null);
  }
});
export {
  terminalPanel,
  exports_terminal_panel as TerminalPanelMount,
  TERMINAL_PANEL_ID
};
