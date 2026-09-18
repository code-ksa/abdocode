/** Native shell localization. This module never reads credentials or changes content. */
const nativeEntries = `
// 2026-09-13: ٢٨ نصّاً كانت تظهر عربيّةً في واجهةٍ إنجليزيّة (مقيسةٌ من DOM التطبيق المثبَّت عبر CDP) — لوحةُ الإعدادات العامّة والموصّلات وإضافةُ المتصفّح.
السحابيّ القويّ رفيعٌ ينطلق، والمحلّيّ يشتدّ بالفهارس والنظام؛ الأمن لا يرقّ أبداً.|A strong cloud model runs on a thin harness; a local model gets indexes and structure. Security never thins.
وضع العمل|Work mode
أساسيّ: وكيلٌ واحد. أقوى: وكيلٌ موجِّه يقرأ المشروع من الوعي والذاكرة أوّلاً + تحقّقٌ ومراجعة. أقوى+: فريقٌ متوازٍ حتى ٤. أقصى: فريقٌ حتى ١٢.|Basic: one agent. Stronger: an orienting agent reads the project from awareness and memory first, plus verification and review. Stronger+: a parallel team of up to 4. Max: a team of up to 12.
أساسيّ|Basic
أقوى|Stronger
أقوى+|Stronger+
أقصى|Max
التوصيلُ فعلٌ صريحٌ في كلّ جلسة؛ القائمةُ تُحفظ والتشغيلُ لا يقع وحده — إلا ما أذنتَ له بالتوصيل التلقائيّ بيدك (إضافةُ المتصفّح، والموصّلاتُ بعد ربطها).|Connecting is an explicit action in every session; the list is saved but nothing starts on its own — except what you personally allowed to auto-connect (the browser extension, and connectors once linked).
الموصّلات|Connectors
اربط حساباتك بضغطة كما في كلود: جوجل (Gmail والتقويم وDrive) بخادمنا المدمج، وسلاك وLinear وNotion وأخواتها عبر خوادم MCP البعيدة. الرموزُ في الخزنة وحدها، والربطُ يفتح متصفّحك لتسجّل الدخول بنفسك، والخادمُ يُوصَل تلقائياً عند فتح الجلسة.|Link your accounts with one click, as in Claude: Google (Gmail, Calendar, Drive) through our built-in server, and Slack, Linear, Notion and the rest through remote MCP servers. Tokens live only in the vault, linking opens your browser so you sign in yourself, and the server connects automatically when a session opens.
جوجل (Gmail · التقويم · Drive)|Google (Gmail · Calendar · Drive)
يحتاج معرّف تطبيق|Needs an app ID
gmail_search، gmail_read، gmail_draft، gmail_send_draft، calendar_events، calendar_create، drive_search، drive_read|gmail_search, gmail_read, gmail_draft, gmail_send_draft, calendar_events, calendar_create, drive_search, drive_read
احفظ في الخزنة|Save to vault
وصّل|Connect
سلاك|Slack
slack_search، slack_read_channel، slack_post_message، slack_list_channels|slack_search, slack_read_channel, slack_post_message, slack_list_channels
غير مربوط|Not linked
issues، projects، comments|issues, projects, comments
search، pages، databases|search, pages, databases
tasks، projects|tasks, projects
jira، confluence|jira, confluence
files، nodes، images|files, nodes, images
conversations، contacts|conversations, contacts
repos، issues، pull_requests، search|repos, issues, pull_requests, search
إضافة المتصفّح (كروم/إيدج/سفاري)|Browser extension (Chrome/Edge/Safari)
العربية|Arabic
يحتاج تطبيقاً تصنعه أنت مرّةً واحدة: Google Cloud Console ← APIs & Services ← Credentials ← OAuth client ID ← Desktop app؛ ثمّ فعّل Gmail API وCalendar API وDrive API.|Needs an app you create once: Google Cloud Console → APIs & Services → Credentials → OAuth client ID → Desktop app; then enable the Gmail, Calendar and Drive APIs.
يحتاج تطبيقاً تصنعه أنت مرّةً واحدة: api.slack.com/apps ← Create App ← OAuth & Permissions: أضف Redirect URL \`http://127.0.0.1:9371/callback\` وانسخ Client ID وClient Secret.|Needs an app you create once: api.slack.com/apps → Create App → OAuth & Permissions: add the Redirect URL \`http://127.0.0.1:9371/callback\` and copy the Client ID and Client Secret.
يقود الوكيلُ متصفّحَك الحقيقيّ عبر إضافة عبدو كود: يقرأ التبويب الفعّال ويفتح روابط وينقر ويكتب في غير السرّيّ ويلتقط لقطة — بموافقتك وعلى هذا الجهاز وحده. بعد «وصّل» انسخ رمزَ الاقتران إلى نافذة الإضافة.|The agent drives your real browser through the AbdoCode extension: it reads the active tab, opens links, clicks, types into non-secret fields and takes screenshots — with your approval and on this computer only. After “Connect”, copy the pairing code into the extension popup.
قاعدة SQLite|SQLite database
ملفّ القاعدة|Database file
مستودعُ جِت آخر|Reference Git repository
مجلّد المستودع|Repository folder
قاعدة PostgreSQL|PostgreSQL database
رابط الاتصال|Connection URL
قراءةُ قاعدةِ تطويرٍ محلّيّة — جداولُها ومخطّطُها واستعلاماتُ قراءة. الكتابةُ يرفضها المحرّك نفسُه (اتّصالٌ للقراءة)، و«ضمُّ ملفٍّ آخر» مرفوضٌ بالاسم.|Read tables, schema and queries from a local development database. The database connection is read-only; attaching another database is blocked.
قراءةُ تاريخِ مستودعٍ **غير مشروعك الجاري** — سجلٌّ وفروعٌ وفرقٌ وملفٌّ عند مرجع. أداةُ git الأصليّة تقرأ مشروعك، وهذه تقرأ مرجعاً تنسخ منه أو مستودعَ عميلٍ تقارن به. وإعدادُ المستودع الغريب مُحيَّدٌ فلا يشغّل برنامجاً.|Read history, branches, diffs and files from a reference repository. Use the native Git tool for the active project. External Git commands and repository hooks are disabled.
قراءةُ قاعدةِ بوستجرس بسلكٍ كتبناه (SCRAM وTLS) — جداولُها وأعمدتُها واستعلاماتُ قراءة، كلُّها داخل معاملةٍ للقراءة. والرابطُ يذهب إلى الخزنة لا إلى الإعدادات.|Read PostgreSQL tables, columns and queries inside a read-only transaction. Connection credentials are stored in the vault.
عبدو كود|AbdoCode
إعدادات عبدو كود|AbdoCode settings
تنقّل سريع|Quick navigation
طيّ قائمة المحادثات|Toggle conversation sidebar
بحثٌ في الجلسة|Search this conversation
الجلسة السابقة|Previous conversation
الجلسة التالية|Next conversation
✎ محادثة جديدة|✎ New chat
الأخيرة — من دفتر المحرّك|Recent conversations
تغيير عرض قائمة المحادثات|Resize conversation sidebar
تغيير عرض العمود الطرفيّ|Resize outer panel column
تغيير ارتفاع اللوح فوق المحادثة|Resize panel above conversation
تغيير ارتفاع اللوح تحت المحادثة|Resize panel below conversation
تغيير عرض العمود المجاور للمتصفّح|Resize panel beside browser
مجلد المشروع الحالي|Current project folder
الطرفيّة|Terminal
الخوادم|Servers
المهامّ|Tasks
المتصفّح|Browser
المزيد|More
طيّ/فتحُ الكلّ|Collapse or expand all
نسخُ نصّ الجلسة|Copy conversation
إعداداتُ الواجهة|Interface settings
ابحث في هذه الجلسة…|Search this conversation…
أغلق البحث|Close search
محادثة|Chat
عمل|Work
تصفّح|Browse
إعدادات|Settings
افتح الرابط|Open link
افتح|Open
اقرأ الصفحة|Read page
أغلق المتصفّح|Close browser
أغلق|Close
✕ إغلاق|✕ Close
إعدادات وقشور مطوّرة لهذا المنتج. المفاتيح وحدها تبقى في الخزنة ولا تدخل ملف الإعدادات.|App settings and workspace preferences. API keys stay in the vault and are not stored with settings.
أقسام الإعدادات|Settings sections
عام والمظهر|General & appearance
المزوّدون|Providers
الاتصالات|Connections
النماذج|Models
الإضافات والوكيل|Plugins & agent
الصلاحيات|Permissions
الاختصارات|Keyboard shortcuts
التشغيل والأمان|Runtime & security
صرامة القضبان|Agent guidance
تشتد مع النماذج الصغيرة وترقّ مع القوية؛ الأمن لا يرقّ أبداً.|Adjust guidance for model capability. Security checks remain in force.
تلقائي حسب النموذج|Automatic for model
صارم — للنماذج الصغيرة|Strict — smaller models
متوسط|Medium
رفيع — للنماذج القوية|Light — stronger models
اللغة|Language
لغة القشرة؛ المحتوى يظل بلغته.|Interface language. Content keeps its original language.
السمة|Theme
حسب النظام|System
فاتحة|Light
داكنة|Dark
حجم الواجهة|Interface scale
الشريط الجانبي|Sidebar
زر لوحة التصفّح|Browser panel button
ملخصات التفكير|Reasoning summaries
تفاصيل الأدوات موسّعة|Expand tool details
المزوّدون والخزنة|Providers & vault
المفاتيح تُحفظ محلياً وتُحقن داخل عامل Rust المعزول. لا تُعاد إلى JavaScript أو المحادثة.|Keys are stored locally and used by the isolated worker. They are never returned to the interface or conversation.
مزوّد مخصص|Custom provider
أي واجهة متوافقة مع OpenAI (/chat/completions). المفتاح يذهب للخزنة رأساً.|Configure an OpenAI-compatible endpoint. API keys go directly to the vault.
الاسم|Name
المفتاح|API key
إضافة المزوّد|Add provider
حفظ|Save
الاتصالات — خوادم MCP|Connections — MCP servers
أيّ تطبيقٍ يتكلّم|Any application that supports
يصير مزوّدَ أدوات: بريدٌ، أو تخزينٌ سحابيّ، أو تصميم، أو خادمٌ تكتبه أنت. أدواتُه تدخل بأسماءٍ منسوبة «<الخادم>.<الأداة>» فلا تُظلَّل أداةٌ أصليّة.|can provide tools for email, cloud storage, design, or your own server. Tools use namespaced IDs, <server>.<tool>, so they cannot replace native tools.
ثلاثةُ ثوابت:|Connection rules:
(١)|(1)
(٢)|(2)
(٣)|(3)
كلُّ أداةِ MCP تقف على بوّابة الموافقة — إعلانُ الخادم أنّه «للقراءة فقط» إقرارٌ عن نفسه لا دليل.|Every MCP tool uses the approval gate. A server's read-only claim does not establish permission.
التوصيلُ فعلٌ صريحٌ في كلّ جلسة؛ القائمةُ تُحفظ والتشغيلُ لا يقع وحده.|Connecting requires an explicit action in each session. Saving a server does not start it automatically.
لا تضع مفتاحاً في الأمر — الإعداداتُ ترفض ما يشبه السرّ قبل أن يلمس القرص. الاعتماداتُ تُمنَح أدناه:|Do not put API keys in a command. Settings reject apparent secrets before saving. Add credentials below:
القيمةُ تذهب إلى الخزنة والمقبضُ وحده يُكتب في الإعدادات|The value goes to the vault; only its reference is saved in settings
، ويصل الخادمَ في بيئته عند التوصيل. ومقبضٌ غائبٌ يمنع التوصيل بالاسم.|and is passed to the server environment when connecting. Missing credential references prevent the connection.
عميل MCP مطفأ الآن. فعّله من «الإضافات والوكيل» ثمّ عُد — والمطفأ لا تُحمَّل وحدتُه أصلاً.|MCP is currently disabled. Enable it in Plugins & agent, then return. Disabled components are not loaded.
خوادمُ جاهزة|Built-in servers
ما يشحن داخل التطبيق نفسِه — بضغطةٍ بدل أمرٍ يُكتب بيد.|Servers included with the app, available without entering a command.
لا شيءَ يُنزَّل|Nothing is downloaded
: القائمةُ مغلقةٌ على خوادمنا، ومن أراد غيرَها كتب أمرَه أدناه وعرف ما يشغّل.|: this list contains bundled servers. Configure other servers by entering a command below.
خادمٌ بأمرٍ يدويّ|Custom server command
المعرّف|Identifier
لاتينيّ صغير، وبه تُنسب الأدوات.|Lowercase ID used to namespace the server's tools.
الأمر|Command
ما يُشغَّل. الاقتباسُ يجمع ما فيه مسافات.|Command to run. Quote arguments that contain spaces.
ما سيُشغَّل|Command preview
مقروءاً كما يراه النظام قبل الحفظ.|Review the arguments before saving.
احفظ الخادم|Save server
التبديل بين النماذج|Model routing
المحادثة والأسئلة تذهب إلى النموذج العادي، والبرمجة والخطط والعمل الوكيلي تذهب إلى Empero. يمكنك تثبيت مسار واحد يدوياً.|Chat and questions use the chat model. Coding, planning, and agent work use Empero. You can select one route manually.
طريقة التبديل|Routing mode
تلقائي حسب المهمة|Automatic for task
المحادثة دائماً|Always chat
البرمجة والوكيل دائماً|Always code & agent
نموذج المحادثة والأسئلة|Chat model
مرجع مزوّد/نموذج كامل.|Full provider/model reference.
نموذج البرمجة والعمل الوكيلي|Code & agent model
نسخة Empero المحلية ذات تحميل GPU الإجباري.|Local Empero model with required GPU loading.
نموذج الرؤية (الصور)|Vision model (images)
يُختار حين تحمل الرسالةُ صوراً. فارغٌ = نموذجُ الحارة نفسُه، ويُرفض صراحةً إن لم يقبل الصور.|Chosen when the message carries images. Empty = the lane model itself, refused explicitly if it does not accept images.
قدرات تُفعَّل وتُعطَّل من هنا وتُحفظ في الإعدادات. المعطَّل لا يُحمَّل أصلاً — والتبديل يسري من الدور القادم ولا يمسّ تقدم الجلسة الجارية.|Enable or disable capabilities here. Settings apply from the next turn and preserve current session progress. Disabled components are not loaded.
المحرّك غير متصل — تُعرض الإضافات حين يصل سجلّها منه؛ ولا افتراضات تُرسم من القشرة.|Engine disconnected. Plugin settings appear when its registry is available.
البوابة الأمامية الرخيصة|Lightweight front gate
نموذج بلا أدوات يجيب التافه من حارة المحادثة ويصعّد الباقي إلى الحلقة كما هي؛ معطَّلة = لا تُبنى. cheap يبوّب المحلي أيضاً (تجربة)، auto يبوّب حين يُوفَّر نداء سحابي فقط. يسري من الدور القادم.|A model without tools handles simple chat requests and sends other tasks to the agent loop. Disabled means it is not loaded. Cheap mode also gates local requests; Auto gates cloud requests when it can save a call. Applies next turn.
معطَّلة|Disabled
cheap — كل دور مؤهَّل|Cheap — every eligible turn
auto — السحابي فقط|Auto — cloud only
المنح القائمة لهذه الجلسة|Grants for this session
إذنٌ قيل مرّةً بنطاقٍ مسمّى بدل أن يُسأل عشراً.|Give permission once for a named scope instead of repeating approval for each call.
لا يُكتب على قرص ولا ينجو من إعادة التشغيل|Grants stay in memory and expire on restart
، ويُعلَن في المحادثة عند كلّ استعمال. المفتاح|. Each use is announced in the conversation. The
في «الإضافات والوكيل» يحكمه، وهو مطفأٌ افتراضاً.|setting in Plugins & agent controls this feature and is disabled by default.
الرفضُ المتكرّر|Repeated denials
ما رُفض أكثرَ من مرّةٍ في هذه الجلسة. يُعرض عددُه في كلّ سؤالٍ جديد، ومع مفتاح|Repeated denials in this session are counted and displayed with each request. With
يُقطع الطلبُ الرابع بلا سؤال — ومحوُ العدّاد هنا يعيد السؤال. لا يُكتب على قرص.|enabled, a fourth request is denied without asking. Resetting the counter allows new requests. Counts are not saved to disk.
نمط الموافقة|Approval mode
القراءة فقط آمن افتراضياً؛ التوسعة لا تتم إلا من يدك.|Read-only by default. Only you can expand access.
قراءة فقط|Read-only
تلقائي داخل المشروع|Automatic within project
صلاحية كاملة|Full access
اختصارات لوحة المفاتيح|Keyboard shortcuts
لوحة الأوامر|Command palette
الإعدادات|Settings
محادثة جديدة|New chat
قناة المحرّك|Engine connection
محلية ومصادَق عليها|Local and authenticated
التنفيذ الشبكي|Network requests
عامل Rust مع قائمة نقاط ثابتة|Isolated worker with approved endpoints
المتابعة أثناء العمل|Follow-up behavior
انتظر نهاية الدور|Queue until turn ends
وجّه الدور الجاري|Steer current turn
إشعارات الأخطاء|Error notifications
صوت طلب الصلاحية|Approval request sound
حفظ وتطبيق|Save and apply
استعادة الافتراضي|Restore defaults
المحرّك سقط — لا إعادة تشغيلٍ خلسة.|The engine stopped. Restart it when ready.
إحياء بيد المشغّل|Restart engine
المحرّك ساقط|Engine stopped
بمَ نعمل اليوم؟|What should we work on?
اسأل عبدو…|Ask AbdoCode…
أوامر|Commands
المشروع|Project
اختر مجلد المشروع|Choose project folder
نمط الموافقات|Approval mode
وضع قوة النموذج — يحدد صرامة القضبان|Model guidance level
وضع قوة النموذج|Model guidance
تلقائي|Auto
النموذج الفاعل|Active model
أرسل|Send
‎/docs الفهارس|‎/docs Indexes
‎/read عبر النواة|‎/read Through kernel
‎/sever الفصل|‎/sever Disconnect
‎/status الحالة|‎/status Status
تغيير عرض المتصفّح والمحادثة|Resize browser and conversation
نشاط الدور|Turn activity
المخرجات|Outputs
لا مخرجات بعد|No outputs yet
المصادر|Sources
لا مصادر بعد|No sources yet
المتصفّح الحيّ|Live browser
لم يُفتح متصفّح بعد|No browser open
افتح اللوح في نافذةٍ مستقلّة|Open panel in separate window
وسّع اللوح|Expand panel
أعِد اللوح إلى مرساته|Restore panel
أغلق اللوح|Close panel
رجوع|Back
تقدّم|Forward
تحديث|Reload
أدخل رابطًا|Enter a URL
الخوادم المُدارة|Managed servers
+ أضف خادماً|+ Add server
بحث Google|Google search
فتح|Open
خيارات التبويب|Tab options
تكبير +|Zoom in +
تصغير −|Zoom out −
إعادة الضبط 100%|Reset zoom 100%
بحث في الصفحة|Find in page
طباعة|Print
نسخ الرابط|Copy link
فتح في متصفّح الجهاز|Open in default browser
إغلاق التبويب|Close tab
تبويب جديد|New tab
اكتب رابطاً في الشريط —|Enter a URL in the address bar —
أو اطلب من عبدو: «افتح واجهة منصّةُ المواقع»|or ask AbdoCode to open a website.
لا خادمَ مُدارٌ الآن|No managed servers
أشعِل «لوح الخوادم» من الإعدادات|Enable Servers panel in settings
افتحه في متصفّح عبدو|Open in AbdoCode browser
غير عامل|Stopped
تعذّر النسخ إلى الحافظة|Could not copy to clipboard
شرط اختياري: rail == thin|Optional rule: rail == thin
✓ محفوظ|✓ Saved
غير متاح|Unavailable
لا رفضَ متكرّرٌ في هذه الجلسة.|No repeated denials in this session.
امحُ العدّاد|Reset counter
لا منحَ قائماً — كلُّ نداءٍ يُسأل.|No active grants. Each call requires approval.
انقض|Revoke
أضِف هذا الخادم|Add this server
لا خادمَ محفوظ بعد.|No saved servers yet.
احذف|Delete
انزع|Remove
القيمة — تذهب إلى الخزنة|Value — stored in the vault
امنح اعتماداً|Add credential
شغّل «لسان مسار الدور» لعرض الأوامر — هذا اللوح يعرض فولدَه ولا يبني ثانياً|Enable Execution trajectory to show commands in this panel.
لم يُنفَّذ أمرٌ في هذه الجلسة بعد|No commands executed in this session yet.
أمر طرفية… (مثل: node -v)|Terminal command… (for example: node -v)
اكتب أمراً في الحقل ثم «عمل» لتشغيله في الطرفية (يمرّ ببوابة النمط)|Enter a command, then choose Work to run it with the current approval policy.
لا مسار بعد — أرسل دوراً.|No execution trajectory yet. Send a message to start.
لا مسلَّمات بعد|No deliverables yet
تم الحفظ|Saved
إلغاء|Cancel
رفض|Deny
السماح مرة واحدة|Allow once
وضع سوبر عبدو|Super Abdo mode
مراجعة مستقلة|Independent review
التحقق بعد التعديل|Verify after changes
استعادة سياق المشروع|Recall project context
قوالب المزودين|Provider templates
عنوان الواجهة|Base URL
معرّفات النماذج|Model IDs
مزوّد محلي|Local provider
اختبار الاتصال|Test connection
احفظ الإعدادات أولًا|Save settings first
لم يُختبر|Not tested
غير متصل|Disconnected
متصل|Connected
فشل الاتصال|Connection failed
تحديث المزوّد|Update provider
حذف المزوّد|Remove provider
مزود إعداد مسبق|Provider preset
تكوين مخصص|Custom configuration
جهد التفكير|Reasoning effort
الاستخدام والسياق|Usage and context
إيقاف الرد|Stop response
اختر مزودًا|Choose a provider
النموذج الافتراضي|Default model
جاهز|Ready
جارٍ العمل|Working
جارٍ الرد|Responding
التفاصيل|Details
المظهر|Appearance
قائمة التطبيقات|App menu
تغيير عرض الشريط الجانبي|Resize sidebar
اسحب لتغيير عرض الشريط الجانبي|Drag to resize sidebar
لا مهمّةَ جارية|No active tasks
يجري|Running
تمّ|Completed
قوطع|Interrupted
بلا تمام|Unresolved
نقطة حفظ|Checkpoint
يُقاس…|Checking…
يعمل|Running
أعِد القياس|Refresh status
لا خادمَ مُدارٌ في هذه الجلسة|No managed servers in this session
أمرٌ يمرّ ببوّابة الموافقة…|Command — approval policy applies…
أمرٌ جديد|New command
نفّذ الأمر (يمرّ ببوّابة النمط)|Run command — approval policy applies
بحث Google (PSE)|Google Search (PSE)
السرّان يذهبان إلى الخزنة مباشرةً. من دونهما يظل فتح بحث Google في المتصفّح متاحاً، لكن النتائج المنظّمة لا تعمل.|Both credentials go directly to the vault. Without them, Google can still open in the browser, but structured search results are unavailable.
✓ جاهز|✓ Ready
ناقص إعداد|Setup incomplete
حُفظ إعداد بحث Google في الخزنة|Google Search credentials saved to the vault
نقطة نهاية مخصّصة|Custom endpoint
لقطة حيّة من صفحة المتصفّح|Live browser screenshot
النواة: حاضرة (72h)|Kernel: available (72h)
النواة: غائبة|Kernel: missing
جديد|New
اتصل عبر بوابة HTTPS متوافقة مع OpenAI. مصادقة المؤسسات الأصلية غير مدعومة بعد.|Connect through an OpenAI-compatible HTTPS gateway. Native enterprise authentication is not implemented.
خادم متوافق مع OpenAI على هذا الجهاز. تُقبل عناوين الجهاز المحلي فقط ولا يُرسل اعتماد سحابي.|OpenAI-compatible server on this computer. Loopback URLs only; no cloud credential is sent.
أدخل رابط HTTPS الأساسي المتوافق مع OpenAI ومعرّفات النماذج الدقيقة. تبقى الاعتمادات في الخزنة المحلية.|Enter an OpenAI-compatible HTTPS base URL and exact model IDs. Credentials stay in the native vault.
اتصال أصلي بالمزوّد. أضف اعتماده إلى الخزنة واختر نموذجًا متاحًا.|Native provider transport. Add its credential in the vault and choose an available model.
`;

