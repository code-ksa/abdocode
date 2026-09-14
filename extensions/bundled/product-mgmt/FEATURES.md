# Product management — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `product-mgmt` · **النوع**: knowledge-work · **الإصدار**: 1.2.0
- **الأصل**: anthropics/knowledge-work-plugins / `product-management` @ `1f517b9de47e` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill product-mgmt/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (8)

- `/skill product-mgmt/competitive-brief` — Create a competitive analysis brief for one or more competitors or a feature area. Use when informing product strategy or feature prioritization, building sales battle cards, prepping board or investo
- `/skill product-mgmt/metrics-review` — Review and analyze product metrics with trend analysis and actionable insights. Use when running a weekly, monthly, or quarterly metrics review, investigating a sudden spike or drop, comparing perform
- `/skill product-mgmt/product-brainstorming` — Brainstorm product ideas, explore problem spaces, and challenge assumptions as a thinking partner. Use when exploring a new opportunity, generating solutions to a product problem, stress-testing an id
- `/skill product-mgmt/roadmap-update` — Update, create, or reprioritize your product roadmap. Use when adding a new initiative and deciding what moves to make room, shifting priorities after new information comes in, moving timelines due to
- `/skill product-mgmt/sprint-planning` — Plan a sprint — scope work, estimate capacity, set goals, and draft a sprint plan. Use when kicking off a new sprint, sizing a backlog against team availability (accounting for PTO and meetings), deci
- `/skill product-mgmt/stakeholder-update` — Generate a stakeholder update tailored to audience and cadence. Use when writing a weekly or monthly status for leadership, announcing a launch, escalating a risk or blocker, or translating the same p
- `/skill product-mgmt/synthesize-research` — Synthesize user research from interviews, surveys, and feedback into structured insights. Use when you have a pile of interview notes, survey responses, or support tickets to make sense of, need to ex
- `/skill product-mgmt/write-spec` — Write a feature spec or PRD from a problem statement or feature idea. Use when turning a vague idea or user request into a structured document, scoping a feature with goals and non-goals, defining suc

## الأوامرُ المنقولة مهاراتٍ (1)

- /brainstorm ⇦ `/skill product-mgmt/cmd-brainstorm` — Brainstorm a product idea, problem space, or strategic question with a sharp thinking partner

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (16)

- **slack** — http https://mcp.slack.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **linear** — http https://mcp.linear.app/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **asana** — http https://mcp.asana.com/v2/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **monday** — http https://mcp.monday.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **clickup** — http https://mcp.clickup.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **atlassian** — http https://mcp.atlassian.com/v1/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **notion** — http https://mcp.notion.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **figma** — http https://mcp.figma.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **amplitude** — http https://mcp.amplitude.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **amplitude-eu** — http https://mcp.eu.amplitude.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **pendo** — http https://app.pendo.io/mcp/v0/shttp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **intercom** — http https://mcp.intercom.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **fireflies** — http https://api.fireflies.ai/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **google calendar** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **gmail** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **similarweb** — http https://mcp.similarweb.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
