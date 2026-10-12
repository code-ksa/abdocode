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
  // Esc يغلق قائمة زرّ اليمين قبل أن يبلغ xterm (حقلُه يوقف انتشارَ المفاتيح التي يعالجها) — طورُ الالتقاط لذلك.
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.hidden) { closeMenu(); event.preventDefault(); event.stopPropagation(); } }, true);
  // 2026-09-28 (4.0.70): «التيرمينال لا أستطيع الكتابة فيه» — المفاتيحُ تصل xterm عبر حقله المخفيّ وحده،
  // وهو لا يُركَّز إلا بنقرةٍ داخل الشاشة نفسِها. نقرةٌ في أيّ موضعٍ من اللوح (الحاشية، الشريط، سطر الحالة) تعيد التركيزَ
  // إلى الطرفيّة الحيّة، وتُلتقط في طور الالتقاط كي لا يبتلعها زرٌّ أو منزلقٌ في الطريق.
  root.addEventListener('mousedown', event => {
    if (!active || active.closed || event.target.closest('button, input, form, .nt-tools')) return;
    requestAnimationFrame(() => { if (active && !active.closed) active.term.focus(); });
  }, true);
  const tabs = document.createElement('div'); tabs.className = 'nt-tabs'; tabs.setAttribute('role', 'tablist');
  const area = document.createElement('div'); area.className = 'nt-area';
  const status = document.createElement('div'); status.className = 'nt-status'; status.setAttribute('aria-live', 'polite');
  const tools = document.createElement('div'); tools.className = 'nt-tools panel-list'; tools.id = 'terminalrows'; tools.hidden = true;
  const toolbar = document.createElement('div'); toolbar.className = 'nt-actions';
  const tabItems = document.createElement('div'); tabItems.className = 'nt-tabitems';
  let disposed = false, active = null, sequence = 0, creating = false, unlistenOutput, unlistenExit;
  const terminals = new Map(), early = new Map();
  // 10-09 — لوحةُ ألوانٍ كاملة لكلّ سمة (16 لوناً + تحديدٌ ظاهر): كان «الأبيض» #eeeeee على خلفيةٍ بيضاء فيختفي نصّ،
  // والتحديدُ #73a9e655 باهتاً حتى يبدو أنّ السحبَ لم يحدّد شيئاً.
  const palette = dark => dark
    ? { background: '#171717', foreground: '#e6e6e6', cursor: '#4f9cf0', cursorAccent: '#171717', selectionBackground: '#264f78', selectionInactiveBackground: '#3a3d41', black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5', brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff' }
    : { background: '#ffffff', foreground: '#1f2328', cursor: '#2b80e6', cursorAccent: '#ffffff', selectionBackground: '#add6ff', selectionInactiveBackground: '#e5ebf1', black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7d4e00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781', brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f' };
  const isDark = () => document.documentElement.dataset.theme === 'dark' || document.body.classList.contains('dark');
  const updateTheme = () => {
    const dark = isDark(), colors = palette(dark);
    root.style.setProperty('--nt-background', colors.background);
    root.style.setProperty('--nt-foreground', colors.foreground);
    for (const item of terminals.values()) item.term.options.theme = colors;
  };
  const themeObserver = new MutationObserver(updateTheme); themeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']}); updateTheme();
  const button = (label, title, action) => { const el = document.createElement('button'); el.type = 'button'; el.textContent = label; el.title = title; el.setAttribute('aria-label', title); el.onclick = action; return el; };
  const fail = (error) => { if (!disposed) { status.textContent = L('Terminal: ', 'الطرفية: ') + String(error); status.classList.add('error'); } };
  // 10-09 — النسخُ واللصق عبر حافظة النظام (أمرا Rust)؛ navigator.clipboard احتياطٌ — قراءتُه تحتاج إذناً لا يُمنح في WebView2.
  const clipWrite = text => bridge.invoke('clipboard_write_text', { text }).catch(() => navigator.clipboard.writeText(text));
  const clipRead = () => bridge.invoke('clipboard_read_text').catch(() => navigator.clipboard.readText());
  let flashTimer = 0;
  const flash = text => { status.textContent = text; status.classList.remove('error'); clearTimeout(flashTimer); flashTimer = setTimeout(() => { if (!disposed && active) status.textContent = active.closed ? status.textContent : (active.cwd || ''); }, 1400); };
  const copySelection = item => { const text = item?.term.getSelection(); if (!text) return; clipWrite(text).then(() => { item.term.clearSelection(); flash(L('Copied to clipboard', 'نُسخ إلى الحافظة')); item.term.focus(); }).catch(fail); };
  const pasteInto = item => { if (!item || item.closed) return; clipRead().then(text => { if (text) item.term.paste(text); item.term.focus(); }).catch(fail); };
  const menu = document.createElement('div'); menu.className = 'nt-menu'; menu.setAttribute('role', 'menu'); menu.hidden = true;
  const closeMenu = () => { menu.hidden = true; };
  const openMenu = (event, item) => {
    event.preventDefault();
    const entry = (label, keys, disabled, action) => { const el = document.createElement('button'); el.type = 'button'; el.setAttribute('role', 'menuitem'); el.disabled = disabled; const name = document.createElement('span'); name.textContent = label; const hint = document.createElement('kbd'); hint.textContent = keys; el.append(name, hint); el.onclick = () => { closeMenu(); action(); }; return el; };
    menu.replaceChildren(
      entry(L('Copy', 'نسخ'), 'Ctrl+C', !item.term.hasSelection(), () => copySelection(item)),
      entry(L('Paste', 'لصق'), 'Ctrl+V', item.closed, () => pasteInto(item)),
      entry(L('Select all', 'تحديد الكل'), 'Ctrl+Shift+A', false, () => { item.term.selectAll(); item.term.focus(); }),
      entry(L('Clear', 'مسح الشاشة'), '', false, () => { item.term.clear(); item.term.focus(); }));
    menu.hidden = false;
    const box = root.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(4, Math.min(event.clientX - box.left, box.width - w - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(event.clientY - box.top, box.height - h - 4)) + 'px';
  };
  const onOutside = event => { if (!menu.hidden && !menu.contains(event.target)) closeMenu(); };
  document.addEventListener('mousedown', onOutside, true);
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
    const dark = isDark();
    const term = new Terminal({ cursorBlink: true, cursorStyle: 'block', cursorInactiveStyle: 'outline', convertEol: false, fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace', fontSize: 13, lineHeight: 1.2, letterSpacing: 0, scrollback: 10000, rightClickSelectsWord: false, macOptionIsMeta: true, windowsPty: { backend: 'conpty' }, allowProposedApi: false, theme: palette(dark) });
    const fit = new FitAddon(); term.loadAddon(fit); item.term = term; item.fit = fit; terminals.set(key, item); choose(item); term.open(view);
    item.observer = new ResizeObserver(() => resize(item)); item.observer.observe(view);
    let inputQueue = Promise.resolve();
    term.onData(data => { if (!item.id || item.closed) return; inputQueue = inputQueue.then(() => bridge.invoke('terminal_write', { id: item.id, data })).catch(fail); });
    // مثل Windows Terminal: Ctrl+C ينسخ حين يوجد تحديد (وإلّا يبقى ^C للصدفة)، وCtrl+V يلصق، وCtrl+Shift+C/V وCtrl/Shift+Insert كذلك.
    term.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown' || event.altKey) return true;
      const code = event.code;
      if (event.ctrlKey && (code === 'KeyC' || code === 'Insert') && (event.shiftKey || term.hasSelection())) { event.preventDefault(); copySelection(item); return false; }
      if ((event.ctrlKey && code === 'KeyV') || (event.shiftKey && !event.ctrlKey && code === 'Insert')) { event.preventDefault(); pasteInto(item); return false; }
      if (event.ctrlKey && event.shiftKey && code === 'KeyA') { event.preventDefault(); term.selectAll(); return false; }
      return true;
    });
    view.addEventListener('contextmenu', event => openMenu(event, item));
    try {
      await listenReady;
      if (disposed) return;
      resize(item);
      const opened = await bridge.invoke('terminal_open', { cwd: bridge.getProject() || null, cols: Math.max(2, term.cols), rows: Math.max(2, term.rows) });
      item.id = opened.id; item.cwd = opened.cwd;
      if (disposed || item.closed) { await bridge.invoke('terminal_close', { id: item.id }).catch(() => {}); return; }
      for (const data of early.get(item.id) || []) term.write(new Uint8Array(data)); early.delete(item.id);
      choose(item); resize(item);
      // الصدفةُ حيّة: التركيزُ فوراً لا عند الإطار التالي وحده — مقيسٌ أنّ rAF داخل choose يسبق أحياناً اتّصالَ الشاشة.
      setTimeout(() => { if (!disposed && active === item && !item.closed) term.focus(); }, 60);
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
  root.append(tabs, area, status, menu); host.appendChild(root); attach(receipts);
  void create();
  return () => { disposed = true; themeObserver.disconnect(); document.removeEventListener('mousedown', onOutside, true); clearTimeout(flashTimer); unlistenOutput?.(); unlistenExit?.(); attach(null); for (const item of [...terminals.values()]) void close(item); root.remove(); };
}