// Reused, product-owned vocabulary and native plugin descriptions are embedded below.
const referencePairs = [
  [
"تحذير في الجلسة",
"Session warning"
  ],
  [
"الاستخدام والسياق",
"Usage and context"
  ],
  [
"إعادة التعيين بعد 3 ساعات و10 دقائق",
"Resets in 3 hr 10 min"
  ],
  [
"تم استخدام 28٪",
"28% used"
  ],
  [
"تم استخدام 95٪",
"95% used"
  ],
  [
"قراءة ملفات المشروع",
"Reading project files"
  ],
  [
"الخطوة 2 / 4",
"Step 2 / 4"
  ],
  [
"معاينة الرد",
"Response preview"
  ],
  [
"جارٍ الرد · معاينة",
"Responding · preview"
  ],
  [
"الاسم الكامل",
"Full name"
  ],
  [
"الاسم المفضّل",
"Preferred name"
  ],
  [
"بأي اسم نناديك؟",
"What should we call you?"
  ],
  [
"ما الوصف الأقرب لعملك؟",
"What best describes your work?"
  ],
  [
"تطوير البرمجيات",
"Software development"
  ],
  [
"البحث",
"Research"
  ],
  [
"أخرى",
"Other"
  ],
  [
"ما التفضيلات الشخصية التي يجب أن يراعيها عبدو في الردود؟",
"What personal preferences should Abdo consider in responses?"
  ],
  [
"تفضيلاتك لهذه المعاينة…",
"Your preferences for this preview…"
  ],
  [
"اختر مظهر الواجهة.",
"Choose the appearance of the interface."
  ],
  [
"خط المحادثة",
"Chat font"
  ],
  [
"خط ذو تذييل",
"Serif"
  ],
  [
"الحركة",
"Motion"
  ],
  [
"مخفّضة",
"Reduced"
  ],
  [
"الصوت",
"Voice"
  ],
  [
"لغة الصوت",
"Voice language"
  ],
  [
"العربية",
"Arabic"
  ],
  [
"أسلوب الصوت",
"Voice style"
  ],
  [
"هادئ",
"Calm"
  ],
  [
"واضح",
"Clear"
  ],
  [
"سرعة الصوت",
"Voice speed"
  ],
  [
"الإشعارات",
"Notifications"
  ],
  [
"اكتمال المهمة",
"Task completion"
  ],
  [
"إشعار عند جاهزية المهمة.",
"Notify when a task is ready."
  ],
  [
"البريد الإلكتروني",
"Email address"
  ],
  [
"تسجيل الخروج من جميع الأجهزة",
"Log out of all devices"
  ],
  [
"إنهاء الجلسات الأخرى المتصلة بحسابك.",
"End other sessions connected to your account."
  ],
  [
"تسجيل الخروج",
"Log out"
  ],
  [
"حذف الحساب",
"Delete account"
  ],
  [
"إجراءات الحساب معروضة لمراجعة التصميم.",
"Account actions are shown for design review."
  ],
  [
"المؤسسة",
"Organization"
  ],
  [
"معرّف المؤسسة",
"Organization ID"
  ],
  [
"الأجهزة الموثوقة",
"Trusted devices"
  ],
  [
"الجهاز",
"Device"
  ],
  [
"تاريخ الإضافة",
"Added"
  ],
  [
"كمبيوتر Windows",
"Windows computer"
  ],
  [
"الجهاز الحالي",
"Current device"
  ],
  [
"الجلسات النشطة",
"Active sessions"
  ],
  [
"آخر نشاط",
"Last active"
  ],
  [
"الآن",
"Just now"
  ],
  [
"راجع كيفية حماية معلوماتك واختر تفضيلات بياناتك.",
"Review how your information is protected and choose your data preferences."
  ],
  [
"كيف نحمي بياناتك",
"How we protect your data"
  ],
  [
"كيف نستخدم بياناتك",
"How we use your data"
  ],
  [
"السماح بالموقع التقريبي لتحسين تجربة الاستخدام.",
"Allow coarse location metadata to improve product experiences."
  ],
  [
"السماح باستخدام المحادثات وجلسات البرمجة لتحسين النماذج.",
"Allow chats and coding sessions to help improve models."
  ],
  [
"خطة Max",
"Max plan"
  ],
  [
"استخدام أكثر 20 مرة من Pro",
"20x more usage than Pro"
  ],
  [
"تصميم الاشتراك · حساب تجريبي",
"Subscription layout · sample account"
  ],
  [
"وسيلة دفع تجريبية",
"Example payment method"
  ],
  [
"مثال",
"Sample"
  ],
  [
"حدود استخدام الخطة",
"Plan usage limits"
  ],
  [
"Max ‏(20x) · مثال",
"Max (20x) · Sample"
  ],
  [
"إعادة التعيين بعد 4 ساعات و58 دقيقة",
"Resets in 4 hr 58 min"
  ],
  [
"تم استخدام 0٪",
"0% used"
  ],
  [
"تم استخدام 90٪",
"90% used"
  ],
  [
"تم استخدام 100٪",
"100% used"
  ],
  [
"تمت زيادة حدودك مؤقتًا.",
"Your limits are temporarily boosted."
  ],
  [
"هذا مثال لتصميم إشعار الاستخدام المرجعي.",
"This example reproduces the reference usage notice."
  ],
  [
"تعرّف على حدود الاستخدام",
"Learn more about usage limits"
  ],
  [
"إعادة التعيين الأحد 8 صباحًا",
"Resets Sun 8:00 AM"
  ],
  [
"آخر تحديث: بيانات تجريبية",
"Last updated: sample data"
  ],
  [
"تفعيل رصيد الاستخدام",
"Turn on usage credits"
  ],
  [
"واصل الاستخدام عند بلوغ حد الخطة.",
"Keep using the product if you hit a plan limit."
  ],
  [
"يتحكم في تحميل أدوات الموصلات في المحادثات الجديدة.",
"Controls how connector tools are loaded in new conversations."
  ],
  [
"تحميل الأدوات عند الحاجة",
"Load tools when needed"
  ],
  [
"تحميل جميع الأدوات",
"Load all tools"
  ],
  [
"البحث في دليل الموصلات عن أدوات مناسبة لمحادثتك.",
"Search the connector directory for tools relevant to your conversation."
  ],
  [
"التبديل تلقائيًا إلى نموذج آخر لمتابعة المحادثة.",
"Automatically switch to a different model to keep chatting."
  ],
  [
"إنشاء الأكواد والمستندات والتصميمات بجانب المحادثة.",
"Generate code, documents, and designs alongside your conversation."
  ],
  [
"إنشاء مستندات تفاعلية تستخدم نموذجًا داخل المخرج.",
"Build interactive documents that use a model inside the artifact."
  ],
  [
"عرض الرسوم والمخططات التفاعلية داخل المحادثة.",
"Show interactive visualizations, charts, and diagrams in the conversation."
  ],
  [
"إنشاء الملفات وتحليل البيانات في بيئة مخصصة.",
"Create files and analyze data in a dedicated environment."
  ],
  [
"السماح بالاتصال الخارجي",
"Allow network egress"
  ],
  [
"السماح لمحرك التشغيل بالوصول إلى وجهات الشبكة المحددة.",
"Allow the runtime to access selected network destinations."
  ],
  [
"النطاقات المسموح بها",
"Domain allowlist"
  ],
  [
"مديرو الحزم فقط",
"Package managers only"
  ],
  [
"قائمة سماح مخصصة",
"Custom allowlist"
  ],
  [
"اختر النطاقات المتاحة للأدوات. المفاتيح هنا تغيّر نموذج التصميم فقط.",
"Choose which domains tools can access. All switches here change only this visual prototype."
  ],
  [
"إضافة نطاق",
"Add domain"
  ],
  [
"تصنيف الجلسات الجديدة تلقائيًا إلى متوقفة أو جاهزة للمراجعة أو مكتملة.",
"Automatically classify sessions as blocked, ready for review, or done. Applies to new sessions."
  ],
  [
"تبديل النموذج تلقائيًا لمتابعة جلسات الويب والجلسات البعيدة.",
"Automatically switch models to keep the session moving. Applies to web and remote sessions."
  ],
  [
"عبدو فاتح",
"Abdo Light"
  ],
  [
"عبدو داكن",
"Abdo Dark"
  ],
  [
"تعيين خط ثابت العرض للكود والطرفية.",
"Set a custom monospace font for code and terminal."
  ],
  [
"خط القوائم والشريط الجانبي والمحادثة.",
"Font for menus, sidebar, and chat."
  ],
  [
"خط بلا تذييل",
"Sans"
  ],
  [
"حجم خط سجل المحادثة",
"Transcript font size"
  ],
  [
"صغير",
"Small"
  ],
  [
"كبير",
"Large"
  ],
  [
"عرض سجل المحادثة",
"Transcript width"
  ],
  [
"واسع",
"Wide"
  ],
  [
"ضيق",
"Narrow"
  ],
  [
"الجلسات المحلية",
"Local sessions"
  ],
  [
"وضع تجاوز طلبات الصلاحية",
"Bypass permissions mode"
  ],
  [
"إظهار الوضع في عناصر تحكم الجلسة المحلية.",
"Show the mode in local session controls."
  ],
  [
"التحكم عن بُعد",
"Remote control"
  ],
  [
"متابعة الجلسات من جهاز آخر.",
"Continue sessions from another device."
  ],
  [
"سير عمل ديناميكي",
"Dynamic workflows"
  ],
  [
"أرشفة الجلسات تلقائيًا",
"Automatically archive sessions"
  ],
  [
"أبدًا",
"Never"
  ],
  [
"بعد 7 أيام",
"After 7 days"
  ],
  [
"بعد 30 يومًا",
"After 30 days"
  ],
  [
"موقع شجرة العمل",
"Worktree location"
  ],
  [
"داخل المشروع",
"Inside project"
  ],
  [
"موقع مخصص",
"Custom location"
  ],
  [
"أدوات المتصفح",
"Browser tools"
  ],
  [
"حفظ جلسات المتصفح",
"Persist browser sessions"
  ],
  [
"مشترك",
"Shared"
  ],
  [
"لكل جلسة",
"Per session"
  ],
  [
"المواقع المسموح بها",
"Allowed sites"
  ],
  [
"طلبات الدمج",
"Pull requests"
  ],
  [
"بادئة الفرع",
"Branch prefix"
  ],
  [
"طلبات دمج مسودة",
"Draft pull requests"
  ],
  [
"التحقق من كل جهاز جديد قبل اتصاله عن بُعد.",
"Verify each new device before it can connect remotely."
  ],
  [
"استقبال المهام المرسلة من هاتفك على هذا الكمبيوتر.",
"Let tasks be dispatched from your phone using this computer."
  ],
  [
"المخرجات والمهام المجدولة محفوظة في C:\\\\AbdoCode\\\\Cowork.",
"Artifacts and scheduled tasks are stored in C:\\\\AbdoCode\\\\Cowork."
  ],
  [
"تغيير",
"Change"
  ],
  [
"يمكن للمهام استخدام هذه المجلدات دون طلب موافقة مسبقة.",
"Tasks may use these folders without asking first."
  ],
  [
"يتوقف عند إغلاق التطبيق أو دخول الكمبيوتر في وضع السكون.",
"Stops when the app closes or this computer sleeps."
  ],
  [
"استخدم هذا المتصفح افتراضيًا.",
"Use this browser by default."
  ],
  [
"Chrome ‏(عبدو في Chrome)",
"Chrome (Abdo in Chrome)"
  ],
  [
"المتصفح المدمج",
"Built-in browser"
  ],
  [
"إعدادات عبدو في Chrome",
"Abdo in Chrome settings"
  ],
  [
"تفعيل عبدو في Chrome",
"Enable Abdo in Chrome"
  ],
  [
"استخدم ملحق المتصفح. هذا الإعداد يخص الملحق فقط.",
"Use the browser extension. This setting only affects the extension."
  ],
  [
"تسري هذه الصلاحيات على الملحق والمتصفح المدمج.",
"These permissions apply to the extension and the built-in browser."
  ],
  [
"اختر إن كان المساعد يعمل على جميع المواقع افتراضيًا.",
"Choose whether the assistant works on all sites by default."
  ],
  [
"السؤال قبل الاستخدام",
"Ask before use"
  ],
  [
"حظر جميع المواقع",
"Block all sites"
  ],
  [
"يعمل في جميع المواقع باستثناء ما تحظره أدناه",
"Works everywhere except sites you block below"
  ],
  [
"لا يمكن استخدام المساعد على هذه المواقع",
"The assistant cannot be used on these sites"
  ],
  [
"لم تُضف مواقع في هذه المعاينة",
"No sites added in this preview"
  ],
  [
"تشغيل التطبيق تلقائيًا عند تسجيل الدخول إلى الكمبيوتر.",
"Automatically start the app when you log in to your computer."
  ],
  [
"فتح التطبيق سريعًا من أي مكان.",
"Quickly open the app from anywhere."
  ],
  [
"إبقاء التطبيق قيد التشغيل في علبة النظام.",
"Keep the app running in the system tray."
  ],
  [
"منع السكون أثناء فتح التطبيق لتتمكن المهام المجدولة من العمل.",
"Prevent idle sleep while the app is open so scheduled tasks can run."
  ],
  [
"غير متاح في الجلسات السحابية التي تعمل خارج هذا الكمبيوتر.",
"Not available in cloud sessions, which do not run on this computer."
  ],
  [
"نوافذ Chrome المتاحة للأتمتة.",
"Chrome instances that are available for automation."
  ],
  [
"افتح Chrome مع الملحق وسجّل الدخول. هذه معاينة للحالة الفارغة.",
"Open Chrome with the extension and sign in. This is an empty-state preview."
  ],
  [
"تفعيل استخدام الكمبيوتر",
"Enable computer use"
  ],
  [
"التفاعل مع تطبيقات سطح المكتب.",
"Interact with apps on your desktop."
  ],
  [
"إظهار التطبيقات أثناء الاستخدام",
"Unhide apps during use"
  ],
  [
"التطبيقات المحظورة",
"Denied apps"
  ],
  [
"إضافة تطبيق",
"Add app"
  ],
  [
"التفاعل مع التطبيقات والبيانات والأدوات على الكمبيوتر.",
"Interact with apps, data, and tools on your computer."
  ],
  [
"اسحب ملفات .MCPB أو .DXT هنا للتثبيت",
"Drag .MCPB or .DXT files here to install"
  ],
  [
"إضافة خوادم MCP التي تعمل عليها وإدارتها.",
"Add and manage MCP servers that you are working on."
  ],
  [
"قيد التشغيل · مثال",
"Running · sample"
  ],
  [
"هذا الخادم يُدار بواسطة ملحق",
"This server is managed by an extension"
  ],
  [
"تحتاج إلى مفتاح API؟",
"Want an API key?"
  ],
  [
"إنشاء المفاتيح وعرض الاستخدام على منصة مزوّدك.",
"Create keys and view usage on your provider platform."
  ],
  [
"الانتقال إلى المنصة ↗",
"Go to platform ↗"
  ],
  [
"المهارة",
"Skill"
  ],
  [
"مثال تجريبي",
"Example"
  ],
  [
"أضف مهارات لتوسيع إمكانات مساحة العمل.",
"Add skills to extend your workspace."
  ],
  [
"إضافة مهارة",
"Add skill"
  ],
  [
"الموصل",
"Connector"
  ],
  [
"ويب",
"Web"
  ],
  [
"سطح المكتب",
"Desktop"
  ],
  [
"الإضافة",
"Plugin"
  ],
  [
"البحث عن تفاصيل ذات صلة في المحادثات السابقة.",
"Find relevant details in past conversations."
  ],
  [
"بناء الذاكرة من المحادثات.",
"Build memory from conversations."
  ],
  [
"السماح بحفظ المواضيع الحساسة في الذاكرة.",
"Allow sensitive topics to be saved to memory."
  ],
  [
"استيراد السياق والبيانات ذات الصلة من مزوّد آخر.",
"Bring relevant context and data from another provider."
  ],
  [
"تحديث نظام الذاكرة. صدّر الذاكرة القديمة من النظام السابق.",
"Memory system update. Export legacy memory from the previous system."
  ],
  [
"أسلوب العمل الذي تفضّله",
"Your preferred work style"
  ],
  [
"تم التحديث في 4 سبتمبر",
"Updated Sep 4"
  ],
  [
"تفضيلات الواجهة والتخطيط",
"Interface and layout preferences"
  ],
  [
"سياق مساحة العمل",
"Workspace context"
  ],
  [
"عبدو كود",
"AbdoCode"
  ],
  [
"الإعدادات",
"Settings"
  ],
  [
"عام",
"General"
  ],
  [
"الحساب",
"Account"
  ],
  [
"الخصوصية",
"Privacy"
  ],
  [
"الفوترة",
"Billing"
  ],
  [
"الاستخدام",
"Usage"
  ],
  [
"القدرات",
"Capabilities"
  ],
  [
"عبدو كود",
"Abdo Code"
  ],
  [
"العمل المشترك",
"Cowork"
  ],
  [
"عبدو في Chrome",
"Abdo in Chrome"
  ],
  [
"تطبيق سطح المكتب",
"Desktop app"
  ],
  [
"الملحقات",
"Extensions"
  ],
  [
"المطور",
"Developer"
  ],
  [
"تخصيص",
"Customize"
  ],
  [
"المهارات",
"Skills"
  ],
  [
"الموصلات",
"Connectors"
  ],
  [
"الإضافات",
"Plugins"
  ],
  [
"الذاكرة",
"Memory"
  ],
  [
"المنصة",
"Platform"
  ],
  [
"مفاتيح API",
"API keys"
  ],
  [
"بحث",
"Search"
  ],
  [
"جديد",
"New"
  ],
  [
"جلسة جديدة",
"New session"
  ],
  [
"المحادثة والعمل",
"Chat and Cowork"
  ],
  [
"الكود",
"Code"
  ],
  [
"المحادثة",
"Chat"
  ],
  [
"العمل",
"Work"
  ],
  [
"المشروعات",
"Projects"
  ],
  [
"المخرجات",
"Artifacts"
  ],
  [
"المهام المجدولة",
"Scheduled"
  ],
  [
"الإرسال للأجهزة",
"Dispatch"
  ],
  [
"المزيد",
"More"
  ],
  [
"الطرفية",
"Terminal"
  ],
  [
"التغييرات",
"Changes"
  ],
  [
"المتصفح",
"Browser"
  ],
  [
"الملفات",
"Files"
  ],
  [
"الكل",
"All"
  ],
  [
"الخاصة بك",
"Yours"
  ],
  [
"المشاركة معك",
"Shared with you"
  ],
  [
"مخرج جديد",
"New artifact"
  ],
  [
"مشروع جديد",
"New project"
  ],
  [
"ابحث في المشروعات…",
"Search projects…"
  ],
  [
"ابحث في المخرجات…",
"Search artifacts…"
  ],
  [
"ابحث في الملفات",
"Search files"
  ],
  [
"مرحبًا بعودتك، عبدو",
"Welcome back, abdo"
  ],
  [
"مرحبًا، عبدو",
"Good afternoon, abdo"
  ],
  [
"على ماذا سنعمل؟",
"What should we work on?"
  ],
  [
"كيف يمكنني مساعدتك اليوم؟",
"How can I help you today?"
  ],
  [
"اعمل مع عبدو",
"Work with Abdo"
  ],
  [
"صف مهمة أو اطرح سؤالًا",
"Describe a task or ask a question"
  ],
  [
"اكتب / للأوامر",
"Type / for commands"
  ],
  [
"الجلسات",
"Sessions"
  ],
  [
"إظهار جلسة أخرى",
"Show 1 more"
  ],
  [
"إظهار 20 أخرى",
"Show 20 more"
  ],
  [
"بحاجة إلى إدخال",
"Needs input"
  ],
  [
"اختر مشروعًا",
"Choose project"
  ],
  [
"متصل",
"Connected"
  ],
  [
"غير متصل",
"Not connected"
  ],
  [
"اتصال",
"Connect"
  ],
  [
"إعداد",
"Configure"
  ],
  [
"تصفح",
"Browse"
  ],
  [
"إضافة",
"Add"
  ],
  [
"إغلاق",
"Close"
  ],
  [
"إلغاء",
"Cancel"
  ],
  [
"حفظ",
"Save"
  ],
  [
"تم",
"Done"
  ],
  [
"معرفة المزيد",
"Learn more"
  ],
  [
"مفعّل",
"Enabled"
  ],
  [
"معطّل",
"Disabled"
  ],
  [
"مفعّل",
"On"
  ],
  [
"متوقف",
"Off"
  ],
  [
"فاتح",
"Light"
  ],
  [
"داكن",
"Dark"
  ],
  [
"النظام",
"System"
  ],
  [
"مريح",
"Comfortable"
  ],
  [
"مكثف",
"Compact"
  ],
  [
"افتراضي",
"Default"
  ],
  [
"تلقائي",
"Auto"
  ],
  [
"عالٍ",
"High"
  ],
  [
"متوسط",
"Medium"
  ],
  [
"منخفض",
"Low"
  ],
  [
"أقصى",
"Max"
  ],
  [
"محلي",
"Local"
  ],
  [
"سحابي",
"Cloud"
  ],
  [
"عن بُعد",
"Remote"
  ],
  [
"وصول كامل",
"Full access"
  ],
  [
"قراءة فقط",
"Read-only"
  ],
  [
"تجاوز طلبات الصلاحية",
"Bypass permissions"
  ],
  [
"إنشاء طلب دمج",
"Create PR"
  ],
  [
"إنشاء طلب دمج",
"Create pull request"
  ],
  [
"إنشاء طلب دمج مسودة",
"Create draft PR"
  ],
  [
"عرض التغييرات",
"View changes"
  ],
  [
"استخدام إضافي",
"Get more usage"
  ],
  [
"اقتراب حد الاستخدام الأسبوعي",
"Approaching weekly usage limit"
  ],
  [
"إعادة التعيين الأحد 8 صباحًا · مثال",
"Resets Sun, 8:00 AM · Sample"
  ],
  [
"استكشف الواجهة وحالات التفاعل.",
"Explore the interface and its interaction states."
  ],
  [
"عرض الدليل",
"View guide"
  ],
  [
"جرّبها",
"Try it"
  ],
  [
"شغّل هذه الجلسة في السحابة",
"Run this session in the cloud"
  ],
  [
"معاينة للتحكم في الجلسات البعيدة واختيار مساحة العمل المحلية.",
"A visual preview of remote session controls and local workspace selection."
  ],
  [
"نظرة عامة",
"Overview"
  ],
  [
"مساحة العمل",
"Workspace"
  ],
  [
"التوثيق",
"Documentation"
  ],
  [
"صفحات ذات صلة",
"Related pages"
  ],
  [
"ابدأ التصفح",
"Start browsing"
  ],
  [
"أدخل عنوانًا لفتح صفحة",
"Enter a URL to open a page"
  ],
  [
"ابحث أو أدخل عنوانًا",
"Search or enter a URL"
  ],
  [
"تبويب جديد",
"New tab"
  ],
  [
"بحث تجريبي",
"Preview search"
  ],
  [
"معاينة المتصفح",
"Browser preview"
  ],
  [
"الصور",
"Images"
  ],
  [
"الفيديو",
"Videos"
  ],
  [
"الأخبار",
"News"
  ],
  [
"محتوى توضيحي لتخطيط المتصفح المدمج.",
"Preview content for the embedded browser layout."
  ],
  [
"نتيجة مثال · بيانات عرض محلية",
"Example result · local visual fixture"
  ],
  [
"معاينة محلية للقشرة — بلا تصفح خارجي",
"Local shell preview — no external navigation"
  ],
  [
"الملفات مطوية للتغييرات الكبيرة. اختر ملفًا لتوسيعه.",
"Files are collapsed for large diffs. Select a file to expand."
  ],
  [
"اختر ملفًا للمعاينة",
"Select a file to preview"
  ],
  [
"ملف",
"File"
  ],
  [
"تحرير",
"Edit"
  ],
  [
"عرض",
"View"
  ],
  [
"مساعدة",
"Help"
  ],
  [
"محادثة جديدة",
"New Conversation"
  ],
  [
"فتح ملف…",
"Open File…"
  ],
  [
"فتح مجلد…",
"Open Folder…"
  ],
  [
"إغلاق النافذة",
"Close Window"
  ],
  [
"خروج",
"Exit"
  ],
  [
"تراجع",
"Undo"
  ],
  [
"إعادة",
"Redo"
  ],
  [
"قص",
"Cut"
  ],
  [
"نسخ",
"Copy"
  ],
  [
"لصق",
"Paste"
  ],
  [
"تحديد الكل",
"Select all"
  ],
  [
"ملء الشاشة",
"Full screen"
  ],
  [
"تكبير",
"Zoom in"
  ],
  [
"تصغير",
"Zoom out"
  ],
  [
"الحجم الفعلي",
"Actual size"
  ],
  [
"حول",
"About"
  ],
  [
"اختصارات لوحة المفاتيح",
"Keyboard shortcuts"
  ],
  [
"قائمة التطبيق",
"Application menu"
  ],
  [
"إظهار أو إخفاء الشريط الجانبي",
"Toggle sidebar"
  ],
  [
"البحث والأوامر",
"Search and commands"
  ],
  [
"رجوع",
"Back"
  ],
  [
"تقدم",
"Forward"
  ],
  [
"معاينة ملء الشاشة",
"Fullscreen preview"
  ],
  [
"تصغير لوحات المعاينة",
"Minimize preview panels"
  ],
  [
"دليل القشرة",
"Shell guide"
  ],
  [
"استكشف القشور",
"Explore all shells"
  ],
  [
"تصفية الجلسات",
"Filter sessions"
  ],
  [
"قائمة الجلسة",
"Session menu"
  ],
  [
"إغلاق الإعدادات",
"Close settings"
  ],
  [
"إضافة رسالة إلى المعاينة",
"Add message to preview"
  ],
  [
"طرفية جديدة",
"New terminal"
  ],
  [
"إجراءات اللوحة",
"Panel actions"
  ],
  [
"تعويم اللوحة",
"Float panel"
  ],
  [
"تكبير اللوحة",
"Expand panel"
  ],
  [
"نسخ الرسالة",
"Copy message"
  ],
  [
"تثبيت الرسالة",
"Pin message"
  ],
  [
"تركيز الرسالة",
"Focus message"
  ],
  [
"قراءة بصوت",
"Read aloud"
  ],
  [
"مهمة جديدة",
"New task"
  ],
  [
"التعليمات",
"Instructions"
  ],
  [
"المعرفة",
"Knowledge"
  ],
  [
"المحادثات",
"Chats"
  ],
  [
"إعادة تسمية الجلسة",
"Rename session"
  ],
  [
"أرشفة الجلسة",
"Archive session"
  ],
  [
"نسخ الجلسة",
"Fork session"
  ],
  [
"حذف الجلسة",
"Delete session"
  ],
  [
"المهام الخلفية",
"Background tasks"
  ],
  [
"الحالة",
"Status"
  ],
  [
"البيئة",
"Environment"
  ],
  [
"تجميع حسب",
"Group by"
  ],
  [
"ترتيب حسب",
"Sort by"
  ],
  [
"المجلد",
"Folder"
  ],
  [
"الاسم",
"Name"
  ],
  [
"آخر نشاط",
"Last activity"
  ],
  [
"تاريخ الإنشاء",
"Date created"
  ],
  [
"نشط",
"Active"
  ],
  [
"مؤرشف",
"Archived"
  ],
  [
"إظهار المجموعات الفارغة",
"Show empty groups"
  ],
  [
"إظهار حالة طلب الدمج",
"Show PR status"
  ],
  [
"الروتينات",
"Routines"
  ],
  [
"تخصيص الشريط الجانبي",
"Edit sidebar"
  ],
  [
"تجريبي",
"Beta"
  ],
  [
"مثبّت",
"Installed"
  ],
  [
"غير مثبّت",
"Not installed"
  ],
  [
"الأكثر شيوعًا",
"Popular"
  ],
  [
"حُدّث مؤخرًا",
"Recently updated"
  ],
  [
"تصفية حسب",
"Filter by"
  ],
  [
"الدليل",
"Directory"
  ],
  [
"المؤلف",
"Author"
  ],
  [
"آخر تحديث",
"Last updated"
  ],
  [
"النوع",
"Type"
  ],
  [
"التفاصيل",
"Details"
  ],
  [
"إزالة",
"Remove"
  ],
  [
"إدارة",
"Manage"
  ],
  [
"تحديث",
"Update"
  ],
  [
"تصدير البيانات",
"Export data"
  ],
  [
"الدفع",
"Payment"
  ],
  [
"الفواتير",
"Invoices"
  ],
  [
"التاريخ",
"Date"
  ],
  [
"الإجمالي",
"Total"
  ],
  [
"مدفوع",
"Paid"
  ],
  [
"الإجراءات",
"Actions"
  ],
  [
"الإلغاء",
"Cancellation"
  ],
  [
"إلغاء الخطة",
"Cancel plan"
  ],
  [
"تعديل الخطة",
"Adjust plan"
  ],
  [
"الجلسة الحالية",
"Current session"
  ],
  [
"الحدود الأسبوعية",
"Weekly limits"
  ],
  [
"كل النماذج",
"All models"
  ],
  [
"رصيد الاستخدام",
"Usage credits"
  ],
  [
"التفضيلات",
"Preferences"
  ],
  [
"بياناتك",
"Your data"
  ],
  [
"بيانات الموقع",
"Location metadata"
  ],
  [
"المساعدة في تحسين النماذج",
"Help improve our AI models"
  ],
  [
"المحادثات المشتركة",
"Shared chats"
  ],
  [
"المخرجات المشتركة",
"Shared artifacts"
  ],
  [
"المظهر",
"Appearance"
  ],
  [
"اللغة",
"Language"
  ],
  [
"مظهر الكود",
"Code appearance"
  ],
  [
"خط الكود",
"Code font"
  ],
  [
"خط الواجهة",
"Interface font"
  ],
  [
"إعدادات سطح المكتب العامة",
"General desktop settings"
  ],
  [
"التشغيل عند بدء النظام",
"Run on startup"
  ],
  [
"اختصار الإدخال السريع",
"Quick Entry keyboard shortcut"
  ],
  [
"علبة النظام",
"System tray"
  ],
  [
"إبقاء الكمبيوتر مستيقظًا",
"Keep computer awake"
  ],
  [
"استخدام المتصفح",
"Browser use"
  ],
  [
"المتصفحات المتصلة",
"Connected browsers"
  ],
  [
"لا توجد متصفحات متصلة",
"No browsers connected"
  ],
  [
"إعادة الفحص",
"Recheck"
  ],
  [
"استخدام الكمبيوتر",
"Computer use"
  ],
  [
"أذونات المواقع",
"Site permissions"
  ],
  [
"الافتراضي لكل المواقع",
"Default for all sites"
  ],
  [
"السماح لكل المواقع",
"Allow all sites"
  ],
  [
"المواقع المحظورة",
"Blocked sites"
  ],
  [
"إضافة مواقع",
"Add websites"
  ],
  [
"النطاق",
"Domain"
  ],
  [
"خوادم MCP المحلية",
"Local MCP servers"
  ],
  [
"تحرير الإعدادات",
"Edit config"
  ],
  [
"عرض السجلات",
"View logs"
  ],
  [
"الأمر",
"Command"
  ],
  [
"المعاملات",
"Arguments"
  ],
  [
"قيد التشغيل",
"Running"
  ],
  [
"تصفح الملحقات",
"Browse extensions"
  ],
  [
"المثبّت على الكمبيوتر",
"Installed on your computer"
  ],
  [
"إعدادات متقدمة",
"Advanced settings"
  ],
  [
"وضع الوصول للأدوات",
"Tool access mode"
  ],
  [
"البحث عن الموصلات",
"Connector search"
  ],
  [
"المرئيات",
"Visuals"
  ],
  [
"مخرجات مدعومة بالذكاء الاصطناعي",
"AI-powered artifacts"
  ],
  [
"تصورات داخل المحادثة",
"Inline visualizations"
  ],
  [
"تنفيذ الكود وإنشاء الملفات",
"Code execution and file creation"
  ],
  [
"تصنيف حالات الجلسات",
"Classify session states"
  ],
  [
"تغيير النموذج عند وضع علامة على رسالة",
"Switch models when a message is flagged"
  ],
  [
"اشتراط أجهزة موثوقة",
"Require trusted devices"
  ],
  [
"ملفات العمل المشترك",
"Cowork files"
  ],
  [
"مجلدات العمل المشترك الموثوقة",
"Trusted Cowork folders"
  ],
  [
"على هذا الكمبيوتر فقط",
"Only on this computer"
  ],
  [
"المتصفح المفضل",
"Preferred browser"
  ],
  [
"فتح الروابط في المتصفح المدمج",
"Open links in built-in browser"
  ],
  [
"البحث في المحادثات والرجوع إليها",
"Search and reference chats"
  ],
  [
"إنشاء ذاكرة من المحادثات",
"Generate memory from chats"
  ],
  [
"تضمين المواضيع الحساسة في الذاكرة",
"Include sensitive topics in memory"
  ],
  [
"استيراد الذاكرة من مزوّد آخر",
"Import memory from other AI providers"
  ],
  [
"بدء الاستيراد",
"Start import"
  ],
  [
"أنت",
"You"
  ],
  [
"الملف الشخصي",
"Profile"
  ],
  [
"المواضيع",
"Topics"
  ],
  [
"دائمًا",
"Always"
  ],
  [
"عند الحاجة",
"When needed"
  ],
  [
"قائمة انتظار",
"Queue"
  ],
  [
"توجيه",
"Steer"
  ],
  [
"قشرة تفاعلية · بيانات عرض",
"Interactive shell · sample data"
  ],
  [
"التخطيط",
"Layout"
  ],
  [
"ميزات عبدو",
"AbdoCode features"
  ],
  [
"المحادثة",
"Conversation"
  ],
  [
"المهام",
"Tasks"
  ],
  [
"المسار",
"Trajectory"
  ],
  [
"مسار التنفيذ",
"Execution trajectory"
  ],
  [
"الخوادم",
"Servers"
  ],
  [
"النشاط والمصادر",
"Activity and sources"
  ],
  [
"المخرجات",
"Deliverables"
  ],
  [
"الموافقات",
"Approvals"
  ],
  [
"الوكلاء",
"Agents"
  ],
  [
"السياق والوعي",
"Context and awareness"
  ],
  [
"اسحب اللوحة",
"Drag panel"
  ],
  [
"نقل وترتيب اللوحة",
"Move and arrange panel"
  ],
  [
"تكبير اللوحة",
"Maximize panel"
  ],
  [
"إغلاق اللوحة",
"Close panel"
  ],
  [
"اللوحات والتخطيطات",
"Panels and layouts"
  ],
  [
"حالات الواجهة",
"Interface states"
  ],
  [
"جاهز للعمل",
"Ready to work"
  ],
  [
"جارٍ التنفيذ · حالة عرض",
"Running · sample state"
  ],
  [
"بانتظار موافقتك",
"Waiting for your approval"
  ],
  [
"اكتملت المهمة · حالة عرض",
"Task complete · sample state"
  ],
  [
"تعذر إكمال الخطوة",
"Could not complete the step"
  ],
  [
"محادثة جديدة",
"New conversation"
  ],
  [
"اكتب رسالة أو / للأوامر",
"Write a message or / for commands"
  ],
  [
"المظهر واللغة",
"Appearance and language"
  ],
  [
"لغة الواجهة",
"Interface language"
  ],
  [
"مظهر التطبيق",
"App theme"
  ],
  [
"كثافة العناصر",
"Interface density"
  ],
  [
"حجم الواجهة",
"Interface scale"
  ],
  [
"شدة شريط الأدوات",
"Toolbar strictness"
  ],
  [
"الشريط الجانبي",
"Sidebar"
  ],
  [
"زر المتصفح",
"Browser button"
  ],
  [
"ملخص التفكير",
"Reasoning summary"
  ],
  [
"توسيع تفاصيل الأدوات",
"Expand tool details"
  ],
  [
"المزوّدون والخزنة",
"Providers and vault"
  ],
  [
"اتصالات MCP",
"MCP connections"
  ],
  [
"النماذج والأدوار",
"Models and roles"
  ],
  [
"ميزات الوكيل · 32",
"Agent features · 32"
  ],
  [
"ميزات الوكيل",
"Agent features"
  ],
  [
"المنح وسجل الرفض",
"Grants and denial history"
  ],
  [
"اختصارات لوحة المفاتيح",
"Keyboard shortcuts"
  ],
  [
"التشغيل والأمان",
"Runtime and security"
  ],
  [
"تخطيط اللوحات",
"Panel layout"
  ],
  [
"أنماط التصميم",
"Design styles"
  ],
  [
"خريطة التغطية",
"Coverage map"
  ],
  [
"تفضيلات القشرة تُحفظ محليًا",
"Shell preferences are stored locally"
  ],
  [
"استعادة الافتراضي",
"Restore defaults"
  ],
  [
"إغلاق",
"Close"
  ],
  [
"إضافة",
"Add"
  ],
  [
"حفظ",
"Save"
  ],
  [
"إعداد",
"Configure"
  ],
  [
"تفاصيل",
"Details"
  ],
  [
"التفاصيل",
"Details"
  ],
  [
"فتح",
"Open"
  ],
  [
"استعادة",
"Restore"
  ],
  [
"حذف",
"Delete"
  ],
  [
"إزالة",
"Remove"
  ],
  [
"إلغاء",
"Cancel"
  ],
  [
"معاينة",
"Preview"
  ],
  [
"إدارة",
"Manage"
  ],
  [
"سجل",
"Logs"
  ],
  [
"التخطيطات",
"Layouts"
  ],
  [
"مطابق للصورة",
"Reference layout"
  ],
  [
"تركيز",
"Focus"
  ],
  [
"مراجعة",
"Review"
  ],
  [
"تطوير",
"Development"
  ],
  [
"متابعة الوكيل",
"Agent monitoring"
  ],
  [
"تراجع عن النقل",
"Undo move"
  ],
  [
"حفظ باسم",
"Save as"
  ],
  [
"ترتيباتي المحفوظة",
"My saved layouts"
  ],
  [
"لا توجد ترتيبات مسماة حتى الآن.",
"No named layouts saved yet."
  ],
  [
"تخطيطات مساحة العمل",
"Workspace layouts"
  ],
  [
"اسحب عنوان أي لوحة إلى حافة لوحة أخرى لتقسيمها، أو إلى الوسط لجمعهما في تبويبات.",
"Drag a panel title to another panel's edge to split it, or to its center to group tabs."
  ],
  [
"تصدير التخطيط",
"Export layout"
  ],
  [
"استيراد",
"Import"
  ],
  [
"حفظ التخطيط",
"Save layout"
  ],
  [
"الاسم",
"Name"
  ],
  [
"اللوحة المستهدفة",
"Target panel"
  ],
  [
"الموضع",
"Position"
  ],
  [
"يسار",
"Left"
  ],
  [
"يمين",
"Right"
  ],
  [
"أعلى",
"Top"
  ],
  [
"أسفل",
"Bottom"
  ],
  [
"تبويب داخل اللوحة",
"Tab inside panel"
  ],
  [
"نقل",
"Move"
  ],
  [
"نقل اللوحة…",
"Move panel…"
  ],
  [
"نافذة عائمة",
"Floating window"
  ],
  [
"إرساء داخل المساحة",
"Dock in workspace"
  ],
  [
"تكبير / استعادة",
"Maximize / restore"
  ],
  [
"إضافة لوحة",
"Add panel"
  ],
  [
"التخطيطات المحفوظة",
"Saved layouts"
  ],
  [
"تقسيم يسار",
"Split left"
  ],
  [
"تقسيم يمين",
"Split right"
  ],
  [
"تقسيم أعلى",
"Split above"
  ],
  [
"تقسيم أسفل",
"Split below"
  ],
  [
"جمع في تبويبات",
"Group as tabs"
  ],
  [
"يمكن تنفيذ الحركة نفسها بسحب التبويب إلى الحافة أو المنتصف.",
"You can also drag the tab to an edge or the center."
  ],
  [
"خط الواجهة",
"Interface font"
  ],
  [
"كثافة الواجهة",
"Interface density"
  ],
  [
"لون التمييز",
"Accent color"
  ],
  [
"معاينة المكوّنات",
"Component preview"
  ],
  [
"عنوان لوحة",
"Panel title"
  ],
  [
"نص مساعد وتفاصيل ثانوية",
"Helper text and secondary details"
  ],
  [
"زر أساسي",
"Primary button"
  ],
  [
"زر ثانوي",
"Secondary button"
  ],
  [
"مفتاح إعداد",
"Setting toggle"
  ],
  [
"حالة نشطة",
"Active state"
  ],
  [
"تبديل هذه المفاتيح يحفظ اختيار القشرة فقط. لم تُغيّر إعدادات عبدو كود العامل.",
"These switches save shell preferences only. They do not change the running AbdoCode app."
  ],
  [
"ابحث بالاسم أو المعرّف",
"Search by name or ID"
  ],
  [
"تغطية ميزات عبدو الحالية",
"Current AbdoCode feature coverage"
  ],
  [
"32 ميزة مسجلة في المصدر المقروء. لكل ميزة إعداد وتفاصيل تصميم. حالة المحرك الفعلية غير متصلة بهذه القشرة.",
"32 features catalogued from the reviewed source. Each has settings and design details. The runtime is not connected to this shell."
  ],
  [
"الميزة",
"Feature"
  ],
  [
"موضعها",
"Location"
  ],
  [
"التصميم",
"Design"
  ],
  [
"القيمة الافتراضية في المصدر",
"Source default"
  ],
  [
"موضع التصميم",
"Design location"
  ],
  [
"حفظ خيارات العرض",
"Save display options"
  ],
  [
"تصميم تفاعلي محلي · الربط بالخدمات مؤجل",
"Local interactive design · service integration deferred"
  ],
  [
"سجل الطرفية",
"Terminal history"
  ],
  [
"تصفية الإيصالات",
"Filter receipts"
  ],
  [
"اسم الأداة أو النص",
"Tool name or text"
  ],
  [
"أمر يمر ببوابة الموافقة…",
"Command subject to approval…"
  ],
  [
"مراجعة أمر الطرفية",
"Review terminal command"
  ],
  [
"تصميم مرور الأمر ببوابة الموافقة. لن يعمل الأمر على جهازك.",
"Preview the command approval flow. The command will not run on your computer."
  ],
  [
"عرض طلب الموافقة",
"Show approval request"
  ],
  [
"إيصالات التنفيذ ومخرجات الأوامر تظهر هنا بعد الربط.",
"Execution receipts and command output will appear here after integration."
  ],
  [
"عرض التغييرات",
"Changes view"
  ],
  [
"مراجعة ملف",
"Review file"
  ],
  [
"ملفات معدلة",
"Changed files"
  ],
  [
"ملفات مهيأة",
"Staged files"
  ],
  [
"لا توجد ملفات مهيأة",
"No staged files"
  ],
  [
"اختر ملفًا من التغييرات للمراجعة.",
"Select a changed file to review."
  ],
  [
"عرض تجريبي",
"Preview"
  ],
  [
"تفاصيل الإيصال",
"Receipt details"
  ],
  [
"فهم الطلب",
"Understand request"
  ],
  [
"قراءة المصدر",
"Read source"
  ],
  [
"بوابة الموافقة",
"Approval gate"
  ],
  [
"مراجعة النتيجة",
"Review result"
  ],
  [
"طلب موافقة على تعديل ملف",
"Approval requested for a file edit"
  ],
  [
"write_file · src/shell.rs · 2 تغييرات. راجع المعاينة قبل اختيار القرار.",
"write_file · src/shell.rs · 2 changes. Review the preview before deciding."
  ],
  [
"معاينة التغييرات",
"Preview changes"
  ],
  [
"السماح مرة",
"Allow once"
  ],
  [
"رفض",
"Deny"
  ],
  [
"إلغاء الخطوة",
"Cancel step"
  ],
  [
"مركز الموافقات",
"Approval center"
  ],
  [
"تعديل src/shell.rs",
"Edit src/shell.rs"
  ],
  [
"نوع العملية: كتابة ملف · نطاق المشروع",
"Operation: write file · project scope"
  ],
  [
"بانتظار القرار",
"Awaiting decision"
  ],
  [
"مراجعة الطلب",
"Review request"
  ],
  [
"طلب عرض جديد",
"New sample request"
  ],
  [
"راجع الأذونات الدائمة، قرارات الجلسة، وعداد الرفض المتكرر.",
"Review scoped grants, session decisions, and repeated denial counts."
  ],
  [
"الصلاحيات",
"Permissions"
  ],
  [
"الصلاحيات والمنح",
"Permissions and grants"
  ],
  [
"سياسة العمل",
"Access policy"
  ],
  [
"المنح الدائمة",
"Session grants"
  ],
  [
"النطاق",
"Scope"
  ],
  [
"الفئة",
"Class"
  ],
  [
"إلغاء المنحة",
"Revoke grant"
  ],
  [
"منحة جديدة",
"New grant"
  ],
  [
"سجل الرفض المتكرر",
"Repeated denial history"
  ],
  [
"عداد رفض write_file:",
"write_file denial count:"
  ],
  [
"إعادة ضبط العداد",
"Reset counter"
  ],
  [
"طلبات الموافقة",
"Approval requests"
  ],
  [
"قاطع الرفض",
"Denial breaker"
  ],
  [
"إشعارات الأخطاء",
"Error notifications"
  ],
  [
"صوت طلب الموافقة",
"Approval request sound"
  ],
  [
"رسائل المتابعة",
"Follow-up messages"
  ],
  [
"الإحياء اليدوي للمحرك",
"Manual engine restart"
  ],
  [
"عرض حالة التشغيل",
"View runtime status"
  ],
  [
"حدود الجولة",
"Turn limits"
  ],
  [
"ميزانية السياق وعدد الخطوات",
"Context budget and step limit"
  ],
  [
"تخصيص",
"Customize"
  ],
  [
"الأسرار الواردة",
"Secret intake"
  ],
  [
"حقول أسرار مؤقتة ولا تظهر في الإيصالات",
"Transient secret fields excluded from receipts"
  ],
  [
"حراس الإدخال",
"Input guards"
  ],
  [
"قواعد فحص المدخلات",
"Input inspection rules"
  ],
  [
"التوجيه حسب الدور",
"Role routing"
  ],
  [
"نموذج المحادثة",
"Chat model"
  ],
  [
"نموذج الوكيل",
"Agent model"
  ],
  [
"بوابة الموجّه",
"Router gate"
  ],
  [
"جهد التفكير",
"Reasoning effort"
  ],
  [
"النموذج المحلي",
"Local model"
  ],
  [
"غير متصل",
"Disconnected"
  ],
  [
"إعداد Ollama",
"Configure Ollama"
  ],
  [
"ميزانية المهمة والسياق",
"Task and context budget"
  ],
  [
"حالة التحميل، استخدام الذاكرة، وملف GPU تظهر بعد توصيل مزوّد محلي.",
"Loading status, memory use, and GPU profile appear after a local provider is connected."
  ],
  [
"تصميم خزنة المزوّدين. القشرة لا تقرأ أسرار التطبيق؛ في مرحلة الربط يحفظ المحرك المفتاح ويعيد حالة توفره فقط.",
"Provider vault design. The shell does not read app secrets. After integration, the runtime stores the key and returns availability only."
  ],
  [
"إضافة مزوّد مخصص",
"Add custom provider"
  ],
  [
"كتالوج الخوادم والاتصال اليدوي ومعاينة الأمر قبل التشغيل.",
"Server catalog, manual connections, and command preview before execution."
  ],
  [
"إضافة خادم",
"Add server"
  ],
  [
"لوحة الخوادم",
"Servers panel"
  ],
  [
"مهمة جديدة",
"New task"
  ],
  [
"معاينة الوعي",
"Preview awareness"
  ],
  [
"إضافة مصدر",
"Add source"
  ],
  [
"وعي المشروع",
"Project awareness"
  ],
  [
"مصادر المشروع والسياق المتراكم وإجراءات الاستئناف.",
"Project sources, accumulated context, and resume actions."
  ],
  [
"تعليمات المشروع",
"Project instructions"
  ],
  [
"حفظ التعليمات",
"Save instructions"
  ],
  [
"إضافة ملف",
"Add file"
  ],
  [
"اسم الملف",
"File name"
  ],
  [
"إضافة مرجع ملف",
"Add file reference"
  ],
  [
"مرجع محلي في نموذج التصميم",
"Local reference in the design model"
  ],
  [
"اسم المشروع",
"Project name"
  ],
  [
"الوصف",
"Description"
  ],
  [
"حذف المشروع",
"Delete project"
  ],
  [
"كل المشروعات",
"All projects"
  ],
  [
"مساحة المشروع",
"Project workspace"
  ],
  [
"المحادثات والمراجع والتعليمات الخاصة بهذا المشروع في مكان واحد.",
"Project conversations, references, and instructions in one place."
  ],
  [
"افتح مساحة الكود",
"Open code workspace"
  ],
  [
"ملخص",
"Summary"
  ],
  [
"متابعة",
"Continue"
  ],
  [
"المحادثة الحالية",
"Current conversation"
  ],
  [
"جداول عرض محفوظة محليًا؛ لا تعمل أي مهمة في الخلفية.",
"Schedules saved locally for preview; no background tasks run."
  ],
  [
"لا توجد مهام مجدولة",
"No scheduled tasks"
  ],
  [
"صمّم روتينًا وحدد وقته وتكراره.",
"Create a routine and choose its time and frequency."
  ],
  [
"إنشاء مهمة",
"Create task"
  ],
  [
"تعديل",
"Edit"
  ],
  [
"استئناف",
"Resume"
  ],
  [
"إيقاف",
"Pause"
  ],
  [
"حفظ الجدول",
"Save schedule"
  ],
  [
"تخصيص اختصار",
"Customize shortcut"
  ],
  [
"الإجراء",
"Action"
  ],
  [
"الاختصار",
"Shortcut"
  ],
  [
"لوحة الأوامر",
"Command palette"
  ],
  [
"إظهار الشريط",
"Show sidebar"
  ],
  [
"الطرفية",
"Terminal"
  ],
  [
"التغييرات",
"Changes"
  ],
  [
"الملفات",
"Files"
  ],
  [
"إغلاق نافذة داخلية",
"Close dialog"
  ],
  [
"نقل اللوحات دون سحب",
"Move panels without dragging"
  ],
  [
"افتح قائمة اللوحة ⋮، واختر نقل اللوحة، ثم الموضع واللوحة المستهدفة. حرّك الفواصل بأسهم لوحة المفاتيح.",
"Open a panel's ⋮ menu, choose Move panel, then select a target and position. Use arrow keys to resize focused dividers."
  ],
  [
"الوكيل الرئيسي",
"Main agent"
  ],
  [
"الدور: تنسيق المهمة والسياق والأدوات",
"Role: coordinate the task, context, and tools"
  ],
  [
"النموذج والتوجيه",
"Model and routing"
  ],
  [
"التفويض",
"Delegation"
  ],
  [
"واجهة التفويض المتسلسل لابن واحد، مع تسليم موجز المهمة وإعادة النتيجة للمسار الرئيسي.",
"Sequential delegation to one child, with a task brief and a result returned to the parent trajectory."
  ],
  [
"طلب تفويض",
"Request delegation"
  ],
  [
"المراجع",
"Reviewer"
  ],
  [
"مراجعة الناتج قبل إنهاء المهمة.",
"Review the output before completing the task."
  ],
  [
"إعداد المراجع",
"Configure reviewer"
  ],
  [
"مخرجات مرتبطة بإيصالات قابلة للمراجعة.",
"Deliverables linked to reviewable receipts."
  ],
  [
"ملف توضيحي · لا يصف ناتجًا حقيقيًا للمحرك",
"Sample file · not an actual runtime result"
  ],
  [
"الإيصال",
"Receipt"
  ],
  [
"عرض نشاط مرتبط بالمهمة ومصدره",
"Task activity and its source"
  ],
  [
"حالة الاتصال",
"Connection status"
  ],
  [
"حفظ إعداد العرض",
"Save display settings"
  ],
  [
"حفظ الإعداد",
"Save settings"
  ],
  [
"حفظ التفضيل",
"Save preference"
  ],
  [
"لا توجد جلسة متصلة في القشرة الحالية.",
"No session connected to the current shell."
  ],
  [
"لا توجد قياسات تشغيل فعلية في القشرة.",
"No live runtime measurements are available in the shell."
  ],
  [
"الحالة: غير متصل",
"Status: disconnected"
  ],
  [
"خانة السر معطلة في التصميم لتجنّب جمع مفاتيح حقيقية.",
"The secret field is disabled in this design to avoid collecting real keys."
  ],
  [
"يُحفظ في الخزنة عند الربط",
"Stored in the vault after integration"
  ],
  [
"المعلومة",
"Information"
  ],
  [
"القيمة",
"Value"
  ],
  [
"المدخلات والمخرجات",
"Inputs and outputs"
  ],
  [
"ملاحظة المراجعة",
"Review note"
  ],
  [
"حفظ ملاحظة",
"Save note"
  ],
  [
"حفظ في القشرة",
"Save in shell"
  ],
  [
"معاينة شكل المحادثة وتوزيع الأدوات داخل مساحة العمل.",
"Preview the conversation and tools inside your workspace."
  ],
  [
"تصميم القشرة وواجهات العمل",
"Shell design and workspace interfaces"
  ],
  [
"تحتوي مساحة العمل على محادثة رئيسية، وشريط جانبي للجلسات، ولوحات يمكن فتحها وإغلاقها من أعلى النافذة.",
"The workspace contains a main conversation, a session sidebar, and tool panels that you can open or close from the header."
  ],
  [
"افتح",
"Open"
  ],
  [
"أو",
"or"
  ],
  [
"، ثم اسحب الفاصل لتغيير عرض كل لوحة. يحتفظ هذا النموذج بتفاعلات الواجهة داخل المتصفح.",
", then drag the divider to resize each panel. This prototype keeps interface interactions inside your browser."
  ],
  [
"تنظيم التبويبات",
"Organize tabs"
  ],
  [
"يمكن عرض لوحة واحدة، أو لوحتين فوق بعضهما، أو مساحة أدوات موزعة على عمودين كما في الصور المرجعية.",
"Display one panel, stack two panels, or arrange tools in two columns as shown in the references."
  ],
  [
"تفاصيل القشرة",
"Shell details"
  ],
  [
"١.",
"1."
  ],
  [
"٢.",
"2."
  ],
  [
"٣.",
"3."
  ],
  [
"المحادثة:",
"Conversation:"
  ],
  [
"القوائم:",
"Menus:"
  ],
  [
"الإعدادات:",
"Settings:"
  ],
  [
"نص عربي باتجاه صحيح، عناوين، مقاطع كود، روابط، وأدوات الرسالة.",
"Language-aware text direction, headings, code blocks, links, and message actions."
  ],
  [
"خيارات الجلسة، اختيار النموذج، صلاحيات العرض، مصادر العمل، وتصفية الشريط الجانبي.",
"Session options, model selection, permissions, workspace sources, and sidebar filters."
  ],
  [
"تبويبات مستقلة للمظهر، القدرات، الاستخدام، الإضافات، الموصلات، الذاكرة، وأدوات المطور.",
"Separate settings for appearance, capabilities, usage, plugins, connectors, memory, and developer tools."
  ],
  [
"هذا محتوى توضيحي للتصميم. الأزرار التي تمثل خدمات أو حسابات تعرض نافذة معاينة محلية.",
"This is sample design content. Service and account controls open local preview dialogs."
  ],
  [
"معاينة لتصميم نتائج المتصفح داخل اللوحة. لا يتم الاتصال بالموقع أو إرسال البحث.",
"Preview of search results inside the panel. No website is contacted and no search is submitted."
  ],
  [
"التصميم العام",
"General design"
  ],
  [
"تفاصيل التبويبات",
"Tab details"
  ],
  [
"جلسات العمل",
"Work sessions"
  ],
  [
"إعدادات التطبيق",
"App settings"
  ],
  [
"تخطيط مساحة العمل",
"Workspace layout"
  ],
  [
"إعدادات الوكيل",
"Agent settings"
  ],
  [
"الموافقات والصلاحيات",
"Approvals and permissions"
  ],
  [
"الاتصالات والخوادم",
"Connections and servers"
  ],
  [
"النشاط والمخرجات",
"Activity and deliverables"
  ],
  [
"اسم المزوّد",
"Provider name"
  ],
  [
"اسم الخادم",
"Server name"
  ],
  [
"الأمر أو عنوان الخادم",
"Command or server URL"
  ],
  [
"الأداة / مساحة المزوّد",
"Tool / provider namespace"
  ],
  [
"فئة الإذن",
"Permission class"
  ],
  [
"عنوان المهمة",
"Task title"
  ],
  [
"التعليمات",
"Instructions"
  ],
  [
"المشروع",
"Project"
  ],
  [
"عنوان التفويض",
"Delegation title"
  ],
  [
"موجز المهمة",
"Task brief"
  ],
  [
"معيار إكمال المهمة",
"Completion criterion"
  ],
  [
"اسم المصدر",
"Source name"
  ],
  [
"الرابط أو مسار الملف",
"URL or file path"
  ],
  [
"مهلة انتظار الموافقة بالثواني",
"Approval timeout in seconds"
  ],
  [
"الحدود المسموحة",
"Allowed range"
  ],
  [
"نطاق الرفض",
"Denial scope"
  ],
  [
"عدد الرفض قبل القطع",
"Denials before blocking"
  ],
  [
"الأداة أو المزوّد",
"Tool or provider"
  ],
  [
"فئة العملية",
"Operation class"
  ],
  [
"نطاق المنحة",
"Grant scope"
  ],
  [
"مصدر المحتوى",
"Content source"
  ],
  [
"قاعدة الفحص",
"Inspection rule"
  ],
  [
"عدد الأبناء المتزامنين",
"Concurrent children"
  ],
  [
"موجز التسليم",
"Handoff brief"
  ],
  [
"إرجاع النتيجة",
"Return result"
  ],
  [
"متى يراجع",
"Review timing"
  ],
  [
"معيار القبول",
"Acceptance criterion"
  ],
  [
"العناصر المعروضة",
"Displayed items"
  ],
  [
"الإظهار الافتراضي",
"Default visibility"
  ],
  [
"نوع المخرجات",
"Output type"
  ],
  [
"مدخل الأوامر",
"Command input"
  ],
  [
"الحالة غير المقاسة",
"Unmeasured state"
  ],
  [
"نطاق العملية",
"Operation scope"
  ],
  [
"إظهار المهام",
"Visible tasks"
  ],
  [
"ترتيب العرض",
"Display order"
  ],
  [
"عقد الطلب",
"Request contract"
  ],
  [
"بوابة المخالفة",
"Violation gate"
  ],
  [
"معيار التحقق",
"Verification criterion"
  ],
  [
"عدم اكتمال الدليل",
"Incomplete evidence"
  ],
  [
"نتيجة الأداة",
"Tool result"
  ],
  [
"ربط الإيصال",
"Receipt link"
  ],
  [
"مصدر التعلّم",
"Learning source"
  ],
  [
"مراجعة الاستنتاج",
"Review inference"
  ],
  [
"حفظ أجزاء القراءة",
"Retained read excerpts"
  ],
  [
"المرجع الأصلي",
"Original reference"
  ],
  [
"ضغط المسار",
"Trajectory compaction"
  ],
  [
"الإيصالات المحفوظة",
"Retained receipts"
  ],
  [
"إظهار الإحصاء",
"Visible statistics"
  ],
  [
"مصدر القياس",
"Measurement source"
  ],
  [
"هدف الاستئناف",
"Resume intent"
  ],
  [
"نقطة الحفظ",
"Checkpoint"
  ],
  [
"ميزانية السياق",
"Context budget"
  ],
  [
"أقصى عدد خطوات",
"Maximum steps"
  ],
  [
"نوع الحالة",
"State type"
  ],
  [
"تصنيف الدليل",
"Evidence classification"
  ],
  [
"الهدف",
"Goal"
  ],
  [
"معيار الإكمال",
"Completion criterion"
  ],
  [
"استبدال صندوق الرسالة",
"Replace composer"
  ],
  [
"خيارات القرار",
"Decision options"
  ],
  [
"إظهار المسار",
"Show trajectory"
  ],
  [
"نوع المخرج",
"Deliverable type"
  ],
  [
"مرجع الدليل",
"Evidence reference"
  ],
  [
"موضع الحفظ",
"Storage location"
  ],
  [
"الإظهار في السجل",
"Log visibility"
  ],
  [
"سياسة السياق",
"Context policy"
  ],
  [
"المصادر",
"Sources"
  ],
  [
"نسخة المخطط",
"Schema version"
  ],
  [
"التطبيق",
"Application"
  ],
  [
"قائمة الأدوات",
"Tool inventory"
  ],
  [
"أولوية القاعدة",
"Rule priority"
  ],
  [
"النص",
"Text"
  ],
  [
"تكبير",
"Zoom in"
  ],
  [
"تصغير",
"Zoom out"
  ],
  [
"الحجم الطبيعي",
"Actual size"
  ],
  [
"نسخ العنوان",
"Copy address"
  ],
  [
"فتح خارجي",
"Open externally"
  ],
  [
"طباعة",
"Print"
  ],
  [
"بحث داخل الصفحة",
"Find in page"
  ],
  [
"ابحث عن واجهة أو إعداد",
"Find an interface or setting"
  ],
  [
"تم حفظ تفضيلات القشرة",
"Shell preferences saved"
  ],
  [
"تم حفظ خيارات الميزة في القشرة",
"Feature options saved in the shell"
  ],
  [
"تم حفظ الترتيب",
"Layout saved"
  ],
  [
"تمت الإضافة إلى القشرة",
"Added to the shell"
  ],
  [
"تم حفظ تعليمات المشروع",
"Project instructions saved"
  ],
  [
"حُفظ المستند محليًا",
"Document saved locally"
  ],
  [
"لا توجد حركة للتراجع عنها",
"No move to undo"
  ],
  [
"اكتب اسم التخطيط",
"Enter a layout name"
  ],
  [
"اكتب اسمًا أولًا",
"Enter a name first"
  ],
  [
"اكتب اسم المشروع",
"Enter a project name"
  ],
  [
"اكتب اسم المهمة",
"Enter a task name"
  ],
  [
"التخطيط غير صالح؛ يجب أن يحتوي محادثة ولوحات غير مكررة",
"Invalid layout: a conversation and unique panels are required"
  ],
  [
"تم حفظ نتيجة الخطوة في القشرة",
"Step result saved in the shell"
  ],
  [
"تم اتخاذ القرار بالفعل",
"A decision has already been made"
  ],
  [
"معاينة حالة الزر",
"Button state preview"
  ],
  [
"النص موجود في الصفحة",
"Text found on the page"
  ],
  [
"لا توجد نتيجة",
"No results"
  ],
  [
"تم نسخ العنوان",
"Address copied"
  ],
  [
"تعذر النسخ",
"Copy failed"
  ],
  [
"تم تحديث قائمة المعاينة المحلية فقط",
"Only the local preview list was updated"
  ],
  [
"تم عرض العنوان محليًا — لم يُفتح اتصال خارجي",
"Address preview updated locally; no external connection opened"
  ],
  [
"انتهت معاينة الخطوة — لا يوجد إجراء خارجي",
"Step preview finished; no external action occurred"
  ],
  [
"تم حفظ حالة العرض لهذه الخطوة فقط",
"Only this step's display state was saved"
  ],
  [
"أُضيف النص إلى هذه المعاينة المحلية",
"Text added to this local preview"
  ]
];
const pluginTranslations = {
"denialBreaker": {
"label": "قاطعُ الرفض المتكرّر",
"description": "طلبٌ رُفض ثلاث مرّاتٍ في هذه الجلسة يُقطع بلا سؤالٍ رابع. العطلُ الذي يعالجه: نموذجٌ يعيد ما رُفض بصيغةٍ أخرى فيُسأل المشغّلُ السؤالَ نفسَه مراراً حتى يملّ فيوافق — وإرهاقُ الموافقة بابٌ خلفيٌّ بلا كود. **يبدأ مطفأً** لأنّه يقرّر نيابةً عن المشغّل؛ أمّا **عرضُ التاريخ** (كم مرّةً رُفض هذا الطلب) فيصحب كلَّ سؤالٍ بلا مفتاح، لأنّ إخفاء تاريخٍ يملكه النظامُ عمّن يقرّر ليس حياداً. والعدُّ للجلسة وحدها ولا يُكتب على قرص، والمحوُ من «الصلاحيات» يعيد السؤال.",
"englishLabel": "Repeated denial breaker",
"englishDescription": "Stop requesting an operation after three denials in the current session. Disabled by default. Denial history is always shown; counts stay in memory and can be reset in Permissions."
  },
"unattendedDeny": {
"label": "الصمتُ رفضٌ بعد مهلة",
"description": "سؤالُ موافقةٍ لا يجيبه أحدٌ ينتهي رفضاً بعد مهلة، بدل أن يعلّق الدورَ إلى الأبد. المهلةُ من الإعدادات (approvalTimeoutSeconds، من 10 ثوانٍ إلى أربع ساعات، والافتراض عشر دقائق)، والانتهاءُ يُعلَن بإطارٍ فتُحدَّث كتلةُ السؤال في القشرة ويُكتب في الدفتر. **مشتغلٌ افتراضاً** لأنّه ينفّذ قاعدةً مكتوبةً في البوّابة نفسِها منذ البداية — «الصمت ليس إذناً» — ولم يكن لها آليّة: الدورُ كان يقف بلا نهاية. المعطَّل = الانتظارُ بلا حدّ كما كان.",
"englishLabel": "Approval timeout denial",
"englishDescription": "Deny unanswered approval requests after a configurable timeout. Default: 600 seconds; allowed range: 10–14400 seconds. Enabled by default; silence never grants permission."
  },
"standingGrants": {
"label": "منحٌ قائمٌ لهذه الجلسة",
"description": "إذنٌ مكتوبُ النطاق يُقال مرّةً بدل أن يُسأل عشراً: «هذه الأداة» أو «كلّ أدوات هذا الخادم»، لصنفٍ واحدٍ بعينه. مقيَّدٌ بالصنف والهدف معاً (منحُ read لا يفتح command)، ولا منحَ عامّاً (أوسعُه بادئةُ مزوّدٍ منتهيةٌ بنقطة)، ولا يُكتب على قرصٍ ولا ينجو من إعادة تشغيل، ويُعلَن عند كلّ استعمال، ويُنقض بنقرة. **يبدأ مطفأً** لأنّه يخفّف بوّابةً: الحارسُ يبدأ مشتغلاً، والتخفيفُ يبدأ مطفأً. المعطَّل = كلُّ نداءٍ يُسأل كما كان.",
"englishLabel": "Session-scoped grants",
"englishDescription": "Grant a named tool or provider namespace access for one operation class and target. Grants are announced when used, revocable, and kept in memory for this session only. Disabled by default."
  },
"inboundGuard": {
"label": "حارس الوارد",
"description": "نصُّ الأدوات — صفحةٌ، أو نتيجةُ بحث، أو ملفٌّ، أو أداةُ خادم MCP — يُفحص بقواعدَ مسمّاةٍ قبل أن يبلغ النموذج: تجاوزُ التعليمات، وانتحالُ الهويّة، وطلبُ التسريب، وتزويرُ إطارِ أداة، ومحارفُ الإخفاء. والفعلُ **وسمٌ لا مقصّ**: لا يُحذف نصُّ أحد، بل يُعلَن ما أُطلق ويُسبَق النصُّ بسطرِ «بياناتٌ لا أوامر»؛ ووسومُ الأدوار وحدها تُبطَّل لأنّها محاكاةُ بروتوكولٍ لا نصٌّ للقارئ. الكشفُ على نسخةٍ مطبَّعةٍ (تشكيل وتطويل وهمزات وأرقام وصفرُ عرض) وبمتغيّراتٍ (بدائلُ الأرقام، وضمُّ المسافات) — والنظيفُ يخرج مطابقاً بايتاً ببايت، فلا كلفةَ في الحالة الغالبة. المعطَّل = النصُّ يمرّ كما هو.",
"englishLabel": "Inbound content guard",
"englishDescription": "Inspect incoming tool, web, file, and MCP content for embedded instructions, impersonation, secret requests, and protocol spoofing. Mark suspicious content as data; preserve ordinary content and neutralize role-tag spoofing."
  },
"mcpClient": {
"label": "عميل MCP",
"description": "توصيلُ خوادم MCP القياسيّة (JSON-RPC 2.0 على stdio) كمزوّدي أدوات: initialize ثمّ tools/list ثمّ tools/call. أدواتُها تدخل الكتالوجَ منسوبةً بـ«<خادم>.<أداة>» وتمرّ ببوّابة الموافقة نفسِها، وصنفُها command دائماً — تلميحُ readOnlyHint إقرارُ طرفٍ ثالثٍ عن نفسه لا دليل. المعطَّل = وحدةُ العميل لا تُستورَد أصلاً، وطلبُ التوصيل بـmcp يُرفض بالاسم. وكلُّ توصيلٍ قرارُ مالكٍ صريح، لا ثقةَ مشتقّةٌ من توصيلٍ سابق.",
"englishLabel": "MCP client",
"englishDescription": "Connect explicitly to MCP servers over stdio JSON-RPC and expose their tools with server-prefixed names. Every tool uses the same approval gate; a server read-only hint does not establish permission. Disabled means the client is not loaded."
  },
"delegation": {
"label": "التفويض إلى وكيل دور",
"description": "أداةُ delegate: مهمّةٌ تُسلَّم لوكيلٍ سقفُه أدواته المعلَنة، بحِقبٍ وإيصالاتٍ ووعيٍ خاصّة به، وبسقفِ إنفاقِ الدور وبوّابتِه ونمطِه نفسها. المعطَّل = الأداة لا تُعلَن ولا تُوزَّع (رفضٌ بالاسم)، والعمقُ مسقوفٌ بواحد في الحالتين.",
"englishLabel": "Sequential delegation",
"englishDescription": "Delegate a bounded task to one child at a time, with its declared tools, evidence, parent budget, and approval policy. Delegation depth is limited to one. Disabled means the tool is not available."
  },
"reviewer": {
"label": "وكيل المراجعة قراءة-فقط",
"description": "يُدرج وكيل «reviewer» في كتالوج التفويض: يقرأ ما كُتب ويسمّي عيوبه ولا يصلحها — وقراءتُه-فقط مشتقّةٌ من أدواته المعلَنة لا من نثر متنه. المعطَّل = الوكيل غائبٌ عن الكتالوج، وتفويضٌ إليه يُرفض بالاسم.",
"englishLabel": "Result reviewer",
"englishDescription": "Make the read-only reviewer available for delegation. It can inspect the result and report defects, but cannot edit files. Disabled means it is absent from the agent catalog."
  },
"activity": {
"label": "لوحة نشاط الدور",
"description": "المخرجات والمصادر والمتصفّح الحيّ فوق لوح التصفّح. مطفأةٌ افتراضياً اللوح صار للمتصفّح وحده كما في المرجع. والمطفأ يُنزع من الشجرة لا يُخفى بصنفٍ — فلا يشغل تخطيطاً ولا يقرؤه قارئُ الشاشة. تشغيلُها يعيدها إلى موضعها بمرساةٍ محفوظة.",
"englishLabel": "Activity panel",
"englishDescription": "Show task activity, sources, browser references, and outputs in an optional panel."
  },
"terminalPanel": {
"label": "لوح الطرفية",
"description": "لوحٌ يعرض أوامرَ الجلسة وإيصالاتِها بألسنة، وحقلُ أمرٍ يمرّ ببوابة النمط نفسِها. **إيصالاتٌ لا بثٌّ حيّ**: خرجُ الأمر يُستنزف كاملاً في المُطلِق قبل أن يصل، فلوحٌ يوهم بالحياة يكذب. لا فولد ثانياً — الصفوف من فولد المسار القائم. المعطَّل = لا لوح ولا وحدة تُحمَّل.",
"englishLabel": "Terminal panel",
"englishDescription": "Display execution receipts and command output. Command input follows the approval policy."
  },
"serversPanel": {
"label": "لوح الخوادم المُدارة",
"description": "لوحٌ يعرض خوادمَ التطوير المُدارة بحالةٍ مقيسة (يعمل/غير عامل بسببه) وزرِّ فتحٍ وإيقاف. **ويغيّر عمرَها**: مشتعلاً تبقى الخوادم بين الأدوار حتى يوقفها المشغّل أو يُغلق المحرّك؛ مطفأً تُقتل عند نهاية كلّ دور كما كانت حرفياً. أطفئه إن أردت ألّا يبقى خادمٌ يعمل بعد انتهاء دورك.",
"englishLabel": "Servers panel",
"englishDescription": "Display managed servers with their observed status, settings, and logs. Unmeasured status remains unverified."
  },
"tasksPanel": {
"label": "لوح المهامّ",
"description": "عمودٌ يعرض الدورَ الجاري بحقبه وأدواته وأزمنته، والأدوارَ الأخيرة بحكمها. عرضٌ فوق فولد المسار القائم — لا فولد ثانياً ولا كلفة على المحرّك ولا نصٌّ يراه النموذج. المعطَّل = لا لوح ولا وحدة تُحمَّل.",
"englishLabel": "Tasks panel",
"englishDescription": "Display session tasks, execution epochs, tool counts, durations, and progress."
  },
"walls": {
"label": "كاشف الجدران الخارجية",
"description": "جدار بيئة تكرر (اعتماد غائب/تنصيب/صلاحية) = تسليم صادق باسمه بدل حرق الحقب. عيوب النموذج الذاتية لا تُحتسب أبداً.",
"englishLabel": "Execution boundaries",
"englishDescription": "Keep execution inside explicit request boundaries and surface violations for review."
  },
"verifier": {
"label": "المحكّم الدلالي للتسليم",
"description": "بعد نجاح البوابات الميكانيكية، نموذج يحكم: هل فُعل المطلوب فعلاً؟ حكم رباعي، ولا فشل مفتوحاً. قيد التأهيل الحي.",
"englishLabel": "Outcome verifier",
"englishDescription": "Verify that the result has evidence for the requested outcome. Missing evidence remains unresolved."
  },
"toolVerdict": {
"label": "حكم صريح من الأداة",
"description": "الحكم من حقول المنفّذ لا من نص الإيصال؛ التعبير النمطي احتياطٌ يُعدّ. يسري من الدور القادم.",
"englishLabel": "Tool verdicts",
"englishDescription": "Record success, failure, or unresolved status for each tool call and link it to its receipt."
  },
"miner": {
"label": "معدِّن الكتيّبات",
"description": "فشل متكرر لا يعرفه السجل يُرشَّح كتيّباً جديداً للمشرف — ترشيح لا حفظ، وبصفر تكلفة نموذج.",
"englishLabel": "Experience mining",
"englishDescription": "Extract reusable lessons from verified receipts and keep their evidence available for review."
  },
"readCompaction": {
"label": "ضغط إيصالات القراءة",
"description": "القراءات القديمة تُطوى إلى بصمة حين تتضخّم الحقبة؛ الأحدث تبقى كاملة. يسري من الدور القادم.",
"englishLabel": "Read compaction",
"englishDescription": "Reduce retained reads to relevant excerpts while preserving source references."
  },
"trailCompaction": {
"label": "ضغط إيصالات التنفيذ",
"description": "إيصالات run/write/edit القديمة تُطوى إلى سطر الحكم؛ الأحدث تبقى كاملة. يسري من الدور القادم.",
"englishLabel": "Trajectory compaction",
"englishDescription": "Compact completed execution history while retaining decisions and unresolved steps."
  },
"cacheAccounting": {
"label": "حساب الكاش في الميزانية",
"description": "التوكنز المخبوءة عند المزوّد تُحسب بخصمها لا كاملة. يسري من الدور القادم.",
"englishLabel": "Cache accounting",
"englishDescription": "Display input, cached-input, and output usage from provider receipts."
  },
"semanticFrame": {
"label": "المحرّك الدلاليّ — فهمُ الطلب بلهجته",
"description": "إطارٌ حتميّ للطلب قبل أوّل نداء: اللغةُ واللهجةُ والفعلُ والهدف — بسطر إيصالٍ 🧭 — وعثورٌ حتميّ على المجلّد المطلوب بالاسم المنطوق يُحقن في الحقبة الأولى، فيبدأ النموذجُ من الحقيقة لا من التخمين. بلا نموذج ولا شبكة. المعطَّل = لا إطار ولا سطر ولا موجز — بايتاً كما كان. يسري من الدور القادم.",
"englishLabel": "Semantic frame",
"englishDescription": "Deterministically frames each request before the first model call: language, dialect, action and target, with a receipt line; locates a folder by its spoken name and injects the real path into the first epoch. No model, no network. Off = byte-identical to before. Applies from the next turn."
  },
"semanticInfer": {
"label": "الاستنتاج الدلاليّ — المرادُ والدافعُ والمطلوب",
"description": "الطبقةُ الرابعة من المحرّك الدلاليّ: بعد الإطار الحتميّ، نداءٌ جانبيّ مقيَّد بمفتاح المستخدم ومزوّدِه (بلا أدوات ولا بثّ، ٢٥٦ توكناً، حرارة ٠، ٦٠ ثانية، حكمُ الميزانيتين قبله والدفترُ بعده) يخرج بأربعة أسطرٍ حرفية: المرادُ والدافعُ والمطلوبُ والثقة. وأيُّ ردٍّ لا يطابق الشكلَ حرفاً يُرفض كلُّه — الغيابُ معلَن والحدسُ ممنوع. **يبدأ مطفأً** لأنه ينفق نداءً. المعطَّل = لا نداء ولا سطر — بايتاً كما كان. يسري من الدور القادم.",
"englishLabel": "Semantic inference",
"englishDescription": "Fourth semantic layer: after the deterministic frame, one bounded side call on the user's own provider (no tools, no streaming, 256 tokens, temperature 0, 60 s, both budgets checked before and the ledger charged after) returns four literal lines: meaning, motive, request and confidence. Any reply that does not match the shape exactly is rejected whole. Starts off because it spends a call. Off = byte-identical to before. Applies from the next turn."
  },
"lessons": {
"label": "دروسُ المشروع — الفشلُ المقيس لا يتكرّر",
"description": "فشلُ أمرٍ حقيقيّ (بناء/أنواع/اختبار/تدقيق/تشغيل) ببصمةٍ مطبَّعة يُسجَّل درساً مقيَّداً بالمشروع — بسطر إيصالٍ 📚 — ويُحقن في الحقبة الأولى من كلّ دورٍ تالٍ في المشروع نفسه قبل أوّل نداء، والتكرارُ بالبصمة نفسها يُسمّى في الإيصال بحكم «محاولةٌ ثالثة ليست مثابرة». الجدارُ الخارجيّ والعابرُ ليسا درساً. بلا نموذج ولا شبكة. المعطَّل = لا تسجيل ولا سطر ولا موجز — بايتاً كما كان. يسري من الدور القادم.",
"englishLabel": "Project lessons",
"englishDescription": "A real command failure (build, typecheck, test, audit, run) with a normalized signature is recorded as a lesson scoped to this project — with a 📚 receipt line — and injected into the first epoch of every later turn in the same project before the first model call; the same signature failing again is named in the receipt with the verdict that a third attempt is not persistence. External walls and transient failures are not lessons. No model, no network. Off = no recording, no line, no brief — byte-identical to before. Applies from the next turn."
  },
"usageMeter": {
"label": "العدّاد المحلي — توكنز وزمنٌ ونموذجٌ لكلّ نداء",
"description": "سطرٌ لكلّ نداءِ نموذجٍ — محلّيٍّ أو سحابيّ — في ملفٍّ على قرصك وحده (~/.abdo/usage-meter.jsonl أو ABDO_USAGE_METER): المزوّدُ والنموذجُ والزمنُ وما أعلنه المزوّدُ حرفاً وما حوسب به. لا يُرسل ولا يُجمَّع ولا يغادر الجهاز. الدفترُ السحابيّ وسقفُه كما هما. المعطَّل = لا سطر ولا ملفّ — بايتاً كما كان. يسري من النداء القادم.",
"englishLabel": "Local usage meter",
"englishDescription": "One line per model call — local or cloud — in a file on your disk only (~/.abdo/usage-meter.jsonl or ABDO_USAGE_METER): provider, model, time, what the provider reported verbatim and what was charged. Never sent, never aggregated, never leaves the machine. The cloud ledger and its cap are unchanged. Off = no line, no file — byte-identical to before. Applies from the next call."
  },
"resumeIntent": {
"label": "آلية اكمل من حيث توقفت",
"description": "دورٌ يقول اكمل فقط يرث هدف الدور السابق وبواباته ويقرأ التسليم أولاً. يسري من الدور القادم.",
"englishLabel": "Resume intent",
"englishDescription": "Retain the original user intent and the last completed checkpoint when resuming work."
  },
"turnBudget": {
"label": "سقف إنفاق الدور",
"description": "سقف بالتوكنز الفعّالة لكل دور من ABDO_TURN_TOKEN_CAP؛ سماحة واحدة حين يبقى فحص قبول أو سبرنت واحد. بلا متغيّر = لا سقف؛ قيمة مشوَّهة = رفض النداءات باسمه لا سقف افتراضي. يسري من الدور القادم.",
"englishLabel": "Turn budget",
"englishDescription": "Bound the context and execution budget for a turn."
  },
"receiptFixtures": {
"label": "التقاط إيصالات الحوادث",
"description": "إيصالات run الكاملة تُحجَب أسرارُها وتُكتب محلياً بسقفٍ لكل دور (لا تُرسل إلى أحد)، فتُرقّى الحادثة سجلَّ اختبارٍ يُعاد تشغيله. المعطَّل = لا مِلقَط ولا مجلّد ولا أمر fixture. يسري من الدور القادم.",
"englishLabel": "Receipt fixtures",
"englishDescription": "Provide clearly marked success, failure, and unresolved fixtures for interface validation."
  },
"intentField": {
"label": "حقل النيّة ودروس المخالفة",
"description": "سطر نية لكل أداة؛ عند الفشل يُقطَّر فرق النية والواقع درساً دائماً ≤25 كلمة بلا نداء نموذج. يسري من الدور القادم. قيد التأهيل المحلي.",
"englishLabel": "Intent field",
"englishDescription": "Keep the task objective and completion criterion explicit through execution."
  },
"approvalTakeover": {
"label": "استيلاء الموافقة على المؤلِّف",
"description": "طلب الموافقة يستولي على مقعد المؤلِّف ولا يعود منه إلا على قرارٍ مكتوب، والسؤالُ والقرار يُثبتان في الدفتر الدائم زوجاً فيُقرآن بعد إعادة التشغيل. المعطَّل = الكتلة القديمة في المحادثة بلا سطرَي 🔐. حسمُ الموافقة المعلّقة رفضاً عند المقاطعة يقع في الحالتين — إصلاح عطلٍ لا ميزة.",
"englishLabel": "Approval composer takeover",
"englishDescription": "Replace the composer with a pending approval request, showing allow-once, deny, and cancel choices."
  },
"trajectory": {
"label": "لسان مسار الدور",
"description": "عدسة تشخيصية فوق الأُطر القائمة: الأداة ونتيجتها صفٌّ واحد بحكمه وسببه وزمنه، وأسطر الأحداث بنصّها لا محسوبةً من جديد. صفرُ كلفةٍ على المحرّك وصفرُ نصٍّ يراه النموذج. المعطَّل = لا لسان ولا مخزن ولا تحميل للوحدة.",
"englishLabel": "Execution trajectory",
"englishDescription": "Display epochs, gates, tool inputs, timing, and receipts in a dedicated surface."
  },
"deliverables": {
"label": "المسلَّمات من مواضع الأثر",
"description": "صفٌّ لكل ملفٍ كُتب وخادمٍ رُفع، من حكم الأداة الصريح وحده لا من نصّ الإيصال؛ ومع «حكم صريح من الأداة» معطَّلاً لا مسلَّمات أصلاً (فراغٌ صادق لا استنتاج). المعطَّل = لا حقل locations على الأُطر، ولوحة النشاط كما كانت. يسري من الدور القادم. ومطفأٌ افتراضياً صفُّه يسكن لوحةَ النشاط، وقد أُطفئت — فتشغيلُه وحده يبني قسماً في مضيفٍ غائب.",
"englishLabel": "Deliverables",
"englishDescription": "Display output files and previews linked to their supporting receipts."
  },
"secretIntake": {
"label": "الإدخال المُعان للأسرار وتحذير التدوير",
"description": "اعتمادٌ يصل في نصّ المحادثة يُحجب قبل أن يُقبل في الدفتر أو تُكتب حقيقة الدور أو يراه نموذج، ويُعلَن محروقاً بخطوة تدويره. المفعَّل يزيد: يُفتح محرّرُ نصٍّ لإدخال البديل في خزنةٍ محميّة باسمك ثم يُزفَّر الملفّ ويُحذف — فلا عمل يدويّ. المعطَّل: الكشفُ والحجبُ ومنعُ التخزين تقع كما هي (أرضيّةُ أمانٍ ليست اختيارية)، ولا محرّرَ يُفتح ولا ملفَّ خزنةٍ يُكتب. يسري من الدور القادم.",
"englishLabel": "Secret intake",
"englishDescription": "Accept transient secrets through the runtime vault boundary; exclude them from logs and shell storage."
  },
"sessionAwareness": {
"label": "وعي الجلسة — خلاصة كل حقبة",
"description": "النموذج يُلحق خلاصةً (فُعل/فُهم/قُرّر/المانع) بالردّ الخاتم للحقبة نفسها — بلا نداء إضافي — فتُراجَع ضدّ إيصالات الدور: ما لا إيصال له يُسقَط ولا يُخزَّن، والباقي يُحفظ session:<الجلسة>:summary ويُحقن في كل حقبة لا الأولى. المعطَّل = لا كتلة ولا جملة موجِّهة ولا حقن ولا حفظ. يسري من الدور القادم.",
"englishLabel": "Session awareness",
"englishDescription": "Retain relevant context and intent for the current session."
  },
"projectAwareness": {
"label": "وعي المشروع — ABDO-AWARENESS.md",
"description": "فهرسٌ حيّ في جذر المشروع (حقائق مقيسة، قرارات المالك، فخاخ، حالة السبرنتات) يُدمج لا يُدهس عند تمام الدور ويُقرأ أولاً في كل دور. لا يُكتب في مشروعٍ غير موثوق، ويمرّ بحجب الأسرار قبل الكتابة. المعطَّل = لا قراءة ولا ملفّ يُلمس. يسري من الدور القادم.",
"englishLabel": "Project awareness",
"englishDescription": "Use the selected project’s instructions, files, and accumulated context."
  },
"generalAwareness": {
"label": "الوعي العام — ذاكرة عابرة للمشاريع",
"description": "دروسٌ عامّة (كتيّبات معتمَدة بعد تأهيلها بجولةٍ مكتملة) تُخزَّن في دليل التثبيت وتُقرأ في كل مشروع موسومةً «معرفة عامّة لا قياس عن هذا المشروع». الترقية إليها مقنَّنة: حجبُ الأسرار قبل الكتابة، ورفضٌ بالاسم لكلّ ما يحمل مساراً أو مضيفاً أو منفذاً أو معرّفاً أو اسماً من مشروع الدور — فلا يعبر شيءٌ من مشروع عميلٍ إلى آخر. المعطَّل = لا قراءة ولا كتابة ولا ملفّ يُلمس. يسري من الدور القادم.",
"englishLabel": "General awareness",
"englishDescription": "Retain verified general workspace context outside a single project."
  },
"settingsSeam": {
"label": "سياج الإعدادات والتثبيت من البيئة",
"description": "كتابات الإضافات المتزامنة تُفحص برقم مراجعة، وABDO_PLUGIN_* تثبّت إضافة لهذه العملية وحدها. المعطَّل = الحفظ غير المشروط القديم.",
"englishLabel": "Settings boundary",
"englishDescription": "Apply settings through a versioned, validated adapter boundary."
  },
"inventory": {
"label": "جرد الإضافات لكل دور",
"description": "كل قراءة مفتاحٍ تُسجَّل بموضعها وعددها وقيمتها النافذة وسببها، وتُرسل إطاراً قبل تمام الدور. المعطَّل = لا تسجيل ولا إطار ولا كتالوج.",
"englishLabel": "Tool inventory",
"englishDescription": "Distinguish advertised, available, and invoked capabilities. Unknown status remains unknown."
  },
"rules": {
"label": "شروط تفعيل الإضافات",
"description": "قيمة الإضافة قد تكون شرطاً {when} بنحوٍ مغلق على rail/os/lane/mode/provider. المعطَّل = الشرط يُرفض عند الحفظ، والمحفوظ منه يُحلّ إلى معطَّل لا إلى الافتراض.",
"englishLabel": "Scoped rules",
"englishDescription": "Allow plugin activation rules over rail, OS, lane, mode, and provider. Disabled means new conditions are rejected and saved conditional settings resolve to disabled rather than falling back to their defaults."
  }
};

