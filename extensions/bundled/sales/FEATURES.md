# Sales — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `sales` · **النوع**: knowledge-work · **الإصدار**: 1.3.0
- **الأصل**: anthropics/knowledge-work-plugins / `sales` @ `1f517b9de47e` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill sales/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (9)

- `/skill sales/account-research` — Research a company or person and get actionable sales intel. Works standalone with web search, supercharged when you connect enrichment tools or your CRM. Trigger with "research [company]", "look up [
- `/skill sales/call-prep` — Prepare for a sales call with account context, attendee research, and suggested agenda. Works standalone with user input and web research, supercharged when you connect your CRM, email, chat, or trans
- `/skill sales/call-summary` — Process call notes or a transcript — extract action items, draft follow-up email, generate internal summary. Use when pasting rough notes or a transcript after a discovery, demo, or negotiation call,
- `/skill sales/competitive-intelligence` — Research your competitors and build an interactive battlecard. Outputs an HTML artifact with clickable competitor cards and a comparison matrix. Trigger with "competitive intel", "research competitors
- `/skill sales/create-an-asset` — Generate tailored sales assets (landing pages, decks, one-pagers, workflow demos) from your deal context. Describe your prospect, audience, and goal — get a polished, branded asset ready to share with
- `/skill sales/daily-briefing` — Start your day with a prioritized sales briefing. Works standalone when you tell me your meetings and priorities, supercharged when you connect your calendar, CRM, and email. Trigger with "morning bri
- `/skill sales/draft-outreach` — Research a prospect then draft personalized outreach. Uses web research by default, supercharged with enrichment and CRM. Trigger with "draft outreach to [person/company]", "write cold email to [prosp
- `/skill sales/forecast` — Generate a weighted sales forecast with best/likely/worst scenarios, commit vs. upside breakdown, and gap analysis. Use when preparing a quarterly forecast call, assessing gap-to-quota from a pipeline
- `/skill sales/pipeline-review` — Analyze pipeline health — prioritize deals, flag risks, get a weekly action plan. Use when running a weekly pipeline review, deciding which deals to focus on this week, spotting stale or stuck opportu

## الأوامرُ المنقولة مهاراتٍ (0)

- (لا أوامر)

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (14)

- **slack** — http https://mcp.slack.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **hubspot** — http https://mcp.hubspot.com/anthropic — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **close** — http https://mcp.close.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **monday** — http https://mcp.monday.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **clay** — http https://api.clay.com/v3/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **zoominfo** — http https://mcp.zoominfo.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **notion** — http https://mcp.notion.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **atlassian** — http https://mcp.atlassian.com/v1/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **fireflies** — http https://api.fireflies.ai/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **apollo** — http https://mcp.apollo.io/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **outreach** — http https://api.outreach.io/mcp/ — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **google calendar** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **gmail** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **similarweb** — http https://mcp.similarweb.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
