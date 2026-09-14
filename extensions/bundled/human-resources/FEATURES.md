# Human resources — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `human-resources` · **النوع**: knowledge-work · **الإصدار**: 1.3.0
- **الأصل**: anthropics/knowledge-work-plugins / `human-resources` @ `1f517b9de47e` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill human-resources/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (9)

- `/skill human-resources/comp-analysis` — Analyze compensation — benchmarking, band placement, and equity modeling. Trigger with "what should we pay a [role]", "is this offer competitive", "model this equity grant", or when uploading comp dat
- `/skill human-resources/draft-offer` — Draft an offer letter with comp details and terms. Use when a candidate is ready for an offer, assembling a total comp package (base, equity, signing bonus), writing the offer letter text itself, or p
- `/skill human-resources/interview-prep` — Create structured interview plans with competency-based questions and scorecards. Trigger with "interview plan for", "interview questions for", "how should we interview", "scorecard for", or when the
- `/skill human-resources/onboarding` — Generate an onboarding checklist and first-week plan for a new hire. Use when someone has a start date coming up, building the pre-start task list (accounts, equipment, buddy), scheduling Day 1 and We
- `/skill human-resources/org-planning` — Headcount planning, org design, and team structure optimization. Trigger with "org planning", "headcount plan", "team structure", "reorg", "who should we hire next", or when the user is thinking about
- `/skill human-resources/people-report` — Generate headcount, attrition, diversity, or org health reports. Use when pulling a headcount snapshot for leadership, analyzing turnover trends by team, preparing diversity representation metrics, or
- `/skill human-resources/performance-review` — Structure a performance review with self-assessment, manager template, and calibration prep. Use when review season kicks off and you need a self-assessment template, writing a manager review for a di
- `/skill human-resources/policy-lookup` — Find and explain company policies in plain language. Trigger with "what's our PTO policy", "can I work remotely from another country", "how do expenses work", or any plain-language question about bene
- `/skill human-resources/recruiting-pipeline` — Track and manage recruiting pipeline stages. Trigger with "recruiting update", "candidate pipeline", "how many candidates", "hiring status", or when the user discusses sourcing, screening, interviewin

## الأوامرُ المنقولة مهاراتٍ (0)

- (لا أوامر)

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (5)

- **slack** — http https://mcp.slack.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **google calendar** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **gmail** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **notion** — http https://mcp.notion.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **atlassian** — http https://mcp.atlassian.com/v1/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
