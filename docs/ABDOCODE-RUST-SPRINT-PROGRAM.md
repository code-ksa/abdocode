# برنامج عبدو كود — تقارب الفروع فوق نواة Rust

**الفرع الحاكم:** `rust-main`
**تاريخ القياس:** 2026-08-29
**الهدف:** استعادة كل قدرة مفيدة من فروع التطوير مرة واحدة، بعقودنا ونواة Rust، لا استعادة أسماء الحزم أو تشغيل منتج آخر.

## قواعد لا تتغير

1. لا نسخ لحزم `abdo/core/llm/server/plugin` القديمة؛ تُقرأ القدرة وتُعاد كتابتها خلف عقود Rust.
2. لا اتصال تلقائي بمستودعات أو خدمات OpenCode أو DeepSeek Harness أو Goose أو OpenHands أو Qwen أو غيرها. لا updater ولا discovery ولا bootstrap شبكي.
3. المراجع الخارجية أفكار فقط. المكتبة الآمنة لا تدخل إلا بقفل إصدار، مراجعة ترخيص، جرد transitive dependencies، وبوابة offline.
4. Rust هو مصدر الحقيقة للسلطة، القبول، الأثر، التسوية، التحقق، الاسترداد، fencing والسجل. Bun/TypeScript يملك التخطيط والنماذج والـHarness والقشور.
5. لا أداة مؤثرة تنفذ من `serve` مباشرة. المسار النهائي الوحيد:
   `Desktop → Engine → SessionRuntime → ToolRegistry → Rust authority/host → receipt`.
6. `typecheck` ليس إثبات ربط. كل حزمة تحتاج reachability من composition root، إنشاء خدمة، سيناريو runtime، وأثرًا أو رفضًا مثبتًا.
7. لا سجل ثانٍ ينافس Rust journal، ولا حلقة وكيل ثانية، ولا `eval` أو JavaScript مولّد. بديل Code Mode هو AbdoFlow typed DSL.
8. الغياب رفض: مزود بلا إعداد، approval بلا handler، sandbox بلا attestation، target قديم، أو endpoint غير مصرح به كلها تفشل مغلقة.

## خط الأساس المقيس

- مساحة العمل الحالية: **52 package manifests**. أضيفت 11 حزمة مكافئة مكتوبة محليًا، لا نسخًا من الحزم القديمة.
- يصل جذر `@abdo/engine` الإنتاجي إلى **46 حزمة**، ويصل جذر `@abdo/desktop` إلى **47 حزمة**، ومجموع جذور المنتج يصل إلى **52/52**.
- نُقلت الحزم الوظيفية الست عشرة إلى مسارات المنتج أو إلى جذور مستقلة صريحة؛ لا توجد حزمة يتيمة أو خارج إغلاق المنتج.
- سطح المكتب يشغّل `abdocode.exe serve`.
- `serve` لم يعد يكتب `serve-ledger.jsonl`: القبول والجلسات والأحداث والنهايات في SQLite عبر `@abdo/engine-host`، مع استيراد القديم مرة واحدة. أزيلت التطبيقات الخمسة الموازية المسجلة وصارت ملكيات الحلقة والأدوات والأسرار والمتصفح والتنفيذ صريحة.
- مضيف Rust الإنتاجي ينفذ `read-bound-object` ويملك الآن جسر دفتر دائم للمحوّلات الخارجية. عامل `abdo-tool-worker` يقبل أسماء وتأثيرات write/git/package/network من جدول Rust مترجم فقط، ويعلن `Partial` بحدود صريحة: قيود تطبيقية مترجمة ومقيسة، لا ادعاء OS sandbox كامل.

## جرد أفكار DeepSeek Harness

