// استيرادُ الذاكرة والتخصيصات — لوحةٌ في الإعدادات (10-10).
// المحرّكُ يملك القراءةَ والحجبَ وإزالةَ التكرار والحفظ (packages/engine/src/memory-import.ts) إلى ملاحظات المالك نفسِها؛
// هذه الوحدةُ عرضٌ ومراجعة فقط. لا شيءَ يُحفظ إلا بزرّ «حفظ المحدَّد» (إطار memory-import-save).

const PROMPT_AR = 'اكتب كلّ ما تتذكّره عنّي وعن تفضيلاتي: اسمي وعملي ولغتي، وأسلوبَ الردّ الذي أفضّله، وأسلوبي في البرمجة والأدوات التي أستعملها، ومشاريعي، وأيَّ تعليماتٍ دائمة أعطيتك إيّاها. اكتبها نقاطاً — حقيقةً واحدة في كلّ سطر — بلا مقدّمةٍ ولا تعليق، ولا تذكر كلماتِ مرورٍ أو مفاتيحَ API أو أيَّ أسرار.';
const PROMPT_EN = 'List everything you remember about me and my preferences: my name, role and language, how I like you to respond, my coding style and the tools I use, my projects, and any standing instructions I have given you. Output bullet points — one fact per line — with no introduction or commentary, and do not include passwords, API keys or other secrets.';
const AGENT_LABEL = {'claude-code':'Claude Code',codex:'Codex','gemini-cli':'Gemini CLI',qwen:'Qwen Code',cursor:'Cursor',windsurf:'Windsurf',cline:'Cline',copilot:'GitHub Copilot',chatgpt:'ChatGPT',claude:'Claude',gemini:'Gemini',other:'Other'};
const SAVE_MAX = 200;
const size = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function createMemoryImport(api) {
  const st = {tab:'local', sources:null, picked:new Set(), busy:'', error:'', review:null, found:[], dropped:null, truncated:false,
    vendor:'chatgpt', exportPath:'', paste:'', from:'chatgpt', scope:'user', maskEmails:true, result:null};
  let panel = null, t = (en, ar) => en, lang = 'en';
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const user = n => { n.dataset.userContent = ''; n.dir = 'auto'; return n; };
  const btn = (label, run, cls = '') => { const b = el('button', 'nss-action ' + cls, label); b.type = 'button'; b.onclick = run; return b; };
  const send = (frame, busy) => {
    st.busy = busy; st.error = ''; draw();
    Promise.resolve(api.bridge.send?.(frame)).catch(e => { st.busy = ''; st.error = String(e?.message || e); draw(); });
  };
  const preview = frame => { st.result = null; send({kind:'memory-import-preview', maskEmails:st.maskEmails, ...frame}, t('Reading and masking secrets…', 'جارٍ القراءة وحجب الأسرار…')); };
  const kept = () => (st.review || []).filter(item => item.keep);

  function render(host, tr, language) { panel = host; t = tr; lang = language; draw(); }

  function draw() {
    if (!panel || !panel.isConnected) return;
    const title = panel.querySelector(':scope > h3');
    const root = el('div', 'nmi'); root.dir = lang === 'ar' ? 'rtl' : 'ltr';
    panel.replaceChildren(...(title ? [title] : []), root);
    root.append(el('p', 'nss-summary', t('Bring what other assistants already know about you — ChatGPT, Claude, Gemini and the agents that work on your projects — so AbdoCode follows your preferences. Everything is read on this computer, secrets are masked, and nothing is saved until you review it and press Save. Saved items become memory notes you can edit or forget in Memory.',
      'اجلب ما تعرفه عنك المساعداتُ الأخرى — ChatGPT وClaude وGemini والوكلاءُ الذين يعملون على مشاريعك — كي يتّبع عبدو كود تفضيلاتك. كلُّ شيءٍ يُقرأ على هذا الجهاز، والأسرارُ تُحجب، ولا يُحفظ شيءٌ حتى تراجعه وتضغط «حفظ». ما يُحفظ يصير ملاحظاتِ ذاكرةٍ تعدّلها أو تنساها من صفحة الذاكرة.')));
    const tabs = el('div', 'nmi-tabs'); tabs.setAttribute('role', 'tablist');
    for (const [id, en, ar] of [['local', 'Agent files on this computer', 'ملفّات الوكلاء على جهازك'], ['export', 'Export file', 'ملفّ تصدير'], ['paste', 'Paste', 'لصق']]) {
      const b = el('button', 'nmi-tab' + (st.tab === id ? ' active' : ''), t(en, ar)); b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(st.tab === id));
      b.onclick = () => { st.tab = id; draw(); }; tabs.append(b);
    }
    root.append(tabs);
    const body = el('div', 'nmi-body'); root.append(body);
    if (st.tab === 'local') drawLocal(body); else if (st.tab === 'export') drawExport(body); else drawPaste(body);
    const mask = el('label', 'nss-pref-row'); const copy = el('span'); copy.append(el('strong', '', t('Mask email addresses', 'حجب عناوين البريد')), el('small', '', t('Keys, tokens and passwords are always masked; emails are masked too unless you turn this off.', 'المفاتيحُ والرموزُ وكلماتُ المرور تُحجب دائماً؛ والبريدُ يُحجب أيضاً ما لم تطفئ هذا.')));
    const box = el('input'); box.type = 'checkbox'; box.checked = st.maskEmails; box.onchange = () => { st.maskEmails = box.checked; }; mask.append(copy, box); root.append(mask);
    if (st.busy) root.append(el('p', 'nmi-status', st.busy));
    if (st.error) root.append(user(el('p', 'nmi-status nmi-error', st.error)));
    if (st.result) drawResult(root);
    if (st.review) drawReview(root);
  }

  function drawLocal(body) {
    const head = el('div', 'nss-action-row'); const copy = el('div');
    copy.append(el('strong', '', t('Scan for agent instruction and memory files', 'افحص ملفّات تعليمات الوكلاء وذاكرتهم')), el('small', '', t('Claude Code (CLAUDE.md, ~/.claude/projects/*/memory), Codex (AGENTS.md), Gemini CLI (GEMINI.md), Qwen (QWEN.md), Cursor, Windsurf, Cline and GitHub Copilot rules — in your home folder, the open project and your project roots (Memory ▸ Project roots). Only paths and sizes are listed until you read a file.',
      'Claude Code (CLAUDE.md و~/.claude/projects/*/memory) وCodex (AGENTS.md) وGemini CLI (GEMINI.md) وQwen (QWEN.md) وقواعد Cursor وWindsurf وCline وGitHub Copilot — في مجلّدك الشخصيّ والمشروع المفتوح وجذور مشاريعك (الذاكرة ▸ جذور المشاريع). تُسرد المساراتُ والأحجامُ فقط حتى تقرأ ملفّاً.')));
    head.append(copy, btn(st.sources === null ? t('Scan', 'افحص') : t('Rescan', 'أعد الفحص'), () => send({kind:'memory-import-scan'}, t('Scanning…', 'جارٍ الفحص…')), 'primary'));
    body.append(head);
    if (st.sources === null) return;
    if (!st.sources.length) { body.append(el('p', 'nmi-empty', t('No agent files were found in your home folder or project roots.', 'لم يُعثر على ملفّات وكلاء في مجلّدك الشخصيّ أو جذور مشاريعك.'))); return; }
    const tools = el('div', 'nmi-toolbar');
    const count = el('span', 'nmi-count');
    const read = btn('', () => preview({source:'local', paths:[...st.picked]}), 'primary');
    const sync = () => { count.textContent = t(`${st.picked.size} of ${st.sources.length} selected`, `${st.picked.size} من ${st.sources.length} محدَّدة`); read.textContent = t(`Read selected (${st.picked.size})`, `اقرأ المحدَّد (${st.picked.size})`); read.disabled = st.picked.size === 0 || !!st.busy; };
    tools.append(btn(t('Select all', 'تحديد الكلّ'), () => { st.sources.forEach(s => st.picked.add(s.path)); draw(); }), btn(t('Clear', 'إلغاء التحديد'), () => { st.picked.clear(); draw(); }), count, read);
    body.append(tools);
    const list = el('div', 'nmi-sources');
    for (const source of st.sources) {
      const row = el('label', 'nmi-source');
      const box = el('input'); box.type = 'checkbox'; box.checked = st.picked.has(source.path);
      box.onchange = () => { if (box.checked) st.picked.add(source.path); else st.picked.delete(source.path); sync(); };
      const info = el('span', 'nmi-source-info');
      const path = el('code', 'nmi-path', source.path); path.dir = 'ltr'; path.dataset.userContent = '';
      info.append(el('strong', '', AGENT_LABEL[source.agent] || source.agent), path, el('small', '', `${size(source.bytes)} · ${source.where === 'home' ? t('home folder', 'المجلّد الشخصيّ') : t('project', 'مشروع')}`));
      const look = btn(t('Preview', 'معاينة'), e => { e.preventDefault(); preview({source:'local', paths:[source.path]}); });
      row.append(box, info, look); list.append(row);
    }
    body.append(list); sync();
  }

  function drawExport(body) {
    const vendor = el('label', 'nss-pref-row'); const vcopy = el('span'); vcopy.append(el('strong', '', t('Export from', 'التصدير من')), el('small', '', t('How to get it: ChatGPT ▸ Settings ▸ Data controls ▸ Export data · Claude ▸ Settings ▸ Privacy ▸ Export data · Gemini ▸ takeout.google.com (My Activity ▸ Gemini Apps).', 'طريقُ الحصول عليه: ChatGPT ▸ الإعدادات ▸ عناصر التحكّم بالبيانات ▸ تصدير البيانات · Claude ▸ الإعدادات ▸ الخصوصية ▸ تصدير البيانات · Gemini ▸ takeout.google.com (نشاطي ▸ تطبيقات Gemini).')));
    const select = el('select'); for (const [id, label] of [['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini']]) { const o = el('option', '', label); o.value = id; select.append(o); }
    select.value = st.vendor; select.onchange = () => { st.vendor = select.value; draw(); }; vendor.append(vcopy, select); body.append(vendor);
    const fields = {
      chatgpt: t('Reads conversations.json: your custom instructions (user_editable_context → user_profile “about you” and user_instructions “how to respond”, newest version) and what ChatGPT saved to memory (messages sent to the bio tool), plus a memories*.json file if the export has one. user.json holds account fields only and is not imported.',
        'يقرأ conversations.json: تعليماتِك المخصّصة (user_editable_context ⇦ user_profile «عنك» وuser_instructions «كيف يردّ»، الأحدثُ منها) وما حفظه ChatGPT في الذاكرة (رسائلُ أداة bio)، وملفَّ memories*.json إن وُجد. user.json حقولُ حسابٍ فقط فلا يُستورد.'),
      claude: t('Reads projects.json (each project’s instructions, prompt_template) and a memories*.json file if present (conversations_memory, project_memories). Conversations and account files are counted, not imported.',
        'يقرأ projects.json (تعليماتُ كلّ مشروع prompt_template) وملفَّ memories*.json إن وُجد (conversations_memory وproject_memories). المحادثاتُ وملفّاتُ الحساب تُعدّ ولا تُستورد.'),
      gemini: t('Reads any “Saved info” or Gems file in the Takeout, and from My Activity ▸ Gemini Apps only the prompts that start with “remember…”/“from now on…”. Takeout usually does not include Saved info — if it is missing you will be told, and the Paste tab is the way.',
        'يقرأ أيَّ ملفّ «معلومات محفوظة» أو Gems في Takeout، ومن «نشاطي ▸ تطبيقات Gemini» الطلباتِ التي تبدأ بـ«تذكّر…/من الآن…» وحدها. Takeout لا يحمل «المعلومات المحفوظة» عادةً — إن غابت قيل لك، وتبويبُ اللصق هو الطريق.'),
    };
    body.append(el('p', 'nmi-note', fields[st.vendor]));
    const row = el('div', 'nmi-pathrow');
    const input = el('input', 'nmi-pathinput'); input.dir = 'ltr'; input.placeholder = 'C:\\Users\\…\\export.zip'; input.value = st.exportPath; input.oninput = () => { st.exportPath = input.value; };
    const choose = btn(t('Choose file…', 'اختر الملفّ…'), async () => {
      try { const path = await api.bridge.invoke('memory_import_choose'); if (path) { st.exportPath = path; preview({source:'export', path, vendor:st.vendor}); } }
      catch (e) { st.error = t('The file picker is unavailable in this build — paste the full path of the export instead.', 'منتقي الملفّات غير متاح في هذا الإصدار — الصق المسار الكامل لملفّ التصدير.'); draw(); }
    });
    const read = btn(t('Read', 'اقرأ'), () => { const path = st.exportPath.trim(); if (!path) { st.error = t('Choose an export file first.', 'اختر ملفّ التصدير أوّلاً.'); draw(); return; } preview({source:'export', path, vendor:st.vendor}); }, 'primary');
    row.append(choose, input, read); body.append(row);
  }

  function drawPaste(body) {
    body.append(el('p', 'nmi-step', t('1 — Copy this request into ChatGPT, Claude or Gemini:', '١ — انسخ هذا الطلب إلى ChatGPT أو Claude أو Gemini:')));
    const prompt = el('textarea', 'nmi-prompt'); prompt.readOnly = true; prompt.rows = 4; prompt.dir = lang === 'ar' ? 'rtl' : 'ltr'; prompt.value = lang === 'ar' ? PROMPT_AR : PROMPT_EN; body.append(prompt);
    const copy = text => Promise.resolve(api.bridge.invoke?.('clipboard_write_text', {text})).catch(() => navigator.clipboard.writeText(text)).then(() => api.bridge.notice?.(t('Request copied.', 'نُسخ الطلب.'))).catch(e => { st.error = String(e); draw(); });
    const copies = el('div', 'nmi-toolbar'); copies.append(btn(t('Copy Arabic request', 'نسخ الطلب بالعربية'), () => copy(PROMPT_AR)), btn(t('Copy English request', 'نسخ الطلب بالإنجليزية'), () => copy(PROMPT_EN))); body.append(copies);
    body.append(el('p', 'nmi-step', t('2 — Paste the answer here:', '٢ — الصق الجواب هنا:')));
    const from = el('select'); for (const [id, label] of [['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['other', t('Another assistant', 'مساعدٌ آخر')]]) { const o = el('option', '', label); o.value = id; from.append(o); }
    from.value = st.from; from.onchange = () => { st.from = from.value; };
    const area = user(el('textarea', 'nmi-paste')); area.rows = 8; area.value = st.paste; area.placeholder = t('- I prefer short answers in Arabic\n- I work with Next.js and PostgreSQL', '- أفضّل الردود القصيرة بالعربية\n- أعمل بـNext.js وPostgreSQL'); area.oninput = () => { st.paste = area.value; };
    const row = el('div', 'nmi-toolbar'); row.append(el('span', 'nmi-count', t('From', 'من')), from, btn(t('Review', 'راجِع'), () => { if (!st.paste.trim()) { st.error = t('Paste the assistant’s answer first.', 'الصق جوابَ المساعد أوّلاً.'); draw(); return; } preview({source:'paste', text:st.paste.slice(0, 200000), from:st.from}); }, 'primary'));
    body.append(area, row);
  }

  function drawReview(root) {
    const section = el('section', 'nmi-review');
    section.append(el('h4', '', t('Review before saving', 'راجِع قبل الحفظ')));
    const d = st.dropped || {duplicates:0, tooShort:0, secrets:0};
    section.append(el('p', 'nmi-note', t(`${st.review.length} items. Removed: ${d.duplicates} duplicates, ${d.tooShort} too short, ${d.secrets} carrying credentials.${st.truncated ? ' The list was capped — save these, then read the rest.' : ''}`,
      `${st.review.length} بنداً. أُسقط: ${d.duplicates} مكرّراً، و${d.tooShort} قصيراً، و${d.secrets} يحمل اعتماداً.${st.truncated ? ' القائمةُ مسقوفة — احفظ هذه ثمّ اقرأ الباقي.' : ''}`)));
    if (st.found.length) { const det = el('details', 'nmi-found'); det.append(el('summary', '', t('What was found', 'ما وُجد وما غاب'))); for (const line of st.found) det.append(user(el('p', '', line))); det.open = st.review.length === 0; section.append(det); }
    if (!st.review.length) { section.append(el('p', 'nmi-empty', t('Nothing to import from this source.', 'لا شيءَ للاستيراد من هذا المصدر.'))); root.append(section); return; }
    const tools = el('div', 'nmi-toolbar'); const count = el('span', 'nmi-count');
    const save = btn('', () => {
      const items = kept().map(item => ({text:item.text, agent:item.agent, origin:item.origin, category:item.category, sensitive:item.sensitive}));
      if (!items.length) return;
      if (items.length > SAVE_MAX) { st.error = t(`Save up to ${SAVE_MAX} items at a time.`, `احفظ حتى ${SAVE_MAX} بند في المرّة.`); draw(); return; }
      send({kind:'memory-import-save', items, scope:st.scope, maskEmails:st.maskEmails}, t('Saving to memory…', 'جارٍ الحفظ في الذاكرة…'));
    }, 'primary');
    const sync = () => { const n = kept().length; count.textContent = t(`${n} of ${st.review.length} kept`, `${n} من ${st.review.length} مُبقاة`); save.textContent = t(`Save selected (${n})`, `حفظ المحدَّد (${n})`); save.disabled = n === 0 || n > SAVE_MAX || !!st.busy; };
    tools.append(btn(t('Keep all', 'إبقاء الكلّ'), () => { st.review.forEach(i => { i.keep = true; }); draw(); }), btn(t('Discard all', 'استبعاد الكلّ'), () => { st.review.forEach(i => { i.keep = false; }); draw(); }), count);
    section.append(tools);
    const list = el('div', 'nmi-items');
    for (const item of st.review) {
      const row = el('article', 'nmi-item' + (item.keep ? '' : ' discarded'));
      const box = el('input'); box.type = 'checkbox'; box.checked = item.keep; box.title = t('Keep', 'إبقاء');
      box.onchange = () => { item.keep = box.checked; row.classList.toggle('discarded', !item.keep); sync(); };
      const main = el('div', 'nmi-item-main');
      const text = user(el('textarea', 'nmi-item-text')); text.rows = Math.min(6, Math.max(1, Math.ceil(item.text.length / 90))); text.maxLength = 2000; text.value = item.text;
      text.oninput = () => { item.text = text.value; };
      const meta = el('div', 'nmi-item-meta');
      meta.append(el('span', 'nss-status', AGENT_LABEL[item.agent] || item.agent), user(el('small', 'nmi-origin', item.origin)));
      if (item.redactions) meta.append(el('span', 'nss-status nmi-masked', t(`${item.redactions} masked`, `حُجب ${item.redactions}`)));
      if (item.sensitive) meta.append(el('span', 'nss-status nss-status-warning', t('Sensitive? saved as sensitive if kept', 'حسّاس؟ يُحفظ حسّاساً إن أبقيته')));
      const category = el('select', 'nmi-category'); for (const [id, en, ar] of [['profile', 'Profile', 'ملفّي'], ['topic', 'Topics', 'المواضيع'], ['area', 'Areas', 'المجالات'], ['person', 'People', 'الأشخاص']]) { const o = el('option', '', t(en, ar)); o.value = id; category.append(o); }
      category.value = item.category; category.onchange = () => { item.category = category.value; }; meta.append(category);
      main.append(text, meta); row.append(box, main); list.append(row);
    }
    section.append(list);
    const foot = el('div', 'nmi-footer');
    const scope = el('select'); for (const [id, en, ar] of [['user', 'All projects (recommended)', 'كلّ المشاريع (موصى به)'], ['project', 'This project only', 'هذا المشروع فقط']]) { const o = el('option', '', t(en, ar)); o.value = id; scope.append(o); }
    scope.value = st.scope; scope.onchange = () => { st.scope = scope.value; };
    foot.append(el('span', 'nmi-count', t('Save to', 'الحفظ في')), scope, save);
    section.append(foot, el('p', 'nmi-note', t('Nothing has been saved yet. Imported items are written as owner memory notes (with their source and time) and reach the agent the same way your other memory notes do.', 'لم يُحفظ شيءٌ بعد. البنودُ المستوردة تُكتب ملاحظاتِ مالكٍ (بمصدرها ووقتها) وتصل الوكيلَ بالطريق نفسه الذي تصله به ملاحظاتُ ذاكرتك الأخرى.')));
    root.append(section); sync();
  }

  function drawResult(root) {
    const r = st.result; const box = el('div', 'nmi-result');
    box.append(el('strong', '', t(`Saved ${r.saved.length} to ${r.scope === 'project' ? 'this project' : 'all projects'}${r.skipped.length ? `, skipped ${r.skipped.length}` : ''}.`, `حُفظ ${r.saved.length} في ${r.scope === 'project' ? 'هذا المشروع' : 'كلّ المشاريع'}${r.skipped.length ? `، وتُخطّي ${r.skipped.length}` : ''}.`)));
    for (const s of r.skipped.slice(0, 20)) box.append(user(el('p', 'nmi-note', `${s.text} — ${s.why}`)));
    box.append(btn(t('Open Memory', 'افتح صفحة الذاكرة'), () => api.native?.settings?.('memory')));
    root.append(box);
  }

  function frame(f) {
    if (!f || typeof f.kind !== 'string') return;
    if (f.kind === 'memory-import-sources') { st.busy = ''; st.sources = Array.isArray(f.sources) ? f.sources : []; const paths = new Set(st.sources.map(s => s.path)); for (const p of [...st.picked]) if (!paths.has(p)) st.picked.delete(p); draw(); }
    else if (f.kind === 'memory-import-review') { st.busy = ''; st.review = (Array.isArray(f.items) ? f.items : []).map(item => ({...item, keep:!item.sensitive})); st.found = Array.isArray(f.found) ? f.found : []; st.dropped = f.dropped || null; st.truncated = !!f.truncated; draw(); }
    else if (f.kind === 'memory-import-saved') { st.busy = ''; st.result = {saved:f.saved || [], skipped:f.skipped || [], scope:f.scope}; st.review = null; st.found = []; draw(); api.bridge.notice?.(t(`Imported ${(f.saved || []).length} memory notes.`, `استُورد ${(f.saved || []).length} من ملاحظات الذاكرة.`)); }
    else if (f.kind === 'refused' && st.busy && /^(استيراد الذاكرة|انتظر انتهاء الدور قبل تعديل الذاكرة)/u.test(String(f.why || ''))) { st.busy = ''; st.error = String(f.why); draw(); }
  }

  return {render, frame};
}
