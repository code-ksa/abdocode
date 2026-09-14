# Operations — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `operations` · **النوع**: knowledge-work · **الإصدار**: 1.3.0
- **الأصل**: anthropics/knowledge-work-plugins / `operations` @ `1f517b9de47e` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill operations/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (9)

- `/skill operations/capacity-plan` — Plan resource capacity — workload analysis and utilization forecasting. Use when heading into quarterly planning, the team feels overallocated and you need the numbers, deciding whether to hire or dep
- `/skill operations/change-request` — Create a change management request with impact analysis and rollback plan. Use when proposing a system or process change that needs approval, preparing a change record for CAB review, documenting risk
- `/skill operations/compliance-tracking` — Track compliance requirements and audit readiness. Trigger with "compliance", "audit prep", "SOC 2", "ISO 27001", "GDPR", "regulatory requirement", or when the user needs help tracking, preparing for,
- `/skill operations/process-doc` — Document a business process — flowcharts, RACI, and SOPs. Use when formalizing a process that lives in someone's head, building a RACI to clarify who owns what, writing an SOP for a handoff or audit,
- `/skill operations/process-optimization` — Analyze and improve business processes. Trigger with "this process is slow", "how can we improve", "streamline this workflow", "too many steps", "bottleneck", or when the user describes an inefficient
- `/skill operations/risk-assessment` — Identify, assess, and mitigate operational risks. Trigger with "what are the risks", "risk assessment", "risk register", "what could go wrong", or when the user is evaluating risks associated with a p
- `/skill operations/runbook` — Create or update an operational runbook for a recurring task or procedure. Use when documenting a task that on-call or ops needs to run repeatably, turning tribal knowledge into exact step-by-step com
- `/skill operations/status-report` — Generate a status report with KPIs, risks, and action items. Use when writing a weekly or monthly update for leadership, summarizing project health with green/yellow/red status, surfacing risks and de
- `/skill operations/vendor-review` — Evaluate a vendor — cost analysis, risk assessment, and recommendation. Use when reviewing a new vendor proposal, deciding whether to renew or replace a contract, comparing two vendors side-by-side, o

## الأوامرُ المنقولة مهاراتٍ (0)

- (لا أوامر)

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (6)

- **slack** — http https://mcp.slack.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **google calendar** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **gmail** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **notion** — http https://mcp.notion.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **atlassian** — http https://mcp.atlassian.com/v1/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **asana** — http https://mcp.asana.com/v2/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
