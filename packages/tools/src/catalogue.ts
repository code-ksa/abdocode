/**
 * T01 — سجلّ الأدوات الواحد.
 *
 * التصحيح قبل الإضافة: أسماء الأدوات كانت مبعثرةً في ستّة مواضع داخل
 * `serve` (قائمة القراءة، قائمة الوكيل، مفتاح التنفيذ، فحص الصنف…) — وهذا
 * بالضبط ما تحذّر منه القاعدة القائمة: **سؤالٌ واحدٌ بمالكٍ واحد**، وإلا
 * افترقت الإجابات في أسبوع. هنا يصير للسؤال «ما الأدوات وما أصنافها؟»
 * مالكٌ وحيد، والكتالوج الذي يراه النموذج **يُصاغ من السجلّ آلياً** لا
 * يُكتب يدوياً فيهرم.
 *
 * الصنف (`effect`) ليس وصفاً: هو ما تحكم به بوابة النمط (S138). أداةٌ بلا
 * صنفٍ صحيحٍ تعني بوابةً تحكم في الفراغ.
 */

export type RequestKind = "read" | "edit" | "command" | "network" | "outside-workspace"

export interface ToolSpec {
  readonly name: string
  /** مرادفاتٌ تُقبل عند التوجيه ولا تُعرض في الكتالوج. */
  readonly aliases?: readonly string[]
  /** صنف الأثر الذي تحكم به بوابة النمط. */
  readonly effect: RequestKind
  /** صيغة الاستدعاء كما يكتبها المستخدم أو يقترحها النموذج. */
  readonly usage: string
  /** سطرٌ واحد للكتالوج — يقرؤه النموذج، فليكن دقيقاً لا شاعرياً. */
  readonly summary: string
  /** هل يجوز للنموذج اقتراحها بسطر «نفّذ:»؟ الكتابة والتنفيذ نعم — لكن
   *  ببوابتهما؛ وdemo لا، فهي عرضٌ لا أداة. */
  readonly agentCallable: boolean
  /** المنفّذ الذي يخدمها — يقرؤه المُوزِّع من هنا فلا يخمّن بالاسم، ولا
   *  تعود قائمةُ أسماءٍ ثانيةٌ إلى الحياة. */
  readonly runner: "templates" | "project-template" | "project-inspect" | "project-locate" | "project-open" | "project-orient" | "project-create" | "exec" | "write" | "image" | "project-read" | "framed" | "surface" | "net" | "patch" | "adapter" | "delegate" | "desktop"
  /** قدرةٌ لا تُمنح إلا لنموذجٍ سحابيّ كبير — صيغتها تقتل النماذج الصغيرة
   *  (قرار المالك 2026-08-28: تُضاف خياراً عند استعمال API كبير لا افتراضاً).
   *  الحكم من المزوّد الفاعل وقتَ النداء، لا من نيّة النموذج. */
  readonly cloudOnly?: boolean
}

