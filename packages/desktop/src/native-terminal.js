import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './native-terminal.css';

// A user-operated PTY is separate from agent command receipts. The latter still
// arrive through the established attach/submit contract and approval gate.
export function mountNativeTerminal(host, bridge, attach) {
  const L = (en, ar) => document.documentElement.lang === 'ar' ? ar : en;
  const root = document.createElement('div'); root.className = 'native-terminal'; root.dir = 'ltr';
  // Escape/Ctrl+K in a shell belong to the shell, not to the conversation's
  // interruption/command-palette shortcuts on document.
  root.addEventListener('keydown', event => event.stopPropagation());
  const tabs = document.createElement('div'); tabs.className = 'nt-tabs'; tabs.setAttribute('role', 'tablist');
  const area = document.createElement('div'); area.className = 'nt-area';
  const status = document.createElement('div'); status.className = 'nt-status'; status.setAttribute('aria-live', 'polite');
  const tools = document.createElement('div'); tools.className = 'nt-tools panel-list'; tools.id = 'terminalrows'; tools.hidden = true;
  const toolbar = document.createElement('div'); toolbar.className = 'nt-actions';
  const tabItems = document.createElement('div'); tabItems.className = 'nt-tabitems';
  let disposed = false, active = null, sequence = 0, creating = false, unlistenOutput, unlistenExit;
  const terminals = new Map(), early = new Map();
  const updateTheme = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    root.style.setProperty('--nt-background', dark ? '#171717' : '#ffffff');
    for (const item of terminals.values()) { item.term.options.theme = { ...item.term.options.theme, background: dark ? '#171717' : '#ffffff', foreground: dark ? '#eeeeee' : '#242424' }; }
  };
  const themeObserver = new MutationObserver(updateTheme); themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']}); updateTheme();
  const button = (label, title, action) => { const el = document.createElement('button'); el.type = 'button'; el.textContent = label; el.title = title; el.setAttribute('aria-label', title); el.onclick = action; return el; };
  const fail = (error) => { if (!disposed) { status.textContent = L('Terminal: ', 'الطرفية: ') + String(error); status.classList.add('error'); } };
  const resize = item => {
    if (disposed || item.closed || item.view.hidden || !item.view.isConnected || item.view.clientWidth < 24 || item.view.clientHeight < 24) return;
    try { item.fit.fit(); if (item.id) bridge.invoke('terminal_resize', { id: item.id, cols: Math.min(500, Math.max(2, item.term.cols)), rows: Math.min(200, Math.max(2, item.term.rows)) }).catch(fail); } catch (error) { fail(error); }
  };
  const choose = item => {
    active = item;
    tools.hidden = item !== null;
    toolTab.classList.toggle('active', item === null);
    toolTab.setAttribute('aria-selected', String(item === null));
    for (const other of terminals.values()) { other.view.hidden = other !== item; other.tab.classList.toggle('active', other === item); other.tab.setAttribute('aria-selected', String(other === item)); }
    if (item) { status.textContent = item.closed ? L('Shell exited. Open a new terminal to continue.', 'انتهت الصدفة. افتح طرفية جديدة للمتابعة.') : item.cwd || L('Starting PowerShell…', 'يجري تشغيل PowerShell…'); status.classList.remove('error'); requestAnimationFrame(() => { resize(item); item.term.focus(); }); }
    else { status.textContent = L('Agent commands use the conversation permission mode.', 'أوامر الوكيل تتبع وضع صلاحيات المحادثة.'); }
  };
  async function close(item) {
    terminals.delete(item.key);
    item.closed = true; item.observer?.disconnect(); item.term.dispose(); item.tabWrap.remove(); item.view.remove();
    if (item.id) await bridge.invoke('terminal_close', { id: item.id }).catch(() => {});
    if (active === item) choose([...terminals.values()].at(-1) || null);
  }
  const handleOutput = payload => {
    const item = [...terminals.values()].find(item => item.id === payload.id);
    if (item) { item.term.write(new Uint8Array(payload.data)); return; }
    // ConPTY can emit the initial prompt before terminal_open returns its ID.
    if (creating) { const chunks = early.get(payload.id) || []; if (chunks.length < 64) chunks.push(payload.data); early.set(payload.id, chunks); }
  };
  const listenReady = Promise.all([
    bridge.listen('terminal-output', ({payload}) => handleOutput(payload)).then(fn => { if (disposed) fn(); else unlistenOutput = fn; }),
    bridge.listen('terminal-exited', ({payload}) => { const item = [...terminals.values()].find(item => item.id === payload.id); if (!item) return; item.closed = true; item.term.options.disableStdin = true; item.term.writeln('\r\n[' + L('Process exited', 'انتهت العملية') + ': ' + (payload.exitCode ?? '?') + ']'); if (active === item) choose(item); }).then(fn => { if (disposed) fn(); else unlistenExit = fn; }),
  ]);
  async function create() {
    if (disposed || creating) return;
    creating = true; add.disabled = true;
    const key = ++sequence;
    const view = document.createElement('div'); view.className = 'nt-screen'; view.hidden = true; area.append(view);
    const tabWrap = document.createElement('div'); tabWrap.className = 'nt-tab-wrap';
    const tab = button('PowerShell ' + key, 'PowerShell ' + key, () => choose(item)); tab.className = 'nt-tab'; tab.setAttribute('role', 'tab');
    const item = { key, term: null, fit: null, view, tab, tabWrap, closed: false, id: null, cwd: null, observer: null };
    tabWrap.append(tab, button('×', L('Close terminal', 'إغلاق الطرفية'), () => close(item))); tabItems.append(tabWrap);
    const dark = document.documentElement.dataset.theme === 'dark' || document.body.classList.contains('dark') || document.documentElement.getAttribute('data-theme') === 'dark';
    const term = new Terminal({ cursorBlink: true, cursorStyle: 'bar', convertEol: false, fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13, lineHeight: 1.18, scrollback: 5000, theme: { background: dark ? '#171717' : '#ffffff', foreground: dark ? '#eeeeee' : '#242424', cursor: '#2b80e6', selectionBackground: '#73a9e655', black: '#343434', red: '#c43c37', green: '#258549', yellow: '#94752b', blue: '#2676c9', magenta: '#9253b3', cyan: '#207b85', white: '#eeeeee' } });
    const fit = new FitAddon(); term.loadAddon(fit); item.term = term; item.fit = fit; terminals.set(key, item); choose(item); term.open(view);
    item.observer = new ResizeObserver(() => resize(item)); item.observer.observe(view);
    let inputQueue = Promise.resolve();
    term.onData(data => { if (!item.id || item.closed) return; inputQueue = inputQueue.then(() => bridge.invoke('terminal_write', { id: item.id, data })).catch(fail); });
    term.attachCustomKeyEventHandler(event => {
      if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.code === 'KeyC') { const text = term.getSelection(); if (text) navigator.clipboard.writeText(text).catch(fail); return false; }
      if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.code === 'KeyV') { navigator.clipboard.readText().then(text => term.paste(text)).catch(fail); return false; }
      return true;
    });
    try {
      await listenReady;
      if (disposed) return;
      resize(item);
      const opened = await bridge.invoke('terminal_open', { cwd: bridge.getProject() || null, cols: Math.max(2, term.cols), rows: Math.max(2, term.rows) });
      item.id = opened.id; item.cwd = opened.cwd;
      if (disposed || item.closed) { await bridge.invoke('terminal_close', { id: item.id }).catch(() => {}); return; }
      for (const data of early.get(item.id) || []) term.write(new Uint8Array(data)); early.delete(item.id);
      choose(item); resize(item);
    } catch (error) { item.closed = true; term.options.disableStdin = true; term.writeln(L('Could not start terminal. Use + to try again.', 'تعذر تشغيل الطرفية. اضغط + لإعادة المحاولة.')); fail(error); }
    finally { creating = false; add.disabled = false; early.clear(); }
  }
  const add = button('+', L('New PowerShell terminal', 'طرفية PowerShell جديدة'), create); add.className = 'nt-new';
  const toolTab = button(L('Agent output', 'مخرجات الوكيل'), L('View agent command receipts', 'عرض إيصالات أوامر الوكيل'), () => choose(null)); toolTab.className = 'nt-tab nt-tool-tab'; toolTab.setAttribute('role','tab');
  toolbar.append(button('↧', L('Scroll to bottom', 'انتقل للأسفل'), () => active?.term.scrollToBottom()), button('⌫', L('Clear terminal display', 'مسح عرض الطرفية'), () => active?.term.clear()), button('■', L('Interrupt (Ctrl+C)', 'إيقاف الأمر (Ctrl+C)'), () => { if (active?.id && !active.closed) bridge.invoke('terminal_write', { id: active.id, data: '\u0003' }).catch(fail); }));
  tabs.append(tabItems, add, toolTab, toolbar);
  const command = document.createElement('form'); command.className = 'nt-agent-command';
  const input = document.createElement('input'); input.placeholder = L('Run through agent permissions…', 'نفّذ عبر صلاحيات الوكيل…'); input.setAttribute('aria-label', input.placeholder);
  command.append(input, button(L('Run', 'تنفيذ'), L('Run agent command', 'تنفيذ أمر الوكيل'), () => { if (input.value.trim()) { bridge.submit(input.value.trim()); input.value = ''; } }));
  command.onsubmit = event => { event.preventDefault(); if (input.value.trim()) { bridge.submit(input.value.trim()); input.value = ''; } };
  const receipts = document.createElement('div'); receipts.className = 'nt-receipts'; receipts.id = 'terminalrows'; tools.removeAttribute('id'); tools.append(receipts, command); area.append(tools);
  root.append(tabs, area, status); host.appendChild(root); attach(receipts);
  void create();
  return () => { disposed = true; themeObserver.disconnect(); unlistenOutput?.(); unlistenExit?.(); attach(null); for (const item of [...terminals.values()]) void close(item); root.remove(); };
}