const nativeShellPairs = [
  [
"تعذّر الإكمال: ",
"Could not complete: "
  ],
  [
"تم تطبيق الإعدادات.",
"Settings applied."
  ],
  [
"انتهى الروتين: ",
"Routine ended: "
  ],
  [
"بمَ نعمل اليوم؟",
"What should we work on?"
  ],
  [
"محادثة جديدة",
"New conversation"
  ],
  [
"المحادثة",
"Conversation"
  ],
  [
"يعمل الآن…",
"Working…"
  ],
  [
"يكتب الرد…",
"Responding…"
  ],
  [
"يحتاج انتباهك",
"Needs attention"
  ],
  [
"انتهى الدور",
"Turn finished"
  ],
  [
"لم يكتمل",
"Could not finish"
  ],
  [
"المحادثة والعمل",
"Chat & Work"
  ],
  [
"الكود",
"Code"
  ],
  [
"المخرجات",
"Artifacts"
  ],
  [
"المشاريع",
"Projects"
  ],
  [
"تخصيص",
"Customize"
  ],
  [
"الروتينات",
"Routines"
  ],
  [
"المزيد",
"More"
  ],
  [
"الذاكرة والوعي",
"Memory & awareness"
  ],
  [
"المهارات والوكلاء",
"Skills & agents"
  ],
  [
"الاتصالات",
"Connectors"
  ],
  [
"وضع سوبر عبدو",
"Super Abdo Mode"
  ],
  [
"تخطيط الألواح",
"Panel layout"
  ],
  [
"الأرشيف",
"Archive"
  ],
  [
"إعادة التسمية",
"Rename"
  ],
  [
"اسم المحادثة",
"Conversation name"
  ],
  [
"إلغاء التثبيت",
"Unpin"
  ],
  [
"تثبيت",
"Pin"
  ],
  [
"أرشفة",
"Archive"
  ],
  [
"ستظهر محادثاتك هنا.",
"Your conversations will appear here."
  ],
  [
"مجلدات وتعليمات ومحادثات مشاريعك في مكان واحد.",
"Folders, instructions, and conversations in one place."
  ],
  [
"إضافة مشروع",
"Add project"
  ],
  [
"لم تضف تعليمات للمشروع.",
"No project instructions yet."
  ],
  [
"فتح المشروع",
"Open project"
  ],
  [
"تعديل",
"Edit"
  ],
  [
"إزالة من القائمة",
"Remove from list"
  ],
  [
"احذف روتينات المشروع أولاً.",
"Remove this project’s routines first."
  ],
  [
"اختر مجلدًا لإضافة أول مشروع.",
"Choose a folder to create your first project."
  ],
  [
"تعمل محليًا أثناء فتح عبدو كود. التشغيل الفائت ينتظر الموعد التالي، وتبقى قواعد الموافقة لكل تشغيل.",
"Run locally while AbdoCode is open. Missed runs wait for the next interval. Each run keeps your approval rules."
  ],
  [
"روتين جديد",
"New routine"
  ],
  [
"دقيقة",
"minutes"
  ],
  [
"مفعّل",
"Enabled"
  ],
  [
"متوقف",
"Paused"
  ],
  [
"تشغيل الآن",
"Run now"
  ],
  [
"إيقاف",
"Pause"
  ],
  [
"تفعيل",
"Enable"
  ],
  [
"حذف",
"Delete"
  ],
  [
"أنشئ روتينًا لمشروع لجدولة الأعمال المتكررة.",
"Create a routine for a project to schedule repeat work."
  ],
  [
"ملفات سجلتها الأدوات المنفذة في هذه الجلسة.",
"Files recorded from this session’s executed tools."
  ],
  [
"لا توجد ملفات مولدة مسجلة في هذه الجلسة بعد.",
"No generated files recorded in this session yet."
  ],
  [
"المحادثات المؤرشفة",
"Archived conversations"
  ],
  [
"استعادة",
"Restore"
  ],
  [
"إعدادات المشروع",
"Project settings"
  ],
  [
"الاسم",
"Name"
  ],
  [
"المجلد",
"Folder"
  ],
  [
"تعليمات المشروع",
"Project instructions"
  ],
  [
"أنه الدور الحالي أو أوقفه قبل تغيير المشروع.",
"Finish or stop the current turn before switching projects."
  ],
  [
"أضف مشروعًا أولاً.",
"Add a project first."
  ],
  [
"روتين",
"Routine"
  ],
  [
"المشروع",
"Project"
  ],
  [
"المهمة",
"Task"
  ],
  [
"التكرار كل (دقيقة)",
"Repeat every (minutes)"
  ],
  [
"اختر من 5 إلى 525600 دقيقة.",
"Use 5 to 525600 minutes."
  ],
  [
"هناك دور قيد التنفيذ؛ سينتظر الروتين.",
"A turn is already running. This routine will wait."
  ],
  [
"إلغاء",
"Cancel"
  ],
  [
"حفظ",
"Save"
  ],
  [
"اختر واحفظ مجلد المشروع لعرض ملفاته.",
"Choose and save this project folder to inspect its files."
  ],
  [
"الملفات",
"Files"
  ],
  [
"جارٍ التحميل…",
"Loading…"
  ],
  [
"أضف مجلد المشروع من المشاريع.",
"Add a project folder from Projects."
  ],
  [
"تم عرض بداية القائمة. افتح مجلدًا فرعيًا لتضييقها.",
"First entries shown. Open a subfolder to narrow the list."
  ],
  [
"معاينة الملف",
"File preview"
  ],
  [
"التغييرات",
"Changes"
  ],
  [
"اختر مشروعًا أولاً.",
"Select a project first."
  ],
  [
"نسخة العمل",
"Working tree"
  ],
  [
"هذا المجلد ليس مستودع Git.",
"This folder is not a Git repository."
  ],
  [
"لا توجد تغييرات.",
"No changes."
  ],
  [
"تم اختصار الفرق. اختر ملفًا بعينه.",
"Diff truncated. Select an individual file."
  ],
  [
"التخطيط",
"Layout"
  ],
  [
"ضبط المزوّدين",
"Configure providers"
  ],
  [
"ابحث عن نموذج…",
"Find a model…"
  ],
  [
"يضبط توجيه العمل. التفكير الداخلي يعتمد على النموذج.",
"This controls work guidance. Provider reasoning is model-dependent."
  ],
  [
"الاستخدام والحدود",
"Usage & limits"
  ],
  [
"الجلسة الحالية",
"Current session"
  ],
  [
"لم يُبلّغ المزوّد عن استخدام هذه الجلسة. حدود الاشتراك غير متاحة من المحرك المحلي.",
"Provider usage has not been reported for this session. Subscription limits are not available from the local runtime."
  ],
  [
"فحص ← تخطيط ← تنفيذ ← تحقق ← مراجعة ← إصلاح. يسري من الدور القادم مع الالتزام بصلاحياتك وحدود الإنفاق.",
"Inspect → plan → execute → verify → review → repair. Applies to the next turn and keeps your permissions and spending limits."
  ],
  [
"تفعيل وضع سوبر عبدو",
"Enable Super Abdo Mode"
  ],
  [
"فحص البيئة الحالية",
"Inspect the current environment"
  ],
  [
"عزل التغييرات عند الحاجة",
"Isolate changes when needed"
  ],
  [
"اشتراط التحقق بعد التغييرات",
"Require verification after changes"
  ],
  [
"مراجعة أدلة التنفيذ في سياق مستقل",
"Review execution evidence in a separate context"
  ],
  [
"أقصى محاولات الإصلاح",
"Maximum repair attempts"
  ],
  [
"تستخدم المراجعة النموذج المختار في سياق جديد بلا أدوات. غياب الحكم أو فشله يبقي الدور غير محسوم.",
"The review uses the selected model with a fresh context and no tools. A missing or failed verdict keeps the turn unresolved."
  ],
  [
"الألواح والتخطيط",
"Panels & layout"
  ],
  [
"اسحب تبويب اللوح إلى حافة للتقسيم أو الوسط لتجميع التبويبات. غيّر الفواصل بالماوس أو الأسهم.",
"Drag a panel tab onto an edge to split, or the center to group tabs. Resize separators with the mouse or arrow keys."
  ],
  [
"استعادة التخطيط الافتراضي",
"Restore default layout"
  ],
  [
"القائمة على اليسار",
"Sidebar on the left"
  ],
  [
"القائمة على اليمين",
"Sidebar on the right"
  ],
  [
"اعرض الذاكرة التي يديرها المحرك لهذه الجلسة والمشروع.",
"Inspect the memory owned by the engine for this session and project."
  ],
  [
"عرض الوعي",
"Show awareness"
  ],
  [
"بحث الذاكرة",
"Search memory"
  ],
  [
"استخدم الوكلاء المسجلين ووثائق المشروع. تأتي القدرات من سجل المحرك.",
"Use the project’s registered agents and documentation. Capabilities come from the engine registry."
  ],
  [
"فتح دليل الوكلاء",
"Open agent directory"
  ],
  [
"فتح الوثائق",
"Open documentation"
  ],
  [
"ضبط القدرات",
"Configure capabilities"
  ],
  [
"دليل المزوّدين",
"Provider directory"
  ],
  [
"ابحث عن مزوّد…",
"Search providers…"
  ],
  [
"اختر مزوّدًا…",
"Choose a provider…"
  ],
  [
"هذا المزوّد يحتاج بوابة متوافقة مع OpenAI. أدخل رابط البوابة ومعرّف النموذج أدناه.",
"This provider needs an OpenAI-compatible gateway. Enter the gateway URL and deployment model below."
  ],
  [
"معرّفات النماذج (واحد لكل سطر)",
"Model IDs (one per line)"
  ],
  [
"خادم محلي على هذا الجهاز",
"Local server on this computer"
  ],
  [
"استخدم معرّفًا قصيرًا بحروف لاتينية وأرقام وشرطات.",
"Use a short provider ID with letters, digits and hyphens."
  ],
  [
"انتظر انتهاء الدور قبل تغيير المزوّدين.",
"Wait for the current turn before changing providers."
  ],
  [
"إدارة المزوّدين المضبوطين",
"Manage configured providers"
  ],
  [
"المزوّدون المضبوطون",
"Configured providers"
  ],
  [
"المزوّد",
"Provider"
  ],
  [
"الإجراء",
"Action"
  ],
  [
"تعديل الإعدادات",
"Edit settings"
  ],
  [
"إزالة الإعداد",
"Remove configuration"
  ],
  [
"المفتاح محفوظ",
"Key saved"
  ],
  [
"لا يوجد مفتاح",
"No key"
  ],
  [
"الطرفية",
"Terminal"
  ],
  [
"المهام",
"Tasks"
  ],
  [
"الخوادم",
"Servers"
  ],
  [
"المتصفّح",
"Browser"
  ],
  [
"تغيير حجم الألواح",
"Resize panels"
  ],
  [
"نقل اللوح",
"Move panel"
  ],
  [
"نقل لليسار",
"Move left"
  ],
  [
"نقل لليمين",
"Move right"
  ],
  [
"نقل للأعلى",
"Move above"
  ],
  [
"نقل للأسفل",
"Move below"
  ],
  [
"ضم للمحادثة",
"Group with conversation"
  ],
  [
"لوح عائم",
"Float panel"
  ],
  [
"تكبير / استعادة",
"Maximize / restore"
  ],
  [
"إغلاق اللوح",
"Close panel"
  ],
  [
"إرساء",
"Dock"
  ],
  [
"إغلاق",
"Close"
  ],
  [
"تغيير حجم اللوح العائم",
"Resize floating panel"
  ],
  [
"جاهزة للإيداع",
"Staged"
  ],
  [
"غير مضافة",
"Unstaged"
  ],
  [
"عالٍ ✓",
"High ✓"
  ],
  [
"متوسط ✓",
"Medium ✓"
  ],
  [
"منخفض ✓",
"Low ✓"
  ],
  [
"بحث المحادثات",
"Search conversations"
  ],
  [
"الاستخدام",
"Usage"
  ],
  [
"المشروع غير موجود",
"Project is missing"
  ],
  [
"أولاما (محليّ)",
"Ollama (local)"
  ],
  [
"كلود (Anthropic)",
"Claude (Anthropic)"
  ],
  [
"شات جي بي تي (OpenAI)",
"ChatGPT (OpenAI)"
  ],
  [
"جيميني (Google)",
"Gemini (Google)"
  ],
  [
"جروك (xAI)",
"Grok (xAI)"
  ],
  [
"ميسترال",
"Mistral"
  ],
  [
"جروك (Groq)",
"Groq"
  ],
  [
"توغيذر (Together AI)",
"Together AI"
  ],
  [
"كيمي (Moonshot)",
"Kimi (Moonshot)"
  ],
  [
"كوين (DashScope)",
"Qwen (DashScope)"
  ],
  [
"ميني ماكس (MiniMax)",
"MiniMax"
  ],
  [
"أوبن راوتر (OpenRouter)",
"OpenRouter"
  ],
  [
"إنفيديا (NIM)",
"NVIDIA (NIM)"
  ],
  [
"ميتا (Llama API)",
"Meta (Llama API)"
  ]
];

