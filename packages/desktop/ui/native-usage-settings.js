const $ = id => document.getElementById(id);

const finiteNonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validCount = value => finiteNonNegative(value) && Number.isSafeInteger(value);
const validRate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Validate the aggregate returned by the authenticated engine before rendering
 * it. The renderer never accepts ledger entries, paths, provider names or any
 * other free-form fields as usage evidence.
 */
const nonNegative = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** خلاصةُ العدّاد المحلي: مجاميعُ متّسقة أو لا شيء — لا أسماءُ مزوّدين ولا نماذج تُقبل هنا أصلاً. */
export function normaliseMeterSummary(value) {
  if (!value || typeof value !== 'object') return { status: 'unknown' };
  if (value.status === 'absent') return { status: 'absent' };
  if (value.status !== 'available') return { status: 'unknown' };
  const r = value.reported, c = value.charged;
  if (!r || !c || ![value.calls, value.localCalls, value.cloudCalls, value.ms, r.calls, r.inputTokens, r.outputTokens, c.inputTokens, c.outputTokens].every(nonNegative)) return { status: 'unknown' };
  if (value.localCalls + value.cloudCalls !== value.calls || r.calls > value.calls) return { status: 'unknown' };
  return { status: 'available', calls: value.calls, localCalls: value.localCalls, cloudCalls: value.cloudCalls, ms: value.ms,
    reported: { calls: r.calls, inputTokens: r.inputTokens, outputTokens: r.outputTokens }, charged: { inputTokens: c.inputTokens, outputTokens: c.outputTokens },
    malformed: nonNegative(value.malformed) ? value.malformed : 0 };
}

export function normaliseUsageSummary(value) {
  const capTokens = validCount(value?.capTokens) && value.capTokens > 0 ? value.capTokens : null;
  const cacheDiscount = validRate(value?.cacheDiscount) ? value.cacheDiscount : null;
  const base = {
    status: 'unknown', source: 'local-cloud-token-ledger', localModelsIncluded: false,
    capTokens, remainingTokens: null, calls: null, inputTokens: null,
    cachedInputTokens: null, outputTokens: null, rawTokens: null,
    effectiveTokens: null, cacheHitRate: null, cacheDiscount,
  };
  if (!value || value.status !== 'available' || value.source !== 'local-cloud-token-ledger'
    || value.localModelsIncluded !== false || capTokens === null || cacheDiscount === null) return base;
  const counts = ['remainingTokens','calls','inputTokens','cachedInputTokens','outputTokens','rawTokens','effectiveTokens'];
  if (counts.some(key => !validCount(value[key])) || !validRate(value.cacheHitRate)) return base;
  if (value.cachedInputTokens > value.inputTokens || value.rawTokens !== value.inputTokens + value.outputTokens
    || value.remainingTokens !== Math.max(0, capTokens - value.effectiveTokens)) return base;
  return {
    status: 'available', source: 'local-cloud-token-ledger', localModelsIncluded: false,
    capTokens, remainingTokens: value.remainingTokens, calls: value.calls,
    inputTokens: value.inputTokens, cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens, rawTokens: value.rawTokens,
    effectiveTokens: value.effectiveTokens, cacheHitRate: value.cacheHitRate,
    cacheDiscount,
  };
}

/** Clipboard-safe allowlist. Extra fields on an inbound frame never cross it. */
export function exportableUsageSummary(value) {
  const report = normaliseUsageSummary(value);
  if (report.status !== 'available') return null;
  return {
    schema: 'abdocode-cloud-usage-summary-v1',
    source: report.source,
    scope: 'recorded-cloud-model-calls-only',
    localModelsIncluded: false,
    providerAccountDataIncluded: false,
    totals: {
      calls: report.calls,
      inputTokens: report.inputTokens,
      cachedInputTokens: report.cachedInputTokens,
      outputTokens: report.outputTokens,
      rawTokens: report.rawTokens,
      effectiveTokens: report.effectiveTokens,
      cacheHitRate: report.cacheHitRate,
    },
    localSafetyCap: {capTokens:report.capTokens,remainingTokens:report.remainingTokens},
    cacheAccounting: {cachedInputFraction:report.cacheDiscount},
  };
}