export const TOOLS: readonly ToolSpec[] = [
  {name:'templates',effect:'read',runner:'templates',agentCallable:true,usage:'templates [framework database ORM or feature]',summary:'Search 100 reviewed project starters and show exact dependencies and setup commands. No network or execution.'},
  {name:'project-inspect',effect:'read',runner:'project-inspect',agentCallable:true,usage:'project-inspect',summary:'Inspect selected project framework, dependencies, package manager and missing companion packages. Read only.'},
  {name:'project-locate',effect:'read',runner:'project-locate',agentCallable:true,usage:'project-locate <project name the user said, or an absolute folder path>',summary:'Find an existing project folder by name across the user\'s project roots (Documents, configured roots, siblings of the selected project). Returns ranked candidates with Git and plan signals. Read only; selects nothing.'},
  {name:'project-open',effect:'outside-workspace',runner:'project-open',agentCallable:true,usage:'project-open <absolute folder path from project-locate or from the user>',summary:'Select an existing project folder for this session and return its orientation (Git, plans, handoff, gaps). Requires approval. Never creates, deletes or edits files.'},
  {name:'project-orient',effect:'read',runner:'project-orient',agentCallable:true,usage:'project-orient',summary:'Read the selected project\'s current state: Git history and working tree, plan and handoff documents, recent notes, remembered goals, and deterministic gaps. Use before proposing development branches. Read only.'},
  {name:'project-template',effect:'outside-workspace',runner:'project-template',agentCallable:true,usage:'project-template <template-id> <new folder name or absolute path>',summary:'Only for a requested NEW project: download a pinned first-party starter, verify checksum, create its files in an exclusive new folder and select it. Never modifies the old project. No dependency installs. Requires project-creation and network approval.'},
  // قراءة — تمرّ في كل الأنماط بلا موافقة
  {
    name: "project-create", aliases: [], effect: "outside-workspace", runner: "project-create", agentCallable: true,
    usage: "project-create <folder name or absolute new folder path>",
    summary: "Create and select an empty project. A name creates it in the current user's Documents folder, avoiding collisions. An absolute path uses the user's chosen location. Only without a selected project. Outside-workspace approval applies; full-access proceeds automatically. Never overwrites an existing folder.",
  },
  { name: "status", effect: "read", usage: "status", summary: "حالة النواة ودفتر الآثار", agentCallable: true, runner: "framed" },
  { name: "docs", effect: "read", usage: "docs [موضوع]", summary: "فهارس L0: تعريف الأنظمة وكيفية استخدامها", agentCallable: true, runner: "framed" },
  { name: "read", effect: "read", usage: "read <ملف>", summary: "قراءة ملفٍّ عبر النواة بأطوارها السبعة", agentCallable: true, runner: "framed" },
  { name: "list", aliases: ["ls"], effect: "read", usage: "list [مجلد]", summary: "سرد محتوى مجلدٍ داخل المشروع", agentCallable: true, runner: "project-read" },
  { name: "glob", effect: "read", usage: "glob <نمط>", summary: "بحثٌ عن ملفّاتٍ بنمطٍ داخل المشروع", agentCallable: true, runner: "project-read" },
  { name: "grep", effect: "read", usage: "grep <regex> [نمط] [-i] [-C n] [--type ts] [--files|--count]", summary: "بحثٌ في محتوى الملفّات برقم السطر — بلا حساسيةٍ للحالة (-i)، بسياقٍ (-C)، بنوع الملفّ (--type)، أو أسماءَ الملفّات/العدَّ فقط", agentCallable: true, runner: "project-read" },
  { name: "sever", effect: "read", usage: "sever", summary: "فحص الفصل عن السلالة القديمة بالمحتوى والبصمة", agentCallable: true, runner: "framed" },
  // S13.4 — الاسترجاع بالبحث بدل مقطعٍ ثابت: سؤالٌ يُجاب من طبقات الوعي
  // الأربع بنسبها، والغياب يُقال «لا شيء مقيس» ولا يُملأ بجوابٍ مؤلَّف.
  { name: "recall", effect: "read", usage: "recall <سؤال>", summary: "استرجاعٌ بالبحث في طبقات الوعي الأربع (حقائق، خلاصات، وعي المشروع، معرفة عامة) بنسبها", agentCallable: true, runner: "framed" },
  // ب6 — كومبيوتر-يوس على النظام: كلُّ فعلٍ خارج المتصفّح صنفُه outside-workspace (موافقةٌ في الأنماط التي تسأل)، ومفتاحُه مستقلّ.
  { name: "desk", effect: "outside-workspace", usage: "desk open <برنامج|مسار> | desk shot [screen] | desk windows | desk focus <عنوان|pid:رقم> | desk ui [عمق] | desk set <uN> <نص> | desk press <uN> | desk click <x> <y> [right|double] | desk type <نص> | desk key <Enter|ctrl+s|…> | desk scroll <up|down> [عدد]", summary: "كومبيوتر-يوس على سطح مكتب المستخدم. الطريقُ الأوّل على أيّ واجهة: desk ui يقرأ شجرةَ الواجهة (الحقولُ والأزرارُ بأسمائها ومراجعها uN) ثمّ desk set/press يملأ ويضغط بالمرجع؛ اللقطةُ (النافذةُ المركَّزة، أو shot screen للشاشة كلِّها) إلى نموذج الرؤية حين لا تعلن الواجهةُ عناصرَها؛ النوافذُ وتركيزُها (عنوان أو pid:)، نقرٌ وكتابةٌ ومفاتيحُ وتمرير. يحتاج «تحكّم سطح المكتب» وموافقةً لكلّ فعل؛ لا إدخالَ بلا desk focus: الإحداثيّاتُ بكسلاتٌ فعليّة من زاوية النافذة، والفعلُ يُلغى إن لم تكن هي المقدّمة", agentCallable: true, runner: "desktop" },
  // المهاراتُ المحلّية كما في كلود: النموذجُ يعرفها من إعلانٍ في النظام ويحمّل ما يناسب المهمّة بنفسه — تعليماتٌ لا صلاحيات.
  { name: "skill", effect: "read", usage: "skill <حزمة/مهارة> | skill list [كلمة]", summary: "تحميلُ مهارةٍ محلّية مفعَّلة إلى السياق (تعليماتٌ لا صلاحيات، حتى ثلاثٍ في الدور) — أو سردُ المتاح بكلمة", agentCallable: true, runner: "framed" },
  // S13.5 — التفويض إلى وكيل دور. صنفُه `read` لأنه **بذاته** بلا أثر: كلُّ
  // أداةٍ يستدعيها الطفل تمرّ من المُوزِّع نفسه فتقف على بوّابتها بصنفها هي
  // وبنمط الدور نفسه. سقفُ الطفل من أدوات وكيله المعلَنة، والعمق مسقوف.
  // هـ2 — تفويضٌ متوازٍ لمهامّ محدّدة: سقفُ التوازي من وضع العمل (الأساسيّ يرفض؛ أقوى+ ٤؛ أقصى ١٢)، وكلُّ طفلٍ بسقف وكيله.
  { name: "team", effect: "read", usage: "team <<< ثمّ سطرٌ لكلّ مهمّة: وكيل :: المهمّة (مهمّتان فأكثر)", summary: "فريقٌ من وكلاء يعملون متوازين كلٌّ على مهمّةٍ محدّدة بسقف أدواته — سقفُ العدد من وضع العمل، والبوّابةُ والنمطُ والعدّادُ مشتركة مع الدور", agentCallable: true, runner: "delegate" },
  { name: "delegate", effect: "read", usage: "delegate <وكيل> :: <المهمّة>", summary: "تفويض مهمّة إلى وكيل دور بسقف أدواته المعلَنة (حِقبٌ وإيصالاتٌ ووعيٌ خاصّة به، وسقفُ الإنفاق والبوّابة والنمط مشتركة مع الدور)", agentCallable: true, runner: "delegate" },
  // git — قراءةٌ محصورة بقائمةٍ بيضاء (status/diff/log/branch فقط)، لا كتابةَ في الشجرة أو التاريخ
  { name: "git", effect: "read", usage: "git [status|diff|log|branch|show]", summary: "قراءة Git بقائمة بيضاء عبر عامل Rust", agentCallable: true, runner: "adapter" },
  { name: "gate", effect: "read", usage: "gate [installer|structure|typecheck]", summary: "بوّابات المنتج العامة فقط", agentCallable: true, runner: "framed" },

  // كتابة — معاينةٌ ثمّ موافقةٌ ثمّ lease وكتابةٌ ذرّية
  { name: "write", effect: "edit", usage: "write <ملف> <<< المحتوى", summary: "كتابة ملفٍّ (معاينة ثمّ موافقة)", agentCallable: true, runner: "write" },
  // S13.5 (إصلاح عيب): التطابق الفريد شرطٌ — تكرّر النصّ القديم يُرفض بالاسم،
  // و«--all» هي الطريقة الوحيدة لإعلان نيّة «كلّ المواضع».
  // ذ9ب — عدّةُ استبدالاتٍ في ملفٍّ واحد بموافقةٍ واحدة، لكلّ المسارات (المحلّيّ كان يملك استبدالاً واحداً في الجولة).
  { name: "medit", effect: "edit", usage: "medit <ملف> <<<\nالقديم الأوّل\n=>\nالجديد الأوّل\n@@\nالقديم الثاني\n=>\nالجديد الثاني", summary: "استبدالاتٌ عدّة في ملفٍّ واحد بموافقةٍ واحدة — كلُّ قديمٍ يطابق موضعاً واحداً بالضبط، وتُطبَّق بالترتيب أو لا تُطبَّق كلُّها", agentCallable: true, runner: "write" },
  { name: "edit", effect: "edit", usage: "edit <ملف> [--all] :: قديم => جديد", summary: "استبدال نصٍّ حرفيّ فريد في ملفّ؛ تكرّرُه رفضٌ ما لم تُعلن --all (معاينة ثمّ موافقة)", agentCallable: true, runner: "write" },
  { name: "git-stage", effect: "edit", usage: "git-stage <ملف>", summary: "إضافة ملف محدد إلى فهرس Git بعد الموافقة", agentCallable: true, runner: "adapter" },
  { name: "git-unstage", effect: "edit", usage: "git-unstage <ملف>", summary: "إخراج ملف محدد من فهرس Git بعد الموافقة", agentCallable: true, runner: "adapter" },
  { name: "git-commit", effect: "edit", usage: "git-commit <رسالة>", summary: "إنشاء commit محلي بلا hooks ولا push وبعد الموافقة", agentCallable: true, runner: "adapter" },
  { name: "packages", effect: "network", usage: "packages <npm|pnpm|bun|cargo> <offline|registry>", summary: "استعادة الحزم من lockfile فقط، بلا scripts وبمصادر مسموحة", agentCallable: true, runner: "adapter" },

  // تنفيذ — بوابة النمط، مهلةٌ وخرجٌ محدود
  { name: "run", effect: "command", usage: "run <أمر> | run --bg <أمر طويل>", summary: "تنفيذ أمرٍ في مجلد المشروع (موافقة في قراءة-فقط)", agentCallable: true, runner: "exec" },
  // ذ9ج — ذكاءُ الشيفرة من خادم اللغة الحقيقيّ (لا تخمين): الغيابُ يُقال غيرَ متاح.
  { name: "lsp", effect: "command", usage: "lsp diag <ملف> | lsp def <ملف> <سطر>:<عمود> | lsp refs <ملف> <سطر>:<عمود> | lsp symbols <ملف>", summary: "خادمُ اللغة: أخطاءُ الأنواع في ملفّ، تعريفُ رمز، مراجعُه، رموزُ الملفّ — من typescript-language-server المثبَّت في المشروع أو rust-analyzer؛ غيابُه يُقال لا يُخمَّن", agentCallable: true, runner: "framed" },
  // ذ9د — لوحُ الخطّة يضعه النموذجُ بنفسه (كما TodoWrite عند كلود) ويُفحص دوراً (DAG) ويحفظ المثبَت عند إعادة التخطيط.
  { name: "plan", effect: "read", usage: "plan set <<<\nid: action [after: id,id]\n… | plan start <id> | plan done <id> | plan fail <id> :: why | plan show", summary: "لوحُ خطّةٍ يديره النموذج: خطواتٌ بمعرّفاتٍ واعتماديّات تُفحص (لا دورات)، وتُحدَّث done/fail بإيصالها، وتُعرض للمستخدم حيّةً وتُلخَّص كلَّ حقبة", agentCallable: true, runner: "framed" },
  // ذ9ب — التشغيلُ الخلفيّ: بناءٌ طويل أو اختبارٌ ثقيل بمعرّف؛ السجلُّ يُقرأ والإيقافُ لما بدأته هذه الجلسة وحدها.
  { name: "recipe", effect: "read", usage: "recipe [list | <slug> | forget <slug>]", summary: "وصفاتُ الإعداد المتعلَّمة من نجاحاتٍ سابقة (nginx/pm2/docker/سقالات flutter وexpo وswift…) محفوظةً سكربتاتٍ عند المستخدم وتعبر المشاريع — اقرأها قبل إعادة الاكتشاف؛ التشغيلُ عبر run", agentCallable: true, runner: "exec" },
  { name: "logs", effect: "read", usage: "logs <معرّف> [عدد الأسطر]", summary: "ذيلُ سجلّ تشغيلٍ خلفيّ (run --bg) وحالتُه: جارٍ أو انتهى برمز", agentCallable: true, runner: "exec" },
  { name: "stop", effect: "command", usage: "stop <معرّف>", summary: "إيقافُ تشغيلٍ خلفيّ بدأته هذه الجلسة مع شجرة عمليّاته", agentCallable: true, runner: "exec" },

  // قدرتان سحابيّتان فقط (قرار المالك): صيغتاهما تقتلان 9B، وتنفعان مع نموذجٍ كبير
  { name: "patch", effect: "edit", usage: "patch <<< *** Begin Patch … *** End Patch", summary: "رقعةٌ متعدّدة الملفّات بصيغة Codex — تُترجَم إلى تحريراتنا المبوَّبة (سحابيّ فقط)", agentCallable: true, runner: "patch", cloudOnly: true },
  { name: "codemode", effect: "command", usage: "codemode <<< سطرٌ لكلّ أمر أدوات", summary: "تنفيذُ سيناريو أدواتٍ مكتوبٍ سطراً سطراً بالسجلّ وحده — كلّ خطوةٍ ببوّابتها (سحابيّ فقط)", agentCallable: true, runner: "patch", cloudOnly: true },

  // شبكة بلا متصفّح — جلبُ صفحةٍ نصّاً (فكرة webfetch من 2.1 بأبسط كود، حارس SSRF واحد)
  { name: "fetch", effect: "network", usage: "fetch <رابط HTTPS>", summary: "جلب نص HTTPS عبر DNS/SSRF وحدود تحويل وحجم وعامل Rust", agentCallable: true, runner: "adapter" },
  { name: "search", aliases: ["google", "google_search", "بحث"], effect: "network", usage: "search <عبارة> [--count 5] [--site example.com] [--images]", summary: "بحث Google منظّم؛ يفتح النتائج في متصفّح عبدو ويعيد العناوين والروابط عند ضبط PSE", agentCallable: true, runner: "net" },

  // T15–T18 — السطح: التصنيف من العقد لا من هنا؛ هذه المداخل فقط
  { name: "ui", effect: "network", usage: "ui <رابط>", summary: "فتح رابط يقدمه المستخدم في متصفح القشرة", agentCallable: true, runner: "surface" },
  { name: "browser", effect: "edit", usage: "browser [status | owned | extension | pair | off]", summary: "خلفيّةُ متصفّح الوكيل من الشات: المتصفّحُ الخفيف المملوك (Edge عبر CDP)، أو إضافةُ المتصفّح الحقيقيّ (كروم/إيدج/فايرفوكس)، أو إيقاف — تُحفظ في الإعدادات؛ «browser pair»/«browser extension» يقترن بالإضافة آليّاً: يفتح نافذةَ الاقتران، يُقلع المتصفّح إن لزم، وينتظرها — وإن غابت يعطي رابطَ تثبيتها", agentCallable: false, runner: "surface" },
  { name: "surface", effect: "network", usage: "surface <منفذ> | surface off", summary: "وصلُ متصفّحٍ عبر CDP أو فصلُه", agentCallable: false, runner: "surface" },
  { name: "page", effect: "read", usage: "page [styles | dom <ref> | css <selector> | assets]", summary: "قراءة الصفحة شجرةً نصّيةً بمراجع ثابتة؛ «page styles» ألوانُها وخطوطُها بالأرقام؛ «page dom r12» HTML العنصر وأنماطُه المحسوبة؛ «page css .btn» قواعدُ CSS المطابقة؛ «page assets» الصورُ والأيقوناتُ والخطوطُ وأوراقُ الأنماط — لنسخ تصميمٍ كما هو — وقيمةُ حقول الاعتماد (كلمةُ مرورٍ/رمزٌ/بطاقة) لا تُقرأ أصلاً، يُقال حالُها لا محتواها", agentCallable: true, runner: "surface" },
  { name: "open", effect: "network", usage: "open <رابط>", summary: "تنقّلٌ في متصفّح الوكيل — يُطلقه إن لم يكن موصولاً (موافقة في قراءة-فقط)", agentCallable: true, runner: "surface" },
  { name: "tap", effect: "outside-workspace", usage: "tap <مرجع>", summary: "نقرةٌ موثوقةٌ على عنصرٍ بمرجعه — يُتحقَّق قبلها وبعد موافقتك أنّ العنصر ما زال هو (دورُه واسمُه) وظاهرٌ وغيرُ مغطّى، وإلّا لا تقع", agentCallable: true, runner: "surface" },
  { name: "fill", effect: "outside-workspace", usage: "fill <مرجع> <نصّ>", summary: "كتابةٌ موثوقةٌ في حقلٍ (حقولُ الاعتماد مرفوضةٌ بنوعها) — تُبدِل قيمةَ الحقل لا تُذيَّل عليها، ويُقرأ الحقلُ بعدها فإن لم يطابق قيل ما استقرّ", agentCallable: true, runner: "surface" },
  { name: "image", effect: "read", usage: "image <ملف صورة>", summary: "صورةٌ محفوظة في المشروع (png/jpg/webp — رندرُ بليندر، لقطةٌ مصدَّرة) تُصغَّر وتصل نموذجَ الرؤية في النداء التالي؛ صِف ما تراه فيها بالأرقام", agentCallable: true, runner: "image" },
  { name: "shot", effect: "read", usage: "shot [full]", summary: "لقطةُ شاشةٍ للصفحة — إلى اللوحة، وإلى نموذج الرؤية في النداء التالي؛ «shot full» يمرّر الصفحةَ كلَّها ويلتقطها بلاطاتٍ (حتى ٨) تصل النموذجَ أربعاً في كلّ نداء", agentCallable: true, runner: "surface" },
  { name: "scroll", effect: "read", usage: "scroll <up|down|top|bottom> [عدد]", summary: "تمريرٌ بعجلة الماوس في الصفحة الموصولة", agentCallable: true, runner: "surface" },
  { name: "hover", effect: "read", usage: "hover <مرجع>", summary: "تحويمُ المؤشّر فوق عنصرٍ بمرجعه", agentCallable: true, runner: "surface" },
  { name: "key", effect: "outside-workspace", usage: "key <Enter|Tab|Escape|…>", summary: "ضغطةُ مفتاحٍ موثوقة (قد تُرسل نموذجاً)", agentCallable: true, runner: "surface" },
  // ذ9هـ — أدواتي في المتصفّح: العثورُ على العنصر بدل قراءة الشجرة كاملةً، وقراءةُ طرفيّة الصفحة بدل تخمين العطب.
  // م12 — إغلاقُ الطبقة العائمة (مقيس 09-14: نافذةُ لغة Google أوقفت النموذج): يقرأ الصفحةَ ويختار الإغلاقَ الأسلم ثمّ ينقر بمسار tap.
  { name: "dismiss", effect: "outside-workspace", usage: "dismiss", summary: "إغلاقُ الطبقة العائمة على الصفحة (نافذةُ لغة، شريطُ كوكيز، حوارُ ترحيب): يختار «إبقاء اللغة/لا شكراً/رفض/إغلاق» بالمعنى وينقره نقرةً موثوقة، ثمّ أعد page", agentCallable: true, runner: "surface" },
  { name: "find", effect: "read", usage: "find <نصّ>", summary: "بحثٌ في الصفحة عن عناصرَ يطابق دورُها أو اسمُها النصَّ — يعيد المراجع للنقر والكتابة بدل قراءة الشجرة كاملةً", agentCallable: true, runner: "surface" },
  { name: "network", effect: "read", usage: "network [عدد]", summary: "طلباتُ الصفحة منذ الوصل: الطريقةُ والحالةُ والرابطُ ونوعُ المورد — بلا ترويسةٍ ولا جسمِ طلبٍ أو ردّ (لا تُلتقط أصلاً)؛ الفارغُ يُقال فارغاً", agentCallable: true, runner: "surface" },
  { name: "console", effect: "read", usage: "console [عدد]", summary: "رسائلُ طرفيّة الصفحة الملتقطة منذ الوصل (console.* والأخطاء غير الملتقطة) — الفارغُ يُقال فارغاً ولا يُخمَّن", agentCallable: true, runner: "surface" },
  { name: "look", effect: "read", usage: "look [مرجع]", summary: "نصُّ الصفحة أو عنصرٍ وأنماطُه المحسوبة — لإصلاح التصميم", agentCallable: true, runner: "surface" },
  { name: "handoff", effect: "read", usage: "handoff <مرجع>", summary: "تسليمُ حقلِ اعتمادٍ للمستخدم: تركيزٌ في نافذة المتصفّح بلا كتابة", agentCallable: true, runner: "surface" },

  // عرضٌ داخليّ لا أداةَ وكيل
  { name: "demo", effect: "read", usage: "demo", summary: "دورةٌ كاملةٌ خفيفة على النواة", agentCallable: false, runner: "framed" },
  { name: "agents", effect: "read", usage: "agents", summary: "كتالوج وكلاء الأدوار المثبتين وسقف أدواتهم — عرض للمشغّل بلا نموذج", agentCallable: false, runner: "framed" },
]