const english = new Map(), arabic = new Map();
function addPair(source, target) {
  if (!source || !target) return;
  english.set(source, target);
  arabic.set(target, source);
}
for (const [source, target] of referencePairs) addPair(source, target);
for (const line of nativeEntries.trim().split("\n")) {
  const split = line.indexOf("|");
  if (split >= 0) addPair(line.slice(0, split), line.slice(split + 1));
}
for (const [source, target] of nativeShellPairs) addPair(source, target);
for (const descriptor of Object.values(pluginTranslations)) {
  addPair(descriptor.label, descriptor.englishLabel);
  addPair(descriptor.description, descriptor.englishDescription);
  addPair(descriptor.description.replaceAll("**", ""), descriptor.englishDescription);
}
english.set("Abdo Code", "AbdoCode");
english.set("ABDO CODE / RUST", "AbdoCode");
arabic.set("AbdoCode", "عبدو كود");

const ATTRIBUTES = ["title", "aria-label", "placeholder", "alt"];
const PROTECTED_CONTENT = [
"script", "style", "pre", "code", "textarea", "noscript", "svg", "math",
"#feed", "#slot-transcript-node", "#sessions", "#sessionname", "#headprojectchip",
"#projectchip .lbl", "#modelchip .lbl", "#modelseeds", "#setlanguage", "#panestrip .ptab > span",
"#actoutputs .act-item", "#actsources .act-item", "#actbrowser .act-caption", "#actbrowser a", "#paneview iframe",
".srv-name", "#srvmenulist button > span:first-child",
".terminal-output", ".term-output", ".mcp-name", ".session-title", ".task-title", ".file-path",
"[data-user-content]", "[data-session-title]", "[data-user-path]", "[data-user-title]",
  '[contenteditable]:not([contenteditable="false"])', '[translate="no"]',
].join(",");
const originals = new WeakMap(), attributeOriginals = new WeakMap();
// اللغاتُ التي تملك القشرةُ ترجمتَها فعلاً — المالكُ الواحد لقائمة الاختيار ولتطبيع القيمة. لغةٌ خارجها ليست خياراً بل سقوطٌ صامتٌ إلى الإنجليزية.
export const SUPPORTED_LANGUAGES = Object.freeze([{ code: "en", label: "English" }, { code: "ar", label: "العربية" }]);
export function normalizeLanguage(value) { return value === "ar" ? "ar" : "en"; }
let language = "en", observer = null, queued = false;
const pending = new Set();