export function mountUsageSettings(api) {
  const settings = $('settings');
  if (!settings) return {refresh(){}, frame(){}, settingsApplied(){}, dispose(){}};
  let lang = api.state?.lang === 'ar' ? 'ar' : 'en';
  let report = null;
  let loading = false;
  let error = '';
  let sequence = 0;
  let pendingRequestId = null;
  let timeout = null;
  const t = (en, ar) => lang === 'ar' ? ar : en;
  const make = (tag, className = '', text = '') => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== '') element.textContent = text;
    return element;
  };
  const number = value => new Intl.NumberFormat(lang === 'ar' ? 'ar-SA' : 'en-US', {maximumFractionDigits: 0}).format(value);
  const percent = value => new Intl.NumberFormat(lang === 'ar' ? 'ar-SA' : 'en-US', {style:'percent', maximumFractionDigits:1}).format(value);
  const panel = id => settings.querySelector(`[data-panel="${id}"]`);

  function summary(target, text) { target.append(make('p','nss-summary',text)); }
  function fact(target, label, value, detail = '') {
    const row = make('div','nss-fact');
    const copy = make('div'); copy.append(make('strong','',label));
    if (detail) copy.append(make('small','',detail));
    const shown = make('span','nss-value',String(value)); shown.dataset.userContent = '';
    row.append(copy, shown); target.append(row); return row;
  }
  function action(target, label, detail, buttonLabel, run, primary = false) {
    const row = make('div','nss-action-row');
    const copy = make('div'); copy.append(make('strong','',label), make('small','',detail));
    const control = make('button',`nss-action${primary ? ' primary' : ''}`,buttonLabel);
    control.type = 'button'; control.onclick = run;
    row.append(copy,control); target.append(row); return control;
  }
  function heading(target, en, ar) { target.replaceChildren(make('h3','',t(en,ar))); }
  function status(target, text, kind = '') { target.append(make('span',`nss-status nss-status-neutral ${kind}`.trim(),text)); }

  function renderUsage() {
    const target = panel('nss-usage');
    if (!target) return;
    heading(target,'Usage','الاستخدام');
    summary(target,t(
      'These totals come from AbdoCode’s local cloud-token safety ledger. They cover recorded cloud model calls only; local models are excluded.',
      'تأتي هذه المجاميع من دفتر أمان التوكنز السحابية المحلي لعبدو كود. وهي تغطي استدعاءات النماذج السحابية المسجلة فقط؛ ولا تشمل النماذج المحلية.'
    ));
    if (loading && report === null) status(target,t('Reading local ledger…','جارٍ قراءة الدفتر المحلي…'));
    if (error) status(target,error,'nss-status-warning');
    if (report?.status === 'available') {
      const used = Math.min(report.effectiveTokens, report.capTokens);
      const block = make('section','nus-budget');
      const top = make('div','nus-budget-head');
      const copy = make('div');
      copy.append(make('strong','',t('Local cloud safety cap','سقف أمان السحابة المحلي')),
        make('small','',t('This is an AbdoCode guardrail, not your provider plan or balance.','هذا حاجز أمان داخل عبدو كود، وليس خطة المزوّد أو رصيده.')));
      top.append(copy,make('span','nus-budget-value',`${number(report.effectiveTokens)} / ${number(report.capTokens)}`));
      const meter = make('progress','nus-budget-meter'); meter.max = report.capTokens; meter.value = used;
      meter.setAttribute('aria-label',t('Effective cloud tokens used under the local safety cap','التوكنز السحابية الفعالة المستخدمة ضمن سقف الأمان المحلي'));
      block.append(top,meter); target.append(block);
      const grid = make('div','nus-stat-grid');
      for (const [label,value,detail] of [
        [t('Cloud calls','الاستدعاءات السحابية'),number(report.calls),t('Recorded calls','استدعاءات مسجلة')],
        [t('Effective tokens','التوكنز الفعالة'),number(report.effectiveTokens),t('Used by the safety cap','تُحسب على سقف الأمان')],
        [t('Raw tokens','التوكنز الخام'),number(report.rawTokens),t('Input plus output','الإدخال مع الإخراج')],
        [t('Remaining to local cap','المتبقي للسقف المحلي'),number(report.remainingTokens),t('Not provider credit','ليس رصيد المزوّد')],
      ]) {
        const card = make('div','nus-stat'); card.append(make('span','',label),make('strong','',value),make('small','',detail)); grid.append(card);
      }
      target.append(grid);
      fact(target,t('Input tokens','توكنز الإدخال'),number(report.inputTokens));
      fact(target,t('Cached input tokens','توكنز الإدخال المخبأة'),number(report.cachedInputTokens),t(`Cache hit rate ${percent(report.cacheHitRate)}`,`نسبة إصابة الخبيئة ${percent(report.cacheHitRate)}`));
      fact(target,t('Output tokens','توكنز الإخراج'),number(report.outputTokens));
      fact(target,t('Cached-input accounting','محاسبة الإدخال المخبأ'),percent(report.cacheDiscount),t('Configured fraction charged when cached usage is reported.','النسبة المضبوطة التي تُحسب عندما يبلّغ المزوّد عن الاستخدام المخبأ.'));
      renderMeter(target);
      fact(target,t('Local model usage','استخدام النماذج المحلية'),meter?.status==='available'?t('See the local meter above','انظر العدّاد المحلي أعلاه'):t('Not in this ledger','غير موجود في هذا الدفتر'),t('No local token totals are invented.','لا تُختلق مجاميع توكنز محلية.'));
    } else if (!loading) {
      status(target,t('Usage unknown','الاستخدام غير معروف'),'nss-status-warning');
      summary(target,t(
        'The local ledger could not be read safely. AbdoCode does not assume zero usage when the ledger is unreadable.',
        'تعذرت قراءة الدفتر المحلي بأمان. لا يفترض عبدو كود أن الاستخدام صفر عندما يتعذر فهم الدفتر.'
      ));
      if (report && report.capTokens !== null) fact(target,t('Configured local safety cap','سقف الأمان المحلي المضبوط'),number(report.capTokens));
    }
    const refresh = action(target,t('Refresh usage','تحديث الاستخدام'),t('Read the aggregate again from the local engine.','اقرأ المجموع مرة أخرى من المحرك المحلي.'),loading?t('Refreshing…','جارٍ التحديث…'):t('Refresh','تحديث'),requestUsage,true);
    refresh.disabled = loading;
    action(target,t('Accounting controls','ضوابط المحاسبة'),t('Review the existing cache-accounting capability and runtime policy.','راجع إمكانية محاسبة الخبيئة وسياسة التشغيل الحالية.'),t('Open','فتح'),()=>api.native.settings('plugins'));
  }

  // ذ5 — العدّادُ المحلي: مجاميعُ من ملفٍّ على قرصك لكلّ نداءٍ محلّيٍّ أو سحابيّ؛ لا أسماءَ مزوّدين ولا نماذج هنا.
  function renderMeter(target) {
    if (!meter || meter.status !== 'available') return;
    const block = make('section','nus-budget');
    const head = make('div','nus-budget-head');
    const copy = make('div');
    copy.append(make('strong','',t('Local call meter','العدّاد المحلي للنداءات')),
      make('small','',t('Every model call, local or cloud, counted on this machine only — never sent anywhere.','كلُّ نداءِ نموذجٍ، محلّيٍّ أو سحابيّ، يُعدّ على هذا الجهاز وحده — لا يُرسل إلى أحد.')));
    head.append(copy,make('span','nus-budget-value',`${number(meter.calls)}`));
    block.append(head); target.append(block);
    const grid = make('div','nus-stat-grid');
    for (const [label,value,detail] of [
      [t('Local calls','نداءات محلية'),number(meter.localCalls),t('Local models','نماذج محلية')],
      [t('Cloud calls','نداءات سحابية'),number(meter.cloudCalls),t('Cloud providers','مزوّدون سحابيون')],
      [t('Time in model calls','الزمن في النداءات'),`${number(Math.round(meter.ms/1000))} s`,t('Wall clock, summed','ساعةُ الحائط مجموعةً')],
      [t('Reported tokens','التوكنز المبلَّغة'),`${number(meter.reported.inputTokens)} / ${number(meter.reported.outputTokens)}`,t(`Input / output, from ${number(meter.reported.calls)} reporting calls`,`إدخال / إخراج، من ${number(meter.reported.calls)} نداءً أعلن استعمالَه`)],
    ]) {
      const card = make('div','nus-stat'); card.append(make('span','',label),make('strong','',value),make('small','',detail)); grid.append(card);
    }
    target.append(grid);
    if (meter.malformed > 0) fact(target,t('Unreadable meter lines','أسطرٌ غير مقروءة في العدّاد'),number(meter.malformed),t('Counted, never repaired.','تُعدّ ولا تُصلَّح.'));
  }

  function renderBilling() {
    const target = panel('nss-billing');
    if (!target) return;
    heading(target,'Billing','الفوترة');
    summary(target,t(
      'AbdoCode has no account billing service in this build and does not receive provider plans, prices, balances, reset times or invoices.',
      'لا يملك عبدو كود خدمة فوترة للحساب في هذا الإصدار، ولا يستقبل خطط المزوّدين أو أسعارهم أو أرصدتهم أو مواعيد التجديد أو الفواتير.'
    ));
    status(target,t('Provider billing unavailable locally','فوترة المزوّد غير متاحة محليًا'));
    if (report?.status === 'available') {
      fact(target,t('Recorded cloud calls','الاستدعاءات السحابية المسجلة'),number(report.calls),t('Local ledger total; not an invoice.','مجموع الدفتر المحلي؛ وليس فاتورة.'));
      fact(target,t('Effective cloud tokens','التوكنز السحابية الفعالة'),number(report.effectiveTokens),t('Safety accounting; no money estimate is inferred.','محاسبة أمان؛ ولا يُستنتج منها تقدير مالي.'));
    } else {
      fact(target,t('Local usage evidence','دليل الاستخدام المحلي'),t('Unavailable','غير متاح'));
    }
    const custom = api.bridge.snapshot()?.settings?.customProviders;
    fact(target,t('Custom provider configurations','إعدادات المزوّدين المخصصة'),Array.isArray(custom)?number(custom.length):t('Unavailable','غير متاح'));
    const exportButton = action(target,t('Export usage summary','تصدير ملخص الاستخدام'),t('Copy only the validated aggregate shown here. No ledger entries, paths, provider names or credentials are included.','انسخ المجموع المتحقق منه المعروض هنا فقط. لا تُضمَّن قيود الدفتر أو المسارات أو أسماء المزوّدين أو بيانات الاعتماد.'),t('Copy JSON','نسخ JSON'),exportUsage);
    exportButton.disabled = loading || report?.status !== 'available';
    action(target,t('Provider accounts','حسابات المزوّدين'),t('Open provider setup. Billing remains in each provider’s own account.','افتح ضبط المزوّدين. تبقى الفوترة داخل حساب كل مزوّد.'),t('Open providers','فتح المزوّدين'),()=>api.native.settings('providers'),true);
  }

  function render() { renderUsage(); renderBilling(); }
  function clearWait() { if (timeout !== null) { clearTimeout(timeout); timeout = null; } }
  async function exportUsage() {
    if (report?.status !== 'available') return;
    // Reconstruct the export from the normalized allowlist instead of copying
    // the inbound frame. This keeps future engine fields out by default.
    const exported = exportableUsageSummary(report);
    if (exported === null) return;
    try {
      await navigator.clipboard.writeText(`${JSON.stringify(exported,null,2)}\n`);
      api.bridge.notice?.(t('Usage summary copied to the clipboard.','نُسخ ملخص الاستخدام إلى الحافظة.'));
    } catch (failure) {
      api.bridge.notice?.(t('Could not copy the usage summary: ','تعذر نسخ ملخص الاستخدام: ')+String(failure));
    }
  }
  function requestUsage() {
    if (loading) return;
    loading = true; error = ''; pendingRequestId = `native-usage-${Date.now()}-${++sequence}`; render();
    const requestId=pendingRequestId;
    const failed=failure=>{
      if(pendingRequestId!==requestId)return;
      clearWait();loading=false;pendingRequestId=null;
      error=t('Could not request local usage: ','تعذر طلب الاستخدام المحلي: ')+String(failure);render();
    };
    try {
      timeout = setTimeout(() => {
        if (!loading) return;
        loading = false; pendingRequestId = null;
        error = t('The local engine did not return usage data.','لم يُرجع المحرك المحلي بيانات الاستخدام.');
        render();
      },8000);
      Promise.resolve(api.bridge.send({kind:'usage-get',requestId})).catch(failed);
      // ذ5: العدّادُ المحلي (محلّيّ وسحابيّ، بزمنه) إطارٌ منفصل — غيابُه لا يُسقط الخلاصةَ السحابية.
      Promise.resolve(api.bridge.send({kind:'meter-get',requestId})).catch(()=>{});
    } catch (failure) {
      failed(failure);
    }
  }
  function frame(value) {
    if (value?.kind === 'meter-summary') { if (!pendingRequestId || value.requestId === undefined || value.requestId === pendingRequestId) { meter = normaliseMeterSummary(value.summary); render(); } return; }
    if (value?.kind !== 'usage-summary') return;
    if (pendingRequestId && value.requestId !== undefined && value.requestId !== pendingRequestId) return;
    clearWait(); loading = false; pendingRequestId = null;
    report = normaliseUsageSummary(value.summary);
    error = report.status === 'unknown' ? t('The local usage ledger is unreadable or inconsistent.','دفتر الاستخدام المحلي غير مقروء أو غير متسق.') : '';
    render();
  }
  // The settings owner announces structural redraws separately from page opens.
  // A redraw must never create I/O; opening Usage/Billing explicitly requests a
  // fresh aggregate. Listen on both global targets so either dispatch location
  // is supported, while `loading` coalesces a bubbling duplicate.
  const onSettingsRendered = () => render();
  const onSettingsOpened = event => {
    if (event?.detail?.id === 'nss-usage' || event?.detail?.id === 'nss-billing') requestUsage();
  };
  function refresh() { render(); }
  function settingsApplied(next) { lang = next?.language === 'ar' ? 'ar' : 'en'; render(); }
  for (const target of [window,document]) {
    target.addEventListener('abdocode:settings-rendered',onSettingsRendered);
    target.addEventListener('abdocode:settings-opened',onSettingsOpened);
  }
  render();
  return {refresh,frame,settingsApplied,requestUsage,dispose(){clearWait();for(const target of [window,document]){target.removeEventListener('abdocode:settings-rendered',onSettingsRendered);target.removeEventListener('abdocode:settings-opened',onSettingsOpened);}}};
}
