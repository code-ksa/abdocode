/** إدراك الحزمة (stack) — المحرّك يبني أنواعاً لا نوعاً واحداً.
 *
 * كان كلّ شيء مخصّصاً لـNext.js: بوابة الخطة ترفض أيّ مشروع لا يذكر
 * Next/RTL/SQLite/إدارة/تواصل، فمشروع React+Vite أو Fastify أو HTML يُرفض
 * قبل أن يبدأ. هذا السجلّ يعرّف لكلّ حزمةٍ ثوابتَها وقالبها وأمر بنائها
 * وتشغيلها، ويُكتشف النوع من نصّ الخطة أو الهدف أو ملفّات المشروع. إضافة
 * حزمةٍ سطرٌ هنا وقالبٌ — لا فرعٌ في المحرّك.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

export interface StackProfile {
  readonly id: string
  readonly label: string
  /** يُطابق نصّ الهدف/الخطة ليُكتشف النوع. */
  readonly detect: RegExp
  /** ثوابت يجب أن تذكرها الخطة لهذا النوع (regex, اسم). */
  readonly anchors: readonly (readonly [RegExp, string])[]
  /** أمر البناء، أو undefined لِما لا يُبنى (HTML ساكن). */
  readonly buildCommand: string | undefined
  /** أمر التشغيل للفحص الحيّ، أو undefined. */
  readonly serveCommand: string | undefined
  readonly defaultPort: number
  /** نمط الأدلة القابلة للقياس في الخطة — كل حزمةٍ عدّتُها (npm/cargo/go/cl...). */
  readonly evidence: RegExp
  readonly template: (goal: string) => string
}

const sprint = (title: string, work: string, gate: string): string =>
  `## ${title}\n- الحالة: غير مكتمل\n- العمل: ${work}\n- بوابة القبول: ${gate}\n- الأدلة: (تُملأ بإيصال التشغيل بعد نجاح البوابة)\n`

const handoffTail = "\n## التسليم\nيُحدَّث ABDO-HANDOFF.md بعد كل سبرنت بالهدف والحالة الحقيقية وNEXT_ACTION والأدلة. لا اكتمال وبوّابةٌ مفتوحة.\n"