/** Translate a known UI label only; unknown text is returned byte-for-byte. */
export function translateUI(text, lang = language) {
  if (typeof text !== "string") return text;
  const key = text.trim();
  const translated = (lang === "ar" ? arabic : english).get(key);
  return translated === undefined ? text : text.slice(0, text.indexOf(key)) + translated + text.slice(text.indexOf(key) + key.length);
}

function isProtected(element) {
  if (!element || element.closest(PROTECTED_CONTENT)) return true;
  // Native cards distinguish owner-defined providers in their existing note.
  // Their display names are content; bundled vendor labels are interface text.
  if (element.closest(".prov .top b")) {
    const note = element.closest(".prov")?.querySelector(".note")?.textContent || "";
    if (note.startsWith("مزوّدٌ مخصّص · ") || note.startsWith("Custom provider · ")) return true;
  }
  return false;
}

// Only the engine-owned plugin note has a structured, variable suffix. The exact
// descriptor prefix is required, and rule/env values are retained without translation.
function pluginNote(text, parent) {
  if (language !== "en" || !parent.matches("[data-plugin-note]")) return translateUI(text);
  const descriptor = pluginTranslations[parent.dataset.pluginNote];
  if (!descriptor || !text.startsWith(descriptor.description + " ")) return translateUI(text);
  let suffix = text.slice(descriptor.description.length);
  const literalPairs = [
    ["يسري من الدور القادم.", "Applies next turn."],
    ["يسري فوراً.", "Applies immediately."],
    ["يسري بعد إعادة تشغيل المحرّك.", "Applies after restarting the engine."],
    ["غير موصول بعد — لا قارئ له في المحرّك.", "Not connected yet — no engine consumer."],
    ["مثبَّت من البيئة: ", "Pinned by environment: "],
    ["الجرد معطَّل", "Inventory disabled"],
    ["غير معروف", "Unknown"],
    ["شرط مرفوض", "Invalid rule"],
    ["قيمة غير صالحة — تُقرأ معطَّلة", "Invalid value — treated as disabled"],
    ["افتراض", "Default"], ["مضبوط", "Configured"],
    ["شرط: ", "Rule: "],
    [" · النافذ الآن: ", " · Effective now: "],
    ["حسب سياق الدور", "Depends on turn context"],
    ["مفعَّل", "Enabled"], ["معطَّل", "Disabled"],
  ];
  suffix = suffix.replace(/ · قُرئ (\d+) مرة في آخر دور/g, " · Read $1 times in the last turn")
    .replace(/ \(كان (مفعَّلاً|معطَّلاً)\)/g, (_, value) => " (was " + (value === "مفعَّلاً" ? "enabled" : "disabled") + ")");
  for (const [ar, en] of literalPairs) suffix = suffix.replaceAll(ar, en);
  return descriptor.englishDescription + suffix;
}

