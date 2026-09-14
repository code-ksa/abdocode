# Enterprise search — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `ent-search` · **النوع**: knowledge-work · **الإصدار**: 1.3.0
- **الأصل**: anthropics/knowledge-work-plugins / `enterprise-search` @ `1f517b9de47e` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill ent-search/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (5)

- `/skill ent-search/digest` — Generate a daily or weekly digest of activity across all connected sources. Use when catching up after time away, starting the day and wanting a summary of mentions and action items, or reviewing a we
- `/skill ent-search/knowledge-synthesis` — Combines search results from multiple sources into coherent, deduplicated answers with source attribution. Handles confidence scoring based on freshness and authority, and summarizes large result sets
- `/skill ent-search/search` — Search across all connected sources in one query. Trigger with "find that doc about...", "what did we decide on...", "where was the conversation about...", or when looking for a decision, document, or
- `/skill ent-search/search-strategy` — Query decomposition and multi-source search orchestration. Breaks natural language questions into targeted searches per source, translates queries into source-specific syntax, ranks results by relevan
- `/skill ent-search/source-management` — Manages connected MCP sources for enterprise search. Detects available sources, guides users to connect new ones, handles source priority ordering, and manages rate limiting awareness.

## الأوامرُ المنقولة مهاراتٍ (0)

- (لا أوامر)

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (7)

- **slack** — http https://mcp.slack.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **notion** — http https://mcp.notion.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **guru** — http https://mcp.api.getguru.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **atlassian** — http https://mcp.atlassian.com/v1/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **asana** — http https://mcp.asana.com/v2/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **google calendar** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **gmail** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
