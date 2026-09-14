/**
 * سجلّ الإضافات — مصدرٌ واحد لفضاء `settings.plugins`.
 *
 * دمجُ فكرتين ممتصّتين (dsh): «فواصل الإعدادات ذات المخطّط» و«جردُ الإضافات
 * الحيّ + شروطها». الجدول أدناه يحمل الوصف (النصّ المعروض، الافتراض، توقيت
 * السريان، حاجة الخزنة) **و** موضع القراءة الحقيقيّ في المحرّك — فاسمٌ
 * يُعرض في اللوحة ولا يقرؤه أحد يُوسم `wired: false` بصدق («مسجَّلة ≠ قابلة
 * للاستدعاء»)، لا يُخفى.
 *
 * القواعد الحاكمة:
 * - **الوحدة نقيّة**: لا `node:` ولا `process` ولا DOM — البيئة تُمرَّر إليها.
 * - **فشلٌ مُغلق في كل خطوة**: اسمٌ مجهول، قيمةٌ ليست منطقيّة، قاعدةٌ لا
 *   تُحلَّل، قاعدةٌ والقواعد مطفأة، تثبيتٌ مشوَّه من البيئة — كلّها ترفض
 *   بالاسم أو تُحلّ إلى `false`، ولا تعود إلى الافتراض أبداً.
 * - **النحو مغلق**: خمسة مفاتيح سياق، `==` و`!=`، `&&` و`||`، بلا أقواس ولا
 *   نفي ولا اقتباس ولا دوال. لا `eval` ولا `new Function` — أبداً.
 * - **التوقيت يُروى ولا يُبدَّل**: `site` يصف متى يُقرأ المفتاح فعلاً (دور،
 *   حقبة، نداء، باب الإعدادات)، والجرد يسجّل ما جرى لا يغيّره.
 */

export type PluginApplies = "next-turn" | "immediate" | "restart"
/** موضع القراءة كما هو مقيس في المحرّك؛ `none` = لا قارئ، `panel` = القشرة وحدها. */
export type ReaderSite = "turn" | "epoch" | "call" | "door" | "panel" | "none"
/** المواضع التي يمكن لقارئٍ حيّ أن يعلنها عند القراءة. */
export type ReadSite = "turn" | "epoch" | "call" | "door"

export type PluginName =
  | "delegation"
  | "reviewer"
  | "activity"
  | "terminalPanel"
  | "serversPanel"
  | "mcpClient"
  | "inboundGuard"
  | "standingGrants"
  | "unattendedDeny"
  | "denialBreaker"
  | "tasksPanel"
  | "walls"
  | "verifier"
  | "toolVerdict"
  | "miner"
  | "readCompaction"
  | "trailCompaction"
  | "cacheAccounting"
  | "resumeIntent"
  | "turnBudget"
  | "receiptFixtures"
  | "intentField"
  | "approvalTakeover"
  | "trajectory"
  | "deliverables"
  | "secretIntake"
  | "sessionAwareness"
  | "projectAwareness"
  | "generalAwareness"
  | "semanticFrame"
  | "semanticInfer"
  | "lessons"
  | "usageMeter"
  | "settingsSeam"
  | "inventory"
  | "rules"

export type MetaPluginName = "settingsSeam" | "inventory" | "rules"

export interface PluginDescriptor {
  readonly name: PluginName
  /** نصّ العنوان كما كان في صفّ اللوحة الثابت — منقولٌ حرفاً بحرف. */
  readonly label: string
  /** نصّ `<small>` كما كان في صفّ اللوحة الثابت — منقولٌ حرفاً بحرف. */
  readonly description: string
  /** يجب أن يساوي احتياطَ القارئ: `!== false` ⇒ true، `=== true` ⇒ false. */
  readonly defaultOn: boolean
  readonly applies: PluginApplies
  /** أين يُقرأ فعلاً (مقيس في الشجرة، لا مُدّعى). */
  readonly site: ReaderSite
  /** false = مُعلَنٌ بلا قارئ: «غير موصول بعد». */
  readonly wired: boolean
  /** مقابض الخزنة التي تحتاجها الإضافة — حضورٌ لا قيمة (لا سرّ في الإعدادات). */
  readonly requiresVault: readonly string[]
  /** مفتاحٌ حاكم: منطقيٌّ فقط، ولا يقبل شرطاً. */
  readonly meta?: true
}

/**
 * الترتيب هنا هو ترتيب صفوف اللوحة المولَّدة **وترتيب خريطة الاستعادة**.
 * (قبل هذا السبرنت كان الترتيبان مختلفَين: `trailCompaction` كان يقع بعد
 * `toolVerdict` في خريطة الاستعادة وبعد `readCompaction` في صفوف اللوحة.
 * وُحّدا على ترتيب اللوحة — الترتيب المرئيّ — وتبديلُ ترتيب مفاتيح كائنٍ
 * ليس تبديلَ قيمة؛ اختبار re-pin يثبت أن المجموعة والقيم لم تتغيّر.)
 */