| الفكرة | مصدر الحقيقة الحالي | القرار |
|---|---|---|
| Reconstruction invariant | `abdo-kernel/state.rs` و`reduce.rs` | موجود؛ نربط إسقاط السياق به ولا نعرّف transcript موازيًا |
| Transactional compaction | `abdo-journal::compact` و`0004_compactions.sql` | موجود |
| Turn/Step/Round | `abdo-runtime/session.rs` | موجود في Rust؛ wire له سبرنت مستقل عند الحاجة |
| Followup/Steer/Inject | `InputChannel` في عقود Rust وTS المولدة | موجود؛ ممنوع enum ثانٍ |
| Capability seam | `ToolSpec.handler_digest` وbroker | موجود |
| Fresh-agent epochs | `engine/mind/team.ts` | موجود جزئيًا؛ يُوصل بالعمال والسجل في R7 |
| Enforcement attestation | `EnforcementReport` المولد | موجود؛ `full/partial/unavailable` لا boolean |
| غياب approval handler | `gatekeeper.rs` | رفض fail-closed موجود |
| Progressive disclosure | `abdo-tools/disclosure.rs` | موجود في crate الأدوات ويُعاد تصديره من runtime |
| DeepSeek-style prompt profile | `@abdo/prompting` | محلي ومكتوب هنا؛ يُستخدم كبيانات بلا اتصال DeepSeek |
| Code Mode | القديم يولد JavaScript | مرفوض؛ المكافئ AbdoFlow typed DSL فقط |

## مصفوفة تقارب الفروع

| عائلة الفروع | القدرات التي لا نضيّعها | موطنها الجديد |
|---|---|---|
| `main/publish/archive` | النواة، Conversation IR، codecs، routing، memory، planning، team، flow | kernel الحالي + `model-gateway` + engine composition |
| `identity-rename/opencode-neon-harbor/rust-main` | الفصل والهوية والنقل النظيف | independence + structure gates |
| سلطة تفويض محلية محايدة | one-shot capabilities، signed dispatch، fencing، replay refusal | Rust authority + `dispatch-contracts` عامة بلا حقول مشروع خاص |
| `mega-sprint-3` | browser، connectors، workers، audit view، integration matrix | browser/tool adapters + projections من Rust journal + offline matrix |
| `preserved/ms2` | رحلات UI والمتصفح متعدد التبويبات | Tauri الحالي؛ لا OpenCode plugin |
| `p14/confirmatory` | preregistered offline benchmarks وnon-inferiority | `@abdo/benchmark` local/fake provider |
| `swarm P6` | CAS، writer ownership، keeper، zombie rejection | Rust journal/leases/fences + isolation adapter |
| `pilot/P7` | manager/coder/reviewer/tester، exact commit، terminal refusal | `workers` و`orchestrator` فوق Rust |
| `state-io remediation` | فشل atomic JSON تحت التزامن | لا JSON state؛ Rust journal transaction/CAS فقط |
| `pre-R4/Qwen recovery` | provider binding، timeout taxonomy، bounded output | `providers/registry/model-gateway` بلا endpoint خفي |

## مكافئات الحزم المستبعدة

| الحزم القديمة | المكافئ المملوك | مبدأ التنفيذ |
|---|---|---|
| `abdo/core/host/cli/server` | `engine` + composition root + Rust host | محرك واحد وسجل واحد |
| `llm/providers/registry` | `model-gateway/providers/registry/harness` | IR موحدة، harness profile كبيانات، local-first |
| `protocol/client/sdk/httpapi-codegen` | `transport-contracts/client-sdk/transport-codegen/agent-server` | ناقل محلي مصادق عليه؛ لا listen خارجي افتراضيًا |
| `codemode` | `flow-runtime` | DAG typed، لا code/eval/shell payload |
| `plugin` | `plugin-runtime` | manifests محلية وقدرات ثابتة؛ لا discovery أو تحميل شبكي |
| `containers/effect-sqlite wrappers` | Rust journal + isolation helper | لا wrappers Effect |
| `app/session-ui/tui/storybook` | Tauri desktop + `ui` + `session-ui` جديدة | نقل الرحلة لا الشجرة القديمة |
| `slack/connectors` | `connectors` اختيارية | صفر connector مفعل افتراضيًا؛ authority+secret+egress |
| `workers/swarm scripts` | `workers/orchestrator` | leases وfencing من Rust |
| `audit-model/stats` | journal projections + benchmark/reliability | لا telemetry خارجي ولا ledger ثانٍ |

## السبرنتات

### R0 — الجرد والحواجز — DONE

- جرد 37 فرعًا محليًا و3 remote refs من الحالة المحلية فقط.
- قياس package reachability بدل الاكتفاء بعد الحزم.
- إثبات أن `serve` و`integration` مساران مختلفان.
- منع DeepSeek/OpenCode/upstream hosts في egress وإبقاء الأفكار محلية.

