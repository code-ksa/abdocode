# Finance — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `finance` · **النوع**: knowledge-work · **الإصدار**: 1.3.0
- **الأصل**: anthropics/knowledge-work-plugins / `finance` @ `1f517b9de47e` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill finance/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (8)

- `/skill finance/audit-support` — Support SOX 404 compliance with control testing methodology, sample selection, and documentation standards. Use when generating testing workpapers, selecting audit samples, classifying control deficie
- `/skill finance/close-management` — Manage the month-end close process with task sequencing, dependencies, and status tracking. Use when planning the close calendar, tracking close progress, identifying blockers, or sequencing close act
- `/skill finance/financial-statements` — Generate financial statements (income statement, balance sheet, cash flow) with period-over-period comparison and variance analysis. Use when preparing a monthly or quarterly P&L, closing the books an
- `/skill finance/journal-entry` — Prepare journal entries with proper debits, credits, and supporting detail. Use when booking month-end accruals (AP, payroll, prepaid), recording depreciation or amortization, posting revenue recognit
- `/skill finance/journal-entry-prep` — Prepare journal entries with proper debits, credits, and supporting documentation for month-end close. Use when booking accruals, prepaid amortization, fixed asset depreciation, payroll entries, reven
- `/skill finance/reconciliation` — Reconcile accounts by comparing GL balances to subledgers, bank statements, or third-party data. Use when performing bank reconciliations, GL-to-subledger recs, intercompany reconciliations, or identi
- `/skill finance/sox-testing` — Generate SOX sample selections, testing workpapers, and control assessments. Use when planning quarterly or annual SOX 404 testing, pulling a sample for a control (revenue, P2P, ITGC, close), building
- `/skill finance/variance-analysis` — Decompose financial variances into drivers with narrative explanations and waterfall analysis. Use when analyzing budget vs. actual, period-over-period changes, revenue or expense variances, or prepar

## الأوامرُ المنقولة مهاراتٍ (0)

- (لا أوامر)

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (6)

- **snowflake** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **databricks** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **bigquery** — http https://bigquery.googleapis.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **slack** — http https://mcp.slack.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **google calendar** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **gmail** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
