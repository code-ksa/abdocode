# Abdo Code skills — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `abdo-skills` · **النوع**: skills · **الإصدار**: 1.0.0
- **الأصل**: anthropics/skills / `skills/*` @ `41bbe19d1a1a` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill abdo-skills/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (14)

- `/skill abdo-skills/canvas-design` — Create beautiful visual art in .png and .pdf documents using design philosophy. You should use this skill when the user asks to create a poster, piece of art, design, or other static piece. Create ori
- `/skill abdo-skills/web-artifacts-builder` — Suite of tools for creating elaborate, multi-component claude.ai HTML artifacts using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). Use for complex artifacts requiring state manag
- `/skill abdo-skills/mcp-builder` — Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building MCP servers to integrate externa
- `/skill abdo-skills/theme-factory` — Toolkit for styling artifacts with a theme. These artifacts can be slides, docs, reportings, HTML landing pages, etc. There are 10 pre-set themes with colors/fonts that you can apply to any artifact t
- `/skill abdo-skills/brand-guidelines` — Applies Anthropic's official brand colors and typography to any sort of artifact that may benefit from having Anthropic's look-and-feel. Use it when brand colors or style guidelines, visual formatting
- `/skill abdo-skills/internal-comms` — A set of resources to help me write all kinds of internal communications, using the formats that my company likes to use. Claude should use this skill whenever asked to write some sort of internal com
- `/skill abdo-skills/algorithmic-art` — Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. Use this when users request creating art using code, generative art, algorithmic art, flow fields, or
- `/skill abdo-skills/slack-gif-creator` — Knowledge and utilities for creating animated GIFs optimized for Slack. Provides constraints, validation tools, and animation concepts. Use when users request animated GIFs for Slack like "make me a G
- `/skill abdo-skills/skill-creator` — Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill
- `/skill abdo-skills/frontend-design` — Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and making choices that don't read as templated defau
- `/skill abdo-skills/webapp-testing` — Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser l
- `/skill abdo-skills/import-memory` — Import memory from another AI assistant — the user pastes an exported memory or "what you know about me" text (from ChatGPT, Claude, Gemini or notes); turn it into clean, categorised Abdo Code memory  (أصلُ عبدو كود)
- `/skill abdo-skills/learn` — Learn a topic with the user — explain a concept or a piece of this codebase step by step, check understanding with one question per step, and finish with a small exercise that the user can verify by r (أصلُ عبدو كود)
- `/skill abdo-skills/morning` — Morning briefing — start the working day by reading the project's plan and memory, listing what changed since the last session, the gates that are red, and the three next actions, then ask which one t (أصلُ عبدو كود)

## الأوامرُ المنقولة مهاراتٍ (0)

- (لا أوامر)

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.
- الخطوطُ والوسائط الثنائية للأصل لم تُنسخ (canvas-design/slack-gif-creator) — تُنزَّل عند الحاجة من الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