**البوابة:** جرد قابل لإعادة التشغيل + صفر اتصال شبكة أثناء الجرد.

### R1 — Registry + Providers + Harness adapter — DONE

- `@abdo/registry`: سجل حتمي، IDs مغلقة، duplicate refusal، digest ثابت.
- `@abdo/providers`: كتالوج مملوك، لا discovery، المزود المحلي افتراضي، remote يحتاج اختيارًا ومفتاحًا.
- `@abdo/harness`: adapter على `@abdo/kernel/contracts` و`@abdo/prompting`، لا عقود مكررة.
- تصدير harness profiles الموجودة وربط profile بالمزود قبل بناء الطلب.
- حذف مزود DeepSeek الشبكي؛ `deepseek-style` محلي فقط.
- ربط `engine.ask` بالحزم الجديدة بدل `mind/providers`.
- إزالة دلالات إيقاظ القنوات من TypeScript؛ Rust وحده يملكها.
- تطبيق profile على سجل الأدوات الفعلي مع خريطة قابلة للعكس بين الاسم المعروض والقانوني.
- توحيد system prompt في مسار واحد وحذف نسخة provider القديمة غير المستخدمة.

**القبول:** اختبارات الحزم وprompting خضراء؛ لا `deepseek.com` في executable source؛ طلب Ollama يحمل profile محليًا وأدوات مشكلة بلا system مكرر.

### R2 — بوابة الهيكل وComposition Manifest — DONE

- إنشاء manifest يصف كل package: دوره، owner، runtime root، source-of-truth، proof command.
- بوابة graph تفشل لكل package مجهولة أو orphan بلا استثناء مبرر.
- منع dual ledgers، dual runtimes، Effect imports، OpenCode SDK، endpoints الثابتة للمراجع.
- إعادة بناء `@abdo/web` كواجهة عربية ثابتة وفحصها مع بقية الحزم بلا حجر.
- إزالة كتالوج providers القديم بعد إثبات انعدام المستهلكين.

**القبول:** 52/52 مصنفة؛ كل orphan له sprint وسبب؛ كسر مصطنع يُحمر البوابة.

### R3 — Model Gateway وConversation IR — DONE

- إعادة تطوير IR موحدة للرسائل/deltas/tool calls/reasoning metadata.
- codecs مستقلة للعائلات، streaming bounded، cancellation، retry taxonomy.
- harness registry يضيف تعليمات وشكل أدوات كبيانات، بلا switch خاص بالمزود.
- لا raw secret داخل Bun في الحالة النهائية؛ credential handle من Rust.

**المنجز:** `@abdo/model-gateway` يملك IR محايدة، codecs لـOllama وOpenAI-compatible وAnthropic، تطبيع final/tool/truncated، وframing محدود الحجم يحافظ على UTF-8 العربي عند انقسام البايتات. ترميز الطلب وdecoding غير المتدفق متصلان عبر harness/providers، ومسار `serve` يستهلك decoder محدودًا لـOllama وOpenAI SSE وAnthropic. أضيف تصنيف retry واحد fail-closed لكل العائلات؛ الاستجابة التي بدأت لا تعاد آليًا. انتقل HTTP السحابي وحقن الاعتماد إلى `abdo-tool-worker`؛ TypeScript يرسل المزود والوجهة والجسم فقط، وRust يفرض جدول ثمانية مزودين ووجهاتهم المترجمة ويملك الإلغاء وحدود 1MiB/2MiB.

**القبول:** golden conversations byte-stable؛ partial stream لا يصبح completion؛ provider swap لا يغير semantic events.

### R4 — تقارب Session و`serve` — IN PROGRESS

- استبدال `serve-ledger.jsonl` بـ`SqliteEventStore/SessionRuntime` ثم Rust journal projection.
- admit/promote/steer/queue/interrupt/resume من مسار واحد.
- جعل واجهة سطح المكتب تستهلك semantic events نفسها التي يستهلكها CLI.

**المنجز:** `@abdo/engine-host` أصبح composition root مملوكًا يجمع `SqliteEventStore + SessionRuntime + ToolRegistry`، ومسار `integration` يستخدمه فعليًا بدل تركيب نسخة محلية ثانية. كما انتقلت إليه حلقة النموذج/الأداة المحدودة، وأزيل منها الاستدعاء القسري لملفات الوعي والمشاريع الخاصة.

