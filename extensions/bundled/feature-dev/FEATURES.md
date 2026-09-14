# Feature dev — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `feature-dev` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/feature-dev` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill feature-dev/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (0)

- (لا مهاراتٍ مستقلّة في الأصل)

## الأوامرُ المنقولة مهاراتٍ (1)

- /feature-dev ⇦ `/skill feature-dev/cmd-feature-dev` — Guided feature development with codebase understanding and architecture focus

## الوكلاء (3)

- `code-architect` (أدوات: glob, grep, list, read, fetch, search) — نصُّه الكامل `/skill feature-dev/agent-code-architect`، وملفُّه `agents/code-architect.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate code-architect :: <المهمّة>`
- `code-explorer` (أدوات: glob, grep, list, read, fetch, search) — نصُّه الكامل `/skill feature-dev/agent-code-explorer`، وملفُّه `agents/code-explorer.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate code-explorer :: <المهمّة>`
- `code-reviewer` (أدوات: glob, grep, list, read, fetch, search) — نصُّه الكامل `/skill feature-dev/agent-code-reviewer`، وملفُّه `agents/code-reviewer.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate code-reviewer :: <المهمّة>`

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