export const STACKS: readonly StackProfile[] = [
  {
    id: "next",
    label: "Next.js (App Router)",
    detect: /next\.?js|app\s*router/iu,
    anchors: [
      [/next\.?js/iu, "Next.js"],
      [/RTL|عربي/iu, "عربي/RTL"],
      [/SQLite|prisma|قاعدة/iu, "قاعدة بيانات"],
      [/(?:لوحة\s*(?:ال)?[إا]دارة|admin)/iu, "لوحة الإدارة"],
    ],
    buildCommand: "npm run build",
    serveCommand: "npm start",
    defaultPort: 3000,
    evidence: /(?:npm\s+(?:(?:--filter|-F|--workspace|-w)(?:=\S+|\s+\S+)\s+)*(?:run\s+)?(?:build|test|audit|start)|playwright|vitest|sqlite3|HTTP\s*\d{3}|فحص\s+المتصفح)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (Next.js · عربي RTL · SQLite · لوحة إدارة)\n\nالمخزن ومصدر الحقيقة: SQLite عبر better-sqlite3. App Router في app/ وحده دون موجّهٍ قديم.\n\n` +
      sprint("سبرنت 1 — الهيكل والرئيسية", "app/layout.tsx وapp/page.tsx بعربية RTL وخصائص CSS منطقية", "npm run build ينجح") +
      sprint("سبرنت 2 — القاعدة (SQLite)", "app/lib/db.ts بجداول المحتوى والمديرين، وصولها في Server Components وroute handlers فقط", "npm test لعمليات القاعدة ينجح") +
      sprint("سبرنت 3 — الصفحات العامة", "صفحات المحتوى بعربية حقيقية", "HTTP 200 لكل صفحة") +
      sprint("سبرنت 4 — التواصل", "نموذج وroute handler يحفظ في SQLite", "HTTP 200 وصفٌّ جديد في القاعدة") +
      sprint("سبرنت 5 — المصادقة", "قراءة ADMIN_PASSWORD_HASH من البيئة، فشلٌ مغلقٌ بلا سرٍّ في المصدر", "npm test للمصادقة نجاحاً وفشلاً ينجح") +
      sprint("سبرنت 6 — لوحة الإدارة", "app/admin محميّة لإدارة المحتوى وعرض الطلبات", "HTTP: /admin يرفض بلا مصادقة ويقبل بها") +
      sprint("سبرنت 7 — الإقفال", "الموقع كله", "npm run build + npm test + npm audit صفر ثغرات + فحص المتصفح HTTP 200 للصفحات ومسارات api") +
      handoffTail,
  },
  {
    id: "vite-react",
    label: "React + Vite",
    detect: /\bvite\b|react[\s+]*vite|vite[\s+]*react/iu,
    anchors: [
      [/react/iu, "React"],
      [/vite/iu, "Vite"],
      [/(?:مكوّن|component|صفحة|page|واجهة)/iu, "واجهة مكوّنات"],
    ],
    buildCommand: "npm run build",
    serveCommand: "npm run preview",
    defaultPort: 4173,
    evidence: /(?:npm\s+(?:(?:--filter|-F|--workspace|-w)(?:=\S+|\s+\S+)\s+)*(?:run\s+)?(?:build|test|audit|preview)|vitest|dist\/|HTTP\s*\d{3}|فحص\s+المتصفح)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (React + Vite + TypeScript)\n\nتطبيق SPA بـVite. المصدر في src/، ونقطة الدخول src/main.tsx.\n\n` +
      sprint("سبرنت 1 — الهيكل", "index.html وsrc/main.tsx وsrc/App.tsx وvite.config.ts", "npm run build ينجح ويُخرج dist/") +
      sprint("سبرنت 2 — التنسيق", "Tailwind أو CSS منطقي، سمة متسقة", "npm run build ينجح") +
      sprint("سبرنت 3 — المكوّنات", "مكوّنات الواجهة الأساسية في src/components", "npm run build ينجح") +
      sprint("سبرنت 4 — الحالة والبيانات", "إدارة الحالة وجلب البيانات (fetch/مصدر محلي)", "npm test لمنطق الحالة ينجح") +
      sprint("سبرنت 5 — التوجيه", "مسارات الصفحات (react-router أو حالة)", "npm run build ينجح") +
      sprint("سبرنت 6 — الاختبارات", "vitest لمكوّنات ومنطق حقيقيين", "npm test غير تفاعليّ ينجح") +
      sprint("سبرنت 7 — الإقفال", "التطبيق كله", "npm run build + npm test + npm audit صفر ثغرات + npm run preview وفحص HTTP 200") +
      handoffTail,
  },
  {
    id: "fastify",
    label: "Fastify API",
    detect: /fastify/iu,
    anchors: [
      [/fastify/iu, "Fastify"],
      [/(?:مسار|route|endpoint|نقطة\s*نهاية)/iu, "مسارات"],
      [/(?:قاعدة|SQLite|prisma|مخزن)/iu, "مخزن بيانات"],
    ],
    buildCommand: "npm run build",
    serveCommand: "npm start",
    defaultPort: 3000,
    evidence: /(?:npm\s+(?:(?:--filter|-F|--workspace|-w)(?:=\S+|\s+\S+)\s+)*(?:run\s+)?(?:build|test|audit|start)|vitest|inject|HTTP\s*\d{3})/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (Fastify API · TypeScript · SQLite)\n\nمخزن الحقيقة: SQLite. الخادم src/server.ts، والمسارات مسجّلةٌ كـplugins.\n\n` +
      sprint("سبرنت 1 — الخادم", "src/server.ts يشغّل Fastify ويستمع على PORT من البيئة", "npm run build ينجح ثم npm start يستمع") +
      sprint("سبرنت 2 — القاعدة", "src/db.ts بجداول المجال، وصولٌ في المسارات فقط", "npm test لعمليات القاعدة ينجح") +
      sprint("سبرنت 3 — مسارات القراءة", "GET للموارد مع تصديق المخطط (schema)", "HTTP 200 بJSON حقيقيّ") +
      sprint("سبرنت 4 — مسارات الكتابة", "POST/PUT/DELETE بتحقق المدخلات ومعاملات SQL مرتبطة", "HTTP 2xx وتغيّرٌ مقيسٌ في القاعدة") +
      sprint("سبرنت 5 — المصادقة", "حماية المسارات الإدارية بمفتاح/توكن من البيئة، فشلٌ مغلق", "HTTP 401 بلا اعتماد و2xx به") +
      sprint("سبرنت 6 — الاختبارات", "اختبارات مسارات حقيقية (inject) للمصادقة والقاعدة", "npm test غير تفاعليّ ينجح") +
      sprint("سبرنت 7 — الإقفال", "الواجهة كلها", "npm run build + npm test + npm audit صفر ثغرات + npm start وفحص HTTP للمسارات") +
      handoffTail,
  },
  {
    id: "static-html",
    label: "HTML + Tailwind (ساكن)",
    detect: /(?:^|\s)html(?:\s|$)|صفحة\s+ساكنة|موقع\s+ساكن|tailwind(?!.*(?:react|next|vue))/iu,
    anchors: [
      [/html/iu, "HTML"],
      [/(?:tailwind|css|تنسيق)/iu, "تنسيق"],
      [/(?:صفحة|قسم|section|page)/iu, "أقسام الصفحة"],
    ],
    buildCommand: undefined,
    serveCommand: undefined,
    defaultPort: 8080,
    evidence: /(?:فحص\s+المتصفح|HTML|في\s+المتصفح|بنيويّ|متجاوب|قسم)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (HTML + Tailwind ساكن)\n\nموقعٌ ساكن، لا خطوة بناءٍ إلزامية. index.html هو المدخل، وTailwind عبر CDN أو CLI.\n\n` +
      sprint("سبرنت 1 — الهيكل", "index.html بترويسةٍ وأقسامٍ دلاليّة", "الملف موجود وصالح HTML") +
      sprint("سبرنت 2 — التنسيق", "Tailwind وتصميمٌ متجاوب", "فتحٌ في المتصفح يعرض التصميم") +
      sprint("سبرنت 3 — المحتوى", "محتوى حقيقيّ في كل قسم", "لا نصوص حشوٍ ظاهرة") +
      sprint("سبرنت 4 — التفاعل", "JavaScript للتنقّل/النماذج عند اللزوم", "التفاعل يعمل في المتصفح") +
      sprint("سبرنت 5 — الوصولية وSEO", "وسوم meta وبنية عناوين وبدائل نصّية", "فحص بنيويّ يمرّ") +
      sprint("سبرنت 6 — الاستجابة", "اختبار على مقاسات متعددة", "لا كسر تخطيطٍ ظاهر") +
      sprint("سبرنت 7 — الإقفال", "الموقع كله", "فتحٌ حيّ في المتصفح: كل الأقسام تظهر وتتفاعل، وفحص HTML بنيويّ") +
      handoffTail,
  },
  {
    id: "flutter",
    label: "Flutter (Dart)",
    detect: /flutter|\bdart\b|(?<![\p{L}])(?:فلاتر|فلوتر)(?![\p{L}])/iu,
    anchors: [
      [/flutter|فلاتر|فلوتر|dart/iu, "Flutter/Dart"],
      [/(?:lib\/|test\/|pubspec)/iu, "بنية المشروع"],
      [/(?:اختبار|test)/iu, "اختبارات"],
    ],
    buildCommand: undefined,
    serveCommand: undefined,
    defaultPort: 8080,
    evidence: /(?:flutter\s+(?:test|analyze|pub)|All tests passed|dart\s|test\/|lib\/|pubspec\.yaml|exit\s*(?:code\s*)?0)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (Flutter/Dart — إن لم تكن الأدوات في PATH فاقرأ مسار flutter/bin مرّةً بـ«where flutter» ثم صدِّر PATH في نفس السطر قبل كل أمر: $env:PATH="<مسار flutter/bin>;"+$env:PATH)

` +
      sprint("سبرنت 1 — القراءة", "اقرأ pubspec.yaml وبنية lib/ وtest/ القائمة قبل أي كتابة — التطبيق حقيقي قائم لا يُكسر", "flutter test الحالي يمر (خط الأساس)") +
      sprint("سبرنت 2 — الوحدة الجديدة", "ملف Dart نقي في lib/ بالدوال المطلوبة بلا استيراد خارجي", "dart analyze أو flutter analyze بلا أخطاء على الملف") +
      sprint("سبرنت 3 — الاختبارات", "ملف اختبار في test/ بحزمة flutter_test يغطي الحالات والحدود", "flutter test يمر بكل الاختبارات") +
      sprint("سبرنت 4 — الحدود", "أصفار وسوالب ورموش خطأ (throwsArgumentError) ونصوص عربية", "flutter test يغطيها بنجاح") +
      sprint("سبرنت 5 — عدم الكسر", "لا تعديل على ملفات قائمة إلا بأمر صريح", "flutter test كاملاً أخضر بما فيه القديم") +
      sprint("سبرنت 6 — التحليل", "flutter analyze على المضاف بلا تحذيرات جديدة", "analyze نظيف") +
      sprint("سبرنت 7 — الإقفال", "الوحدة والاختبارات كاملة", "flutter test النهائي All tests passed بإيصال") +
      handoffTail,
  },
  {
    id: "php",
    label: "PHP (خالص بلا composer)",
    detect: /\bphp\b|بي\s*اتش\s*بي/iu,
    anchors: [
      [/php/iu, "PHP"],
      [/(?:run\.php|src\/|class)/iu, "بنية المشروع"],
      [/(?:اختبار|test)/iu, "اختبارات"],
    ],
    buildCommand: undefined,
    serveCommand: undefined,
    defaultPort: 8080,
    evidence: /(?:php(?:\.exe)?\s|test\.php|run\.php|ALL TESTS PASSED|FAILED|exit\s*(?:code\s*)?[012]|require_once|Usage)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (PHP خالص — إن لم يكن المفسّر في PATH فاقرأ مساره مرّةً بـ«where php» واستعمله مطلقاً في كل أمر؛ لا composer ولا مكتبات)

` +
      sprint("سبرنت 1 — الهيكل", "src/ فيه class بدوال static نقية وrun.php مدخلاً بrequire_once", "php.exe -l على كل ملف بلا أخطاء صياغة") +
      sprint("سبرنت 2 — منطق المجال", "الدوال النقية كاملة بأنواع معلنة (declare strict_types=1 اختياري)", "php.exe run.php على عيّنة يخرج صحيحاً") +
      sprint("سبرنت 3 — الاختبارات", "test.php بعدّاد فحوص بلا أي إطار، يطبع ALL TESTS PASSED عند الكمال ويرجع 0 وإلا FAILED و1", "php.exe test.php بexit 0") +
      sprint("سبرنت 4 — الحدود", "مدخل فاسد وملف غائب وقائمة فارغة بأكواد خروج مسمّاة", "php.exe test.php يغطيها بنجاح") +
      sprint("سبرنت 5 — المدخل", "run.php يقرأ الوسائط ويطبع التقرير وUsage بلا وسيط بexit 1", "php.exe run.php على العيّنة يطبع الأسطر المطلوبة") +
      sprint("سبرنت 6 — العربية", "عيّنة بنصوص عربية تمرّ سليمة (UTF-8 بلا BOM)", "php.exe run.php يعرضها بلا تشويه") +
      sprint("سبرنت 7 — الإقفال", "المشروع كله", "test.php وrun.php كلاهما بإيصال exit صحيح") +
      handoffTail,
  },
  {
    id: "rust",
    label: "Rust (cargo)",
    detect: /\brust\b|\bcargo\b|(?<![\p{L}])راست(?![\p{L}])/iu,
    anchors: [
      [/rust|cargo|راست/iu, "Rust/cargo"],
      [/(?:src\/main\.rs|Cargo\.toml)/iu, "بنية cargo"],
      [/(?:اختبار|test)/iu, "اختبارات"],
    ],
    buildCommand: "cargo build",
    serveCommand: undefined,
    defaultPort: 8080,
    evidence: /(?:cargo\s+(?:build|test|run|clippy|check)|#\[test\]|assert(?:_eq)?!|exit\s*(?:code\s*)?0)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (Rust · cargo)\n\nمشروع cargo قياسي: Cargo.toml وsrc/main.rs، والاختبارات بوحدات #[test] وtests/. لا تبعيات إلا بحاجةٍ مسمّاة.\n\n` +
      sprint("سبرنت 1 — الهيكل", "Cargo.toml (اسم وإصدار وedition) وsrc/main.rs يعمل", "cargo build ينجح") +
      sprint("سبرنت 2 — منطق المجال", "src/lib.rs بأنواع المجال ودواله النقية", "cargo build ينجح") +
      sprint("سبرنت 3 — اختبارات الوحدات", "#[test] لكل دالة منطق (نجاحاً وحدوداً)", "cargo test ينجح") +
      sprint("سبرنت 4 — واجهة التشغيل", "main.rs يقرأ الوسائط وينفّذ ويطبع ناتجاً حقيقياً", "cargo run -- <مثال> يطبع الناتج الصحيح") +
      sprint("سبرنت 5 — الأخطاء", "Result/Option بلا unwrap في مسارات الإنتاج؛ رسائل خطأ مسمّاة", "cargo test ينجح واختبار حالة خطأ يمرّ") +
      sprint("سبرنت 6 — اختبارات التكامل", "tests/cli.rs يشغّل الثنائي ويقيس خرجه", "cargo test ينجح كاملاً") +
      sprint("سبرنت 7 — الإقفال", "المشروع كله", "cargo build --release + cargo test بنجاح كامل وتشغيل الثنائي بإيصال exit 0") +
      handoffTail,
  },
  {
    id: "go",
    label: "Go",
    // ⚠️ درسنا الموثّق: \b لا يطابق العربية — «جو» العارية طابقت «موجود».
    // الحدود بـ\p{L} lookarounds للعربية، و\b للّاتينية وحدها.
    detect: /\bgo(?:lang)?\b(?!\s*(?:to|ing))|(?<![\p{L}])جو(?:لانج)?(?![\p{L}])/iu,
    anchors: [
      [/\bgo(?:lang)?\b|جو/iu, "Go"],
      [/go\.mod|package\s+main/iu, "وحدة go"],
      [/(?:اختبار|test)/iu, "اختبارات"],
    ],
    buildCommand: "go build ./...",
    serveCommand: undefined,
    defaultPort: 8080,
    evidence: /(?:go\s+(?:build|test|run|vet|mod)|func\s+Test|t\.(?:Errorf|Fatal)|exit\s*(?:code\s*)?0)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (Go)\n\nوحدة Go قياسية: go.mod وmain.go، والاختبارات *_test.go بجانب مصدرها. لا تبعيات إلا بحاجةٍ مسمّاة.\n\n` +
      sprint("سبرنت 1 — الهيكل", "go mod init والحزمة الرئيسة main.go تعمل", "go build ./... ينجح") +
      sprint("سبرنت 2 — منطق المجال", "حزمة داخلية بأنواع المجال ودواله النقية", "go build ./... ينجح") +
      sprint("سبرنت 3 — اختبارات الوحدات", "*_test.go بدوال func TestX لكل منطق (نجاحاً وحدوداً)", "go test ./... ينجح") +
      sprint("سبرنت 4 — واجهة التشغيل", "main يقرأ الوسائط وينفّذ ويطبع ناتجاً حقيقياً", "go run . <مثال> يطبع الناتج الصحيح") +
      sprint("سبرنت 5 — الأخطاء", "error يُعاد ويُفحص بلا panic في مسارات الإنتاج", "go test ./... ينجح واختبار حالة خطأ يمرّ") +
      sprint("سبرنت 6 — الفحص الساكن", "go vet نظيف والتسميات اصطلاحية", "go vet ./... بلا شكاوى") +
      sprint("سبرنت 7 — الإقفال", "المشروع كله", "go build ./... + go test ./... + go vet ./... بنجاح كامل وتشغيل الثنائي بإيصال exit 0") +
      handoffTail,
  },
  {
    id: "cpp",
    label: "C++ (MSVC cl)",
    detect: /c\+\+|\bcpp\b|سي\s*بلس/iu,
    anchors: [
      [/c\+\+|cpp|سي\s*بلس/iu, "C++"],
      [/(?:cl\.exe|vcvars|MSVC|build\.bat)/iu, "عدّة MSVC"],
      [/(?:اختبار|test)/iu, "اختبارات"],
    ],
    buildCommand: "cmd /c build.bat",
    serveCommand: undefined,
    defaultPort: 8080,
    evidence: /(?:build\.bat|test\.bat|cl(?:\.exe)?\s|vcvars|assert|exit\s*(?:code\s*)?0)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (C++17 · MSVC cl)\n\nالمترجم cl.exe من BuildTools عبر vcvars64. البناء بسكربت build.bat (يستدعي vcvars64.bat ثم cl /EHsc /W4 /std:c++17)، والاختبارات ثنائيّ tests.exe بassert يبنيه test.bat ويشغّله.\n\n` +
      sprint("سبرنت 1 — الهيكل والبناء", "build.bat: استدعِ vcvars64.bat ثم أضف سطري SDK — set INCLUDE=%INCLUDE%; مع مجلدات ucrt وshared وum، وset LIB=%LIB%; مع ucrt/x64 وum/x64 (كلها تحت Windows Kits/10/Include|Lib/10.0.26100.0) لأن vcvars هنا لا يكتشف SDK وحده — ثم cl /EHsc /W4 /std:c++17 على ملفات src ليخرج app.exe", "cmd /c build.bat ينجح ويُخرج app.exe") +
      sprint("سبرنت 2 — منطق المجال", "src/lib.h وsrc/lib.cpp بأنواع المجال ودواله النقية", "cmd /c build.bat ينجح") +
      sprint("سبرنت 3 — اختبارات الوحدات", "src/tests.cpp بassert لكل دالة، وtest.bat يبنيه tests.exe ويشغّله", "cmd /c test.bat ينجح بexit 0") +
      sprint("سبرنت 4 — واجهة التشغيل", "main يقرأ الوسائط وينفّذ ويطبع ناتجاً حقيقياً", "app.exe <مثال> يطبع الناتج الصحيح") +
      sprint("سبرنت 5 — الأخطاء والحدود", "فحص المدخلات ورسائل خطأ مسمّاة وexit codes صحيحة", "cmd /c test.bat يمرّ باختبارات الحدود") +
      sprint("سبرنت 6 — الذاكرة والملكية", "RAII بلا new/delete خام؛ std::vector/string/unique_ptr", "cmd /c build.bat بلا تحذيرات /W4") +
      sprint("سبرنت 7 — الإقفال", "المشروع كله", "cmd /c build.bat + cmd /c test.bat بنجاح كامل وتشغيل app.exe بإيصال exit 0") +
      handoffTail,
  },
  {
    id: "python",
    label: "Python",
    detect: /python|بايثون/iu,
    anchors: [
      [/python|بايثون/iu, "Python"],
      [/(?:unittest|pytest|اختبار|test)/iu, "اختبارات"],
      [/(?:main\.py|src\/)/iu, "بنية المشروع"],
    ],
    buildCommand: "python -m compileall src",
    serveCommand: undefined,
    defaultPort: 8080,
    evidence: /(?:python\s+-m\s+(?:unittest|compileall|pytest)|python\s+\S+\.py|unittest|assert|exit\s*(?:code\s*)?0)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (Python 3 · unittest — src/ للمصدر وtests/ لاختبارات unittest المدمجة بلا تبعيات خارجية)\n\n` +
      sprint("سبرنت 1 — الهيكل", "src/main.py يعمل وsrc/lib.py لوحدات المجال", "python -m compileall src ينجح وpython src/main.py يطبع ناتجاً") +
      sprint("سبرنت 2 — منطق المجال", "دوال المجال النقية في src/lib.py بtype hints", "python -m compileall src ينجح") +
      sprint("سبرنت 3 — اختبارات الوحدات", "tests/test_lib.py بunittest لكل دالة نجاحاً وحدوداً", "python -m unittest discover -s tests ينجح") +
      sprint("سبرنت 4 — واجهة التشغيل", "main.py يقرأ الوسائط بargparse وينفّذ ويطبع ناتجاً حقيقياً", "python src/main.py مع مثال يطبع الناتج الصحيح") +
      sprint("سبرنت 5 — الأخطاء", "استثناءات مسمّاة وexit codes صحيحة", "python -m unittest يمرّ باختبار حالة خطأ") +
      sprint("سبرنت 6 — التغطية", "اختبار لكل مسار منطقي رئيس", "python -m unittest discover -s tests ينجح كاملاً") +
      sprint("سبرنت 7 — الإقفال", "المشروع كله", "python -m compileall src ثم python -m unittest discover -s tests بنجاح كامل وتشغيل main.py بإيصال exit 0") +
      handoffTail,
  },
  {
    id: "c",
    label: "C (MSVC cl)",
    detect: /(?<![\w+#])\bC\b(?![\w+#])|\bC1[78]\b|MSVC(?![\s\S]*C\+\+)|لغة\s*سي(?!\s*(?:بلس|شارب))|بلغة\s*سي(?!\s*(?:بلس|شارب))/u,
    anchors: [
      [/(?:\bC\b|\bC1[78]\b|MSVC|لغة\s*سي|بلغة\s*سي)/u, "C"],
      [/(?:cl\.exe|vcvars|build\.bat)/iu, "عدّة MSVC"],
      [/(?:اختبار|test|assert)/iu, "اختبارات"],
    ],
    buildCommand: "cmd /c build.bat",
    serveCommand: undefined,
    defaultPort: 8080,
    evidence: /(?:build\.bat|test\.bat|cl(?:\.exe)?\s|vcvars|assert|exit\s*(?:code\s*)?0)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (C17 · MSVC cl — build.bat عبر vcvars64 يبني src بـ/W4، وtest.bat يبني tests.exe بassert.h ويشغّله)\n\n` +
      sprint("سبرنت 1 — الهيكل والبناء", "build.bat يستدعي vcvars64.bat ثم يضيف سطري SDK (INCLUDE وLIB من Windows Kits 10.0.26100.0: ucrt+shared+um) ثم cl /W4 /std:c17 src مع main.c ليخرج app.exe", "cmd /c build.bat ينجح ويُخرج app.exe") +
      sprint("سبرنت 2 — منطق المجال", "src/lib.h وsrc/lib.c بدوال المجال النقية", "cmd /c build.bat ينجح") +
      sprint("سبرنت 3 — اختبارات الوحدات", "src/tests.c بassert لكل دالة، وtest.bat يبنيه tests.exe ويشغّله", "cmd /c test.bat ينجح بexit 0") +
      sprint("سبرنت 4 — واجهة التشغيل", "main يقرأ argv وينفّذ ويطبع ناتجاً حقيقياً", "app.exe مع مثال يطبع الناتج الصحيح") +
      sprint("سبرنت 5 — الأخطاء والحدود", "فحص المدخلات وexit codes ورسائل stderr", "cmd /c test.bat يمرّ باختبارات الحدود") +
      sprint("سبرنت 6 — الذاكرة", "كل malloc له free وفحص NULL ولا وصول خارج الحدود", "cmd /c build.bat بلا تحذيرات /W4") +
      sprint("سبرنت 7 — الإقفال", "المشروع كله", "cmd /c build.bat ثم cmd /c test.bat بنجاح كامل وتشغيل app.exe بإيصال exit 0") +
      handoffTail,
  },
  {
    id: "zig",
    label: "Zig",
    detect: /\bzig\b|(?<![\p{L}])(?:زيج|زيغ)(?![\p{L}])/iu,
    anchors: [
      [/zig|زيج|زيغ/iu, "Zig"],
      [/(?:build\.zig|main\.zig)/iu, "بنية zig"],
      [/(?:اختبار|test)/iu, "اختبارات"],
    ],
    buildCommand: "zig build",
    serveCommand: undefined,
    defaultPort: 8080,
    evidence: /(?:zig\s+(?:build|test|run)|expectEqual|std\.testing|exit\s*(?:code\s*)?0)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (Zig — build.zig وsrc/main.zig، والاختبارات كتل test مدمجة يقيسها zig test)\n\n` +
      sprint("سبرنت 1 — الهيكل", "build.zig بأسلوب 0.16 حرفياً: pub fn build(b: *std.Build) void مع b.addExecutable(.{ .name, .root_module = b.createModule(.{ .root_source_file = b.path(...), .target, .optimize }) })؛ وmain تستلم std.process.Init (فيها .gpa و.minimal.args) والوسائط بArgs.Iterator.initAllocator — لا getArgv ولا GeneralPurposeAllocator (أزيلتا)؛ وunused parameter خطأ تصريف؛ و@intCast يحتاج نوع نتيجة (@as(i32, @intCast(x)))", "zig build ينجح") +
      sprint("سبرنت 2 — منطق المجال", "src/lib.zig بدوال المجال النقية", "zig build ينجح") +
      sprint("سبرنت 3 — اختبارات الوحدات", "كتل test مع std.testing.expectEqual لكل دالة", "zig test src/lib.zig ينجح") +
      sprint("سبرنت 4 — واجهة التشغيل", "main يقرأ الوسائط وينفّذ ويطبع ناتجاً حقيقياً", "zig build run مع مثال يطبع الناتج الصحيح") +
      sprint("سبرنت 5 — الأخطاء", "error unions وdefer للتحرير بلا unreachable في الإنتاج", "zig test يمرّ باختبار حالة خطأ") +
      sprint("سبرنت 6 — التكامل", "اختبار يشغّل المنطق كاملاً على مثال حقيقي", "zig test src/lib.zig ينجح كاملاً") +
      sprint("سبرنت 7 — الإقفال", "المشروع كله", "zig build ثم zig test src/lib.zig بنجاح كامل وتشغيل الثنائي بإيصال exit 0") +
      handoffTail,
  },
  {
    id: "wasm",
    label: "WebAssembly (AssemblyScript)",
    detect: /webassembly|\bwasm\b|assemblyscript|(?<![\p{L}])(?:ويب\s*أسمبلي|واسم)(?![\p{L}])/iu,
    anchors: [
      [/webassembly|wasm|assemblyscript|أسمبلي|واسم/iu, "WebAssembly"],
      [/(?:asc|assembly|node)/iu, "عدّة AssemblyScript/Node"],
      [/(?:اختبار|test)/iu, "اختبارات"],
    ],
    buildCommand: "npm run asbuild",
    serveCommand: undefined,
    defaultPort: 8080,
    evidence: /(?:npm\s+(?:(?:--filter|-F|--workspace|-w)(?:=\S+|\s+\S+)\s+)*(?:run\s+)?(?:asbuild|test)|\.wasm|WebAssembly\.instantiate|node\s+\S+\.m?js|exit\s*(?:code\s*)?0)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (WebAssembly عبر AssemblyScript — asc يصرّف assembly/index.ts إلى build/release.wasm وNode يحمّله ويقيسه)\n\n` +
      sprint("سبرنت 1 — الهيكل", "package.json بassemblyscript وسكربت asbuild، وassembly/index.ts بدالة مصدَّرة", "npm run asbuild ينجح ويُخرج build/release.wasm") +
      sprint("سبرنت 2 — منطق المجال", "دوال المجال في assembly/index.ts بأنواع i32/f64 صريحة", "npm run asbuild ينجح") +
      sprint("سبرنت 3 — المحمّل", "loader.mjs يحمّل الـwasm بWebAssembly.instantiate مع بيئة { env: { abort } } ويصدّر دواله؛ مقيس 2026-08-31: معاملات i64 تستقبل BigInt في JS ومعاملات i32 تستقبل Number — والناتج i64 يعود BigInt (55n)؛ اقرأ الملف بمسارٍ نسبيٍّ لمجلد المشروع لأن البوابات تشغّل من جذره؛ وإن نصّ الهدف على طباعة خرجٍ بعينه فاطبعه حرفياً ثم قِسه — رمز الخروج 0 وحده ليس دليلاً على السلوك", "node loader.mjs يستدعي دالة ويطبع ناتجها") +
      sprint("سبرنت 4 — الاختبارات", "test.mjs يستدعي كل دالة مصدَّرة بassert نجاحاً وحدوداً", "npm test ينجح بexit 0") +
      sprint("سبرنت 5 — الحدود", "أصفار وسوالب وقيم كبيرة", "npm test يمرّ باختبارات الحدود") +
      sprint("سبرنت 6 — الأداء", "قياس زمن دالة رئيسة على مدخل كبير", "node bench.mjs يطبع زمناً مقيساً") +
      sprint("سبرنت 7 — الإقفال", "المشروع كله", "npm run asbuild ثم npm test بنجاح كامل وnode loader.mjs بإيصال exit 0") +
      handoffTail,
  },
  {
    id: "csharp",
    label: "C# (.NET)",
    detect: /c#|csharp|سي\s*شارب|\.net\b|dotnet/iu,
    anchors: [
      [/c#|csharp|سي\s*شارب|dotnet|\.net/iu, "C#/.NET"],
      [/(?:dotnet|csproj)/iu, "عدّة dotnet"],
      [/(?:اختبار|test|xunit)/iu, "اختبارات"],
    ],
    buildCommand: "dotnet build",
    serveCommand: undefined,
    defaultPort: 8080,
    evidence: /(?:dotnet\s+(?:build|test|run)|xunit|Assert\.|exit\s*(?:code\s*)?0)/giu,
    template: (goal) =>
      `# خطة سبرنتات ${goal} (C# · .NET 9 — مشروع console في App/ واختبارات xunit في App.Tests/ يجمعهما sln، وdotnet هو المقياس)\n\n` +
      sprint("سبرنت 1 — الهيكل", "App/App.csproj وProgram.cs يعمل وsln يجمع المشاريع", "dotnet build ينجح") +
      sprint("سبرنت 2 — منطق المجال", "App/Lib.cs بدوال المجال النقية", "dotnet build ينجح") +
      sprint("سبرنت 3 — اختبارات الوحدات", "App.Tests بxunit وAssert لكل دالة نجاحاً وحدوداً", "dotnet test ينجح") +
      sprint("سبرنت 4 — واجهة التشغيل", "Program يقرأ args وينفّذ ويطبع ناتجاً حقيقياً", "dotnet run --project App مع مثال يطبع الناتج الصحيح") +
      sprint("سبرنت 5 — الأخطاء", "استثناءات مسمّاة وexit codes صحيحة", "dotnet test يمرّ باختبار حالة خطأ") +
      sprint("سبرنت 6 — التغطية", "اختبار لكل مسار منطقي رئيس", "dotnet test ينجح كاملاً") +
      sprint("سبرنت 7 — الإقفال", "المشروع كله", "dotnet build ثم dotnet test بنجاح كامل وdotnet run بإيصال exit 0") +
      handoffTail,
  },
]

const NODE_FALLBACK = STACKS[0] // Next افتراضاً للمواقع، لأنه الأكثر طلباً عندنا.

/** يكتشف الحزمة من نصّ الخطة/الهدف. الأكثر تخصيصاً يفوز (Vite قبل Next لو ذُكرا). */
export function detectStack(text: string): StackProfile {
  // ترتيب التخصيص: اللغات المسمّاة أولاً، ثم fastify/vite/static، وnext آخراً.
  for (const id of ["wasm", "zig", "flutter", "php", "rust", "csharp", "cpp", "c", "go", "python", "fastify", "vite-react", "static-html", "next"]) {
    const s = STACKS.find((p) => p.id === id)!
    if (s.detect.test(text)) return s
  }
  return NODE_FALLBACK
}

export const stackById = (id: string): StackProfile | undefined => STACKS.find((s) => s.id === id)

/** مصدر اكتشاف الحزمة: المستودع الحيّ يفوق النثر.
 *
 * قيس 2026-09-02 (جولة إيدو جلوبال): خطةُ مشروع Next داخل pnpm workspace
 * اكتُشفت «AssemblyScript» لأن «واسم» طابقت داخل كلمة عربية، فرُفضت خطةٌ
 * صحيحة حقبةً بعد حقبة. مشروعٌ قائم يملك ملفات بيان — تُقرأ هي لا النثر؛
 * النثر يبقى للمشروع الجديد الفارغ. */
export interface StackDetection { readonly stack: StackProfile; readonly source: "repo" | "text" }

const readManifest = (path: string): string | undefined => {
  try { return existsSync(path) ? readFileSync(path, "utf-8") : undefined } catch { return undefined }
}

/** package.json الجذر ومساحات العمل من مستوى واحد (apps/*, packages/*). */
const packageManifests = (projectDir: string): string[] => {
  const found: string[] = []
  const root = readManifest(join(projectDir, "package.json"))
  if (root !== undefined) found.push(root)
  for (const ws of ["apps", "packages"]) {
    const dir = join(projectDir, ws)
    if (!existsSync(dir)) continue
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const manifest = readManifest(join(dir, entry.name, "package.json"))
        if (manifest !== undefined) found.push(manifest)
      }
    } catch { /* مجلد غير مقروء — يُتجاوز */ }
  }
  return found
}