export const PLUGINS: readonly PluginDescriptor[] = Object.freeze([
  // S13.5 — المفتاحان الميتان أُعطيا قارئَين حقيقيَّين، واسمُ الأوّل صُحّح إلى
  // ما يفعله فعلاً: لا «سربَ عمّالٍ متوازين» (لا وجود له، ولا يُبنى في هذا
  // السبرنت) بل **تفويضٌ واحدٌ متسلسل** إلى وكيل دور. جردٌ يعد بسربٍ ويسلّم
  // طفلاً واحداً يكذب في الاتجاه الذي يصدّقه المشغّل — فالاسمُ والوصف يُقلبان
  // مع الوصل في التغيير نفسه (سابقةُ `activity`).
  Object.freeze({
    name: "denialBreaker",
    label: "قاطعُ الرفض المتكرّر",
    description: "طلبٌ رُفض ثلاث مرّاتٍ في هذه الجلسة يُقطع بلا سؤالٍ رابع. العطلُ الذي يعالجه: نموذجٌ يعيد ما رُفض بصيغةٍ أخرى فيُسأل المشغّلُ السؤالَ نفسَه مراراً حتى يملّ فيوافق — وإرهاقُ الموافقة بابٌ خلفيٌّ بلا كود. **يبدأ مطفأً** لأنّه يقرّر نيابةً عن المشغّل؛ أمّا **عرضُ التاريخ** (كم مرّةً رُفض هذا الطلب) فيصحب كلَّ سؤالٍ بلا مفتاح، لأنّ إخفاء تاريخٍ يملكه النظامُ عمّن يقرّر ليس حياداً. والعدُّ للجلسة وحدها ولا يُكتب على قرص، والمحوُ من «الصلاحيات» يعيد السؤال.",
    defaultOn: false,
    applies: "immediate",
    site: "call",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "unattendedDeny",
    label: "الصمتُ رفضٌ بعد مهلة",
    description: "سؤالُ موافقةٍ لا يجيبه أحدٌ ينتهي رفضاً بعد مهلة، بدل أن يعلّق الدورَ إلى الأبد. المهلةُ من الإعدادات (approvalTimeoutSeconds، من 10 ثوانٍ إلى أربع ساعات، والافتراض عشر دقائق)، والانتهاءُ يُعلَن بإطارٍ فتُحدَّث كتلةُ السؤال في القشرة ويُكتب في الدفتر. **مشتغلٌ افتراضاً** لأنّه ينفّذ قاعدةً مكتوبةً في البوّابة نفسِها منذ البداية — «الصمت ليس إذناً» — ولم يكن لها آليّة: الدورُ كان يقف بلا نهاية. المعطَّل = الانتظارُ بلا حدّ كما كان.",
    defaultOn: true,
    applies: "immediate",
    site: "call",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "standingGrants",
    label: "منحٌ قائمٌ لهذه الجلسة",
    description: "إذنٌ مكتوبُ النطاق يُقال مرّةً بدل أن يُسأل عشراً: «هذه الأداة» أو «كلّ أدوات هذا الخادم»، لصنفٍ واحدٍ بعينه. مقيَّدٌ بالصنف والهدف معاً (منحُ read لا يفتح command)، ولا منحَ عامّاً (أوسعُه بادئةُ مزوّدٍ منتهيةٌ بنقطة)، ولا يُكتب على قرصٍ ولا ينجو من إعادة تشغيل، ويُعلَن عند كلّ استعمال، ويُنقض بنقرة. **يبدأ مطفأً** لأنّه يخفّف بوّابةً: الحارسُ يبدأ مشتغلاً، والتخفيفُ يبدأ مطفأً. المعطَّل = كلُّ نداءٍ يُسأل كما كان.",
    defaultOn: false,
    applies: "immediate",
    site: "call",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "inboundGuard",
    label: "حارس الوارد",
    description: "نصُّ الأدوات — صفحةٌ، أو نتيجةُ بحث، أو ملفٌّ، أو أداةُ خادم MCP — يُفحص بقواعدَ مسمّاةٍ قبل أن يبلغ النموذج: تجاوزُ التعليمات، وانتحالُ الهويّة، وطلبُ التسريب، وتزويرُ إطارِ أداة، ومحارفُ الإخفاء. والفعلُ **وسمٌ لا مقصّ**: لا يُحذف نصُّ أحد، بل يُعلَن ما أُطلق ويُسبَق النصُّ بسطرِ «بياناتٌ لا أوامر»؛ ووسومُ الأدوار وحدها تُبطَّل لأنّها محاكاةُ بروتوكولٍ لا نصٌّ للقارئ. الكشفُ على نسخةٍ مطبَّعةٍ (تشكيل وتطويل وهمزات وأرقام وصفرُ عرض) وبمتغيّراتٍ (بدائلُ الأرقام، وضمُّ المسافات) — والنظيفُ يخرج مطابقاً بايتاً ببايت، فلا كلفةَ في الحالة الغالبة. المعطَّل = النصُّ يمرّ كما هو.",
    defaultOn: true,
    applies: "immediate",
    site: "call",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "mcpClient",
    label: "عميل MCP",
    description: "توصيلُ خوادم MCP القياسيّة (JSON-RPC 2.0 على stdio) كمزوّدي أدوات: initialize ثمّ tools/list ثمّ tools/call. أدواتُها تدخل الكتالوجَ منسوبةً بـ«<خادم>.<أداة>» وتمرّ ببوّابة الموافقة نفسِها، وصنفُها command دائماً — تلميحُ readOnlyHint إقرارُ طرفٍ ثالثٍ عن نفسه لا دليل. المعطَّل = وحدةُ العميل لا تُستورَد أصلاً، وطلبُ التوصيل بـmcp يُرفض بالاسم. وكلُّ توصيلٍ قرارُ مالكٍ صريح، لا ثقةَ مشتقّةٌ من توصيلٍ سابق.",
    defaultOn: false,
    applies: "immediate",
    site: "call",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "delegation",
    label: "التفويض إلى وكيل دور",
    description: "أداةُ delegate: مهمّةٌ تُسلَّم لوكيلٍ سقفُه أدواته المعلَنة، بحِقبٍ وإيصالاتٍ ووعيٍ خاصّة به، وبسقفِ إنفاقِ الدور وبوّابتِه ونمطِه نفسها. المعطَّل = الأداة لا تُعلَن ولا تُوزَّع (رفضٌ بالاسم)، والعمقُ مسقوفٌ بواحد في الحالتين.",
    defaultOn: false,
    applies: "next-turn",
    site: "call",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "reviewer",
    label: "وكيل المراجعة قراءة-فقط",
    description: "يُدرج وكيل «reviewer» في كتالوج التفويض: يقرأ ما كُتب ويسمّي عيوبه ولا يصلحها — وقراءتُه-فقط مشتقّةٌ من أدواته المعلَنة لا من نثر متنه. المعطَّل = الوكيل غائبٌ عن الكتالوج، وتفويضٌ إليه يُرفض بالاسم.",
    defaultOn: false,
    applies: "next-turn",
    site: "call",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "activity",
    label: "لوحة نشاط الدور",
    description: "المخرجات والمصادر والمتصفّح الحيّ فوق لوح التصفّح. مطفأةٌ افتراضياً بأمر المالك (2026-09-04): اللوح صار للمتصفّح وحده كما في المرجع. والمطفأ يُنزع من الشجرة لا يُخفى بصنفٍ — فلا يشغل تخطيطاً ولا يقرؤه قارئُ الشاشة. تشغيلُها يعيدها إلى موضعها بمرساةٍ محفوظة.",
    defaultOn: false,
    applies: "immediate",
    // قيس 2026-09-02: كانت اللوحة تُرسم دائماً ولا تستشير المفتاح أصلاً —
    // فوُسم «لا قارئ» بصدق. ووُصل مع سبرنت المسلَّمات (IDEA 9): القشرة تقرؤه
    // على ready/settings وتخفي اللوحة بـ`#activity.hidden` القائم. الوصف
    // يُقلب مع الوصل في التغيير نفسه — جردٌ يكذب في الاتجاه المعاكس أسوأ من
    // الثغرة التي يبلغ عنها.
    site: "panel",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "terminalPanel",
    label: "لوح الطرفية",
    description: "لوحٌ يعرض أوامرَ الجلسة وإيصالاتِها بألسنة، وحقلُ أمرٍ يمرّ ببوابة النمط نفسِها. **إيصالاتٌ لا بثٌّ حيّ**: خرجُ الأمر يُستنزف كاملاً في المُطلِق قبل أن يصل، فلوحٌ يوهم بالحياة يكذب. لا فولد ثانياً — الصفوف من فولد المسار القائم. المعطَّل = لا لوح ولا وحدة تُحمَّل.",
    defaultOn: true,
    applies: "immediate",
    site: "panel",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "serversPanel",
    label: "لوح الخوادم المُدارة",
    description: "لوحٌ يعرض خوادمَ التطوير المُدارة بحالةٍ مقيسة (يعمل/غير عامل بسببه) وزرِّ فتحٍ وإيقاف. **ويغيّر عمرَها**: مشتعلاً تبقى الخوادم بين الأدوار حتى يوقفها المشغّل أو يُغلق المحرّك؛ مطفأً تُقتل عند نهاية كلّ دور كما كانت حرفياً. أطفئه إن أردت ألّا يبقى خادمٌ يعمل بعد انتهاء دورك.",
    defaultOn: false,
    applies: "immediate",
    site: "panel",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "tasksPanel",
    label: "لوح المهامّ",
    description: "عمودٌ يعرض الدورَ الجاري بحقبه وأدواته وأزمنته، والأدوارَ الأخيرة بحكمها. عرضٌ فوق فولد المسار القائم — لا فولد ثانياً ولا كلفة على المحرّك ولا نصٌّ يراه النموذج. المعطَّل = لا لوح ولا وحدة تُحمَّل.",
    defaultOn: true,
    applies: "immediate",
    site: "panel",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "walls",
    label: "كاشف الجدران الخارجية",
    description: "جدار بيئة تكرر (اعتماد غائب/تنصيب/صلاحية) = تسليم صادق باسمه بدل حرق الحقب. عيوب النموذج الذاتية لا تُحتسب أبداً.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "verifier",
    label: "المحكّم الدلالي للتسليم",
    description: "بعد نجاح البوابات الميكانيكية، نموذج يحكم: هل فُعل المطلوب فعلاً؟ حكم رباعي، ولا فشل مفتوحاً. قيد التأهيل الحي.",
    defaultOn: false,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "toolVerdict",
    label: "حكم صريح من الأداة",
    description: "الحكم من حقول المنفّذ لا من نص الإيصال؛ التعبير النمطي احتياطٌ يُعدّ. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "miner",
    label: "معدِّن الكتيّبات",
    description: "فشل متكرر لا يعرفه السجل يُرشَّح كتيّباً جديداً للمشرف — ترشيح لا حفظ، وبصفر تكلفة نموذج.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "readCompaction",
    label: "ضغط إيصالات القراءة",
    description: "القراءات القديمة تُطوى إلى بصمة حين تتضخّم الحقبة؛ الأحدث تبقى كاملة. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "epoch",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "trailCompaction",
    label: "ضغط إيصالات التنفيذ",
    description: "إيصالات run/write/edit القديمة تُطوى إلى سطر الحكم؛ الأحدث تبقى كاملة. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "epoch",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "cacheAccounting",
    label: "حساب الكاش في الميزانية",
    description: "التوكنز المخبوءة عند المزوّد تُحسب بخصمها لا كاملة. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "call",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "resumeIntent",
    label: "آلية اكمل من حيث توقفت",
    description: "دورٌ يقول اكمل فقط يرث هدف الدور السابق وبواباته ويقرأ التسليم أولاً. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "turnBudget",
    label: "سقف إنفاق الدور",
    description: "سقف بالتوكنز الفعّالة لكل دور من ABDO_TURN_TOKEN_CAP؛ سماحة واحدة حين يبقى فحص قبول أو سبرنت واحد. بلا متغيّر = لا سقف؛ قيمة مشوَّهة = رفض النداءات باسمه لا سقف افتراضي. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "receiptFixtures",
    label: "التقاط إيصالات الحوادث",
    description: "إيصالات run الكاملة تُحجَب أسرارُها وتُكتب محلياً بسقفٍ لكل دور (لا تُرسل إلى أحد)، فتُرقّى الحادثة سجلَّ اختبارٍ يُعاد تشغيله. المعطَّل = لا مِلقَط ولا مجلّد ولا أمر fixture. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "intentField",
    label: "حقل النيّة ودروس المخالفة",
    description: "سطر نية لكل أداة؛ عند الفشل يُقطَّر فرق النية والواقع درساً دائماً ≤25 كلمة بلا نداء نموذج. يسري من الدور القادم. قيد التأهيل المحلي.",
    defaultOn: false,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "approvalTakeover",
    label: "استيلاء الموافقة على المؤلِّف",
    description: "طلب الموافقة يستولي على مقعد المؤلِّف ولا يعود منه إلا على قرارٍ مكتوب، والسؤالُ والقرار يُثبتان في الدفتر الدائم زوجاً فيُقرآن بعد إعادة التشغيل. المعطَّل = الكتلة القديمة في المحادثة بلا سطرَي 🔐. حسمُ الموافقة المعلّقة رفضاً عند المقاطعة يقع في الحالتين — إصلاح عطلٍ لا ميزة.",
    defaultOn: true,
    applies: "immediate",
    site: "call",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "trajectory",
    label: "لسان مسار الدور",
    description: "عدسة تشخيصية فوق الأُطر القائمة: الأداة ونتيجتها صفٌّ واحد بحكمه وسببه وزمنه، وأسطر الأحداث بنصّها لا محسوبةً من جديد. صفرُ كلفةٍ على المحرّك وصفرُ نصٍّ يراه النموذج. المعطَّل = لا لسان ولا مخزن ولا تحميل للوحدة.",
    defaultOn: true,
    applies: "immediate",
    site: "panel",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "deliverables",
    label: "المسلَّمات من مواضع الأثر",
    description: "صفٌّ لكل ملفٍ كُتب وخادمٍ رُفع، من حكم الأداة الصريح وحده لا من نصّ الإيصال؛ ومع «حكم صريح من الأداة» معطَّلاً لا مسلَّمات أصلاً (فراغٌ صادق لا استنتاج). المعطَّل = لا حقل locations على الأُطر، ولوحة النشاط كما كانت. يسري من الدور القادم. ومطفأٌ افتراضياً بأمر المالك (2026-09-04): صفُّه يسكن لوحةَ النشاط، وقد أُطفئت — فتشغيلُه وحده يبني قسماً في مضيفٍ غائب.",
    defaultOn: false,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "secretIntake",
    label: "الإدخال المُعان للأسرار وتحذير التدوير",
    description: "اعتمادٌ يصل في نصّ المحادثة يُحجب قبل أن يُقبل في الدفتر أو تُكتب حقيقة الدور أو يراه نموذج، ويُعلَن محروقاً بخطوة تدويره. المفعَّل يزيد: يُفتح محرّرُ نصٍّ لإدخال البديل في خزنةٍ محميّة باسمك ثم يُزفَّر الملفّ ويُحذف — فلا عمل يدويّ. المعطَّل: الكشفُ والحجبُ ومنعُ التخزين تقع كما هي (أرضيّةُ أمانٍ ليست اختيارية)، ولا محرّرَ يُفتح ولا ملفَّ خزنةٍ يُكتب. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    // حضورٌ لا قيمة: المقبض يُشتقّ من شكل الاعتماد ساعتَه، فلا مقبضَ ثابتٌ
    // يُعلَن هنا — والإعدادات لا تحمل سرّاً أبداً.
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "sessionAwareness",
    label: "وعي الجلسة — خلاصة كل حقبة",
    description: "النموذج يُلحق خلاصةً (فُعل/فُهم/قُرّر/المانع) بالردّ الخاتم للحقبة نفسها — بلا نداء إضافي — فتُراجَع ضدّ إيصالات الدور: ما لا إيصال له يُسقَط ولا يُخزَّن، والباقي يُحفظ session:<الجلسة>:summary ويُحقن في كل حقبة لا الأولى. المعطَّل = لا كتلة ولا جملة موجِّهة ولا حقن ولا حفظ. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "projectAwareness",
    label: "وعي المشروع — ABDO-AWARENESS.md",
    description: "فهرسٌ حيّ في جذر المشروع (حقائق مقيسة، قرارات المالك، فخاخ، حالة السبرنتات) يُدمج لا يُدهس عند تمام الدور ويُقرأ أولاً في كل دور. لا يُكتب في مشروعٍ غير موثوق، ويمرّ بحجب الأسرار قبل الكتابة. المعطَّل = لا قراءة ولا ملفّ يُلمس. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "generalAwareness",
    label: "الوعي العام — ذاكرة عابرة للمشاريع",
    description: "دروسٌ عامّة (كتيّبات معتمَدة بعد تأهيلها بجولةٍ مكتملة) تُخزَّن في دليل التثبيت وتُقرأ في كل مشروع موسومةً «معرفة عامّة لا قياس عن هذا المشروع». الترقية إليها مقنَّنة: حجبُ الأسرار قبل الكتابة، ورفضٌ بالاسم لكلّ ما يحمل مساراً أو مضيفاً أو منفذاً أو معرّفاً أو اسماً من مشروع الدور — فلا يعبر شيءٌ من مشروع عميلٍ إلى آخر. المعطَّل = لا قراءة ولا كتابة ولا ملفّ يُلمس. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "semanticFrame",
    label: "المحرّك الدلاليّ — فهمُ الطلب بلهجته",
    description: "إطارٌ حتميّ للطلب قبل أوّل نداء: اللغةُ واللهجةُ والفعلُ والهدف — بسطر إيصالٍ 🧭 — وعثورٌ حتميّ على المجلّد المطلوب بالاسم المنطوق يُحقن في الحقبة الأولى، فيبدأ النموذجُ من الحقيقة لا من التخمين. بلا نموذج ولا شبكة. المعطَّل = لا إطار ولا سطر ولا موجز — بايتاً كما كان. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "semanticInfer",
    label: "الاستنتاج الدلاليّ — المرادُ والدافعُ والمطلوب",
    description: "الطبقةُ الرابعة من المحرّك الدلاليّ: بعد الإطار الحتميّ، نداءٌ جانبيّ مقيَّد بمفتاح المستخدم ومزوّدِه (بلا أدوات ولا بثّ، ٢٥٦ توكناً، حرارة ٠، ٦٠ ثانية، حكمُ الميزانيتين قبله والدفترُ بعده) يخرج بأربعة أسطرٍ حرفية: المرادُ والدافعُ والمطلوبُ والثقة. وأيُّ ردٍّ لا يطابق الشكلَ حرفاً يُرفض كلُّه — الغيابُ معلَن والحدسُ ممنوع. **يبدأ مطفأً** لأنه ينفق نداءً. المعطَّل = لا نداء ولا سطر — بايتاً كما كان. يسري من الدور القادم.",
    defaultOn: false,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "lessons",
    label: "دروسُ المشروع — الفشلُ المقيس لا يتكرّر",
    description: "فشلُ أمرٍ حقيقيّ (بناء/أنواع/اختبار/تدقيق/تشغيل) ببصمةٍ مطبَّعة يُسجَّل درساً مقيَّداً بالمشروع — بسطر إيصالٍ 📚 — ويُحقن في الحقبة الأولى من كلّ دورٍ تالٍ في المشروع نفسه قبل أوّل نداء، والتكرارُ بالبصمة نفسها يُسمّى في الإيصال بحكم «محاولةٌ ثالثة ليست مثابرة». الجدارُ الخارجيّ والعابرُ ليسا درساً. بلا نموذج ولا شبكة. المعطَّل = لا تسجيل ولا سطر ولا موجز — بايتاً كما كان. يسري من الدور القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "usageMeter",
    label: "العدّاد المحلي — توكنز وزمنٌ ونموذجٌ لكلّ نداء",
    description: "سطرٌ لكلّ نداءِ نموذجٍ — محلّيٍّ أو سحابيّ — في ملفٍّ على قرصك وحده (~/.abdo/usage-meter.jsonl أو ABDO_USAGE_METER): المزوّدُ والنموذجُ والزمنُ وما أعلنه المزوّدُ حرفاً وما حوسب به. لا يُرسل ولا يُجمَّع ولا يغادر الجهاز. الدفترُ السحابيّ وسقفُه كما هما. المعطَّل = لا سطر ولا ملفّ — بايتاً كما كان. يسري من النداء القادم.",
    defaultOn: true,
    applies: "next-turn",
    site: "call",
    wired: true,
    requiresVault: Object.freeze([]),
  }),
  Object.freeze({
    name: "settingsSeam",
    label: "سياج الإعدادات والتثبيت من البيئة",
    description: "كتابات الإضافات المتزامنة تُفحص برقم مراجعة، وABDO_PLUGIN_* تثبّت إضافة لهذه العملية وحدها. المعطَّل = الحفظ غير المشروط القديم.",
    defaultOn: true,
    applies: "immediate",
    site: "door",
    wired: true,
    requiresVault: Object.freeze([]),
    meta: true,
  }),
  Object.freeze({
    name: "inventory",
    label: "جرد الإضافات لكل دور",
    description: "كل قراءة مفتاحٍ تُسجَّل بموضعها وعددها وقيمتها النافذة وسببها، وتُرسل إطاراً قبل تمام الدور. المعطَّل = لا تسجيل ولا إطار ولا كتالوج.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
    meta: true,
  }),
  Object.freeze({
    name: "rules",
    label: "شروط تفعيل الإضافات",
    description: "قيمة الإضافة قد تكون شرطاً {when} بنحوٍ مغلق على rail/os/lane/mode/provider. المعطَّل = الشرط يُرفض عند الحفظ، والمحفوظ منه يُحلّ إلى معطَّل لا إلى الافتراض.",
    defaultOn: true,
    applies: "next-turn",
    site: "turn",
    wired: true,
    requiresVault: Object.freeze([]),
    meta: true,
  }),
])