function scopedText(text, parent) {
  if (language !== "en") return translateUI(text);
  if (parent.matches("[data-plugin-note]")) return pluginNote(text, parent);
  // These exact grammars are produced by native panels, never by a transcript.
  if (parent.matches(".task-state")) {
    const match = /^(يجري|تمّ|قوطع|بلا تمام|نقطة حفظ)( · .+)?$/.exec(text);
    if (match) return translateUI(match[1]) + (match[2] || "");
  }
  if (parent.matches(".task-meta")) {
    const match = /^(\d+) حقبة · (\d+) أداة(?: · (\d+) سقطت)?$/.exec(text);
    if (match) return `${match[1]} epochs · ${match[2]} tools` + (match[3] ? ` · ${match[3]} failed` : "");
  }
  if (parent.matches(".srv-state")) {
    const match = /^(يُقاس…|يعمل|غير عامل)( — .+)?$/.exec(text);
    if (match) return translateUI(match[1]) + (match[2] || "");
  }
  if (parent.matches("#deniallist .mcp-state")) {
    const match = /^رُفض (\d+) · صنف: (read|write|command|network|delete)$/.exec(text);
    if (match) return `Denied ${match[1]} times · Class: ${match[2]}`;
  }
  if (parent.matches("#grantlist .mcp-state")) {
    const match = /^صنف: (read|write|command|network|delete)$/.exec(text);
    if (match) return `Class: ${match[1]}`;
  }
  if (parent.matches(".prov .note") && text.startsWith("مزوّدٌ مخصّص · ")) return "Custom provider · " + text.slice("مزوّدٌ مخصّص · ".length);
  return translateUI(text);
}