const index = new Map<string, ToolSpec>()
for (const t of TOOLS) {
  index.set(t.name, t)
  for (const a of t.aliases ?? []) index.set(a, t)
}

/** الاسم أو المرادف ← المواصفة. الاسم المجهول يعود undefined لا افتراضاً. */
export const tool = (word: string): ToolSpec | undefined => index.get(word)

export const isTool = (word: string): boolean => index.has(word)

/** ما يجوز للنموذج اقتراحه بـ«نفّذ:» — من السجلّ، لا من قائمةٍ موازية. */
export const agentCallable = (word: string): boolean => tool(word)?.agentCallable === true

/**
 * كتالوج النموذج، مُصاغٌ من السجلّ. يُحقن في رسالة النظام فتبقى قائمةُ
 * الأدوات المعلَنة والمُنفَّذة **شيئاً واحداً** مهما أُضيف.
 */
export const catalogue = (cloud = false): string =>
  TOOLS.filter((t) => t.agentCallable && (cloud || t.cloudOnly !== true))
    .map((t) => `- ${t.usage} — ${t.summary}`)
    .join("\n")

/** تصنيفٌ للعرض: أدواتٌ مرتّبةٌ بصنفها. */
export const byEffect = (): Record<string, readonly string[]> => {
  const out: Record<string, string[]> = {}
  for (const t of TOOLS) (out[t.effect] ??= []).push(t.name)
  return out
}
