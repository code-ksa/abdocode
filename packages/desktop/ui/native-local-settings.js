// Local settings use native persistence and the existing engine contracts.
export function mountLocalSettings(api) {
  const {bridge}=api, L=(en,ar)=>api.L(en,ar);
  const make=(tag,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
  let profile=null, profileDraft=null, diagnostics=null, loading=false, disposed=false;
  const activeTurns=new Set(), notified=new Set();
  function panel(id,title){const p=document.querySelector(`#settings [data-panel="${id}"]`);if(p)p.replaceChildren(make('h3',title));return p;}
  const note=(p,en,ar)=>p.append(make('p',L(en,ar),'nss-description'));
  function row(p,label,detail,control){const r=make('div','','nss-action-row'),c=make('div');c.append(make('strong',label),make('small',detail));r.append(c,control);p.append(r);}
  function action(p,label,detail,run){const b=make('button',L('Open','فتح'),'nss-action');b.type='button';b.onclick=async()=>{b.disabled=true;try{await run();}catch(e){api.reportError(e);}finally{b.disabled=false;}};row(p,label,detail,b);return b;}
  function toggle(p,label,detail,checked,run){const input=make('input');input.type='checkbox';input.checked=checked;input.onchange=async()=>{input.disabled=true;try{await run(input.checked);}catch(e){input.checked=!input.checked;api.reportError(e);}finally{input.disabled=false;}};row(p,label,detail,input);}
  function render(){
    if(disposed)return;
    const snap=bridge.snapshot();
    let p=panel('nss-account',L('Local profile','الملف الشخصي المحلي'));
    if(p){note(p,'This profile belongs to this installation. Your provider accounts are configured separately.','هذا الملف يخص هذا التثبيت. تُضبط حسابات المزوّدين على حدة.');
      const form=make('form','','nls-profile-form'),label=make('label',L('Display name','الاسم الظاهر')),input=make('input');input.id='local-display-name';input.maxLength=80;input.value=profileDraft??profile?.displayName??'';input.oninput=()=>profileDraft=input.value;input.placeholder='AbdoCode';input.autocomplete='nickname';label.append(input);const save=make('button',L('Save profile','حفظ الملف'),'nss-action primary');save.type='submit';form.append(label,save);
      form.onsubmit=async e=>{e.preventDefault();save.disabled=true;try{profile=await bridge.invoke('local_profile_set',{profile:{displayName:input.value.trim()}});profileDraft=null;applyProfile();bridge.notice(L('Local profile saved.','حُفظ الملف الشخصي المحلي.'));}catch(err){api.reportError(err);}finally{save.disabled=false;}};p.append(form);
      action(p,L('Provider accounts','حسابات المزوّدين'),L('Manage credentials and test connections.','إدارة بيانات الاعتماد واختبار الاتصال.'),()=>api.native.settings('providers'));
      p.append(make('p',L('Profile directory: ','مجلد الملف: ')+(diagnostics?.profileDirectory||L('Loading…','جارٍ التحميل…')),'nls-path'));
    }
    p=panel('nss-privacy',L('Privacy & local data','الخصوصية والبيانات المحلية'));
    if(p){note(p,'Choose what the agent may recall. Permission changes apply to the next request and are confirmed by the engine.','اختر ما يستطيع الوكيل استرجاعه. تسري تغييرات الصلاحيات على الطلب التالي ويؤكدها المحرك.');
      toggle(p,L('Automatic context compaction','الضغط التلقائي للسياق'),L('When the conversation grows, older turns are folded into a receipt-verified summary and the recent ones stay whole; a 🧹 line announces each compaction. Type «compact» in chat to compact now.','حين تتضخّم المحادثة تُطوى الأدوار القديمة إلى خلاصةٍ موثَّقة بالإيصالات وتبقى الأحدث كاملة؛ سطر 🧹 يعلن كلّ ضغط. اكتب «compact» في الشات للضغط الآن.'),snap.settings.autoCompact!==false,v=>api.applyRuntimeSettings({autoCompact:v}));
      // سقفُ الدور (09-13): كان متغيّرَ بيئةٍ خفيّاً على جهاز المطوّر (150k) — صار إعداداً يراه المستخدم؛ 0 = بلا سقف، فارغ = الافتراض 400,000.
      {const cap=make('input');cap.type='number';cap.min='0';cap.step='10000';cap.placeholder='400000';cap.value=typeof snap.settings.turnTokenCap==='number'?String(snap.settings.turnTokenCap):'';cap.onchange=async()=>{cap.disabled=true;try{const v=cap.value.trim()===''?undefined:Number(cap.value);if(v!==undefined)await api.applyRuntimeSettings({turnTokenCap:v});}catch(e){api.reportError(e);}finally{cap.disabled=false;}};row(p,L('Per-turn token cap','سقف الدور بالتوكن'),L('Effective tokens one turn may spend before an honest stop (0 = no cap; empty = 400,000 default or ABDO_TURN_TOKEN_CAP). Resume a stopped turn with «اكمل».','التوكن الفعّال الذي يُنفقه دورٌ واحد قبل توقّفٍ صادق (0 = بلا سقف؛ فارغ = الافتراض 400,000 أو متغيّر البيئة). استأنف الدورَ الموقوف بـ«اكمل».'),cap);}
      toggle(p,L('Notify when a turn stops','إشعار عند توقّف الدور'),L('A Windows notification when the agent finishes or needs you while the window is in the background.','إشعارُ ويندوز حين ينتهي الوكيل أو يحتاجك والنافذةُ في الخلفيّة.'),snap.settings.turnNotifications!==false,v=>api.applyRuntimeSettings({turnNotifications:v}));
      toggle(p,L('Session affinity for provider caching','تثبيتُ الجلسة عند المزوّد'),L('Sends an opaque per-conversation token (a hash, never the transcript) with each cloud request so the provider can route it to the same prompt cache. Turn off to send nothing.','يرسل رمزاً مبهماً لكلّ محادثة (بصمةٌ لا نصّ) مع كلّ طلبٍ سحابيّ كي يوجّهه المزوّد إلى الذاكرة المؤقّتة نفسها. أطفئه فلا يُرسَل شيء.'),snap.settings.sessionAffinity!==false,v=>api.applyRuntimeSettings({sessionAffinity:v}));
      toggle(p,L('Check for updates at startup','التحقّق من التحديثات عند التشغيل'),L('Reads the published version document from the distribution repository once per launch (a network request). Help ▸ Check for updates always works.','يقرأ وثيقةَ الإصدار المنشورة من مستودع التوزيع مرّةً عند كلّ تشغيل (طلبُ شبكة). «مساعدة ▸ التحقّق من التحديثات» يعمل دائماً.'),snap.settings.updateCheckEnabled!==false,v=>api.applyRuntimeSettings({updateCheckEnabled:v}));
      toggle(p,L('Search and reference local conversations','البحث والرجوع إلى المحادثات المحلية'),L('Controls past-conversation context and recall. Current conversation and explicit owner notes remain available.','يتحكم في استرجاع سياق المحادثات السابقة. تظل المحادثة الحالية وملاحظات المالك الصريحة متاحة.'),snap.settings.memorySearchEnabled!==false,v=>api.applyRuntimeSettings({memorySearchEnabled:v}));
      toggle(p,L('Semantic memory search','البحث الدلالي في الذاكرة'),L('Matches meaning using your selected model. Eligible memory excerpts are sent to that provider and count against usage.','يطابق المعنى بالنموذج المختار. تُرسل مقاطع الذاكرة المسموحة للمزوّد وتُحسب ضمن الاستخدام.'),snap.settings.semanticMemoryEnabled!==false,v=>api.applyRuntimeSettings({semanticMemoryEnabled:v}));
      toggle(p,L('Learn corrections from your messages','تعلّم التصحيحات من رسائلك'),L('Plain “use X instead of Y” messages become unconfirmed project memory you can confirm or forget in Memory & awareness.','رسائل «استخدم كذا بدل كذا» تصير ذاكرة مشروع غير مؤكَّدة تؤكّدها أو تنساها في صفحة الذاكرة والوعي.'),snap.settings.inferredMemoryEnabled!==false,v=>api.applyRuntimeSettings({inferredMemoryEnabled:v}));
      toggle(p,L('Allow explicit sensitive memory notes','السماح بملاحظات ذاكرة حساسة صريحة'),L('Only owner-authored notes marked as sensitive.','ملاحظات المالك المصنفة حساسة صراحة فقط.'),snap.settings.sensitiveMemoryEnabled===true,v=>api.applyRuntimeSettings({sensitiveMemoryEnabled:v}));
      action(p,L('Review or forget memory notes','مراجعة ملاحظات الذاكرة أو نسيانها'),L('Select individual notes in Memory & awareness.','اختر الملاحظات منفردة في صفحة الذاكرة والوعي.'),()=>api.native.settings('memory'));
      action(p,L('Export displayed conversation','تصدير المحادثة المعروضة'),L('Save the loaded transcript as text. Older unloaded messages and vault credentials are not included.','احفظ نص الرسائل المحمّلة. الرسائل الأقدم غير المحمّلة وبيانات الخزنة لا تُضمّن.'),async()=>{
        const text=[...document.querySelectorAll('#feed .block')].map(b=>b.textContent.trim()).filter(Boolean).join('\n\n———\n\n');
        if(!text)throw Error(L('Open a conversation with messages first.','افتح محادثة تحتوي على رسائل أولًا.'));
        await bridge.invoke('local_export_text',{kind:'conversation',text});
      });
      action(p,L('Execution permissions','صلاحيات التنفيذ'),L('Review filesystem, tools and browser access.','راجع صلاحيات الملفات والأدوات والمتصفح.'),()=>api.native.settings('permissions'));
      if(diagnostics){const list=make('div','','nls-storage');for(const file of diagnostics.files||[])list.append(make('p',`${file.name} · ${file.exists?Number(file.bytes||0).toLocaleString()+' bytes':L('Not created','غير منشأ')}`));p.append(list);}
    }
    p=panel('nss-developer',L('Developer diagnostics','تشخيص المطوّر'));
    if(p){note(p,'This report contains build, process and file-size metadata. It excludes keys, prompts, tool output and settings contents.','يحتوي التقرير على بيانات الإصدار والعملية وأحجام الملفات. يستبعد المفاتيح والرسائل ومخرجات الأدوات ومحتويات الإعدادات.');
      p.append(make('pre',diagnostics?JSON.stringify(diagnostics,null,2):L('Loading…','جارٍ التحميل…'),'nls-diagnostics'));
      action(p,L('Refresh diagnostics','تحديث التشخيص'),L('Read the running native process now.','اقرأ حالة العملية الأصلية الآن.'),refresh);
      action(p,L('Export diagnostics','تصدير التشخيص'),L('Choose where to save the metadata report.','اختر مكان حفظ تقرير البيانات.'),()=>bridge.invoke('local_export_diagnostics'));
      action(p,L('Runtime settings','إعدادات التشغيل'),L('Configure the existing engine.','اضبط المحرك الحالي.'),()=>api.native.settings('runtime'));
    }
    let host=document.querySelector('#settings [data-panel="general"] .nls-notifications');
    if(!host){host=make('div','','nls-notifications');document.querySelector('#settings [data-panel="general"]')?.append(host);}
    host.replaceChildren(make('h3',L('Notifications & sounds','الإشعارات والأصوات')));
    for(const [event,en,ar]of [['agent','Turn finished','انتهاء الدور'],['permission','Approval requested','طلب الموافقة'],['error','Error or unresolved turn','خطأ أو دور غير محسوم']]){
      for(const [group,label]of [['notifications',L('Notify: ','إشعار: ')],['sounds',L('Sound: ','صوت: ')]])toggle(host,label+L(en,ar),group==='notifications'?L('In-app notice and Windows taskbar attention when unfocused.','تنبيه داخل التطبيق ولفت الانتباه في شريط Windows عندما تكون النافذة بالخلفية.'):L('Use the Windows system sound.','استخدام صوت نظام Windows.'),!!snap.shell[group]?.[event],async value=>{
        const current=bridge.snapshot().shell;await bridge.saveShellSettings({...current,[group]:{...current[group],[event]:value}});
      });
    }
    action(host,L('Test approval signal','اختبار تنبيه الموافقة'),L('Uses your saved notification and sound preferences.','يستخدم تفضيلات الإشعار والصوت المحفوظة.'),()=>signal('permission',L('Approval notification test','اختبار إشعار الموافقة')));
    const reset=document.getElementById('settingsreset');if(reset){reset.textContent=L('Reset interface settings','إعادة ضبط إعدادات الواجهة');reset.title=L('Resets language, appearance, shortcuts and notification preferences.','يعيد ضبط اللغة والمظهر والاختصارات وتفضيلات الإشعارات.');}
    const reasoning=document.getElementById('setreasoning')?.closest('.setting-row')?.querySelector('label');if(reasoning)reasoning.textContent=L('Show execution summaries','عرض ملخصات التنفيذ');
    applyProfile();
  }
  function applyProfile(){document.querySelectorAll('[data-local-profile-name]').forEach(n=>{n.textContent=profile?.displayName||'AbdoCode';n.dir='auto';});}
  async function refresh(){if(loading)return;loading=true;try{[profile,diagnostics]=await Promise.all([bridge.invoke('local_profile_get'),bridge.invoke('local_diagnostics')]);render();}catch(e){api.reportError(e);}finally{loading=false;}}
  async function signal(event,message){if(bridge.snapshot().shell.notifications?.[event])bridge.notice(message);try{await bridge.invoke('desktop_signal',{event});}catch(e){console.warn('Desktop signal unavailable',String(e));}}
  function frame(f){
    if(['admission','accepted','delta','tool'].includes(f.kind)&&f.turnId)activeTurns.add(f.turnId);
    const event=['approval','trust-request'].includes(f.kind)?'permission':['refused','unresolved'].includes(f.kind)?'error':f.kind==='done'&&activeTurns.has(f.turnId)?'agent':null;
    if(event){const key=`${f.kind}:${f.turnId||''}`;if(event!=='agent'||!notified.has(key)){if(event==='agent')notified.add(key);if(notified.size>300)notified.delete(notified.values().next().value);void signal(event,event==='permission'?L('AbdoCode needs your approval.','عبدو كود يحتاج موافقتك.'):event==='error'?(f.why||L('AbdoCode could not complete the request. Open the conversation for details.','تعذر إكمال الطلب. افتح المحادثة للتفاصيل.')):L('AbdoCode finished the turn.','أنهى عبدو كود الدور.'));}}
    if(['done','unresolved','refused'].includes(f.kind))activeTurns.delete(f.turnId);
  }
  const opened=e=>{if(['nss-account','nss-privacy','nss-developer'].includes(e.detail?.id))void refresh();};
  document.addEventListener('abdocode:settings-rendered',render);document.addEventListener('abdocode:settings-opened',opened);
  render();void refresh();
  return {frame,refresh,settingsApplied:render,dispose(){disposed=true;document.removeEventListener('abdocode:settings-rendered',render);document.removeEventListener('abdocode:settings-opened',opened);}};
}
