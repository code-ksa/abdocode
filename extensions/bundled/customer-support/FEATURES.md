# Customer support — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `customer-support` · **النوع**: knowledge-work · **الإصدار**: 1.3.0
- **الأصل**: anthropics/knowledge-work-plugins / `customer-support` @ `1f517b9de47e` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill customer-support/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (5)

- `/skill customer-support/customer-escalation` — Package an escalation for engineering, product, or leadership with full context. Use when a bug needs engineering attention beyond normal support, multiple customers report the same issue, a customer
- `/skill customer-support/customer-research` — Multi-source research on a customer question or topic with source attribution. Use when a customer asks something you need to look up, investigating whether a bug has been reported before, checking wh
- `/skill customer-support/draft-response` — Draft a professional customer-facing response tailored to the situation and relationship. Use when answering a product question, responding to an escalation or outage, delivering bad news like a delay
- `/skill customer-support/kb-article` — Draft a knowledge base article from a resolved issue or common question. Use when a ticket resolution is worth documenting for self-service, the same question keeps coming up, a workaround needs to be
- `/skill customer-support/ticket-triage` — Triage and prioritize a support ticket or customer issue. Use when a new ticket comes in and needs categorization, assigning P1-P4 priority, deciding which team should handle it, or checking whether i

## الأوامرُ المنقولة مهاراتٍ (0)

- (لا أوامر)

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (8)

- **slack** — http https://mcp.slack.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **intercom** — http https://mcp.intercom.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **hubspot** — http https://mcp.hubspot.com/anthropic — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **guru** — http https://mcp.api.getguru.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **atlassian** — http https://mcp.atlassian.com/v1/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **notion** — http https://mcp.notion.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **google calendar** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **gmail** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
