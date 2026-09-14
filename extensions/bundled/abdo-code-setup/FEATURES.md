# Abdo Code setup — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `abdo-code-setup` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/claude-code-setup` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill abdo-code-setup/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (2)

- `/skill abdo-code-setup/desktop-automation` — Drive any Windows application you were not trained on with `desk`: read the UI tree (`desk ui`), fill and press by reference (`desk set`/`desk press`), dismiss popups, fall back to screenshots + vision only when the app exposes no tree, fill forms from user data, and prove every step by reading the window back. (Original AbdoCode skill, 2026-09-14.)

- `/skill abdo-code-setup/claude-automation-recommender` — Analyze a codebase and recommend Claude Code automations (hooks, subagents, skills, plugins, MCP servers). Use when user asks for automation recommendations, wants to optimize their Claude Code setup,

## الأوامرُ المنقولة مهاراتٍ (0)

- (لا أوامر)

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