**تقارب `serve`:** أزيل كاتب JSONL المنافس. `serve` يعيد بناء admissions/sessions/outputs/completions من SQLite، يستورد الملف القديم ببصمات idempotency، يرفض إعادة ربط معرّف الدور بمحتوى آخر، ويرفض الدور الثاني قبل القبول الدائم. أزيلت التطبيقات المتوازية المسجلة حتى أصبحت صفرًا.

**تصحيح بوابة:** تهيئة `SqliteEventStore` صارت تعيد `journal_mode` وDDL ضمن retry متزامن محدود عند `SQLITE_BUSY`؛ بوابة 4 عمليات اجتازت ست دورات متتالية بلا فجوات أو تكرار.

**القبول:** crash/restart يعيد الجلسة؛ duplicate turn لا ينفذ مرتين؛ `serve` يستحيل تشغيله بلا enforced runner.

### R5 — Tool Brokers فوق Rust — DURABLE ADAPTER PATH DONE / OS SANDBOX OPTIONAL

- جرد كل `Bun.spawn/fs/fetch/browser` في `serve` وتحويله ProposedIntent.
- توسيع Rust host: filesystem read/write، structured process، git، package، network.
- pre/postconditions، receipts، unknown-outcome reconciliation.
- ربط `builtin-tools/browser/lsp/script/reliability/isolation-helper` أو حذف المكرر بعد إثبات parity.

**المنجز:** أضيفت crates `abdo-policy` و`abdo-evidence` و`abdo-tools`، وأنشئ `abdo-tool-worker` الحقيقي محدود الإطار وfail-closed. صارت المحولات الخمسة موجودة ومربوطة فعليًا: كتابة ذرية بإيصال واسترجاع، Git قراءة وتغيير بقوائم read/stage/unstage/commit بلا remote أو hooks، استعادة حزم من lockfile بمصادر مسموحة وبلا lifecycle scripts، وHTTPS GET بحارس DNS/SSRF وتحويلات وحجم محدود. يرفض عامل Rust الاسم أو صنف الأثر غير المترجم، ثم تمر العملية في `PolicyToolRunner`، وأزيل منفذ الشبكة الموازي من engine.

**الإغلاق الدائم:** أضيف حاجز `onBeforeEffect` بعد السياسة/الموافقة/TOCTOU وقبل تسليم التحكم للأداة. يكتب `Prepared → Cleared → Authorized → Dispatching` في `journal_effects` نفسه، ثم يغلق النتيجة بـ`Started → Settled → Verified`. الانهيار بعد الحاجز يتحول عند بدء التشغيل إلى `UnknownOutcome` مرة واحدة ولا توجد إعادة تلقائية. هوية الأثر مربوطة ببصمة الوسائط والقرار والتنفيذ ومساحة العمل، ولا تعبر الوسائط أو المخرجات الخام إلى قناة Rust.

**حد العزل الصريح:** تقرير العامل أصبح `Partial` من `compiled-adapter-boundary-v1` وحدوده `application-controls-only-no-os-sandbox`. هذا يثبت القيود التطبيقية الفعلية ولا يسميها عزلاً كاملاً. AppContainer يبقى طبقة اختيارية للمضيف غير المرتفع وللبرامج الأصلية حين تتوفر أدلته الموثوقة؛ غيابه لا يتحول إلى ادعاء `Full`.

**القبول:** صفر أثر مباشر من engine؛ كل mutate/reach له receipt؛ crash injection بلا duplicate effects.

### R6 — Trust، Secrets، Grants، Connectors

- Trust Gate قبل config/hooks/skills.
- `secret-broker` إلى SecretHandle وJIT injection داخل Rust worker.
- grants one-shot، target-bound، TTL، nonce، fencing.
- `connectors` بديل عام لـSlack وغيرها، كلها disabled افتراضيًا.

**المنجز في مسار المنتج:** اتصالات النماذج وبحث Google PSE تمر من جذر واحد `RustReachEffects`: قبول محول الشبكة من Rust، قرار policy مسجل، حاجز `Dispatching` في دفتر V3، ثم عامل Rust ذي وجهة مترجمة وحقن JIT من الخزنة. أزيل `local-source.ts` وكل API تعيد قيمة سر إلى TypeScript؛ فحص الحضور يعيد boolean فقط. أسرار HTTP توضع في إعداد curl عبر stdin، تُحجب إن أعادها الطرف، وتصفّر buffers عند الإسقاط. طلب غير معروف أو خزنة غائبة يرفض قبل الشبكة، والمقاطعة تقتل الطفل.