export const PLUGIN_NAMES: ReadonlySet<string> = new Set(PLUGINS.map((d) => d.name))
export const descriptorFor = (name: string): PluginDescriptor | undefined => PLUGINS.find((d) => d.name === name)
const NAME_LIST = PLUGINS.map((d) => d.name).join("، ")

// ---------------------------------------------------------------------------
// التثبيت من البيئة — ABDO_PLUGIN_<SNAKE_UPPER>
// ---------------------------------------------------------------------------

/** `toolVerdict` ⇒ `ABDO_PLUGIN_TOOL_VERDICT`. */
export const envPinName = (name: string): string => `ABDO_PLUGIN_${name.replace(/([A-Z])/gu, "_$1").toUpperCase()}`

export interface PluginPin {
  readonly value: boolean
  readonly env: string
}

export interface PinResolution {
  readonly pins: Readonly<Record<string, PluginPin>>
  readonly refusals: readonly string[]
}

export const resolveEnvPins = (env: Readonly<Record<string, string | undefined>>): PinResolution => {
  const pins: Record<string, PluginPin> = {}
  const refusals: string[] = []
  for (const descriptor of PLUGINS) {
    const key = envPinName(descriptor.name)
    const raw = env[key]
    if (raw === undefined || raw === "") continue
    // المفاتيح الحاكمة كلّها لا تُثبَّت من البيئة، لا سياجُ الإعدادات وحده:
    // قارئها في المحرّك هو `metaOn` — من الملف والافتراض بلا سياقٍ ولا تثبيت
    // (وإلا دار `settingsSeam` حول نفسه). فتثبيتٌ يُقبل هنا كان يُعرض في
    // اللوحة مربّعاً مقفلاً ولا يغيّر ما تفعله الحلقة: فشلٌ **مفتوح** —
    // `ABDO_PLUGIN_RULES=0` يُظهر القواعد مطفأةً وهي تُقيَّم. يُرفض بالاسم.
    if (descriptor.meta === true) {
      refusals.push(`${key} لا يُثبَّت من البيئة — plugins.${descriptor.name} مفتاحٌ حاكم يُبدَّل من الإعدادات وحدها`)
      continue
    }
    if (raw === "1") { pins[descriptor.name] = { value: true, env: key }; continue }
    if (raw === "0") { pins[descriptor.name] = { value: false, env: key }; continue }
    refusals.push(`${key}=«${raw.slice(0, 32)}» ليس 0/1 — لم يُطبَّق`)
  }
  return { pins: Object.freeze(pins), refusals: Object.freeze(refusals) }
}