function scopedAttribute(text, element, attribute) {
  if (language === "en" && attribute === "placeholder" && element.matches('.prov input[type="password"]') && text.startsWith("ألصق مفتاح ")) return "Paste API key for " + text.slice("ألصق مفتاح ".length);
  if (language === "en" && ["title", "aria-label"].includes(attribute) && element.matches(".srv-row .iconbtn")) {
    const match = /^افتح (.+) في متصفّح عبدو$/.exec(text);
    if (match) return `Open ${match[1]} in AbdoCode browser`;
  }
  return translateUI(text);
}

function translateNode(node) {
  const parent = node.parentElement;
  if (isProtected(parent) || !node.nodeValue?.trim()) return;
  let memo = originals.get(node);
  if (!memo || node.nodeValue !== memo.last) memo = { source: node.nodeValue, last: node.nodeValue };
  const next = scopedText(memo.source, parent);
  // Text is an option's implicit form value when no value attribute was supplied.
  // Keep that value stable before translating only its visible label.
  if (parent.tagName === "OPTION" && !parent.hasAttribute("value") && node.nodeValue !== next) parent.setAttribute("value", parent.value);
  memo.last = next;
  originals.set(node, memo);
  if (node.nodeValue !== next) node.nodeValue = next;
}

function translateAttributes(element) {
  if (isProtected(element)) return;
  const memo = attributeOriginals.get(element) || {};
  for (const name of ATTRIBUTES) {
    const source = element.getAttribute(name);
    if (source === null) { delete memo[name]; continue; }
    if (!memo[name] || source !== memo[name].last) memo[name] = { source, last: source };
    const next = scopedAttribute(memo[name].source, element, name);
    memo[name].last = next;
    if (next !== source) element.setAttribute(name, next);
  }
  attributeOriginals.set(element, memo);
}