**القبول:** صفر secret raw في TS/log/evidence؛ connector بلا grant مرفوض؛ child-process egress مغطى أو مصرح limitations.

### R7 — Workers، Teams، Fresh Epochs

- إعادة تطوير manager/coder/reviewer/tester كأدوار بيانات.
- writer ownership، bounded mail/handoff، exact-commit merge capability.
- fresh epoch من objective ثابت + handoff محدود + journal evidence.

**القبول:** zombie write = 0؛ shared writable workspace = 0؛ handoff ≤16KiB؛ refusal terminal.

### R8 — Browser وComputer Surface

- Browser router: API → DOM/CDP → Accessibility → Vision → coordinates.
- كل TargetRef مربوط surface generation/document epoch/snapshot.
- Human takeover يجمد الوكيل ويبطل المراجع ثم يعيد الرصد.
- أي driver خارجي optional worker، ليس dependency للنواة ولا اتصالًا بخدمة صاحبه.

**القبول:** stale target execution = 0؛ success يحتاج postcondition؛ unverifiable ليس نجاحًا.

### R9 — UI، Session UI، Transport — IN PROGRESS

- تطوير `session-ui` خفيفة من عقود semantic events، لا نسخ الحزمة القديمة.
- `transport-contracts` وعميل مولد؛ desktop/CLI/SDK نفس القرارات.
- استعادة رحلات الفروع المرئية بعد قياسها.

**المنجز:** `@abdo/transport-contracts` يملك عقود submit/steer/interrupt/events بإصدار صريح، حقول مغلقة وframing محدود إلى 1MiB. كما صار المصدر الوحيد لعقد القشرة ذي 19 إطارًا واردًا؛ المحرك يستورده ويفشل مغلقًا عند نوع/حد/حقل زائد غير معلن. قناة الطفل الخاصة بين سطح المكتب والمحرك مصادق عليها برمز جلسة عشوائي، وتعمل الآن بأطر ثنائية ذات بادئة طول 32-bit وحد 1MiB في الاتجاهين؛ وضع JSON-lines بقي للـCLI المباشر فقط. اختير anonymous child pipe بدل named-pipe namespace لأنه لا يفتح اسماً قابلاً للاكتشاف أو ACL إضافية. أضيف `client-sdk/transport-codegen/agent-server` محليًا واختبار end-to-end حقيقي للمصادقة وتبادل الإطارات.

**القبول:** parity journey matrix؛ no privileged desktop handle؛ RTL/mobile/accessibility gates.

### R10 — Recovery، Verification، Benchmarks

- توصيل `recovery/healing/verification/benchmark` بمسار المنتج.
- confirmatory suite محلية preregistered؛ no live provider في البوابة الافتراضية.
- قياس binary/RSS/IPC/reducer/cancellation/100k restore/crash injection.

**القبول:** الأدلة المقيسة لا claims؛ skipped/ignored لا يغلق sprint؛ replay byte-for-byte.

### R11 — Cutover

- حذف النسخ المحلية المكررة داخل `engine/mind` فقط بعد parity.
- full gates، installer، fresh install، rollback rehearsal.
- commit مستقل لكل sprint؛ لا `git add -A` ولا push/deploy دون قرار مالك.

**القبول:** composition manifest 100%؛ independence 100%؛ installer من HEAD نفسه؛ القديم مؤرشف وقابل للاسترجاع.

## سجل التنفيذ