// ---------------------------------------------------------------------------
// نحو الشروط — مغلقٌ بالبناء
// ---------------------------------------------------------------------------

export const RULE_KEYS = Object.freeze(["rail", "os", "lane", "mode", "provider"] as const)
export type RuleKey = (typeof RULE_KEYS)[number]
export const RULE_MAX_CHARS = 120
/**
 * سقفُ المقارنات يجب أن يكون **قابلاً للبلوغ** داخل سقف المحارف، وإلا كان
 * فرعاً ميتاً يوهم بحراسةٍ لا تقع. أقصرُ مقارنةٍ ممكنة في هذا النحو
 * `os == other` (١١ محرفاً) والواصل ٤، فـ«ن» مقارنة تحتاج `15ن − 4` محرفاً:
 * ثمانٍ = ١١٦ ≤ ١٢٠ فتمرّ من سقف المحارف، وتسعٌ = ١٣١ يقطعها السقف أوّلاً.
 * لذلك السقف سبعٌ: عندها تُرفض الثامنة **بهذا الرفض** لا برفض الطول.
 */
export const RULE_MAX_COMPARISONS = 7

const RULE_DOMAINS: Readonly<Record<RuleKey, readonly string[] | null>> = Object.freeze({
  rail: Object.freeze(["strict", "medium", "thin"]),
  os: Object.freeze(["windows", "linux", "macos", "other"]),
  lane: Object.freeze(["chat", "agent"]),
  mode: Object.freeze(["read-only", "auto", "full-access"]),
  provider: null,
})