function localize(root) {
  if (root.nodeType === Node.TEXT_NODE) { translateNode(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE || isProtected(root)) return;
  translateAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE && isProtected(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.TEXT_NODE) translateNode(node);
    else translateAttributes(node);
  }
}

function observe() {
  if (document.body && observer) observer.observe(document.body, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ATTRIBUTES,
  });
}

function flush() {
  queued = false;
  observer?.disconnect();
  const roots = [...pending];
  pending.clear();
  try {
    for (const root of roots) if (root.isConnected && !roots.some(other => other !== root && other.contains(root))) localize(root);
  } finally { observe(); }
}

function startObserver() {
  if (observer) return;
  observer = new MutationObserver(records => {
    for (const record of records) {
      const element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      if (isProtected(element)) continue;
      if (record.type === "childList") {
        for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) pending.add(node);
      } else pending.add(record.target);
    }
    if (pending.size && !queued) { queued = true; queueMicrotask(flush); }
  });
}

/**
 * Apply English (default) or Arabic and observe later native UI updates.
 * No preference storage: the validated native settings boundary owns persistence.
 * Transcript content, titles, paths, commands and form values remain untouched.
 */
export function applyLocale(lang = "en") {
  language = normalizeLanguage(lang);
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.documentElement.classList.toggle("lang-en", language === "en");
  document.documentElement.classList.toggle("lang-ar", language === "ar");
  document.title = language === "ar" ? "عبدو كود" : "AbdoCode";
  // Dock leaves store an explicit direction when mounted. Refresh only their
  // interface direction; physical split axes and user content keep their values.
  for (const surface of document.querySelectorAll(".nd-leaf, .nd-floating")) {
    const direction = language === "ar" ? "rtl" : "ltr";
    if (surface.dir !== direction) surface.dir = direction;
  }
  startObserver();
  observer.disconnect();
  pending.clear();
  try { if (document.body) localize(document.body); } finally { observe(); }
  return language;
}
