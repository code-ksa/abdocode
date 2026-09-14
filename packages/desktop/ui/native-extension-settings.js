import { EXTENSION_DOWNLOADS } from "./extension-downloads.js";
import { MARKETPLACE_CATALOGUE, mergeMarket } from "./marketplace-catalogue.js";
/* Local packages use native storage and the engine's existing MCP connection path. */
const element=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const userText=n=>{n.dataset.userContent='';return n;};
export function mountExtensionSettings(api){
  let catalog=null,servers=[],busy=false,loading=false,error='',query='',dialog=null,disposed=false;
  let bundled=[];// الحزمُ المضمَّنة مع عبدو كود — من إطار extensions-bundled
  let bundledAsked=false;// مقيس 2026-09-13: اللوحةُ تُرسم قبل وصول الإطار فتقول «0 حزم» حتى يُطلب من جديد — الرسمُ الأوّل يطلبها بنفسه
  // السوق (أمر المالك 09-14): بذرةٌ مشحونة + فهرسٌ بعيد يُدمَج فوقها عند الطلب؛ كلُّ مدخلٍ يمرّ بمسار التنزيل المتحقِّق نفسِه.
  let market=mergeMarket(MARKETPLACE_CATALOGUE,[]),marketNote='',marketFilter='all',marketQuery='',marketBusy=false;
  let language=api.bridge.snapshot?.().settings?.language==='ar'?'ar':'en';
  const live=new Map(),hosts=new Map();
  const t=(en,ar)=>language==='ar'?ar:en;
  const button=(text,run,cls='')=>{const b=element('button','nex-button '+cls,text);b.type='button';b.disabled=busy;b.onclick=run;return b;};
  const notice=text=>api.bridge.notice?.(text);
  const showError=e=>{error=String(e);notice(t('Could not complete the extension action. ','تعذر إكمال إجراء الإضافة. ')+error);redraw();};
  const notifyChanged=()=>api.onChange?.();
  async function refresh(){
    if(loading||disposed)return;loading=true;
    try{catalog=await api.bridge.invoke('extensions_list');error='';}catch(e){error=String(e);}finally{loading=false;redraw();notifyChanged();}
    try{await api.bridge.send({kind:'extensions-bundled-list'});}catch{}
  }
  async function mutate(command,args){
    if(busy)return;busy=true;error='';redraw();
    try{
      catalog=await api.bridge.invoke(command,{...args,expectedRevision:catalog?.revision??0});
      // The engine acknowledges current registry metadata and closes invalidated
      // managed MCP connections before handling this settings request.
      await api.bridge.send({kind:'settings-get'});
      notifyChanged();return true;
    }catch(e){showError(e);await refresh();return false;}finally{busy=false;redraw();}
  }
  function closeDialog(){if(!dialog)return;const focus=dialog._returnFocus;dialog.remove();dialog=null;focus?.focus?.();}
  function modal(title){
    closeDialog();const backdrop=element('div','nex-backdrop');const box=element('section','nex-dialog');box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');box.setAttribute('aria-label',title);box.tabIndex=-1;
    const head=element('header','nex-dialog-head');head.append(element('h2','',title),button(t('Close','إغلاق'),closeDialog));box.append(head);backdrop.append(box);backdrop._returnFocus=document.activeElement;
    backdrop.onclick=e=>{if(e.target===backdrop&&!busy)closeDialog();};backdrop.onkeydown=e=>{if(e.key==='Escape'&&!busy){e.preventDefault();closeDialog();}if(e.key==='Tab'){const items=[...box.querySelectorAll('button:not(:disabled),input,summary,[tabindex="0"]')];const first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};
    document.body.append(backdrop);dialog=backdrop;box.focus();return box;
  }
  function showFormat(){
    const box=modal(t('Supported local packages','الحزم المحلية المدعومة'));
    box.append(element('p','',t('Import a folder containing SKILL.md, or a folder with abdocode-extension.json. Review the content, install a private copy, then enable it. Scripts are never run during import or installation.','استورد مجلدًا يحتوي SKILL.md أو ملف abdocode-extension.json. راجع المحتوى ثم ثبّت نسخة خاصة وفعّلها. لا تُشغّل السكربتات أثناء الاستيراد أو التثبيت.')));
    box.append(element('pre','nex-code',JSON.stringify({schemaVersion:1,id:'my-tools',name:'My tools',version:'1.0.0',skills:['skills/review'],mcpServers:[{id:'local',command:['node','${extension}/server.js'],secrets:[{env:'ABDO_EXT_TOKEN',handle:'custom-my-tools-token'}]}]},null,2)));
    box.append(element('p','nex-muted',t('Skill names must be lowercase slugs in the YAML header. Bundle paths are relative. Commands use ${extension}/ for bundled files. Credentials use vault handles only; enter values separately after installation. Maximum: 256 files, 16 MB, 24 skills and 12 MCP servers. GitHub downloads require a commit URL and SHA-256. Archives, install scripts and arbitrary environment variables are not supported.','يُكتب اسم المهارة بحروف لاتينية صغيرة في ترويسة YAML. المسارات نسبية، وتستخدم الأوامر ${extension}/ لملفات الحزمة. تُسجّل مقابض الخزنة فقط؛ أدخل القيم بصورة منفصلة بعد التثبيت. الحد: 256 ملفًا و16 ميجابايت و24 مهارة و12 خادم MCP. يتطلب تنزيل GitHub رابط إصدار ثابت وبصمة SHA-256. الأرشيفات وسكربتات التثبيت ومتغيرات البيئة العشوائية غير مدعومة.')));
  }
  async function importPackage(kind){
    if(busy)return;
    try{
      const sourcePath=await api.bridge.invoke('extensions_choose',{kind});if(!sourcePath)return;
      busy=true;redraw();let preview;try{preview=await api.bridge.invoke('extensions_preview',{sourcePath});}finally{busy=false;redraw();}
      reviewPackage(preview);
    }catch(e){busy=false;showError(e);}
  }
  function reviewPackage(preview){
      const box=modal(t('Review package','راجع الحزمة'));const p=preview.package;
      box.append(userText(element('h3','',p.name+' · '+p.version)),userText(element('p','',p.description)),element('p','nex-muted',t(`${preview.fileCount} files · ${(preview.totalBytes/1024).toFixed(1)} KB · installs disabled`,`${preview.fileCount} ملفًا · ${(preview.totalBytes/1024).toFixed(1)} كيلوبايت · تُثبّت معطلة`)));
      for(const skill of preview.skillPreviews||[]){const details=element('details','nex-preview-skill');details.append(userText(element('summary','',skill.id)),userText(element('pre','nex-code',skill.text)));box.append(details);}
      for(const s of p.mcpServers||[]){box.append(userText(element('h4','',s.id)),userText(element('pre','nex-code',s.command.map(part=>JSON.stringify(part)).join(' '))));if(s.secrets?.length)box.append(userText(element('p','nex-muted',s.secrets.map(g=>g.env+' → '+g.handle).join('\n'))));}
      box.append(element('p','nex-muted',t('Installing saves this reviewed copy only. Enabling makes skills selectable and MCP definitions available; each MCP connection is still started explicitly.','يحفظ التثبيت النسخة التي راجعتها فقط. يتيح التفعيل اختيار المهارات وتعريفات MCP؛ ويبدأ اتصال كل خادم بطلب صريح.')));
      const install=button(t('Install local copy','تثبيت نسخة محلية'),async()=>{install.disabled=true;const done=await mutate('extensions_install',{token:preview.token});if(done){closeDialog();notice(t('Installed. Enable the package when you want to use it.','تم التثبيت. فعّل الحزمة عندما تريد استخدامها.'));}else install.disabled=false;},'primary');box.append(install);
  }
  function downloadDialog(){
    const box=modal(t('Download from GitHub','تنزيل من GitHub'));
    box.append(element('p','nex-muted',t('Review a pinned release before installing. Downloading does not run code or connect accounts. For a private repository, opt in to your existing GitHub CLI sign-in or import an authorized local copy.','راجع إصدارًا ثابتًا قبل التثبيت. لا يشغّل التنزيل كودًا ولا يربط حسابات. للمستودعات الخاصة، اختر استخدام تسجيل دخول GitHub CLI الموجود لديك أو استورد نسخة محلية مصرحًا بها.')));
    const url=element('input','nex-search');url.dir='ltr';url.placeholder='https://raw.githubusercontent.com/owner/repo/COMMIT/package.json';url.setAttribute('aria-label',t('Package URL','رابط الحزمة'));
    const hash=element('input','nex-search');hash.dir='ltr';hash.placeholder='SHA-256';hash.setAttribute('aria-label','SHA-256');
    for(const entry of EXTENSION_DOWNLOADS){box.append(button(entry.name,()=>{url.value=entry.url;hash.value=entry.sha256;}));}
    const authLabel=element('label','nex-enabled');const auth=element('input');auth.type='checkbox';authLabel.append(auth,element('span','',t('Use my GitHub CLI sign-in (private repository)','استخدام تسجيل دخول GitHub CLI الخاص بي (مستودع خاص)')));
    const download=button(t('Download and review','تنزيل ومراجعة'),async()=>{
      download.disabled=true;
      try{const preview=await api.bridge.invoke('extensions_download',{url:url.value.trim(),sha256:hash.value.trim(),githubAuth:auth.checked});reviewPackage(preview);}catch(e){showError(e);download.disabled=false;}
    },'primary');box.append(url,hash,authLabel,download);
  }
  async function refreshMarket(){
    if(marketBusy)return;marketBusy=true;marketNote=t('Fetching the marketplace index…','جارٍ جلب فهرس السوق…');redraw();
    try{const index=await api.bridge.invoke('marketplace_index');const merged=mergeMarket(MARKETPLACE_CATALOGUE,index?.entries);const added=merged.length-market.length;market=merged;
      marketNote=t(`Marketplace index loaded: ${merged.length} packages (${index?.dropped??0} rejected entries).`,`حُمِّل فهرس السوق: ${merged.length} حزمة (${index?.dropped??0} مدخلاً مرفوضاً).`)+(added>0?' +'+added:'');}
    catch(e){marketNote=t('Bundled marketplace only — ','السوق المشحونة فقط — ')+String(e);}
    finally{marketBusy=false;redraw();}
  }
  function marketInstall(entry){
    if(busy||marketBusy)return;busy=true;redraw();
    api.bridge.invoke('extensions_download',{url:entry.url,sha256:entry.sha256,githubAuth:false}).then(preview=>{busy=false;reviewPackage(preview);}).catch(e=>{busy=false;showError(e);});
  }
  function drawMarket(host,section){
    const installed=new Set((catalog?.packages||[]).map(p=>p.id));
    const box=element('section','nex-market');const head=element('div','nex-market-head');head.append(element('h3','',t('Marketplace — free for everyone','السوق — مجّاني للجميع')),button(t('Refresh marketplace','تحديث السوق'),refreshMarket));box.append(head);
    box.append(element('p','nex-muted',t('Skills and MCP packages published by code-ksa, pinned to a commit and a SHA-256. Download, review the exact content, install a private copy, then enable it. Nothing runs during download or installation.','مهاراتٌ وحزمُ MCP تنشرها code-ksa مثبَّتةً إلى كوميت وبصمة SHA-256. نزّل، راجع المحتوى بعينه، ثبّت نسخةً خاصّة، ثم فعّلها. لا يُشغَّل شيءٌ أثناء التنزيل أو التثبيت.')));
    if(marketNote)box.append(element('p','nex-muted nex-market-note',marketNote));
    const bar=element('div','nex-market-bar');
    for(const [key,en,ar]of[['all','All','الكل'],['skills','Skills','مهارات'],['mcp','MCP servers','خوادم MCP']]){const chip=button(t(en,ar),()=>{marketFilter=key;redraw();},'chip'+(marketFilter===key?' on':''));chip.setAttribute('aria-pressed',String(marketFilter===key));bar.append(chip);}
    const search=element('input','nex-search nex-market-search');search.type='search';search.value=marketQuery;search.placeholder=t('Search the marketplace','ابحث في السوق');search.setAttribute('aria-label',search.placeholder);bar.append(search);box.append(bar);
    const grid=element('div','nex-bundled-grid nex-market-grid');box.append(grid);
    const render=()=>{
      grid.replaceChildren();const q=marketQuery.trim().toLowerCase();
      const entries=market.filter(e=>(section!=='skills'||(e.skills||[]).length)&&(marketFilter==='all'||(marketFilter==='skills'?(e.skills||[]).length>0:e.kind!=='skills'))&&(!q||[e.id,e.name,e.nameAr,e.description,e.descriptionAr,...(e.tags||[]),...(e.skills||[])].join(' ').toLowerCase().includes(q)));
      if(!entries.length){grid.append(element('p','nex-empty',t('No marketplace packages match.','لا حزمَ في السوق تطابق البحث.')));return;}
      for(const e of entries){const card=element('article','nex-package nex-bundled-card nex-market-card');const top=element('div','nex-package-head');top.append(userText(element('strong','',language==='ar'&&e.nameAr?e.nameAr:e.name)),element('span','nex-muted',(e.kind==='skills'?t('skills','مهارات'):e.kind==='mcp'?'MCP':t('skills + MCP','مهارات + MCP'))+' · '+t('free','مجّاني')));card.append(top);
        card.append(userText(element('p','nex-muted',language==='ar'&&e.descriptionAr?e.descriptionAr:e.description)));
        const meta=[];if((e.skills||[]).length)meta.push(e.skills.slice(0,6).map(s=>'/'+s).join(' · ')+(e.skills.length>6?' · +'+(e.skills.length-6):''));if(e.requires)meta.push(t('Requires ','يتطلّب ')+e.requires);if(e.publisher)meta.push('@'+e.publisher+(e.commit?' · '+e.commit.slice(0,7):''));
        card.append(userText(element('small','nex-muted',meta.join('  |  '))));
        if(installed.has(e.id)){const done=element('span','nex-market-installed',t('Installed','مثبَّتة'));card.append(done);}
        else{const get=button(t('Download and review','نزّل وراجع'),()=>marketInstall(e),'primary');get.disabled=busy||marketBusy;card.append(get);}
        grid.append(card);}
    };search.oninput=()=>{marketQuery=search.value;render();};render();
    host.append(box);
  }
  function useSkill(ref){
    api.showPage?.('session');
    const input=document.getElementById('prompt');if(!input){notice(t('Open a conversation to use this skill.','افتح محادثة لاستخدام هذه المهارة.'));return;}
    const prefix='/skill '+ref+'\n';if(!input.value.startsWith(prefix))input.value=prefix+input.value;
    input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('settingsclose')?.click();closeDialog();input.focus();
  }
  async function connect(server){
    if(!api.bridge.pluginOn?.('mcpClient')){notice(t('Enable the MCP client in Plugins before connecting.','فعّل عميل MCP من الإضافات قبل الاتصال.'));api.native?.settings?.('plugins');return;}
    try{await api.bridge.send(live.has(server.id)?{kind:'external-disconnect',id:server.id}:{kind:'external-connect',id:server.id,command:server.command,protocol:'mcp'});}catch(e){showError(e);}
  }
  function remove(p){
    const box=modal(t('Remove local package','إزالة الحزمة المحلية'));
    box.append(userText(element('h3','',p.name)),element('p','',t('Remove the installed copy and disable its skills and MCP connections. The source folder and existing vault credentials are kept.','تُزال النسخة المثبتة وتُعطّل مهاراتها واتصالات MCP. يبقى مجلد المصدر والاعتمادات الموجودة في الخزنة.')));
    box.append(button(t('Remove package','إزالة الحزمة'),async()=>{if(await mutate('extensions_remove',{id:p.id})){closeDialog();notice(t('Package removed.','أُزيلت الحزمة.'));}},'danger'));
  }
  function credentials(server){
    const box=modal(t('MCP credentials','اعتمادات MCP'));box.append(userText(element('h3','',server.id)),element('p','nex-muted',t('Values go directly to the existing native vault and are never read back into this page.','تذهب القيم مباشرة إلى الخزنة الأصلية ولا تُقرأ مرة أخرى في هذه الصفحة.')));
    for(const grant of server.secrets||[]){const row=element('form','nex-credential');row.append(userText(element('label','',grant.env+' → '+grant.handle)));const input=element('input');input.type='password';input.autocomplete='new-password';input.maxLength=8192;input.setAttribute('aria-label',grant.env);const save=button(t('Save credential','حفظ الاعتماد'),()=>{});save.type='submit';row.append(input,save);row.onsubmit=async e=>{e.preventDefault();if(!input.value)return;save.disabled=true;try{await api.bridge.invoke('vault_set',{key:grant.handle,value:input.value});input.value='';notice(t('Credential saved in the vault. Reconnect the server to use it.','حُفظ الاعتماد في الخزنة. أعد اتصال الخادم لاستخدامه.'));}catch{notice(t('Could not save this credential.','تعذر حفظ هذا الاعتماد.'));}finally{save.disabled=false;}};box.append(row);}
  }
  function draw(host,section){
    host.replaceChildren();host.classList.add('nex-manager');
    const toolbar=element('div','nex-toolbar');toolbar.append(button(t('Download from GitHub','تنزيل من GitHub'),downloadDialog),button(t('Import folder','استيراد مجلد'),()=>importPackage('folder'),'primary'),button(t('Import manifest','استيراد ملف تعريف'),()=>importPackage('manifest')),button(t('Refresh','تحديث'),refresh),button(t('Supported format','الصيغة المدعومة'),showFormat));host.append(toolbar);
    host.append(element('p','nex-muted',t('Local packages are stored in this AbdoCode profile. Enable a package, then choose a skill for your next message or connect an MCP server.','تُحفظ الحزم المحلية في ملف AbdoCode الحالي. فعّل الحزمة، ثم اختر مهارة للرسالة التالية أو اتصل بخادم MCP.')));
    if(error){const e=element('p','nex-error',error);e.setAttribute('role','alert');host.append(e);}
    if(!catalog){host.append(element('p','nex-muted',loading?t('Loading installed packages…','جارٍ تحميل الحزم المثبتة…'):t('Installed packages are unavailable.','الحزم المثبتة غير متاحة.')));return;}
    const search=element('input','nex-search');search.type='search';search.value=query;search.placeholder=t('Search installed packages','ابحث في الحزم المثبتة');search.setAttribute('aria-label',search.placeholder);host.append(search);
    // مقيسٌ 2026-09-13 على التطبيق المثبَّت: لوحةُ «المهارات» كانت تقول «لا حزم محلية» بينما ٤١ حزمةً مضمَّنة
    // تُعرض في لوحة «الامتدادات» وحدها — فبدت المهاراتُ غائبةً. المضمَّنةُ التي تحمل مهاراتٍ تُعرض هنا أيضاً.
    if(section==='extensions'||section==='skills'){
      // المضمَّنة مع عبدو كود: ما لم يُثبَّت بعد يُعرض للمراجعة والتثبيت بالمسار المعتاد (extensions_preview ⇦ تثبيت ⇦ تفعيل).
      const installed=new Set((catalog.packages||[]).map(p=>p.id));const pending=bundled.filter(b=>!installed.has(b.id)&&(section!=='skills'||b.skills.length));
      const box=element('section','nex-bundled');box.append(element('h3','',t('Bundled with Abdo Code','المضمَّنة مع عبدو كود')));
      box.append(element('p','nex-muted',t(`${bundled.length} bundles ship with this build; ${pending.length} not installed yet. Review a bundle, install a private copy, then enable it.`,`تُشحن ${bundled.length} حزمةً مع هذا البناء؛ ${pending.length} لم تُثبَّت بعد. راجع الحزمة ثم ثبّت نسخة خاصة ثم فعّلها.`)));
      if(pending.length){const grid=element('div','nex-bundled-grid');
        for(const b of pending){const card=element('article','nex-package nex-bundled-card');const head=element('div','nex-package-head');head.append(userText(element('strong','',b.name)),element('span','nex-muted',b.kind+' · '+b.version));card.append(head,userText(element('p','nex-muted',b.description)));
          card.append(element('small','nex-muted',b.skills.slice(0,6).map(s=>'/'+s.id).join(' · ')+(b.skills.length>6?' · +'+(b.skills.length-6):'')));
          card.append(button(t('Review and install','راجع وثبّت'),async()=>{if(busy)return;busy=true;redraw();try{const preview=await api.bridge.invoke('extensions_preview',{sourcePath:b.path});busy=false;reviewPackage(preview);}catch(e){busy=false;showError(e);}},'primary'));grid.append(card);}
        box.append(grid);}
      host.append(box);
      drawMarket(host,section);
    }
    const list=element('div','nex-list');host.append(list);
    const renderList=()=>{
      list.replaceChildren();const packages=catalog.packages.filter(p=>(section!=='skills'||p.skills.length)&&(!query||(p.id+' '+p.name+' '+p.description+' '+p.skills.map(s=>s.name).join(' ')).toLowerCase().includes(query.toLowerCase())));
      if(!packages.length){list.append(element('p','nex-empty',t('No installed packages match yet. Install a bundle from the list above, download one from GitHub, or import a skill folder or an extension manifest.','لا حزمَ مثبَّتةً مطابقةً بعد. ثبّت حزمةً من القائمة أعلاه، أو نزّل واحدةً من GitHub، أو استورد مجلد مهارة أو ملف تعريف إضافة.')));return;}
      for(const p of packages){const card=element('article','nex-package');const head=element('div','nex-package-head');head.append(userText(element('strong','',p.name)),userText(element('span','nex-muted',p.version)));const toggle=element('input');toggle.type='checkbox';toggle.checked=p.enabled;toggle.disabled=busy;toggle.setAttribute('aria-label',t('Enable ','تفعيل ')+p.name);toggle.onchange=async()=>{await mutate('extensions_set_enabled',{id:p.id,enabled:toggle.checked});};const state=element('label','nex-enabled');state.append(element('span','',p.enabled?t('Enabled','مفعّلة'):t('Disabled','معطلة')),toggle);head.append(state);card.append(head,userText(element('p','nex-muted',p.description)));
        for(const s of p.skills){const row=element('div','nex-skill');const copy=element('div');copy.append(userText(element('strong','',s.name)),userText(element('small','nex-muted',s.description)));const use=button(t('Use in next message','استخدام في الرسالة التالية'),()=>useSkill(p.id+'/'+s.id));use.disabled=busy||!p.enabled;row.append(copy,use);card.append(row);}
        for(const raw of p.mcpServers){const id='ext-'+p.id+'-'+raw.id;const server=servers.find(s=>s.id===id);const row=element('div','nex-server');const title=element('div');title.append(userText(element('strong','',id)),element('small','nex-muted',live.has(id)?t('Connected','متصل'):t('Disconnected','غير متصل')));row.append(title);const connectButton=button(live.has(id)?t('Disconnect','فصل'):t('Connect','اتصال'),()=>server&&connect(server));connectButton.disabled=busy||!p.enabled||!server;row.append(connectButton);if(raw.secrets?.length)row.append(button(t('Credentials','الاعتمادات'),()=>credentials({...raw,id})));card.append(row);}
        card.append(button(t('Remove','إزالة'),()=>remove(p),'quiet'));list.append(card);
      }
    };search.oninput=()=>{query=search.value;renderList();};renderList();
  }
  function redraw(){for(const [host,section]of hosts){if(!host.isConnected){hosts.delete(host);continue;}draw(host,section);}}
  function renderPanel(parent,section='extensions'){let host=parent.querySelector(':scope > .nex-manager');if(!host){host=element('div','nex-manager');parent.append(host);}hosts.set(host,section);if(!bundled.length&&!bundledAsked){bundledAsked=true;api.bridge.send({kind:'extensions-bundled-list'}).catch(()=>{bundledAsked=false;});}draw(host,section);if(!catalog&&!loading)void refresh();}
  function frame(f){if(f.kind==='extensions-bundled'){bundled=Array.isArray(f.entries)?f.entries:[];redraw();return;}if(f.kind==='ready'){live.clear();}if(f.kind==='ready'||f.kind==='settings'){if(f.extensionRegistry)catalog=f.extensionRegistry;servers=Array.isArray(f.extensionMcpServers)?f.extensionMcpServers:[];if(f.extensionRegistry?.error)error=f.extensionRegistry.error;redraw();}if(f.kind==='external'){live.set(f.id,f.tools||[]);redraw();}if(f.kind==='external-gone'){live.delete(f.id);redraw();}}
  function directoryItems(tab){
    if(!catalog)return[];
    if(tab==='skills')return catalog.packages.flatMap(p=>p.skills.map(s=>({title:s.name,detail:s.description,state:p.enabled?t('Enabled','مفعّلة'):t('Disabled','معطلة'),action:p.enabled?t('Use','استخدام'):t('Manage','إدارة'),run:()=>p.enabled?useSkill(p.id+'/'+s.id):api.native?.settings?.('nss-extensions'),user:true})));
    if(tab==='plugins')return catalog.packages.map(p=>({title:p.name,detail:p.description,state:p.enabled?t('Enabled','مفعّلة'):t('Disabled','معطلة'),action:t('Manage','إدارة'),run:()=>api.native?.settings?.('nss-extensions'),user:true}));
    return servers.map(s=>({title:s.id,detail:t('Installed local MCP definition. Connection requires an explicit action.','تعريف MCP محلي مثبت. يحتاج الاتصال إجراءً صريحًا.'),state:live.has(s.id)?t('Connected','متصل'):t('Disconnected','غير متصل'),action:t('Manage','إدارة'),run:()=>api.native?.settings?.('nss-extensions'),user:true}));
  }
  const attach=()=>{for(const [id,section]of[['nss-extensions','extensions'],['skills','skills']]){const parent=document.querySelector(`#settings [data-panel="${id}"]`);if(parent)renderPanel(parent,section);}};
  const opened=e=>{if(['nss-extensions','skills'].includes(e.detail?.id)){attach();void refresh();}};
  document.addEventListener('abdocode:settings-rendered',attach);document.addEventListener('abdocode:settings-opened',opened);attach();
  return {renderPanel,refresh,frame,directoryItems,importPackage,settingsApplied(s){language=s?.language==='ar'?'ar':'en';redraw();},dispose(){disposed=true;document.removeEventListener('abdocode:settings-rendered',attach);document.removeEventListener('abdocode:settings-opened',opened);closeDialog();for(const host of hosts.keys())host.remove();hosts.clear();}};
}