export interface RuleComparison {
  readonly key: RuleKey
  readonly negate: boolean
  readonly value: string
}
export interface ParsedRule {
  /** «أو» على مجموعاتٍ من «و» — `a && b || c` هي `(a && b) || c`. */
  readonly groups: readonly (readonly RuleComparison[])[]
}

const isRuleKey = (value: string): value is RuleKey => (RULE_KEYS as readonly string[]).includes(value)

/** يعيد قاعدةً محلَّلة، أو نصّ رفضٍ عربيّاً يبدأ بـ«قاعدة plugins:». */
export const parseRule = (text: unknown): ParsedRule | string => {
  if (typeof text !== "string") return "قاعدة plugins: الشرط نصٌّ لا غير"
  const trimmed = text.trim()
  if (trimmed.length === 0) return "قاعدة plugins: شرطٌ فارغ"
  if (trimmed.length > RULE_MAX_CHARS) return `قاعدة plugins: الشرط أطول من ${RULE_MAX_CHARS} محرفاً`
  // محارف لا تظهر في هذا النحو أبداً: أقواس، اقتباس، دولار، شرطة مائلة
  // خلفية، أقواس معقوفة/مربعة، فاصلة منقوطة. و«!» لا تُقبل إلا في «!=».
  if (/[()"'`$\\{}[\];]/u.test(trimmed)) {
    return "قاعدة plugins: الأقواس والاقتباس والدوال ممنوعة — المسموح مقارناتٌ بـ== و!= تُوصل بـ&& و||"
  }
  if (/!(?!=)/u.test(trimmed)) return "قاعدة plugins: النفي ممنوع — «!» لا تُقبل إلا في «!=»"
  const tokens = trimmed.split(/\s+/u)
  const groups: (readonly RuleComparison[])[] = []
  let current: RuleComparison[] = []
  let comparisons = 0
  let index = 0
  for (;;) {
    const key = tokens[index]
    const operator = tokens[index + 1]
    const value = tokens[index + 2]
    if (key === undefined || operator === undefined || value === undefined) {
      return "قاعدة plugins: الصيغة «مفتاح == قيمة» بفراغات، وتُوصل بـ&& أو ||"
    }
    if (!isRuleKey(key)) return `قاعدة plugins: مفتاح غير معروف «${key}» — المسموح ${RULE_KEYS.join("، ")}`
    if (operator !== "==" && operator !== "!=") return `قاعدة plugins: مقارنٌ غير معروف «${operator}» — المسموح == و!=`
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(value)) return `قاعدة plugins: قيمة غير صالحة «${value}»`
    const domain = RULE_DOMAINS[key]
    if (domain !== null && !domain.includes(value)) {
      return `قاعدة plugins: «${value}» ليست من قيم «${key}» — المسموح ${domain.join("، ")}`
    }
    comparisons += 1
    if (comparisons > RULE_MAX_COMPARISONS) return `قاعدة plugins: أكثر من ${RULE_MAX_COMPARISONS} مقارنات`
    current.push(Object.freeze({ key, negate: operator === "!=", value }))
    const connective = tokens[index + 3]
    if (connective === undefined) { groups.push(Object.freeze(current)); break }
    if (connective === "&&") { index += 4; continue }
    if (connective === "||") { groups.push(Object.freeze(current)); current = []; index += 4; continue }
    return `قاعدة plugins: واصلٌ غير معروف «${connective}» — المسموح && و||`
  }
  return Object.freeze({ groups: Object.freeze(groups) })
}

