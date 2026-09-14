/** سجلّ كتيّبات أصناف الأخطاء — تشخيصٌ حتميّ يسبق اجتهاد النموذج.
 *
 * كل صنفٍ من أخطاء البناء/التشغيل الذي يدور حوله نموذجٌ ضعيف يُشفَّر هنا
 * بنمطٍ يميّزه وتشخيصٍ يُملي الحلّ القانونيّ حرفياً — «انسخه لا تجتهد».
 * سلّم الأدوات: كود قبل نموذج. المصدر: كتالوج السيناريوهات + KF + الدروس
 * + هندسة عامة مقنّنة. النمو مستمرّ: صنفٌ جديد في أي جولة يدخل هنا.
 *
 * تشخيصات المسارات (module-not-found / native / page-data) تبقى في
 * `module-resolution-hint.ts` لأنها تقرأ القرص وtsconfig؛ هذا السجلّ
 * للأصناف التي يكفيها نصّ الإيصال.
 */

export interface Playbook {
  readonly id: string
  readonly when: RegExp
  /** لا يُطلق إن طابق أيٌّ من هذه — لتفادي التشخيص المزدوج. */
  readonly not?: RegExp
  readonly hint: string
}

export const PLAYBOOKS: readonly Playbook[] = [
  // ── قواعد البيانات ──────────────────────────────────────────────────
  {
    id: "pg-password-unchanged",
    when: /password authentication failed|role "[^"]+" does not exist/iu,
    hint: "مصادقة PostgreSQL فشلت. POSTGRES_PASSWORD في compose لا يعيد مفتحة قاعدةٍ مهيأة سابقاً (PGDATA موجود). إمّا احذف مجلد البيانات لإعادة التهيئة (بموافقة وباكاب)، أو غيّر كلمة المرور داخل القاعدة بـALTER ROLE، ولا تفترض اسم الدور — اقرأه أولاً.",
  },
  {
    id: "sqlite-locked",
    when: /database is locked|SQLITE_BUSY/iu,
    hint: "SQLite مقفولة من عملية أخرى. فعّل WAL (PRAGMA journal_mode=WAL) وbusy_timeout، واجعل الكتابة من مسارٍ واحد؛ لا تفتح عدة اتصالات كاتبة على الملف نفسه.",
  },
  {
    id: "sqlite-readonly",
    when: /attempt to write a readonly database|SQLITE_READONLY/iu,
    hint: "القاعدة للقراءة فقط: صلاحيات الملف أو مجلده تمنع الكتابة، أو فُتحت بوضع readonly. تحقق من صلاحيات ملف .sqlite ومجلده، ومن وضع الفتح.",
  },
  // ── أدواتُ سطر الأمر التي تغيّرت واجهتُها ─────────────────────────
  {
    id: "cli-flag-not-registered",
    when: /No flag registered for --|Unknown (?:option|flag|argument)s?\b|unrecognized (?:option|argument)|"code"\s*:\s*"CLI\.(?:INVALID_ARGUMENTS|UNKNOWN_COMMAND)"/iu,
    hint: "الأداةُ الحيّة لا تعرف هذا العلم — نسختُها غيرُ التي تحفظها، فلا تعِد الأمر نفسه. اقرأ أعلامها من الإيصال: «npx <الأداة> --help» ثمّ «npx <الأداة> <الأمر> --help». إن جاء الردّ غلافَ JSON («ok:false» و«error.code») فالخطأ مبنيّ: اقرأ summary/why/nextActions منه. لبريزما: حين لا توجد prisma في node_modules يشغّل npx أحدثَ نسخة (8) وفيها «prisma init» ليس أمرَ التهيئة والأمرُ «npx prisma orm init --target postgres --authoring psl» بلا --datasource-provider؛ أو ثبّت النسخةَ الموافقة لعميل المشروع (npm i -D prisma@6) ثمّ «npx prisma init --datasource-provider postgresql».",
  },
  // ── التبعيات والحزم ─────────────────────────────────────────────────
  {
    id: "node-gyp-fail",
    when: /node-gyp|gyp ERR|MSBuild\.exe|Visual Studio.*not found|prebuild-install/iu,
    hint: "حزمة أصلية تحتاج أدوات بناء غائبة. جرّب نسخةً بثنائيات جاهزة (prebuilt)، أو حزمةً بديلةً نقيةً بلا native، أو ثبّت أدوات بناء ويندوز — ولا تكرّر التثبيت نفسه فيفشل نفسه.",
  },
  {
    id: "npm-ci-lock-mismatch",
    when: /npm ci.*can only install.*package-lock|lock file.*out of sync|EUSAGE.*npm ci/iu,
    hint: "package-lock لا يطابق package.json. لا تحذف القفل: شغّل npm install لمزامنته أولاً (خطوة معلنة)، ثم npm ci. الحذف الأعمى للقفل يخفي التعارض لا يحلّه.",
  },
  {
    id: "peer-dep-conflict",
    when: /ERESOLVE|peer dep|could not resolve dependency/iu,
    hint: "تعارض peer dependency. حدّد النسخ المتوافقة صراحةً بدل --force أو --legacy-peer-deps الأعميين؛ اقرأ أي نسخةٍ تطلبها الحزمة الأعلى ووحّد عليها.",
  },
  {
    id: "global-install",
    when: /npm (?:install|i)\s+(?:-g|--global)\b/iu,
    hint: "التثبيت العالمي (-g) يلوّث الجهاز ولا يثبّت في المشروع. ثبّتها تبعيةً محليةً واستدعها عبر npx أو من node_modules/.bin.",
  },
  // ── ويندوز والصدفة والمسارات ─────────────────────────────────────────
  {
    id: "enametoolong",
    when: /ENAMETOOLONG|path.*too long|filename.*too long|260 character/iu,
    hint: "تجاوز حدّ طول المسار (260 حرفاً على ويندوز). اعمل من مجلدٍ أقصر، أو فعّل LongPathsEnabled، أو استعمل subst لتقصير الجذر؛ ولا تعمّق البنية أكثر.",
  },
  {
    id: "reserved-name",
    when: /\b(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])\b.*(?:reserved|cannot|invalid)|reserved (?:device )?name/iu,
    hint: "اسم ملفٍ محجوز في ويندوز (CON/NUL/AUX/COM#/LPT#). غيّر الاسم — هذه الأسماء لا تصلح ملفاتٍ مهما كان الامتداد.",
  },
  {
    id: "json-bom",
    when: /Unexpected token.*\uFEFF|\uFEFF.*is not valid JSON|Unexpected token '?﻿|BOM/iu,
    hint: "علامة ترتيب البايتات (BOM) في أول ملف JSON/env تكسر المحلّل. أعد كتابة الملف بترميز UTF-8 بلا BOM.",
  },
  {
    id: "execution-policy",
    when: /cannot be loaded because running scripts is disabled|UnauthorizedAccess.*\.ps1|ExecutionPolicy/iu,
    hint: "سياسة تنفيذ PowerShell تمنع السكربت. شغّله بـpowershell -ExecutionPolicy Bypass -File <المسار> لهذه الجلسة فقط؛ لا تغيّر السياسة عالمياً.",
  },
  {
    id: "requires-elevation",
    when: /requires elevation|run as administrator|Access is denied.*(?:service|registry)|The requested operation requires elevation/iu,
    hint: "العملية تحتاج صلاحيات مسؤول. ابحث عن بديلٍ لا يحتاج رفعاً (منفذ غير محجوز، مجلد مستخدم، خدمة بمستوى المستخدم)؛ ولا تفترض توفّر الرفع.",
  },
  {
    id: "file-busy",
    when: /EBUSY|EPERM.*(?:unlink|rename)|being used by another process|resource busy or locked/iu,
    hint: "ملفٌ مقفول من عمليةٍ أخرى (مؤشر، مكافح فيروسات، خادم عامل). أوقف العملية المالكة أولاً (بالملكية المقيسة لا بالاسم)، أو أعد المحاولة بمهلةٍ قصيرة؛ لا تحذف بالقوة أثناء الاستعمال.",
  },
  {
    id: "crlf-script",
    when: /\/bin\/bash\^M|bad interpreter.*\^M|\\r.*command not found|syntax error near unexpected token.*\$'\\r'/iu,
    hint: "نهايات أسطر CRLF كسرت سكربت الصدفة على لينكس. احفظ سكربتات الخادم بنهايات LF حصراً (اكتبها بأداة write بلا CRLF).",
  },
  // ── الشبكة ──────────────────────────────────────────────────────────
  {
    id: "http-429",
    when: /\b429\b|too many requests|rate limit(?:ed)?/iu,
    hint: "تجاوز حدّ المعدّل (429). انتظر بتراجعٍ أسّيّ واحترم رأس Retry-After إن وُجد؛ لا تعِد الطلب فوراً في حلقة.",
  },
  {
    id: "dns-notfound",
    when: /ENOTFOUND|getaddrinfo|EAI_AGAIN|could not resolve host/iu,
    hint: "فشل تحليل DNS — ليس فشل خادم. تحقق من صحة اسم المضيف والاتصال؛ ENOTFOUND يعني «الاسم لا يُحلّ»، غير ECONNREFUSED («يُحلّ ويرفض») وغير المهلة.",
  },
  {
    id: "conn-refused",
    when: /ECONNREFUSED|connection refused/iu,
    hint: "الاتصال رُفض: المضيف يُحلّ لكن لا شيء يُنصت على المنفذ. تأكد أن الخادم يعمل فعلاً على ذلك المنفذ (قِسه)، وأن العنوان 127.0.0.1 لا ::1 إن كان الخادم IPv4.",
  },
  {
    id: "tls-disable-attempt",
    when: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|rejectUnauthorized\s*:\s*false|curl.*\s-k\b|--insecure\b/iu,
    hint: "رُفض تعطيل التحقق من TLS: عادة قاتلة تفتح الباب لاعتراض الاتصال. شخّص سبب خطأ الشهادة (ساعة منحرفة، شهادة جذر ناقصة، بروكسي) وأصلحه؛ لا تعطّل التحقق أبداً.",
  },
  {
    id: "tls-cert-invalid",
    when: /CERT_HAS_EXPIRED|certificate has expired|not yet valid|UNABLE_TO_VERIFY_LEAF|self.signed certificate|SELF_SIGNED/iu,
    hint: "شهادة TLS غير صالحة. إن كانت «expired/not yet valid» فافحص ساعة النظام أولاً؛ وإن كانت «self-signed/unable to verify» فأضف الشهادة الجذر بثقةٍ صريحة — ولا تعطّل التحقق.",
  },
  // ── الموارد ─────────────────────────────────────────────────────────
  {
    id: "enospc",
    when: /ENOSPC|no space left on device|disk (?:is )?full/iu,
    hint: "القرص ممتلئ — الكتابة قد تترك ملفاً نصفياً. حرّر مساحةً (node_modules، dist، لوجات، كاش البناء) قبل إعادة المحاولة، وتحقق أن الكتابات ذرّية.",
  },
  {
    id: "emfile",
    when: /EMFILE|too many open files|ENFILE/iu,
    hint: "نفدت مقابض الملفات. أغلق ما تفتحه (تدفّقات، اتصالات) في finally، ولا تفتح في حلقةٍ بلا إغلاق؛ ارفع الحدّ فقط إن كان السلوك صحيحاً.",
  },
  {
    id: "js-heap-oom",
    when: /JavaScript heap out of memory|FATAL ERROR.*heap|Reached heap limit/iu,
    hint: "نفدت ذاكرة V8. عالج البيانات على دفعات لا دفعةً واحدة، أو ارفع --max-old-space-size إن كان الحجم مشروعاً؛ لا تحمّل ملفاً ضخماً كاملاً في الذاكرة.",
  },
  {
    id: "gpu-oom",
    when: /CUDA out of memory|out of memory.*(?:GPU|VRAM)|failed to allocate.*device memory|cudaMalloc/iu,
    hint: "ذاكرة GPU ممتلئة (نموذجٌ آخر يشغلها غالباً). قِس ollama ps وأفرِغ النموذج غير المستعمل، أو صغّر num_ctx/الدفعة؛ لا تفترض الذاكرة حرّةً.",
  },
  // ── الزمن ───────────────────────────────────────────────────────────
  {
    id: "clock-skew",
    when: /clock skew|time.*out of sync|token used before issued|iat.*future|JWT.*not active yet/iu,
    hint: "انحراف ساعة النظام يكسر التواقيع وJWT وTLS. زامن الساعة (w32tm) قبل إعادة المحاولة؛ خطأٌ «not active/used before issued» غالباً ساعة لا منطق.",
  },
  // ── Next/React (لمشاريع العملاء) ─────────────────────────────────────
  {
    id: "hydration-mismatch",
    when: /hydration failed|text content does not match|did not match.*server|Hydration/iu,
    hint: "عدم تطابق الترطيب: الخادم والعميل أخرجا HTML مختلفاً. أزل ما يعتمد الزمن/العشوائية/المتصفح من التصيير الأول (Date.now، window، localStorage)، أو أجّله إلى useEffect.",
  },
  {
    id: "use-client-server-api",
    when: /you're importing a component that needs.*(?:useState|useEffect)|only works in a (?:Server|Client) Component|next\/headers.*Client Component/iu,
    hint: "خلط حدود Server/Client في Next. الخطافات وواجهات المتصفح في مكوّن \"use client\"، وقراءة القاعدة/الأسرار/next/headers في Server Components وroute handlers فقط.",
  },
  {
    id: "py-dictreader-double-header",
    when: /AssertionError: \d+ != \d+[\s\S]{0,200}(?:csv|DictReader)|DictReader\(.*fieldnames/iu,
    hint: "csv.DictReader(f, fieldnames=...) يعلن ألا ترويسة في الملف فيقرأ سطرَ الترويسة الفعليّ صفاً (عدٌّ زائد بواحد). إن كان الملف يحمل ترويسةً فاستعمل csv.DictReader(f) بلا fieldnames — يستهلكها بنفسه.",
  },
  {
    id: "py-module-not-found-src",
    when: /ModuleNotFoundError: No module named '(?:src|lib|app)'/iu,
    hint: "استيراد حزمةٍ محلية يفشل لأن python يشغّل الملف مباشرةً فيجعل مجلده جذرَ الاستيراد. في أول الملف: import sys, pathlib ثم sys.path.insert(0, str(pathlib.Path(__file__).parent)) ثم from lib import ... (بلا بادئة src) — أو شغّله وحدةً: python -m src.main من جذر المشروع.",
  },
  // ── Rust / Go / C++ ─────────────────────────────────────────────────
  {
    id: "rust-unresolved-crate",
    when: /error\[E0432\]|use of undeclared crate or module|can't find crate/iu,
    hint: "صندوق (crate) مستعمل غير معلن. أضفه إلى [dependencies] في Cargo.toml بنسخة محددة، أو صحّح اسم الوحدة — ولا تفترض توفر صندوق لم يُعلن.",
  },
  {
    id: "rust-borrow-move",
    when: /error\[E0382\]|error\[E0502\]|error\[E0499\]|borrow of moved value|cannot borrow/iu,
    hint: "خطأ ملكية/استعارة. رسالة rustc تحمل الحل حرفياً في سطر help — انسخه: غالباً .clone() لقيمة تُستعمل مرتين، أو & للاستعارة بدل النقل، أو إعادة ترتيب الاستعمالات.",
  },
  {
    id: "rust-linker-missing",
    when: /linker `link\.exe` not found|error: linking with .* failed/iu,
    hint: "رابط MSVC غائب عن البيئة. الأدوات منصّبة في BuildTools — شغّل الأمر من بيئة vcvars64 أو تحقق أن rustup يستعمل toolchain بـmsvc.",
  },
  {
    id: "go-no-module",
    when: /go: cannot find main module|go\.mod file not found/iu,
    hint: "لا وحدة Go في المجلد. شغّل أولاً: go mod init <اسم-الوحدة> ثم أعد الأمر.",
  },
  {
    id: "go-unused",
    when: /declared and not used|imported and not used/iu,
    hint: "Go يرفض المتغيرات والاستيرادات غير المستعملة رفض تصريف. احذف غير المستعمل أو استبدله بـ_ إن كان مقصوداً.",
  },
  {
    id: "c-isspace-signed-utf8",
    when: /0xC0000409|-1073740791|STATUS_STACK_BUFFER_OVERRUN|isspace.*(?:char|UTF)|عدّ.*كلمات.*خاطئ/iu,
    hint: "تمرير بايتات UTF-8 العالية (char سالبة) إلى isspace/ctype سلوكٌ غير معرّف — كل محرفٍ عربيّ يُحسب فاصلاً فينفجر عدّ الكلمات، وقد ينهار assert بـ0xC0000409. العلاج: isspace((unsigned char)c)، أو الأسلم لعدّ الكلمات: فحص الفواصل يدوياً (c==' '||c=='\t'||c=='\n'||c=='\r') واعتبار كل ما سواها جزء كلمة.",
  },
  {
    id: "cpp-unresolved-external",
    when: /LNK2019|unresolved external symbol|LNK1120/iu,
    hint: "رمز معرَّف تصريحاً بلا تعريف (ترجمة ملف ناقصة غالباً). أضف ملف الـcpp الحامل للتعريف إلى سطر cl في build.bat — كل ملفات src\\*.cpp تُذكر معاً.",
  },
  {
    id: "cpp-cl-not-recognized",
    when: /'cl' is not recognized|cl\.exe.*not (?:found|recognized)/iu,
    hint: "cl.exe يحتاج بيئة vcvars. البناء عبر build.bat يبدأ بـ: call \"C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat\" ثم cl — لا تستدعِ cl مباشرة من PowerShell.",
  },
  {
    id: "msvc-sdk-not-wired",
    when: /C1083.*(?:float\.h|math\.h|stdio\.h|stdlib\.h|iostream|vector|string)'?:? No such file/iu,
    hint: "ترويسات النظام (ucrt/STL) غائبة عن INCLUDE — vcvars على هذا الجهاز لا يكتشف Windows SDK وحده. أضف داخل build.bat بعد سطر call vcvars64.bat هذين السطرين حرفياً:\nset \"INCLUDE=%INCLUDE%;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\ucrt;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\shared;C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\um\"\nset \"LIB=%LIB%;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.26100.0\\ucrt\\x64;C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.26100.0\\um\\x64\"\n(داخل ملف bat فقط — لا في سلسلة cmd && لأن %INCLUDE% يتوسّع مبكراً فيمحو مسارات MSVC).",
  },
  {
    id: "cpp-std-member-missing",
    when: /C2039.*is not a member of .std.|C3861.*identifier not found/iu,
    hint: "دالة قياسية بلا ترويستها: أضف #include المناسب (sqrt→<cmath>، accumulate→<numeric>، sort→<algorithm>، setprecision→<iomanip>) — MSVC لا يسرّب الترويسات كما بعض المصرّفات.",
  },
  {
    id: "cpp-missing-include",
    when: /C1083.*Cannot open include file|fatal error C1083/iu,
    hint: "ملف ترويسة غير موجود. تحقق من اسم #include ومساره النسبي، ومن أن build.bat يمرّر /I لمجلد الترويسات إن لم تكن بجانب المصدر.",
  },
  {
    id: "vite-missing-entry",
    when: /Failed to resolve \/?src\/main\.[jt]sx? from .*index\.html|Could not resolve entry module.*index\.html/iu,
    hint: "index.html يشير إلى نقطة دخولٍ غير موجودة. أنشئ src/main.tsx التي يذكرها بالضبط: `import { createRoot } from 'react-dom/client'; import App from './App'; createRoot(document.getElementById('root')!).render(<App />)` — وتأكد أن index.html يحمل `<div id=\"root\"></div>` و`<script type=\"module\" src=\"/src/main.tsx\"></script>`.",
  },
  {
    id: "ts-name-not-found",
    when: /TS2304[^\n]*Cannot find name '([^']+)'/iu,
    hint: "اسمٌ مستعملٌ بلا تعريفٍ أو استيراد (غالباً بقايا نقلٍ إلى وحدةٍ أخرى). عرّفه في مكانه (مثلاً `const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH`) أو استورده من الوحدة التي نُقل إليها. افحص كلّ مواضع استعماله بعد أي إعادة هيكلة.",
  },
  {
    id: "ts-no-exported-member",
    when: /TS2305[^\n]*has no exported member '([^']+)'|TS2724[^\n]*has no exported member/iu,
    hint: "استيرادٌ لعضوٍ لا تصدّره الوحدة (اسمٌ خاطئ أو غير مُصدَّر). افتح الوحدة وتحقّق من الأسماء المصدَّرة فعلاً، وصحّح الاستيراد أو أضف export.",
  },
  {
    id: "route-handler-plain-object",
    when: /TS2353[^\n]*(?:Content-Type|Headers|does not exist in type 'Headers')|TS2345[^\n]*(?:Request|not assignable[^\n]*Request)|is not assignable to type 'ReadableStream/iu,
    hint: "اختبارٌ يستدعي معالج مسارٍ (POST/GET) بكائنٍ عاديّ بدل Request. أنشئ طلباً حقيقياً: `new Request('http://localhost/api/...', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })` ومرّره للمعالج — الكائن العاديّ لا يطابق نوع Request.",
  },
  {
    id: "esm-cjs-interop",
    when: /require\(\) of ES Module|Cannot use import statement outside a module|ERR_REQUIRE_ESM|must use import to load ES Module/iu,
    hint: "تعارض ESM/CJS. وحّد النظام: \"type\":\"module\" مع import، أو استعمل import ديناميكياً للحزمة ESM من سياق CJS؛ لا تخلط require وimport لنفس الوحدة.",
  },
  {
    id: "cs-root-globs-tests",
    when: /CS0246.*(?:FactAttribute|Xunit|TheoryAttribute).*\.csproj\]|CS0579.*Duplicate.*Assembly\w*Attribute/iu,
    hint: "مشروع الجذر SDK-style يلتقط كل **/*.cs بما فيها Tests/ فيصرّف اختبارات xunit بلا مراجعها. أضف داخل ملف المشروع الجذري (Fawtara.csproj) قبل </Project>:\n<ItemGroup>\n  <Compile Remove=\"Tests/**\" />\n  <None Remove=\"Tests/**\" />\n</ItemGroup>\nثم أعد dotnet build. اختبارات Tests تُبنى من مشروعها هي بdotnet test Tests/Tests.csproj. (CS0579 Duplicate AssemblyAttribute من نفس العلة: الجذر يلتقط Tests/obj المولَّد — نفس العلاج، واحذف obj وbin من الجذر قبل إعادة البناء.)",
  },
  {
    id: "cs-nu1101-xunit-restore",
    when: /NU1\d{3}.*(?:xunit|Microsoft\.NET\.Test\.Sdk)/iu,
    hint: "حزم الاختبار لم تُسترجع: تأكد أن Tests/Tests.csproj يحمل PackageReference لxunit وMicrosoft.NET.Test.Sdk وxunit.runner.visualstudio بإصدارات، ثم dotnet restore Tests/Tests.csproj قبل dotnet test.",
  },
  {
    id: "cs-program-main-duplicate",
    when: /CS0017|CS8802/u,
    hint: "نقطتا دخول: إمّا Main واحدة صريحة أو top-level statements في ملف واحد فقط — احذف إحداهما أو اجعل StartupObject يسمّي الصنف.",
  },
  {
    id: "ps1-call-operator-single-string",
    when: /is not recognized as[\s\S]{0,120}CommandNotFoundException|The term '.+\.exe .+' is not recognized/u,
    hint: "وضعت الأمر ووسائطه كلها في سلسلة واحدة واستدعيتها بـ& — مشغّل الاستدعاء يعامل السلسلة كلها اسمَ ملف. القانون: المسار وحده في متغير والوسائط مصفوفة: $exe = \"C:/طريق/أداة.exe\"; $args2 = @(\"-h\",\"127.0.0.1\"); & $exe @args2 -f ملف. وافحص $LASTEXITCODE بعد كل استدعاء — لا تطبع passed قبل الفحص.",
  },
  {
    id: "ps1-arabic-needs-bom",
    when: /Unexpected token '[^']*[ØÙ][^']*'|The string is missing the terminator.*\.ps1|ParserError.*\.ps1/u,
    hint: "سكربت .ps1 يحمل نصوصاً عربية بترميز UTF-8 بلا BOM — ‏PowerShell 5.1 يقرؤه ANSI فتتشوه الحروف وتكسر المحلل (تظهر كـØ£). اجعل كل السلاسل داخل ملفات .ps1 إنجليزية/ASCII فقط (step1 failed بدل الرسائل العربية)، والعربية تبقى في ملفات SQL/البيانات لا في سكربت PowerShell.",
  },
  {
    id: "php-variable-vs-function-call",
    when: /Value of type null is not callable|Call to undefined function|Undefined variable \$\w+/u,
    hint: "خلط بين دالة ومتغير في PHP: ما عُرّف function check(...) {} يُستدعى check(...) لا $check(...)؛ وما أُسند $check = function(...) {} يُستدعى $check(...). وحّد الأسلوب — الأبسط: دوال مسمّاة تُستدعى باسمها بلا $.",
  },
  {
    id: "php-not-in-path",
    when: /'php' is not recognized|php: command not found/iu,
    hint: "php ليست في PATH على هذا الجهاز — استدعها دائماً بمسارها المطلق (اقرأه مرّةً بـ«where php» أو «Get-Command php»، أو من متغيّر ABDO_PHP) ثم مرّر الملف: <مسار php.exe> <الملف>.",
  },
  {
    id: "js-dom-not-defined-in-node",
    when: /(?:document|window|localStorage) is not defined/u,
    hint: "الملف يعمل في بيئتين: Node للاختبار والمتصفح للواجهة. احرس كل لمس DOM/localStorage خلف if (typeof document !== \"undefined\") { ... } وأبقِ الدوال النقية خارج الحرس؛ والتصدير في آخر الملف: if (typeof module !== \"undefined\") module.exports = { addTask, toggleTask, removeTask, remaining }.",
  },
  {
    id: "mjs-require-of-cjs",
    when: /require is not defined in ES module scope|Cannot use import statement outside a module|does not provide an export named/u,
    hint: "ملف .mjs لا يملك require وملف .js التقليدي لا يُستورد بexport مسمّى. في test.mjs استعمل: import { createRequire } from \"node:module\"; const require = createRequire(import.meta.url); const { addTask } = require(\"./app.js\");",
  },
  {
    id: "cs-tryparse-arg-order",
    when: /CS1615.*out|CS1620.*out|CS1503.*NumberStyles/u,
    hint: "ترتيب معاملات TryParse خاطئ — الصيغة الوحيدة الصحيحة: decimal.TryParse(text, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal v) — النمط ثم الثقافة ثم out آخراً؛ وint.TryParse(text, out int n) بلا نمط.",
  },
  {
    id: "cs-no-tests-discovered",
    when: /No test is available in .*\.dll/iu,
    hint: "الحاوية بلا اختبارات مكتشفة — ثلاثة أسباب مقيسة بالترتيب: (1) لا يوجد ملف اختبارات فيه [Fact] أصلاً داخل مشروع الاختبارات — تحقق بlist ثم اكتبه؛ (2) الصنف المُختبَر internal (class بلا public) ومشروع الاختبارات مرجعٌ خارجي لا يراه — اجعله public class؛ (3) xunit.runner.visualstudio غائب من PackageReference. بعد الإصلاح: dotnet test <مسار مشروع الاختبارات>.csproj.",
  },
  {
    id: "cs-decimal-culture",
    when: /System\.FormatException.*(?:decimal|Decimal|number)/u,
    hint: "decimal.Parse يقرأ بثقافة النظام (قد تكون فاصلة عربية) — استعمل decimal.TryParse(text, NumberStyles.Number, CultureInfo.InvariantCulture, out v) وToString(\"0.00\", CultureInfo.InvariantCulture) للطباعة.",
  }
]

/**
 * يبني تشخيصاً من نصّ إيصالٍ فاشل — سطرٌ لكل صنفٍ مطابق (مسقوف).
 * سلسلة فارغة تعني «لا صنف معروفاً» — لا ضوضاء على ناتجٍ سليم.
 */
export function errorPlaybookHints(output: string, max = 3): string {
  const matched: string[] = []
  for (const pb of PLAYBOOKS) {
    if (matched.length >= max) break
    if (pb.not !== undefined && pb.not.test(output)) continue
    if (pb.when.test(output)) matched.push(`«${pb.id}»: ${pb.hint}`)
  }
  if (matched.length === 0) return ""
  return `\nتشخيص صنف الخطأ (محسوب من الإيصال، انسخ الحلّ لا تجتهد):\n${matched.join("\n")}`
}
