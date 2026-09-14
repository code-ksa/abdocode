import {PROJECT_TEMPLATES} from './project-template-catalogue.js';

export function renderTemplateSettings(panel,api,lang){
  const t=(en,ar)=>lang==='ar'?ar:en;
  const el=(tag,text)=>{const n=document.createElement(tag);if(text)n.textContent=text;return n;};
  const help=el('p',t('Create a new project from 100 versioned starters on GitHub. Files are checked before extraction. Dependencies are installed separately after you review the setup instructions.','أنشئ مشروعًا جديدًا من 100 قالب محدد الإصدار على GitHub. تُفحص الملفات قبل استخراجها. تثبيت الحزم خطوة مستقلة بعد مراجعة تعليمات الإعداد.'));
  const search=el('input');search.type='search';search.placeholder=t('Search templates, frameworks, databases or packages','ابحث في القوالب وأطر العمل وقواعد البيانات والحزم');search.setAttribute('aria-label',search.placeholder);search.style.width='100%';
  const count=el('p'),list=el('div');list.className='nss-template-list';
  const repo=el('a',t('Browse source on GitHub','تصفح المصدر على GitHub'));repo.href='https://github.com/code-ksa/abdocode-templates';repo.target='_blank';repo.rel='noopener noreferrer';
  panel.append(help,repo,search,count,list);
  const draw=()=>{list.replaceChildren();const q=search.value.toLowerCase().trim().split(/\s+/);const matches=PROJECT_TEMPLATES.filter(item=>q.every(word=>`${item.id} ${Object.keys(item.packages).join(' ')}`.toLowerCase().includes(word)));count.textContent=t(`${matches.length} templates · ${Math.min(matches.length,20)} shown. Refine your search to find more.`,`${matches.length} قالبًا · يظهر ${Math.min(matches.length,20)}. حدّد البحث لعرض المزيد.`);
    for(const item of matches.slice(0,20)){
      const card=el('details'),heading=el('summary',item.id);heading.dir='ltr';card.style.cssText='border:1px solid var(--border,#ddd);border-radius:12px;padding:16px;margin:12px 0';card.append(heading);
      const description=el('p',`${item.framework} · ${item.database||t('No database','بدون قاعدة بيانات')} · ${item.orm||''} · ${item.features.join(', ')}`);description.dir='ltr';
      const packages=el('pre',Object.entries(item.packages).map(([name,version])=>`${name} ${version}`).join('\n'));packages.style.cssText='white-space:pre-wrap;font-size:12px';packages.dir='ltr';
      const setup=el('pre',item.setup.join('\n'));setup.dir='ltr';
      const label=el('label',t('New folder name or absolute location','اسم المجلد الجديد أو مساره الكامل'));const name=el('input');name.dir='ltr';name.value='my-'+item.framework+'-project';name.setAttribute('aria-label',label.textContent);name.style.cssText='display:block;width:100%;margin:8px 0';label.append(name);
      const create=el('button',t('Create project from this template','إنشاء مشروع من هذا القالب'));create.type='button';
      const note=el('p',t('A folder name uses your Documents folder. An existing folder is never overwritten. The new project becomes selected; the current project remains on disk.','يُنشأ الاسم داخل مجلد المستندات الخاص بك. لا يُستبدل مجلد موجود. يُحدد المشروع الجديد ويبقى المشروع الحالي على القرص.'));
      create.onclick=()=>{const target=name.value.trim();if(!target||/[\r\n\0]/.test(target)){name.reportValidity();return;}const accepted=api.bridge.submit(`project-template ${item.id} ${target}`);if(accepted){document.getElementById('settingsclose')?.click();api.showPage('session');}};
      card.append(description,packages,setup,label,note,create);list.append(card);
    }
  };search.oninput=draw;draw();
}