export interface PluginContext {
  readonly rail: "strict" | "medium" | "thin"
  readonly os: "windows" | "linux" | "macos" | "other"
  readonly lane: "chat" | "agent"
  readonly mode: "read-only" | "auto" | "full-access"
  readonly provider: string
}

/** خالصةٌ وتامّة — لا ترمي أبداً. */
export const evaluateRule = (rule: ParsedRule, ctx: PluginContext): boolean =>
  rule.groups.some((group) => group.every((c) => (ctx[c.key] === c.value) !== c.negate))

/** يبني سياقاً مُطبَّعاً؛ المجهول يسقط إلى الأضيق (fail-closed). */
export const pluginContext = (input: {
  readonly rail?: string
  readonly platform?: string
  readonly lane?: string
  readonly mode?: string
  readonly provider?: string
}): PluginContext => {
  const rail = input.rail === "medium" || input.rail === "thin" ? input.rail : "strict"
  const platform = input.platform
  const os = platform === "win32" ? "windows" : platform === "linux" ? "linux" : platform === "darwin" ? "macos" : "other"
  const lane = input.lane === "agent" ? "agent" : "chat"
  const mode = input.mode === "auto" || input.mode === "full-access" ? input.mode : "read-only"
  const raw = (input.provider ?? "").toLowerCase()
  const provider = /^[a-z][a-z0-9-]{0,31}$/u.test(raw) ? raw : "unknown"
  return Object.freeze({ rail, os, lane, mode, provider })
}

/** سياقٌ محايد للأسئلة التي لا دور لها (باب الإعدادات، الإقلاع). */
export const neutralPluginContext = (platform?: string): PluginContext => pluginContext({ platform })

// ---------------------------------------------------------------------------
// الحلّ — الطبقات: ملف ⊕ افتراض ⊕ تثبيت البيئة ⊕ قاعدة، مغلقةً عند كل خطوة
// ---------------------------------------------------------------------------

export type PluginWhy =
  | "default"
  | "explicit"
  | "pinned-env"
  | "rule-true"
  | "rule-false"
  | "rule-invalid"
  | "rules-disabled"
  | "invalid-value"
  | "unknown-plugin"

export type PluginConfigured = "absent" | "true" | "false" | "rule" | "invalid"

export interface PluginResolution {
  readonly name: string
  readonly effective: boolean
  readonly configured: PluginConfigured
  readonly rule?: string
  readonly why: PluginWhy
  readonly pin?: string
}