export function detectStackForProject(projectDir: string, text: string): StackDetection {
  const repo = (id: string): StackDetection => ({ stack: stackById(id) ?? NODE_FALLBACK, source: "repo" })
  if (existsSync(join(projectDir, "Cargo.toml"))) return repo("rust")
  if (existsSync(join(projectDir, "go.mod"))) return repo("go")
  if (existsSync(join(projectDir, "pubspec.yaml"))) return repo("flutter")
  if (existsSync(join(projectDir, "build.zig"))) return repo("zig")
  if (existsSync(join(projectDir, "composer.json"))) return repo("php")
  if (existsSync(join(projectDir, "pyproject.toml")) || existsSync(join(projectDir, "requirements.txt"))) return repo("python")
  const manifests = packageManifests(projectDir)
  if (manifests.length > 0) {
    const deps = manifests.join("\n")
    if (/"assemblyscript"\s*:/u.test(deps)) return repo("wasm")
    if (/"next"\s*:/u.test(deps)) return repo("next")
    if (/"vite"\s*:/u.test(deps)) return repo("vite-react")
    if (/"fastify"\s*:/u.test(deps)) return repo("fastify")
    // مستودع Node بلا إطارٍ مميَّز: الافتراض Node/Next من البيان لا من النثر.
    return { stack: NODE_FALLBACK, source: "repo" }
  }
  return { stack: detectStack(text), source: "text" }
}
