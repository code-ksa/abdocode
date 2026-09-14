// Connected screens that mirror the approved HTML shell. This module only
// presents state owned by the desktop bridge; it never invents account,
// cloud, billing, repository, or provider results.
const escapeText=value=>String(value??'');

export function mountNativeSurfaces(api){
  const {bridge,native,dock,L,button,make,svg}=api;
  let project=null, projectTab='overview', git=null, gitRequest=0, activity=[], gitNotice='';
  let pullRequestRemote='', pullRequestRequest=0, pullRequestState={loading:false,status:null,items:[],error:'',receipt:null};
  const pageHost=api.pageHost;
  const state=()=>api.state;
  const user=node=>{node.dataset.userContent='';return node;};
  const codeModeMessage=()=>L('Switch to Code to change project files or Git state.','انتقل إلى وضع الكود لتغيير ملفات المشروع أو حالة Git.');
  const requireCode=()=>{if(state().shellMode==='code')return true;bridge.notice(codeModeMessage());return false;};
  const empty=(host,en,ar)=>host.append(make('div','ns-empty',L(en,ar)));
  const head=(title,subtitle)=>{const h=make('div','ns-page-head');h.append(make('h1','',title));if(subtitle)h.append(make('p','ns-muted',subtitle));pageHost.replaceChildren(h);return h;};
  const card=(title,copy)=>{const c=make('article','ns-card ns-reference-card');c.append(make('h2','',title));if(copy)c.append(make('p','ns-muted',copy));return c;};
  const projectSessions=()=>state().sessions.filter(s=>state().metadata?.sessions.find(m=>m.id===s.id)?.projectId===project?.id);
  function openLink(url){if(state().metadata?.preferences?.openLinksInBuiltin!==false){api.showPage('session');document.getElementById('browsertab')?.click();setTimeout(()=>{const field=document.getElementById('paneurl');if(field)field.value=url;document.getElementById('panego')?.click();},0);return;}bridge.invoke('open_external',{url}).catch(api.reportError);}

  function addReferenceNavigation(){
    const nav=document.querySelector('.ns-navigation');if(!nav||nav.querySelector('[data-reference-nav]'))return;
    const more=nav.querySelector('.ns-sidebar-shortcuts')||nav;
    const wrap=make('div','ns-reference-nav');wrap.dataset.referenceNav='';
    for(const [id,en,ar,icon] of [['projects','Projects','المشاريع','folder'],['routines','Routines','الروتينات','clock'],['dispatch','Dispatch','التفويض','clock'],['features','Features','الميزات','grid'],['activity','Activity','النشاط','clock']])wrap.append(button(L(en,ar),()=>api.showPage(id),icon));
    more.replaceWith(wrap);
  }

  async function openProjectDetail(value,tab='overview'){
    project=value;projectTab=tab;const request=++gitRequest;git={loading:true,files:[],branch:'',commits:[]};pullRequestRemote='';pullRequestState={loading:false,status:null,items:[],error:'',receipt:null};api.showPage('project-detail');
    const apply=value=>{if(request!==gitRequest||project?.id!==value.projectId)return;git={...git,...value.result,loading:false};renderProject();if(Array.isArray(value.result.remotes)){const selected=value.result.remotes.find(remote=>remote.name==='origin')||value.result.remotes[0];if(selected)void refreshPullRequests(selected.name);}};
    const fail=()=>{if(request!==gitRequest||project?.id!==value.id)return;git={...git,loading:false};renderProject();};
    // The compact status call can paint branch and changed-file facts without
    // waiting for the richer overview's branch, commit and remote queries.
    void bridge.invoke('workspace_git_diff',{root:value.path,staged:false}).then(result=>apply({projectId:value.id,result})).catch(fail);
    void bridge.invoke('workspace_git_overview',{root:value.path}).then(result=>apply({projectId:value.id,result})).catch(fail);
  }
  async function mutateGit(request){
    if(state().shellMode!=='code')throw Error(codeModeMessage());
    const result=await bridge.invoke('workspace_git_action',{root:project.path,request});
    git={...result.overview,loading:false};gitNotice=L('Git action completed.','اكتملت عملية Git.');renderProject();return result;
  }
  function pullRequestReason(code,provider='github'){
    return ({
      noRemote:L('Add a remote before using pull requests.','أضف مستودعًا بعيدًا قبل استخدام طلبات الدمج.'),
      unsupportedProvider:L(`Pull request creation is not connected for ${provider}. GitHub remotes are supported through GitHub CLI.`,`إنشاء طلبات الدمج غير موصول لمزوّد ${provider}. مستودعات GitHub مدعومة عبر GitHub CLI.`),
      cliUnavailable:L('Install GitHub CLI to use pull requests.','ثبّت GitHub CLI لاستخدام طلبات الدمج.'),
      authenticationRequired:L('Sign in with GitHub CLI on this computer.','سجّل الدخول عبر GitHub CLI على هذا الجهاز.'),
      branchRequired:L('Switch to a local branch first.','انتقل إلى فرع محلي أولًا.'),
      pushRequired:L('Push the current branch to the selected remote, then refresh.','ادفع الفرع الحالي إلى المستودع البعيد المختار ثم حدّث الحالة.')
    })[code]||'';
  }
  async function refreshPullRequests(remote=pullRequestRemote){
    if(!project?.path||!git?.isRepository)return pullRequestState;
    const projectId=project.id,request=++pullRequestRequest;
    pullRequestRemote=remote||git.remotes?.find(item=>item.name==='origin')?.name||git.remotes?.[0]?.name||'';
    pullRequestState={...pullRequestState,loading:true,error:''};renderProject();
    try{
      const status=await bridge.invoke('workspace_git_provider_status',{root:project.path,remote:pullRequestRemote||null});
      if(request!==pullRequestRequest||project?.id!==projectId)return pullRequestState;
      let items=[];
      if(status.supported&&status.authenticated){
        try{const listed=await bridge.invoke('workspace_git_pull_requests',{root:project.path,remote:status.remote});items=listed.pullRequests||[];}
        catch(error){if(request!==pullRequestRequest||project?.id!==projectId)return pullRequestState;pullRequestState={loading:false,status,items:[],error:String(error),receipt:pullRequestState.receipt};renderProject();return pullRequestState;}
      }
      if(request!==pullRequestRequest||project?.id!==projectId)return pullRequestState;
      pullRequestRemote=status.remote||pullRequestRemote;pullRequestState={loading:false,status,items,error:'',receipt:pullRequestState.receipt};renderProject();return pullRequestState;
    }catch(error){
      if(request!==pullRequestRequest||project?.id!==projectId)return pullRequestState;
      pullRequestState={...pullRequestState,loading:false,error:String(error)};renderProject();return pullRequestState;
    }
  }
  function openPushReview(remote){
    const label=remote||git.upstream||L('configured upstream','المنبع المضبوط');
    return api.confirmDialog(L('Push branch','دفع الفرع'),L(`Send the current local commits to ${label} using your existing Git authentication.`,`أرسل الإيداعات المحلية الحالية إلى ${label} باستخدام مصادقة Git الموجودة.`),()=>mutateGit({action:'push',...(remote?{remote}:{})}),L('Push','دفع'));
  }
  function openPushDialog(){
    if(!requireCode())return;
    if(git?.upstream)return openPushReview();
    const remotes=git?.remotes||[];
    if(!remotes.length){api.reportError(L('Add a Git remote before pushing.','أضف مستودع Git بعيدًا قبل الدفع.'));return;}
    const overlay=api.formDialog(L('Choose push remote','اختر مستودع الدفع'),[{key:'remote',label:L('Remote','المستودع البعيد'),value:remotes.find(item=>item.name==='origin')?.name||remotes[0].name,options:remotes.map(item=>[item.name,item.name])}],values=>{setTimeout(()=>openPushReview(values.remote),0);});
    const submit=overlay.querySelector('.ns-form-actions .ns-button:last-child');if(submit)submit.textContent=L('Review push','مراجعة الدفع');
  }
  function pullRequestDefaults(){
    const status=pullRequestState.status||{};
    return {remote:status.remote||pullRequestRemote||git?.remotes?.[0]?.name||'',title:git?.commits?.[0]?.subject||'',body:'## Summary\n\n\n## Validation\n\n',base:status.suggestedBase||'main',head:git?.branch||'',draft:String(state().metadata?.preferences?.draftPullRequests!==false)};
  }
  function openPullRequestPreview(values){
    const draft=values.draft==='true';
    const overlay=api.formDialog(L('Review pull request','مراجعة طلب الدمج'),[
      {key:'repository',label:L('Repository','المستودع'),value:pullRequestState.status?.repository||'',readonly:true},
      {key:'branches',label:L('Branches','الفروع'),value:`${values.base} ← ${values.head}`,readonly:true},
      {key:'kind',label:L('Type','النوع'),value:draft?L('Draft pull request','طلب دمج كمسودة'):L('Ready for review','جاهز للمراجعة'),readonly:true},
      {key:'title',label:L('Title','العنوان'),value:values.title,readonly:true},
      {key:'body',label:L('Body','الوصف'),value:values.body,multiline:true,readonly:true}
    ],async()=>{
      if(state().shellMode!=='code')throw Error(codeModeMessage());
      const receipt=await bridge.invoke('workspace_git_create_pull_request',{root:project.path,request:{remote:values.remote,title:values.title,body:values.body,base:values.base,head:values.head,draft,confirmed:true}});
      pullRequestState={...pullRequestState,receipt};gitNotice=receipt.verified?L(`Pull request #${receipt.number} created.`,`أُنشئ طلب الدمج #${receipt.number}.`):L('GitHub accepted the request. Refresh the list before retrying because the receipt was not verified.','قبل GitHub الطلب. حدّث القائمة قبل إعادة المحاولة لأن الإيصال لم يُتحقق منه.');
      await refreshPullRequests(values.remote);
    });
    const submit=overlay.querySelector('.ns-form-actions .ns-button:last-child');if(submit)submit.textContent=L('Create pull request','إنشاء طلب الدمج');
  }
  async function openPullRequestDialog(rootOverride){
    if(!requireCode())return null;
    const wanted=rootOverride||project?.path||api.rootProject();
    const metadata=state().metadata;
    const target=(metadata?.projects||[]).find(item=>item.path.toLowerCase()===String(wanted||'').toLowerCase())||project;
    if(!target?.path){api.reportError(L('Select a saved project first.','اختر مشروعًا محفوظًا أولًا.'));return null;}
    if(project?.path.toLowerCase()!==target.path.toLowerCase()||!git?.isRepository){
      project=target;projectTab='overview';git={...(await bridge.invoke('workspace_git_overview',{root:target.path})),loading:false};pullRequestState={loading:false,status:null,items:[],error:'',receipt:null};pullRequestRemote='';api.showPage('project-detail');renderProject();
    }
    const selected=pullRequestRemote||git.remotes?.find(item=>item.name==='origin')?.name||git.remotes?.[0]?.name;
    if(!selected){api.reportError(L('Add a Git remote before creating a pull request.','أضف مستودع Git بعيدًا قبل إنشاء طلب دمج.'));return null;}
    const current=await refreshPullRequests(selected);
    if(!current.status?.canCreate){api.reportError(pullRequestReason(current.status?.reasonCode,current.status?.provider)||current.error||L('Pull request creation is not ready.','إنشاء طلب الدمج غير جاهز.'));return null;}
    const values=pullRequestDefaults();
    const overlay=api.formDialog(L('Create pull request','إنشاء طلب دمج'),[
      {key:'remote',label:L('Remote','المستودع البعيد'),value:values.remote,options:(git.remotes||[]).map(item=>[item.name,item.name])},
      {key:'title',label:L('Title','العنوان'),value:values.title},
      {key:'body',label:L('Description','الوصف'),value:values.body,multiline:true},
      {key:'base',label:L('Base branch','الفرع الأساسي'),value:values.base},
      {key:'head',label:L('Head branch','فرع التغييرات'),value:values.head,readonly:true},
      {key:'draft',label:L('Pull request state','حالة طلب الدمج'),value:values.draft,options:[['true',L('Draft','مسودة')],['false',L('Ready for review','جاهز للمراجعة')]]}
    ],async next=>{const refreshed=await refreshPullRequests(next.remote);if(!refreshed.status?.canCreate)throw Error(pullRequestReason(refreshed.status?.reasonCode,refreshed.status?.provider)||refreshed.error||L('Pull request creation is not ready.','إنشاء طلب الدمج غير جاهز.'));setTimeout(()=>openPullRequestPreview(next),0);});
    const submit=overlay.querySelector('.ns-form-actions .ns-button:last-child');if(submit)submit.textContent=L('Review pull request','مراجعة طلب الدمج');
    return overlay;
  }
  function renderPullRequests(host){
    const box=make('section','ns-pr-section');box.append(make('h3','',L('Pull requests','طلبات الدمج')));
    const remotes=git?.remotes||[];
    if(remotes.length){const select=make('select','ns-page-sort');for(const remote of remotes){const option=make('option','',remote.name);option.value=remote.name;select.append(option);}select.value=pullRequestRemote||remotes[0].name;select.onchange=()=>void refreshPullRequests(select.value);box.append(select);}
    const refresh=button(L('Refresh pull requests','تحديث طلبات الدمج'),()=>refreshPullRequests());refresh.disabled=pullRequestState.loading;box.append(refresh);
    const create=button(L('Create pull request','إنشاء طلب دمج'),()=>openPullRequestDialog(project?.path),'plus');create.disabled=state().shellMode!=='code'||pullRequestState.loading||!pullRequestState.status?.canCreate;box.append(create);
    if(pullRequestState.loading)box.append(make('p','ns-muted',L('Checking GitHub…','جارٍ فحص GitHub…')));
    if(pullRequestState.status){const status=pullRequestState.status,copy=status.authenticated?L(`GitHub CLI is connected for ${status.repository}.`,`GitHub CLI متصل بالمستودع ${status.repository}.`):pullRequestReason(status.reasonCode,status.provider);box.append(make('p','ns-state '+(status.authenticated?'connected':'paused'),copy));if(status.authenticated&&!status.canCreate)box.append(make('p','ns-muted',pullRequestReason(status.reasonCode,status.provider)));}
    if(pullRequestState.error)box.append(make('p','ns-error',pullRequestState.error));
    const receipt=pullRequestState.receipt;if(receipt){const row=make('div','ns-list-row');row.append(make('strong','',receipt.verified?L(`Created #${receipt.number}`,`أُنشئ #${receipt.number}`):L('Creation accepted; receipt unverified','قُبل الإنشاء؛ الإيصال غير متحقق')));if(receipt.url)row.append(button(L('Open pull request','فتح طلب الدمج'),()=>openLink(receipt.url)));box.append(row);}
    for(const item of pullRequestState.items){const row=make('div','ns-list-row');row.append(user(make('strong','',`#${item.number} ${item.title}`)),make('span','ns-muted',`${item.isDraft?L('Draft','مسودة'):item.state} · ${item.baseRefName} ← ${item.headRefName}`),button(L('Open','فتح'),()=>openLink(item.url)));box.append(row);}
    if(pullRequestState.status?.authenticated&&!pullRequestState.loading&&!pullRequestState.items.length&&!pullRequestState.error)box.append(make('p','ns-muted',L('No pull requests were found for the current branch.','لم توجد طلبات دمج للفرع الحالي.')));
    host.append(box);
  }
  async function createWorktree(values){
    if(state().shellMode!=='code')throw Error(codeModeMessage());
    const created=await bridge.invoke('workspace_create_worktree',{root:project.path,branch:values.branch});
    if(!created)return;
    if(!state().metadata.projects.some(item=>item.path.toLowerCase()===created.path.toLowerCase())){
      state().metadata.projects.push({id:crypto.randomUUID(),name:created.path.split(/[\\/]/).pop()||created.branch,path:created.path,instructions:project.instructions||''});
      await api.saveStore();
    }
    gitNotice=L('Worktree created and added to Projects.','أُنشئت نسخة العمل وأضيفت إلى المشاريع.');
    await openProjectDetail(project,'overview');
  }
  function projectTabs(host){
    const tabs=make('div','ns-project-tabs');
    for(const [id,en,ar]of [['overview','Overview','نظرة عامة'],['chats','Chats','المحادثات'],['files','Files','الملفات'],['instructions','Instructions','التعليمات'],['knowledge','Knowledge','المعرفة'],['settings','Settings','الإعدادات']]){const b=button(L(en,ar),()=>{projectTab=id;renderProject();});b.classList.toggle('active',projectTab===id);tabs.append(b);}host.append(tabs);
  }
  function automationStatusReferences(status,projectId){
    const store=status?.store||{};
    return (store.schedules||[]).some(item=>item.projectId===projectId)||(store.jobs||[]).some(item=>item.projectId===projectId&&['queued','running','needs-input'].includes(item.status));
  }
  async function verifyProjectCanBeRemoved(projectId){
    let status;
    try{status=await bridge.invoke('automation_status');}
    catch{throw Error(L('Could not verify Dispatch and routine references. The project was not removed.','تعذّر التحقق من مراجع التفويض والروتينات. لم يُحذف المشروع.'));}
    if(automationStatusReferences(status,projectId))throw Error(L('Remove this project’s routines or cancel its pending Dispatch tasks first.','احذف روتينات هذا المشروع أو ألغِ مهام التفويض المعلقة أولًا.'));
  }
  function renderProject(){
    if(!project)return;const top=head(project.name,project.path);top.append(button(L('Open workspace','فتح مساحة العمل'),()=>api.openProject(project),'folder'));projectTabs(pageHost);
    const body=make('div','ns-project-body');pageHost.append(body);
    if(projectTab==='overview'){
      const stats=make('div','ns-project-stats');
      const pending=git?.loading?L('Loading…','جارٍ التحميل…'):'—';
      const rows=[[L('Conversations','المحادثات'),projectSessions().length],[L('Changed files','الملفات المتغيرة'),git?.loading&&!git.files?.length?pending:git?.files?.length??'—'],[L('Branch','الفرع'),git?.branch||pending],[L('Ahead / behind','متقدم / متأخر'),git?.ahead==null?pending:`${git.ahead} / ${git.behind}`]];
      for(const [label,value]of rows){const c=card(label);c.append(user(make('strong','',value)));stats.append(c);}body.append(stats);
      const recent=card(L('Recent commits','آخر الإيداعات'),git?.isRepository?'':L('This folder is not a Git repository.','هذا المجلد ليس مستودع Git.'));for(const commit of git?.commits?.slice(0,6)||[])recent.append(user(make('p','ns-list-row',`${commit.shortId}  ${commit.subject}`)));body.append(recent);
      if(git?.isRepository){
        const actions=card(L('Repository actions','عمليات المستودع'),L('Each change runs only after you choose it here. Pull is fast-forward only and Git hooks stay disabled.','كل تغيير يعمل بعد اختياره هنا فقط. السحب تقديم مباشر فقط وتبقى خطافات Git معطلة.'));
        if(gitNotice)actions.append(make('p','ns-state connected',gitNotice));
        actions.append(
          button(L('Create branch','إنشاء فرع'),()=>{if(requireCode())api.formDialog(L('Create branch','إنشاء فرع'),[{key:'branch',label:L('Branch name','اسم الفرع'),value:state().metadata?.preferences?.branchPrefix||'abdo/'}],v=>mutateGit({action:'createBranch',branch:v.branch}));},'plus'),
          button(L('Create worktree','إنشاء نسخة عمل'),()=>{if(requireCode())api.formDialog(L('Create isolated worktree','إنشاء نسخة عمل معزولة'),[{key:'branch',label:L('New branch name','اسم الفرع الجديد'),value:state().metadata?.preferences?.branchPrefix||'abdo/'}],createWorktree);},'folder'),
          button(L('Commit staged files','إيداع الملفات المضافة'),()=>{if(requireCode())api.formDialog(L('Create commit','إنشاء إيداع'),[{key:'message',label:L('Commit message','رسالة الإيداع'),value:''}],v=>mutateGit({action:'commit',message:v.message}));},'code'),
          button(L('Pull','سحب'),()=>{if(requireCode())api.confirmDialog(L('Pull changes','سحب التغييرات'),L('Fetch and fast-forward the current branch from its configured upstream.','اجلب وقدّم الفرع الحالي من المنبع المضبوط.'),()=>mutateGit({action:'pull'}),L('Pull','سحب'));}),
          button(L('Push','دفع'),openPushDialog)
        );
        const branches=make('div','ns-branch-list');for(const branch of git.branches||[]){const row=make('div','ns-list-row');row.append(user(make('span','',branch.name)),make('span','ns-muted',branch.current?L('Current','الحالي'):branch.head.slice(0,8)));if(!branch.current)row.append(button(L('Switch','تبديل'),()=>{if(requireCode())api.confirmDialog(L('Switch branch','تبديل الفرع'),L('Switch the working tree to ','بدّل نسخة العمل إلى ')+branch.name,()=>mutateGit({action:'switchBranch',branch:branch.name}),L('Switch','تبديل'));}));branches.append(row);}actions.append(branches);
        if(git.worktrees?.length){actions.append(make('h3','',L('Worktrees','نسخ العمل')));for(const item of git.worktrees){const row=make('div','ns-list-row');row.append(user(make('span','',item.branch||L('Detached worktree','نسخة عمل منفصلة'))),user(make('code','ns-path',item.path)),make('span','ns-muted',item.current?L('Current','الحالية'):item.locked?L('Locked','مقفلة'):item.prunable?L('Prunable','قابلة للتنظيف'):''));const known=state().metadata.projects.find(p=>p.path.toLowerCase()===item.path.toLowerCase());if(known&&!item.current)row.append(button(L('Open project','فتح المشروع'),()=>openProjectDetail(known),'folder'));actions.append(row);}}
        for(const remote of git.remotes||[]){const links=make('div','ns-list-row');links.append(user(make('span','',remote.name)));if(remote.webUrl)links.append(button(L('Open repository','فتح المستودع'),()=>openLink(remote.webUrl)));if(remote.compareUrl)links.append(button(L('Open comparison','فتح المقارنة'),()=>openLink(remote.compareUrl)));actions.append(links);}
        renderPullRequests(actions);
        body.append(actions);
      }
    }else if(projectTab==='chats'){
      for(const session of projectSessions()){const c=card(session.title||L('New conversation','محادثة جديدة'));c.append(button(L('Open','فتح'),()=>{api.showPage('session');bridge.send({kind:'recall',session:session.id}).catch(api.reportError);}));body.append(c);}if(!projectSessions().length)empty(body,'No conversations are assigned to this project.','لا توجد محادثات مرتبطة بهذا المشروع.');
    }else if(projectTab==='files'){const c=card(L('Project files','ملفات المشروع'),L('Browse the selected project through the protected desktop file bridge.','تصفح المشروع المختار عبر جسر الملفات المحمي.'));c.append(button(L('Open files panel','فتح لوحة الملفات'),()=>{api.openFiles('',project.path);dock.open('files');api.showPage('session');},'files'),button(L('Open changes','فتح التغييرات'),()=>{api.openChanges(undefined,false,project.path);dock.open('changes');api.showPage('session');},'changes'));body.append(c);}
    else if(projectTab==='instructions'){const c=card(L('Project instructions','تعليمات المشروع'));c.append(user(make('pre','ns-document',project.instructions||L('No project instructions yet.','لم تضف تعليمات للمشروع.'))),button(L('Edit instructions','تعديل التعليمات'),()=>api.projectDialog(project),'edit'));body.append(c);}
    else if(projectTab==='knowledge'){const c=card(L('Project knowledge','معرفة المشروع'),L('Search project memory through the engine. Results appear in a conversation and keep the current permission rules.','ابحث في ذاكرة المشروع عبر المحرك. تظهر النتائج في المحادثة مع قواعد الصلاحيات الحالية.'));c.append(button(L('Inspect awareness','عرض الوعي'),()=>{api.showPage('session');bridge.submit('awareness');}),button(L('Search memory','بحث الذاكرة'),()=>api.formDialog(L('Search memory','بحث الذاكرة'),[{key:'query',label:L('Search','البحث'),value:''}],v=>{api.showPage('session');bridge.submit('recall '+v.query);})));body.append(c);}
    else {
      const c=card(L('Project settings','إعدادات المشروع'));
      const routines=(state().metadata.schedules||[]).filter(item=>item.projectId===project.id);
      const automationReferences=api.automation?.referencesProject?.(project.id)===true;
      c.append(button(L('Edit name, folder and instructions','تعديل الاسم والمجلد والتعليمات'),()=>api.projectDialog(project),'settings'));
      if(routines.length||automationReferences)c.append(make('p','ns-state paused',L('Remove this project’s routines or cancel its pending Dispatch tasks before removing the project.','احذف روتينات هذا المشروع أو ألغِ مهام التفويض المعلقة قبل إزالة المشروع.')));
      else c.append(button(L('Remove from sidebar','إزالة من القائمة'),()=>api.confirmDialog(L('Remove project','إزالة المشروع'),L('The folder and files stay on disk. Conversations and artifacts become unassigned.','سيبقى المجلد وملفاته على القرص، وستصبح المحادثات والمخرجات دون مشروع مرتبط.'),async()=>{
        const removedId=project.id;
        await verifyProjectCanBeRemoved(removedId);
        state().metadata.projects=state().metadata.projects.filter(p=>p.id!==removedId);
        for(const session of state().metadata.sessions||[])if(session.projectId===removedId)delete session.projectId;
        for(const artifact of state().metadata.artifacts||[])if(artifact.projectId===removedId)delete artifact.projectId;
        await api.saveStore();project=null;api.showPage('projects');
      },L('Remove','إزالة'))));
      body.append(c);
    }
  }

  async function renderProjects(){const top=head(L('Projects','المشاريع'),L('Folders, instructions, conversations and repository status.','المجلدات والتعليمات والمحادثات وحالة المستودع.'));top.append(button(L('Add project','إضافة مشروع'),api.addProject,'plus'));const search=make('input','ns-page-search');search.type='search';search.placeholder=L('Search projects…','ابحث في المشاريع…');const sort=make('select','ns-page-sort');for(const [value,label]of [['recent',L('Recently added','المضاف حديثًا')],['name',L('Name','الاسم')],['path',L('Folder','المجلد')]]){const option=make('option','',label);option.value=value;sort.append(option);}top.append(search,sort);const grid=make('div','ns-card-grid ns-project-grid');pageHost.append(grid);const draw=()=>{grid.replaceChildren();const query=search.value.trim().toLowerCase();let rows=state().metadata.projects.filter(p=>!query||`${p.name} ${p.path} ${p.instructions||''}`.toLowerCase().includes(query));if(sort.value==='recent')rows=[...rows].reverse();else rows=[...rows].sort((a,b)=>String(a[sort.value]).localeCompare(String(b[sort.value])));for(const p of rows){const c=card(p.name,p.path);const linked=state().metadata.sessions.filter(s=>s.projectId===p.id).length;c.append(make('div','ns-card-meta',`${linked} ${L('conversations','محادثات')}`),button(L('Open project','فتح المشروع'),()=>openProjectDetail(p),'folder'),button(L('Start working','بدء العمل'),()=>api.openProject(p),'code'));grid.append(c);}if(!rows.length)empty(grid,'No projects match this view.','لا توجد مشاريع مطابقة.');};search.oninput=draw;sort.onchange=draw;draw();}
  function renderFeatures(){head(L('AbdoCode features','ميزات عبدو كود'),L('Actual capabilities currently published by the engine registry.','القدرات الفعلية التي ينشرها سجل المحرك حاليًا.'));const grid=make('div','ns-directory-grid');const registry=bridge.snapshot().pluginRegistry||{};const catalogue=bridge.snapshot().pluginCatalog||[];const entries=Array.isArray(catalogue)?catalogue:Object.values(catalogue||{});if(entries.length){for(const item of entries){const id=item.id||item.name;const descriptor=(registry.descriptors||[]).find(value=>value.name===id)||{};const c=card(item.label||descriptor.label||id,item.description||descriptor.description||item.summary||'');const enabled=registry.effective?.[id]??item.effective??item.enabled??false;c.append(make('span','ns-state '+(enabled?'connected':'paused'),enabled?L('Available','متاحة'):L('Disabled','معطلة')));grid.append(c);}}else empty(grid,'Feature registry is loading.','يتم تحميل سجل الميزات.');pageHost.append(grid);}
  function renderActivity(){head(L('Activity','النشاط'),L('Events received in this desktop session.','الأحداث المستلمة في جلسة سطح المكتب هذه.'));const list=make('div','ns-activity-list');for(const row of activity.slice(-60).reverse()){const c=card(row.label);c.append(make('time','ns-muted',row.time));list.append(c);}pageHost.append(list);if(!activity.length)empty(pageHost,'Activity appears when a turn or tool starts.','يظهر النشاط عند بدء دور أو أداة.');}
  function renderArtifacts(){
    const top=head(L('Artifacts','المخرجات'),L('A persistent library of files created by tools or by you.','مكتبة دائمة للملفات التي أنشأتها الأدوات أو أنشأتها أنت.'));
    top.append(button(L('New artifact','مخرج جديد'),()=>{if(!requireCode())return;const root=api.rootProject();if(!root){api.showPage('projects');return;}api.formDialog(L('New artifact','مخرج جديد'),[{key:'title',label:L('Title','العنوان'),value:''},{key:'path',label:L('Relative file path','مسار الملف النسبي'),value:'note.md'},{key:'text',label:L('Contents','المحتوى'),value:'',multiline:true}],async v=>{if(state().shellMode!=='code')throw Error(codeModeMessage());const result=await bridge.invoke('workspace_write',{root,path:v.path,text:v.text,expected:null});const owner=state().metadata.projects.find(p=>p.path===root);state().metadata.artifacts??=[];state().metadata.artifacts.unshift({id:crypto.randomUUID(),title:v.title||result.path.split(/[\\/]/).pop(),path:result.path,createdAt:new Date().toISOString(),sessionId:bridge.snapshot().sessionId||undefined,projectId:owner?.id,pinned:false});await api.saveStore();renderArtifacts();api.openPreview(result.path,root);});},'plus'));
    const search=make('input','ns-page-search');search.type='search';search.placeholder=L('Search artifacts…','ابحث في المخرجات…');top.append(search);
    const grid=make('div','ns-artifact-grid');pageHost.append(grid);const draw=()=>{grid.replaceChildren();const query=search.value.trim().toLowerCase();const rows=[...(state().metadata.artifacts||[])].filter(item=>!query||`${item.title} ${item.path}`.toLowerCase().includes(query)).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||String(b.createdAt).localeCompare(String(a.createdAt)));for(const item of rows){const c=card(item.title,item.path);const owner=state().metadata.projects.find(p=>p.id===item.projectId);c.append(make('p','ns-card-meta',`${owner?.name||L('Unassigned','غير مرتبط')} · ${new Date(item.createdAt).toLocaleString()}`),button(L('Preview','معاينة'),()=>api.openPreview(item.path,owner?.path),'files'),button(item.pinned?L('Unpin','إلغاء التثبيت'):L('Pin','تثبيت'),async()=>{item.pinned=!item.pinned;await api.saveStore();draw();}),button(L('Remove from library','إزالة من المكتبة'),()=>api.confirmDialog(L('Remove artifact','إزالة المخرج'),L('The file stays on disk; only its library entry is removed.','سيبقى الملف على القرص؛ سيُحذف مدخله من المكتبة فقط.'),async()=>{state().metadata.artifacts=state().metadata.artifacts.filter(x=>x.id!==item.id);await api.saveStore();draw();},L('Remove','إزالة'))));grid.append(c);}if(!rows.length)empty(grid,'No artifacts match this view.','لا توجد مخرجات مطابقة.');};search.oninput=draw;draw();
  }
  function renderRoutines(){return false;}
  function renderPage(page){
    if(page==='project-detail'){renderProject();return true;}if(page==='projects'){void renderProjects();return true;}if(page==='features'){renderFeatures();return true;}if(page==='activity'){renderActivity();return true;}if(page==='artifacts'){renderArtifacts();return true;}return renderRoutines();
  }
  function enhanceLayouts(){
    const panel=document.querySelector('#settings [data-panel="layout"]');if(!panel||panel.querySelector('.ns-layout-presets'))return;
    const wrap=make('div','ns-layout-presets');wrap.append(make('h4','',L('Workspace presets','تخطيطات مساحة العمل')));
    for(const [id,en,ar]of [['reference','Reference','المرجعي'],['focus','Focus','تركيز'],['review','Review','مراجعة'],['ide','IDE','برمجة'],['agent','Agent','وكيل']])wrap.append(button(L(en,ar),()=>{document.querySelector('#settingsclose')?.click();dock.applyPreset(id);}));
    const undo=button(L('Undo layout change','تراجع عن تغيير التخطيط'),()=>{document.querySelector('#settingsclose')?.click();if(!dock.undo())api.bridge.notice?.(L('There is no layout change to undo.','لا يوجد تغيير في التخطيط للتراجع عنه.'));});
    const save=button(L('Save current layout','حفظ التخطيط الحالي'),()=>api.formDialog(L('Save layout','حفظ التخطيط'),[{key:'name',label:L('Name','الاسم'),value:''}],v=>{if(!dock.saveNamed(v.name))throw Error(L('Enter a layout name.','أدخل اسمًا للتخطيط.'));}));
    const restore=button(L('Restore saved layout','استعادة تخطيط محفوظ'),e=>{const names=dock.named();if(!names.length){api.bridge.notice?.(L('No saved layouts yet.','لا توجد تخطيطات محفوظة بعد.'));return;}api.menu(e.currentTarget,names.map(name=>[name,()=>dock.restoreNamed(name)]));});
    const remove=button(L('Delete saved layout','حذف تخطيط محفوظ'),e=>{const names=dock.named();if(!names.length){api.bridge.notice?.(L('No saved layouts yet.','لا توجد تخطيطات محفوظة بعد.'));return;}api.menu(e.currentTarget,names.map(name=>[name,()=>api.confirmDialog(L('Delete layout','حذف التخطيط'),L(`Delete “${name}” from this computer?`,`حذف «${name}» من هذا الجهاز؟`),()=>dock.deleteNamed(name),L('Delete','حذف'))]));});
    const exportButton=button(L('Export layout','تصدير التخطيط'),()=>{const overlay=api.formDialog(L('Export layout','تصدير التخطيط'),[{key:'layout',label:L('Validated layout JSON','ملف التخطيط JSON بعد التحقق'),value:dock.exportLayout(),multiline:true,readonly:true}],async v=>{await navigator.clipboard.writeText(v.layout);api.bridge.notice?.(L('Layout copied to the clipboard.','نُسخ التخطيط إلى الحافظة.'));});const submit=overlay.querySelector('.ns-form-actions .ns-button:last-child');if(submit)submit.textContent=L('Copy','نسخ');});
    const importButton=button(L('Import layout','استيراد تخطيط'),()=>api.formDialog(L('Import layout','استيراد التخطيط'),[{key:'layout',label:L('Paste AbdoCode layout JSON','الصق ملف تخطيط AbdoCode بصيغة JSON'),value:'',multiline:true}],v=>{if(!dock.importLayout(v.layout))throw Error(L('This layout is invalid or uses an unsupported format.','هذا التخطيط غير صالح أو يستخدم صيغة غير مدعومة.'));}));
    wrap.append(undo,save,restore,remove,exportButton,importButton);panel.append(wrap);
  }
  function enhanceTopbar(){const layout=document.querySelector('#native-layout-menu'),features=document.querySelector('#native-features-menu');if(layout&&!layout.dataset.menu){layout.dataset.menu='';layout.onclick=e=>api.menu(e.currentTarget,[['Reference',()=>dock.applyPreset('reference')],['Focus',()=>dock.applyPreset('focus')],['Review',()=>dock.applyPreset('review')],['IDE',()=>dock.applyPreset('ide')],['Agent',()=>dock.applyPreset('agent')],[L('Layout settings','إعدادات التخطيط'),()=>native.settings('layout')]]);}if(features&&!features.dataset.menu){features.dataset.menu='';features.onclick=e=>api.menu(e.currentTarget,[[L('Feature directory','دليل الميزات'),()=>api.showPage('features')],[L('Skills','المهارات'),()=>native.settings('skills')],[L('Connectors','الاتصالات'),()=>native.settings('connections')],[L('Plugins','الإضافات'),()=>native.settings('plugins')],[L('Super Abdo Mode','وضع سوبر عبدو'),()=>native.settings('super')]]);}}
  function refresh(){addReferenceNavigation();enhanceLayouts();enhanceTopbar();if(['project-detail','features','activity','artifacts'].includes(state().page))renderPage(state().page);}
  function frame(value){if(['tool','accepted','approval','trust-request','done','unresolved','refused'].includes(value.kind)){activity.push({label:escapeText(value.cmd||value.name||value.kind),time:new Date().toLocaleTimeString()});if(state().page==='activity')renderActivity();}if(value.kind==='session'&&project){const meta=state().metadata?.sessions.find(s=>s.id===value.session);if(meta&&!meta.projectId){meta.projectId=project.id;api.saveStore().catch(()=>{});}}}
  refresh();
  return {renderPage,refresh,frame,settingsApplied:refresh,openProjectDetail,createPullRequest:openPullRequestDialog};
}