export interface PluginResolveOptions {
  readonly rulesOn: boolean
  readonly pins?: Readonly<Record<string, PluginPin>>
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/**
 * `{when: <ليس نصّاً>}` شرطٌ **حاضر** بقيمةٍ ليست نصّاً — لا شرطٌ فارغ. طيُّه
 * إلى `""` كان يجعل الرفض يقول «شرطٌ فارغ»، وهو تسميةُ سببٍ خاطئ في وحدةٍ
 * كلّ غرضها تسمية السبب الحقيقيّ. الرمزُ أدناه يمرّ إلى `parseRule` كما هو
 * فيقول رفضُها «الشرط نصٌّ لا غير».
 */
const RULE_NOT_TEXT: unique symbol = Symbol("plugins.rule.not-text")
type RuleValue = string | typeof RULE_NOT_TEXT

const ruleObject = (value: unknown): RuleValue | undefined => {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const keys = Object.keys(record)
  if (keys.length !== 1 || keys[0] !== "when") return undefined
  return typeof record.when === "string" ? record.when : RULE_NOT_TEXT
}

/** نصّ الشرط للعرض والتخزين — والقيمةُ غير النصّية لا نصّ لها. */
const ruleText = (value: RuleValue | undefined): string | undefined => (typeof value === "string" ? value : undefined)

/**
 * حلُّ مفتاحٍ حاكم — من الملف والافتراض وحدهما (منطقيٌّ فقط): لا سياق ولا
 * تثبيت، وبهذا لا يدور `settingsSeam` حول نفسه. وهو **المصدر الوحيد** لقيمة
 * المفاتيح الثلاثة: `metaOn` تشتقّ منه، و`resolvePlugin` يفوّض إليه — فلا
 * تفترق القيمة المعروضة في اللوحة عن القيمة التي تعمل بها الحلقة.
 */
export const metaResolution = (map: unknown, name: MetaPluginName): PluginResolution => {
  const descriptor = descriptorFor(name)!
  const stored = asRecord(map)?.[name]
  if (stored === undefined) return Object.freeze({ name, effective: descriptor.defaultOn, configured: "absent" as const, why: "default" as const })
  if (typeof stored === "boolean") {
    return Object.freeze({ name, effective: stored, configured: stored ? ("true" as const) : ("false" as const), why: "explicit" as const })
  }
  const when = ruleObject(stored)
  if (when === undefined) return Object.freeze({ name, effective: false, configured: "invalid" as const, why: "invalid-value" as const })
  const text = ruleText(when)
  return Object.freeze({ name, effective: false, configured: "rule" as const, ...(text === undefined ? {} : { rule: text }), why: "rule-invalid" as const })
}

/**
 * ترتيب الطبقات: اسمٌ مجهول ⇒ رفض؛ ثم تثبيت البيئة (يعلو الملف — قرارُ
 * المشغّل لهذه العملية)؛ ثم قيمة الملف؛ ثم الافتراض. القيمة غير المنطقيّة
 * وغير الشرط تُحلّ إلى `false` لا إلى الافتراض (اليوم: أيّ قيمةٍ غير `false`
 * تُقرأ مفعَّلة — هذا هو الثقب المفتوح الذي يُغلق هنا).
 */
export const resolvePlugin = (
  map: unknown,
  name: string,
  ctx: PluginContext,
  opts: PluginResolveOptions,
): PluginResolution => {
  const descriptor = descriptorFor(name)
  if (descriptor === undefined) return Object.freeze({ name, effective: false, configured: "absent" as const, why: "unknown-plugin" as const })
  // المفاتيح الحاكمة تُفوَّض إلى `metaResolution` قبل أيّ طبقة: قارئها في
  // المحرّك هو `metaOn` وحده، فلو أعلن هذا الحلُّ تثبيتاً أو شرطاً نافذاً
  // لأعلنت اللوحة قيمةً لا تفعلها الحلقة — وهو فشلٌ مفتوح لا مُغلق.
  if (descriptor.meta === true) return metaResolution(map, name as MetaPluginName)
  const stored = asRecord(map)?.[name]
  const storedRule = ruleObject(stored)
  const storedText = ruleText(storedRule)
  const pin = opts.pins?.[name]
  if (pin !== undefined) {
    const configured: PluginConfigured = stored === undefined
      ? "absent"
      : typeof stored === "boolean"
        ? (stored ? "true" : "false")
        : storedRule === undefined ? "invalid" : "rule"
    return Object.freeze({
      name,
      effective: pin.value,
      configured,
      why: "pinned-env" as const,
      pin: pin.env,
      ...(storedText === undefined ? {} : { rule: storedText }),
    })
  }
  if (stored === undefined) return Object.freeze({ name, effective: descriptor.defaultOn, configured: "absent" as const, why: "default" as const })
  if (typeof stored === "boolean") {
    return Object.freeze({ name, effective: stored, configured: stored ? ("true" as const) : ("false" as const), why: "explicit" as const })
  }
  const when = storedRule
  if (when === undefined) return Object.freeze({ name, effective: false, configured: "invalid" as const, why: "invalid-value" as const })
  const text = storedText === undefined ? {} : { rule: storedText }
  // مفتاحٌ حاكم لا يقبل شرطاً — الباب يرفضه، والمحرَّر يدوياً يُغلق هنا.
  if (descriptor.meta === true) return Object.freeze({ name, effective: false, configured: "rule" as const, ...text, why: "rule-invalid" as const })
  if (!opts.rulesOn) return Object.freeze({ name, effective: false, configured: "rule" as const, ...text, why: "rules-disabled" as const })
  // `when` قد يكون الرمزَ غيرَ النصّيّ — و`parseRule` تسمّيه بنفسها.
  const parsed = parseRule(when)
  if (typeof parsed === "string") return Object.freeze({ name, effective: false, configured: "rule" as const, ...text, why: "rule-invalid" as const })
  const value = evaluateRule(parsed, ctx)
  return Object.freeze({ name, effective: value, configured: "rule" as const, ...text, why: value ? ("rule-true" as const) : ("rule-false" as const) })
}

/**
 * مفتاحٌ حاكم يُقرأ من الملف والافتراض وحدهما (منطقيٌّ فقط) — فحلُّه لا يعتمد
 * على سياقٍ ولا على تثبيتٍ، وبهذا لا يدور `settingsSeam` حول نفسه.
 */
/** القيمةُ التي تعمل بها الحلقة فعلاً — مشتقّةٌ من `metaResolution` فلا يفترقان. */
export const metaOn = (map: unknown, name: MetaPluginName): boolean => metaResolution(map, name).effective

export interface PluginsResolution {
  readonly effective: Readonly<Record<string, boolean>>
  readonly pins: Readonly<Record<string, PluginPin>>
  readonly refusals: readonly string[]
}

/** يحلّ الجدول كلّه بطبقاته؛ التثبيت من البيئة لا يُقرأ إلا وسياج الإعدادات مفعَّل. */
export const resolvePlugins = (
  map: unknown,
  env: Readonly<Record<string, string | undefined>>,
  ctx: PluginContext = neutralPluginContext(),
): PluginsResolution => {
  const seamOn = metaOn(map, "settingsSeam")
  const rulesOn = metaOn(map, "rules")
  const refusals: string[] = []
  // فضاءٌ مشوَّه كلّه (نصّ أو رقم أو مصفوفة في settings.json المحرَّر يدوياً)
  // كان يُهمَل بصمت وكلُّ مفتاحٍ يعود إلى افتراضه — «العودة إلى الافتراض» هي
  // بالضبط ما تمنعه قوانين هذه الوحدة. الباب يرفضه على السلك، والمحرَّر يدوياً
  // يُسمَّى هنا: سطرٌ واحد على stderr عند الإقلاع، وحقلٌ في عرض السجلّ.
  if (map !== undefined && asRecord(map) === undefined) {
    refusals.push("فضاء plugins ليس كائناً {اسم: true/false} — أُهمل كلّه، وكل مفتاحٍ على افتراضه")
  }
  const pinned = seamOn ? resolveEnvPins(env) : { pins: Object.freeze({}), refusals: Object.freeze([] as readonly string[]) }
  for (const refusal of pinned.refusals) refusals.push(refusal)
  const effective: Record<string, boolean> = {}
  for (const descriptor of PLUGINS) {
    effective[descriptor.name] = resolvePlugin(map, descriptor.name, ctx, { rulesOn, pins: pinned.pins }).effective
  }
  return Object.freeze({ effective: Object.freeze(effective), pins: pinned.pins, refusals: Object.freeze(refusals) })
}

// ---------------------------------------------------------------------------
// الباب — تحقّقٌ مُغلق قبل القرص
// ---------------------------------------------------------------------------

/** يعيد نصّ رفضٍ عربيّاً يسمّي المفتاح، أو `undefined` للقبول. */
export const validatePluginsPatch = (value: unknown, rulesOn: boolean): string | undefined => {
  const record = asRecord(value)
  if (record === undefined) return "plugins يحتاج كائناً {اسم: true/false}"
  for (const [key, entry] of Object.entries(record)) {
    if (!PLUGIN_NAMES.has(key)) return `plugins: إضافة غير معروفة: ${key} — المعروف: ${NAME_LIST}`
    if (typeof entry === "boolean") continue
    const when = ruleObject(entry)
    if (when === undefined) return `plugins.${key} يحتاج true أو false`
    if (descriptorFor(key)?.meta === true) return `plugins.${key}: المفاتيح الحاكمة تقبل نعم/لا فقط`
    if (!rulesOn) return `plugins.${key}: قواعد الشرط معطَّلة — فعّل plugins.rules أولاً`
    const parsed = parseRule(when)
    if (typeof parsed === "string") return `plugins.${key}: ${parsed}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// الوصف والكتالوج — ما يركب أُطر ready/settings
// ---------------------------------------------------------------------------

export interface PluginRegistryView {
  readonly descriptors: readonly PluginDescriptor[]
  readonly effective: Readonly<Record<string, boolean>>
  readonly pins: Readonly<Record<string, PluginPin>>
  readonly revision: number
  readonly refusals: readonly string[]
  readonly seam: boolean
  readonly rules: boolean
  /**
   * السياق الذي حُسب به `effective` — يُعلَن ولا يُخمَّن. خارج الدور تُعرف
   * منه `os` وحدها يقيناً؛ والثلاثة الأخرى (rail/lane/mode/provider) لا تُعرف
   * إلا بدورٍ جارٍ، فصفٌّ قيمتُه شرطٌ على أحدها لا يُقدَّم في اللوحة قيمةً
   * «نافذةً الآن» بل «حسب سياق الدور».
   */
  readonly context: PluginContext
}

export const describePlugins = (
  settings: { readonly plugins?: unknown; readonly pluginsRevision?: unknown },
  env: Readonly<Record<string, string | undefined>>,
  // السياق يُمرَّر ولا يُفترض: بلا وسيطٍ كانت `os` تُثبَّت على «other» فتُعرض
  // كل قاعدةٍ على `os == windows` معطَّلةً بينما يقرؤها كلُّ دورٍ مفعَّلة.
  ctx: PluginContext = neutralPluginContext(),
): PluginRegistryView => {
  const resolved = resolvePlugins(settings.plugins, env, ctx)
  const seam = metaOn(settings.plugins, "settingsSeam")
  const revision = seam && typeof settings.pluginsRevision === "number" && Number.isSafeInteger(settings.pluginsRevision) && settings.pluginsRevision >= 0
    ? settings.pluginsRevision
    : 0
  return Object.freeze({
    descriptors: PLUGINS,
    effective: resolved.effective,
    pins: resolved.pins,
    revision,
    refusals: resolved.refusals,
    seam,
    rules: metaOn(settings.plugins, "rules"),
    context: ctx,
  })
}

export interface PluginCatalogRow {
  readonly name: PluginName
  readonly defaultOn: boolean
  readonly site: ReaderSite
  readonly wired: boolean
  readonly configured: PluginConfigured
  readonly rule?: string
  readonly valid: boolean
  readonly why?: string
}

/** صفوفُ حالةٍ بلا سياق — تحليلٌ فقط، فتصلح لإطارٍ يُرسل قبل أي دور. */
export const catalogFor = (map: unknown, rulesOn: boolean): PluginCatalogRow[] =>
  PLUGINS.map((descriptor) => {
    const stored = asRecord(map)?.[descriptor.name]
    if (stored === undefined) return { name: descriptor.name, defaultOn: descriptor.defaultOn, site: descriptor.site, wired: descriptor.wired, configured: "absent" as const, valid: true }
    if (typeof stored === "boolean") {
      return { name: descriptor.name, defaultOn: descriptor.defaultOn, site: descriptor.site, wired: descriptor.wired, configured: stored ? ("true" as const) : ("false" as const), valid: true }
    }
    const when = ruleObject(stored)
    if (when === undefined) {
      return { name: descriptor.name, defaultOn: descriptor.defaultOn, site: descriptor.site, wired: descriptor.wired, configured: "invalid" as const, valid: false, why: `plugins.${descriptor.name} يحتاج true أو false` }
    }
    const text = ruleText(when)
    const rule = text === undefined ? {} : { rule: text }
    if (descriptor.meta === true) {
      return { name: descriptor.name, defaultOn: descriptor.defaultOn, site: descriptor.site, wired: descriptor.wired, configured: "rule" as const, ...rule, valid: false, why: `plugins.${descriptor.name}: المفاتيح الحاكمة تقبل نعم/لا فقط` }
    }
    if (!rulesOn) {
      return { name: descriptor.name, defaultOn: descriptor.defaultOn, site: descriptor.site, wired: descriptor.wired, configured: "rule" as const, ...rule, valid: false, why: `plugins.${descriptor.name}: قواعد الشرط معطَّلة — فعّل plugins.rules أولاً` }
    }
    const parsed = parseRule(when)
    return typeof parsed === "string"
      ? { name: descriptor.name, defaultOn: descriptor.defaultOn, site: descriptor.site, wired: descriptor.wired, configured: "rule" as const, ...rule, valid: false, why: parsed }
      : { name: descriptor.name, defaultOn: descriptor.defaultOn, site: descriptor.site, wired: descriptor.wired, configured: "rule" as const, ...rule, valid: true }
  })

// ---------------------------------------------------------------------------
// الجرد — يروي ما جرى، ولا يبدّل توقيته
// ---------------------------------------------------------------------------

export interface PluginInventoryEntry extends PluginResolution {
  readonly site: ReaderSite
  readonly wired: boolean
  readonly reads: number
  readonly readSite?: ReadSite
  readonly epochs?: readonly number[]
}

const EPOCH_CAP = 64

export class PluginInventory {
  readonly context: PluginContext
  readonly enabled: boolean
  readonly rulesOn: boolean
  private readonly map: unknown
  private readonly opts: PluginResolveOptions
  private readonly rows = new Map<string, { reads: number; epochs: number[]; readSite: ReadSite; last: PluginResolution }>()

  constructor(
    map: unknown,
    context: PluginContext,
    opts: { readonly inventoryOn: boolean; readonly rulesOn: boolean; readonly pins?: Readonly<Record<string, PluginPin>> },
  ) {
    this.map = map
    this.context = context
    this.enabled = opts.inventoryOn
    this.rulesOn = opts.rulesOn
    this.opts = Object.freeze({ rulesOn: opts.rulesOn, ...(opts.pins === undefined ? {} : { pins: opts.pins }) })
  }

  /** القيمة النافذة — تُحسب دائماً، وتُسجَّل حين يكون الجرد مفعَّلاً. */
  read(name: PluginName, site: ReadSite, epoch?: number): boolean {
    const resolution = resolvePlugin(this.map, name, this.context, this.opts)
    if (this.enabled) {
      const row = this.rows.get(name) ?? { reads: 0, epochs: [], readSite: site, last: resolution }
      row.reads += 1
      row.readSite = site
      row.last = resolution
      if (epoch !== undefined && row.epochs.length < EPOCH_CAP && !row.epochs.includes(epoch)) row.epochs.push(epoch)
      this.rows.set(name, row)
    }
    return resolution.effective
  }

  /**
   * تسجيلُ قراءةٍ لمفتاحٍ حاكم وقعت **خارج** هذا المحلِّل. المفاتيح الثلاثة
   * تُقرأ بـ`metaOn` (بلا سياقٍ ولا تثبيت — وإلا دار السياج حول نفسه)، فكانت
   * تظهر في الجرد بـ`reads: 0` فتصنّفها القشرة «مُعلَن ولم يُقرأ» — وهي
   * تُقرأ في كلّ دور. هذا يقلب صدقَ «مسجَّلة ≠ قابلة للاستدعاء» رأساً على
   * عقب، فيُسجَّل هنا بقيمته الحقيقيّة من المصدر نفسه ولا يُعاد حلّه.
   */
  note(name: MetaPluginName, site: ReadSite): boolean {
    const resolution = metaResolution(this.map, name)
    if (this.enabled) {
      const row = this.rows.get(name) ?? { reads: 0, epochs: [], readSite: site, last: resolution }
      row.reads += 1
      row.readSite = site
      row.last = resolution
      this.rows.set(name, row)
    }
    return resolution.effective
  }

  /** صفٌّ لكل مفتاحٍ معلَن بترتيب الجدول — المُعلَن ولم يُقرأ يظهر بـreads:0. */
  snapshot(): PluginInventoryEntry[] {
    if (!this.enabled) return []
    return PLUGINS.map((descriptor) => {
      const row = this.rows.get(descriptor.name)
      const resolution = row?.last ?? resolvePlugin(this.map, descriptor.name, this.context, this.opts)
      return {
        ...resolution,
        site: descriptor.site,
        wired: descriptor.wired,
        reads: row?.reads ?? 0,
        ...(row === undefined ? {} : { readSite: row.readSite }),
        ...(row === undefined || row.epochs.length === 0 ? {} : { epochs: row.epochs.slice() }),
      }
    })
  }
}