| التاريخ | السبرنت | الدليل | الحالة |
|---|---|---|---|
| 2026-08-29 | R0 | جرد الفروع والحزم والمسارات بلا شبكة | DONE |
| 2026-08-29 | R1 | تصحيح قنوات Rust + system واحد + تشكيل الأدوات + حذف provider copy | DONE |
| 2026-08-29 | AK-R2 | 41/41 composition + 7 negative mutations + provenance quarantine | DONE |
| 2026-08-29 | R3 | Conversation IR + 3 provider codecs + request/response/stream decoding | DONE |
| 2026-08-29 | R4 | owned engine host + durable session composition proof | IN PROGRESS |
| 2026-08-29 | R4 | bounded constructor retry + repeated cross-process SQLite proof | IN PROGRESS |
| 2026-08-29 | R4 | retired JSONL import-only + SQLite serve journal + replay smoke | IN PROGRESS |
| 2026-08-29 | R5 | fail-closed bound-read adapter through Rust kernel | IN PROGRESS |
| 2026-08-29 | R5 | serve read routed through policy runner and owned kernel adapter | IN PROGRESS |
| 2026-08-29 | R5 | write/git/package/network adapters admitted by compiled Rust table + policy runner; parallel net path removed | DONE |
| 2026-08-29 | R5 | durable pre-effect barrier + verified/unknown Rust reconciliation for all five adapters | DONE |
| 2026-08-29 | R5 | measured compiled adapter boundary; honest Partial with no OS-sandbox overclaim | DONE |
| 2026-08-29 | R9 | versioned bounded local transport contracts; carrier pending | IN PROGRESS |
| 2026-08-29 | R9 | engine consumes the single shell contract; 19 inbound frames fail closed; authenticated desktop carrier pending | IN PROGRESS |
| 2026-08-29 | R3/R6 | model + Google PSE HTTPS داخل Rust worker؛ endpoints مترجمة؛ JIT vault؛ policy + durable effect ledger؛ صفر raw secret في TypeScript الإنتاجي | DONE |
| 2026-08-29 | R9 | authenticated 32-bit length-prefixed private child carrier + end-to-end proof | DONE |
| 2026-08-29 | Original blueprint | 327/327: 122 مجلدًا و205 ملفات؛ 197 facade مجمعة تشير إلى المصادر الحاكمة وتفشل البوابة عند الانفصال | DONE |
| 2026-08-29 | R9/R10 | 52/52 packages؛ 11 مكافئًا جديدًا واختبارات مستقلة وربط integration | DONE |
| 2026-08-29 | Public scrub | إزالة اكتشاف المشاريع الداخلية وملفات الوعي ومسار الخزنة الثابت وكل إحالة إلى المنتج الآخر | DONE |
| 2026-08-29 | Rust tree | 8/8 crates + 2/2 binaries + policy/evidence/tools + bounded worker | DONE |
| 2026-08-29 | Package cutover | 52/52 في جذور المنتج؛ نقل 16؛ صفر تطبيقات متوازية | DONE |
| 2026-08-29 | Public web | استبدال 630 ملفًا موروثًا بواجهة عربية ثابتة؛ صفر quarantine | DONE |
| 2026-08-29 | Full verification | بوابة النواة الكاملة، 52/52 composition، 9/9 independence، 51/51 typecheck، 39/39 reach/secret tests، integration حقيقي وinstaller مطابق | DONE |

## الخطوة التالية الملزمة

أكمل الجزء غير الشبكي من R6 (Trust Gate لملفات config/hooks/skills وربط connectors بالـgrants)، ثم أغلق رحلات R7 وR8 وR9 ببوابات تفاعلية من واجهة سطح المكتب. مسار النماذج والبحث السحابي مغلق داخل Rust، والشجرة الأصلية 327/327 موجودة ومجمعة ومربوطة بالمصادر الحاكمة، وR5 مغلق من ناحية القبول وحاجز ما قبل الأثر والتسوية والاسترداد بلا تكرار. AppContainer الكامل تحسين مضيف اختياري لا شرط لصدق التقرير الحالي.

## نشر حزم npm لاحقاً

- الحزم الـ52 مكتملة داخل مساحة العمل ومتصلة بجذور المنتج، لكنها `private` حالياً، وترخيص المستودع الحالي Proprietary و39 manifest تحمل `UNLICENSED`.
- لا يُنشر اسم عشوائي ولا تُحجز مساحة `@abdo` بلا ملكية مؤكدة. قبل أول نشر يلزم قرار مالك واحد يحدد: scope العام، الترخيص العام، والحزم التي تشكل API مستقراً.
- بعد القرار تضاف لكل حزمة عامة حقول `repository.directory` و`exports/files` و`publishConfig.provenance`، ويُبنى tarball ويفحص محلياً قبل `npm publish`.
- GitHub هو المصدر الحالي: `alkhadraa02/abdo-code-al-akhbari`. لا updater ولا dependency يعيد الاتصال بمستودعات OpenCode أو DeepSeek.
