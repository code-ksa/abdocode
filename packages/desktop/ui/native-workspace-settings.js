import {writeWorkspacePreference} from './workspace-preference-write.js';
/* Native Cowork folders/profiles and the separate controlled browser.
   The embedded browsing pane is never presented as an attached automation surface. */
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
export function surfaceReceiptStatus(command,output){
  if(!/^surface\s/u.test(command||''))return null;
  if(String(output||'').startsWith('فُصل السطح.'))return 'disconnected';
  if(String(output||'').startsWith('وُصل السطح على المنفذ '))return 'connected';
  return 'failed';
}

export function mountWorkspaceSettings(api){
  const L=api.L,bridge=api.bridge;
  let controls=null,browser=null,controlsError='',browserError='',loading=false,browserLoading=false,coworkHost,browserHost,disposed=false,selectedProject='',busy=false;
  let groups=[],connection='unverified',lastUrl='https://example.com',blockedDraft=null,lastChecked='',pendingNavigation=null,pendingNavigationTurn=null,connectionReceipt=false,connectionOutput='';
  const drafts=new Map();
  const snapshot=()=>bridge.snapshot();
  const projects=()=>api.state?.metadata?.projects||[];
  const samePath=(a,b)=>String(a||'').replaceAll('\\','/').replace(/\/+$/u,'').toLowerCase()===String(b||'').replaceAll('\\','/').replace(/\/+$/u,'').toLowerCase();
  const button=(text,run,disabled=false)=>{const b=el('button','nss-action',text);b.type='button';b.disabled=disabled;b.onclick=run;return b;};
  const userText=(tag,text)=>{const n=el(tag,'',text);n.dataset.userContent='';return n;};
  const message=(parent,text)=>parent.append(el('p','nss-summary',text));
  function row(parent,title,detail,control){const wrapper=el('div','nss-pref-row'),copy=el('span');copy.append(el('strong','',title));if(detail)copy.append(el('small','',detail));wrapper.append(copy,control);parent.append(wrapper);return wrapper;}
  function fact(parent,title,value){row(parent,title,'',userText('span',String(value)));}
  function section(host,key){const heading=host.querySelector(':scope > h3');host.replaceChildren(...(heading?[heading]:[]));const body=el('div','nss-workspace-section');body.dataset.workspaceSection=key;host.append(body);return body;}
  function refreshVisible(){if(disposed)return;if(coworkHost?.isConnected)renderCowork(coworkHost);if(browserHost?.isConnected)renderBrowser(browserHost);}
  async function loadControls(){if(loading||disposed)return;loading=true;controlsError='';refreshVisible();try{controls=await bridge.invoke('workspace_controls_get');}catch(error){controlsError=String(error);}finally{loading=false;refreshVisible();}}
  async function loadBrowser(){if(browserLoading||disposed)return;browserLoading=true;browserError='';try{browser=await bridge.invoke('workspace_browser_status');lastChecked=new Date().toLocaleTimeString();if(!browser.ownedProcessRunning||!browser.endpointReady)connection='disconnected';}catch(error){browser=null;browserError=String(error);connection='unverified';}finally{browserLoading=false;refreshVisible();}}
  function draft(project){if(drafts.has(project.id))return drafts.get(project.id);const runtime=snapshot().settings||{},saved=controls?.profiles?.find(profile=>profile.projectId===project.id);const value=saved?{...saved}:{projectId:project.id,chatModel:runtime.chatModel||runtime.model||bridge.providers.DEFAULT_MODEL,agentModel:runtime.agentModel||runtime.model||bridge.providers.DEFAULT_MODEL,mode:runtime.mode||'read-only',computerUseEnabled:runtime.computerUseEnabled!==false};drafts.set(project.id,value);return value;}
  function modelOptions(selected){const ids=new Map();for(const group of groups)for(const id of group.models||[])ids.set(id,id);for(const provider of bridge.providers?.PROVIDERS||[])for(const model of provider.models||[]){const id=`${provider.id}/${model}`;ids.set(id,id);}for(const custom of snapshot().settings?.customProviders||[])for(const model of custom.models||[])ids.set(`${custom.id}/${model}`,`${custom.id}/${model}`);ids.set(selected,selected);return [...ids.entries()];}
  function select(parent,title,detail,value,options,changed){const input=el('select');for(const [id,label]of options){const option=el('option','',label);option.value=id;input.append(option);}input.value=value;input.disabled=busy;input.setAttribute('aria-label',title);input.onchange=()=>changed(input.value);row(parent,title,detail,input);return input;}
  async function saveProfile(project){busy=true;refreshVisible();try{const saved=await bridge.invoke('workspace_profile_set',{profile:draft(project)});drafts.set(project.id,saved);await loadControls();bridge.notice?.(L('Project profile saved.','حُفظ ملف إعدادات المشروع.'));}catch(error){api.reportError(error);}finally{busy=false;refreshVisible();}}
  async function applyProfile(project){
    if(snapshot().working){bridge.notice?.(L('Finish the current turn before changing the workspace profile.','أنه الدور الحالي قبل تغيير ملف إعدادات مساحة العمل.'));return;}
    const status=controls?.folders?.find(folder=>folder.projectId===project.id);
    if(!samePath(snapshot().settings?.project,project.path)||status?.trust!=='trusted'){bridge.notice?.(L('Open and trust this project before applying its profile.','افتح هذا المشروع ووثّقه قبل تطبيق ملف إعداداته.'));return;}
    busy=true;refreshVisible();try{
      const saved=await bridge.invoke('workspace_profile_set',{profile:draft(project)});drafts.set(project.id,saved);
      // Permission changes retain the existing explicit operator mode command.
      await api.native.applyExplicitMode(saved.mode);
      await api.applyRuntimeSettings({chatModel:saved.chatModel,agentModel:saved.agentModel,modelRole:'auto',computerUseEnabled:saved.computerUseEnabled});
      if(!saved.computerUseEnabled)bridge.submit('surface off');
      bridge.notice?.(L('Project models and permissions applied.','طُبقت نماذج المشروع وصلاحياته.'));await loadControls();
    }catch(error){api.reportError(error);}finally{busy=false;refreshVisible();}
  }
  function renderCowork(host){
    coworkHost=host;const body=section(host,'cowork');
    message(body,L('Choose folders, inspect their actual trust state, and save a model and permission profile for each project.','اختر المجلدات واعرض حالة توثيقها الفعلية واحفظ نماذج وصلاحيات خاصة بكل مشروع.'));
    const actions=el('div','nss-actions');actions.append(button(L('Add project folder','إضافة مجلد مشروع'),()=>api.addProject(),busy),button(loading?L('Checking…','جارٍ الفحص…'):L('Refresh folder status','تحديث حالة المجلدات'),loadControls,loading));body.append(actions);
    if(controlsError)message(body,L('Could not verify folder permissions: ','تعذر التحقق من صلاحيات المجلدات: ')+controlsError);
    if(!controls&&!loading&&!controlsError)void loadControls();
    if(!controls)return;
    const savedProjects=projects();
    row(body,L('Routines','الروتينات'),L('Review schedules and their last recorded run. The desktop app and engine must be running.','راجع الجداول وآخر تشغيل مسجّل. يجب أن يكون تطبيق سطح المكتب والمحرك قيد التشغيل.'),button(L('Manage routines','إدارة الروتينات'),()=>{document.getElementById('settingsclose')?.click();api.showPage('routines');}));
    if(!savedProjects.length){message(body,L('No project folder is saved. Adding a folder does not grant engine trust automatically.','لا يوجد مجلد مشروع محفوظ. إضافة المجلد لا تمنح توثيق المحرك تلقائيًا.'));return;}
    const trusted=controls?.folders?.filter(folder=>folder.trust==='trusted').length;
    fact(body,L('Saved project folders','مجلدات المشاريع المحفوظة'),savedProjects.length);
    fact(body,L('Engine trust confirmed','مجلدات موثّقة لدى المحرك'),trusted??L('Not checked','لم تُفحص'));
    for(const project of savedProjects){
      const status=controls?.folders?.find(folder=>folder.projectId===project.id),copy=el('div','nss-fact');const text=el('div');text.append(userText('strong',project.name),userText('small',project.path));
      const label=!status?L('Not checked','لم يُفحص'):!status.available?L('Folder unavailable','المجلد غير متاح'):status.trust==='trusted'?L('Trusted by engine','موثّق لدى المحرك'):status.trust==='untrusted'?L('Needs trust approval','يحتاج موافقة التوثيق'):L('Trust unknown','حالة التوثيق غير معروفة');text.append(el('small','',label));copy.append(text);
      const buttons=el('div','nss-actions');buttons.append(button(L('Open project','فتح المشروع'),()=>{document.getElementById('settingsclose')?.click();api.openProject(project);},busy||status?.available===false));
      if(status?.trust==='trusted')buttons.append(button(L('Revoke trust','سحب التوثيق'),()=>api.confirmDialog(L('Revoke folder trust','سحب توثيق المجلد'),L('This removes the engine trust marker. Opening the folder again will ask for approval; existing project files remain unchanged.','يزيل هذا علامة توثيق المحرك. سيُطلب الإذن عند فتح المجلد مجددًا وتبقى ملفات المشروع كما هي.'),async()=>{if(snapshot().working)throw Error(L('Finish the current turn first.','أنه الدور الحالي أولًا.'));if(samePath(snapshot().settings?.project,project.path))await api.native.applyExplicitMode('read-only');await bridge.invoke('workspace_folder_revoke',{projectId:project.id});await loadControls();}),busy));copy.append(buttons);body.append(copy);
    }
    body.append(el('h4','',L('Project workspace profile','ملف إعدادات مساحة عمل المشروع')));
    if(!savedProjects.some(project=>project.id===selectedProject))selectedProject=savedProjects[0].id;
    select(body,L('Project','المشروع'),'',selectedProject,savedProjects.map(project=>[project.id,project.name]),value=>{selectedProject=value;refreshVisible();});
    const project=savedProjects.find(project=>project.id===selectedProject),profile=draft(project);
    select(body,L('Chat model','نموذج المحادثة'),L('Uses the credentials configured for the selected provider.','يستخدم الاعتماد المضبوط للمزوّد المحدد.'),profile.chatModel,modelOptions(profile.chatModel),value=>profile.chatModel=value);
    select(body,L('Code model','نموذج الكود'),'',profile.agentModel,modelOptions(profile.agentModel),value=>profile.agentModel=value);
    select(body,L('Permission mode','وضع الصلاحيات'),L('Applying a profile uses the existing operator permission controls.','يستخدم تطبيق الملف أدوات صلاحيات المشغّل الحالية.'),profile.mode,[['read-only',L('Read-only','قراءة فقط')],['auto',L('Auto — use approval rules','تلقائي — استخدام قواعد الموافقة')],['full-access',L('Full access','وصول كامل')]],value=>profile.mode=value);
    const use=el('input');use.type='checkbox';use.checked=profile.computerUseEnabled;use.disabled=busy;use.onchange=()=>profile.computerUseEnabled=use.checked;row(body,L('Browser computer use','استخدام متصفح الكمبيوتر'),L('The existing browser tool permission gates still apply.','تظل بوابات صلاحيات أدوات المتصفح الحالية سارية.'),use);
    const buttons=el('div','nss-actions');buttons.append(button(L('Save profile','حفظ ملف الإعدادات'),()=>saveProfile(project),busy),button(L('Apply to open project','تطبيق على المشروع المفتوح'),()=>applyProfile(project),busy||!!snapshot().working),button(L('Project instructions','تعليمات المشروع'),()=>api.projectDialog(project),busy));body.append(buttons);
  }
  async function controlledAction(kind){
    if(busy)return;busy=true;browserError='';refreshVisible();
    try{
      if(kind==='close'){pendingNavigation=null;pendingNavigationTurn=null;bridge.submit('surface off');await bridge.invoke('browser_close');connection='disconnected';await loadBrowser();return;}
      if(snapshot().working)throw Error(L('Finish the current turn before connecting the browser.','أنه الدور الحالي قبل توصيل المتصفح.'));
      if(snapshot().settings?.computerUseEnabled===false)throw Error(L('Enable browser computer use first.','فعّل استخدام متصفح الكمبيوتر أولًا.'));
      if(kind==='open'){
        browser=await bridge.invoke('workspace_browser_open',{url:lastUrl});
        for(let attempt=0;attempt<12&&!browser.endpointReady;attempt++){await new Promise(resolve=>setTimeout(resolve,250));browser=await bridge.invoke('workspace_browser_status');}
      }else await loadBrowser();
      if(!browser?.ownedProcessRunning||!browser.endpointReady)throw Error(L('The owned browser control endpoint is not ready.','منفذ التحكم بالمتصفح المملوك للتطبيق غير جاهز.'));
      pendingNavigation=kind==='open'?lastUrl:null;pendingNavigationTurn=null;connectionReceipt=false;connectionOutput='';connection='connecting';
      const turnId=bridge.submit(`surface ${browser.port}`);
      if(typeof turnId!=='string'||!turnId)throw Error(L('The browser connection request was not accepted.','لم يُقبل طلب اتصال المتصفح.'));
      pendingNavigationTurn=turnId;
    }catch(error){pendingNavigation=null;pendingNavigationTurn=null;browserError=String(error);connection='failed';}finally{busy=false;refreshVisible();}
  }
  function renderBrowser(host){
    browserHost=host;const body=section(host,'browser');const runtime=snapshot().settings||{};
    message(body,L('The controlled browser is an isolated browser process. Its running state and control endpoint are checked here; the docked browsing pane is a separate viewer.','المتصفح القابل للتحكم عملية متصفح معزولة. تُفحص هنا حالة تشغيله ومنفذ التحكم به؛ أما لوحة التصفح المثبتة فهي عارض منفصل.'));
    const enabled=el('input');enabled.type='checkbox';enabled.checked=runtime.computerUseEnabled!==false;enabled.disabled=busy;enabled.onchange=async()=>{busy=true;refreshVisible();try{await api.applyRuntimeSettings({computerUseEnabled:enabled.checked});if(!enabled.checked){bridge.submit('surface off');connection='disconnected';}await loadBrowser();}catch(error){api.reportError(error);}finally{busy=false;refreshVisible();}};row(body,L('Enable browser computer use','تفعيل استخدام متصفح الكمبيوتر'),L('Navigation, reading, clicks and typing retain the existing tool approval rules.','يظل التنقل والقراءة والنقر والكتابة خاضعًا لقواعد موافقات الأدوات الحالية.'),enabled);
    fact(body,L('Owned browser process','عملية المتصفح المملوكة للتطبيق'),!browser?L('Not checked','لم تُفحص'):browser.ownedProcessRunning?L('Running','تعمل'):L('Stopped','متوقفة'));
    fact(body,L('Browser control endpoint','منفذ التحكم بالمتصفح'),!browser?L('Not checked','لم يُفحص'):browser.endpointReady?L('Ready','جاهز'):L('Not ready','غير جاهز'));
    if(lastChecked)fact(body,L('Last status check','آخر فحص للحالة'),lastChecked);
    const connectionLabels={unverified:L('No connection receipt yet','لا يوجد إيصال اتصال بعد'),connecting:L('Waiting for engine receipt','بانتظار إيصال المحرك'),connected:L('Connected — verified by engine','متصل — تحقّق منه المحرك'),disconnected:L('Disconnected','غير متصل'),failed:L('Connection failed','فشل الاتصال')};fact(body,L('Agent surface connection','اتصال سطح الوكيل'),connectionLabels[connection]);
    if(browserError)message(body,L('Browser status: ','حالة المتصفح: ')+browserError);
    const url=el('input');url.type='url';url.dir='ltr';url.value=lastUrl;url.setAttribute('aria-label',L('Browser start URL','رابط بدء المتصفح'));url.oninput=()=>lastUrl=url.value;row(body,L('Start page','صفحة البدء'),L('Site permission and blocked-domain settings below are enforced before opening.','تُطبق إعدادات إذن المواقع وقائمة الحظر أدناه قبل الفتح.'),url);
    const actions=el('div','nss-actions');actions.append(button(L('Open and connect','فتح واتصال'),()=>controlledAction('open'),busy||runtime.computerUseEnabled===false||!!snapshot().working),button(L('Reconnect agent','إعادة اتصال الوكيل'),()=>controlledAction('connect'),busy||!browser?.endpointReady||runtime.computerUseEnabled===false||!!snapshot().working),button(L('Read current page','قراءة الصفحة الحالية'),()=>bridge.submit('page'),busy||connection!=='connected'||runtime.computerUseEnabled===false||!!snapshot().working),button(L('Close controlled browser','إغلاق المتصفح القابل للتحكم'),()=>controlledAction('close'),busy||!browser?.ownedProcessRunning),button(browserLoading?L('Checking…','جارٍ الفحص…'):L('Recheck','إعادة الفحص'),loadBrowser,browserLoading));body.append(actions);
    renderBrowserPreferences(body);
    if(!browser&&!browserLoading&&!browserError)void loadBrowser();
  }
  async function savePreference(key,value){
    const meta=api.state?.metadata;if(!meta||busy)return;
    busy=true;
    try{await writeWorkspacePreference(meta,key,value,()=>api.saveStore());api.applyWorkspacePreferences?.();bridge.notice?.(L('Browser preference saved.','حُفظ تفضيل المتصفح.'));}
    catch(error){api.reportError(error);}finally{busy=false;refreshVisible();}
  }
  function renderBrowserPreferences(body){
    const preferences=api.state?.metadata?.preferences||{};
    body.append(el('h4','',L('Browser preferences','تفضيلات المتصفح')));
    row(body,L('Built-in browser pane','لوحة المتصفح المدمجة'),L('Manual browsing in the docked workspace pane.','تصفح يدوي داخل لوحة مساحة العمل.'),button(L('Open built-in browser','فتح المتصفح المدمج'),()=>{document.getElementById('settingsclose')?.click();document.getElementById('browsertab')?.click();}));
    const links=el('input');links.type='checkbox';links.checked=preferences.openLinksInBuiltin!==false;links.disabled=busy;links.onchange=()=>savePreference('openLinksInBuiltin',links.checked);row(body,L('Open links in the built-in browser','فتح الروابط في المتصفح المدمج'),'',links);
    select(body,L('Default site permission','الإذن الافتراضي للمواقع'),L('Applied before opening a site in either native browser.','يُطبق قبل فتح الموقع في أي من المتصفحين الأصليين.'),preferences.browserDefaultPermission||'allow',[['allow',L('Allow except blocked sites','السماح عدا المواقع المحظورة')],['block',L('Block all sites','حظر كل المواقع')]],value=>savePreference('browserDefaultPermission',value));
    select(body,L('Browser session storage','تخزين جلسة المتصفح'),L('Changes apply the next time the controlled browser starts.','تُطبق التغييرات عند تشغيل المتصفح القابل للتحكم في المرة التالية.'),preferences.browserPersistence||'session',[['session',L('Per app session','لكل جلسة تطبيق')],['shared',L('Shared local profile','ملف محلي مشترك')]],value=>savePreference('browserPersistence',value));
    const blocked=el('textarea');blocked.rows=4;blocked.dir='ltr';blocked.setAttribute('aria-label',L('Blocked sites','المواقع المحظورة'));blocked.value=blockedDraft??(preferences.blockedSites||[]).join('\n');blocked.oninput=()=>blockedDraft=blocked.value;row(body,L('Blocked sites','المواقع المحظورة'),L('One domain per line. Its subdomains are blocked too.','نطاق واحد في كل سطر. تُحظر نطاقاته الفرعية أيضًا.'),blocked);
    body.append(button(L('Save blocked sites','حفظ المواقع المحظورة'),()=>{const values=[...new Set(blocked.value.split(/\s+/u).map(value=>value.toLowerCase()).filter(Boolean))];if(values.length>200||values.some(value=>!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value))){bridge.notice?.(L('Use up to 200 domain names, without protocols or paths.','استخدم حتى 200 اسم نطاق دون بروتوكولات أو مسارات.'));return;}void savePreference('blockedSites',values);},busy));
  }
  function frame(frame){
    if(frame?.kind==='models'){groups=frame.groups||[];refreshVisible();}
    // Direct commands emit event(payload), then done. Only the exact turn ID
    // returned by the outbox may confirm this connection or release navigation.
    const matchingConnection=connection==='connecting'&&pendingNavigationTurn&&frame?.turnId===pendingNavigationTurn;
    if(matchingConnection&&(frame.kind==='event'||frame.kind==='tool-result')){
      const output=frame.kind==='event'?frame.payload:frame.output;
      if(typeof output==='string'){
        connectionOutput=(connectionOutput+'\n'+output).slice(-2000);
        const expected='وُصل السطح على المنفذ '+String(browser?.port);
        if(output.split('\n').some(line=>line===expected||line.startsWith(expected+' ')))connectionReceipt=true;
      }
    }
    if(matchingConnection&&frame.kind==='done'){
      const url=pendingNavigation;pendingNavigation=null;pendingNavigationTurn=null;
      const completed=connectionReceipt&&frame.outcome==='completed';
      connection=completed?'connected':'failed';
      if(!completed)browserError=connectionOutput.trim()||L('The engine did not confirm the browser connection.','لم يؤكد المحرك اتصال المتصفح.');
      refreshVisible();
      if(completed&&url)queueMicrotask(()=>{if(!disposed&&connection==='connected')bridge.submit(`open ${url}`);});
    }
    if(['failed','interrupted','refused','unresolved'].includes(frame?.kind)&&frame.turnId===pendingNavigationTurn){pendingNavigation=null;pendingNavigationTurn=null;connection='failed';browserError=frame.why||L('Browser connection did not complete.','لم يكتمل اتصال المتصفح.');refreshVisible();}
    if(['project','ready'].includes(frame?.kind)){controls=null;void loadControls();void loadBrowser();}
    if(frame?.kind==='settings'){if(frame.settings?.computerUseEnabled===false)connection='disconnected';refreshVisible();}
    if(frame?.kind==='engine-died'){pendingNavigation=null;pendingNavigationTurn=null;connection='unverified';refreshVisible();}
  }
  function render(){const cowork=document.querySelector('[data-panel="nss-cowork"]'),chrome=document.querySelector('[data-panel="nss-chrome"]');if(cowork)renderCowork(cowork);if(chrome)renderBrowser(chrome);}
  function opened(event){if(event.detail?.id==='nss-cowork')void loadControls();if(event.detail?.id==='nss-chrome')void loadBrowser();}
  document.addEventListener('abdocode:settings-rendered',render);
  document.addEventListener('abdocode:settings-opened',opened);
  render();
  return {openAndConnect(url){lastUrl=url;return controlledAction('open');},renderCowork,renderBrowser,frame,settingsApplied(){render();},refresh(){void loadControls();void loadBrowser();},dispose(){disposed=true;document.removeEventListener('abdocode:settings-rendered',render);document.removeEventListener('abdocode:settings-opened',opened);coworkHost=browserHost=null;}};
}
