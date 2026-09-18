# PR review toolkit — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `pr-review-kit` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/pr-review-toolkit` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill pr-review-kit/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (0)

- (لا مهاراتٍ مستقلّة في الأصل)

## الأوامرُ المنقولة مهاراتٍ (1)

- /review-pr ⇦ `/skill pr-review-kit/cmd-review-pr` — Comprehensive PR review using specialized agents

## الوكلاء (6)

- `code-reviewer` (أدوات: read, list, glob, grep) — نصُّه الكامل `/skill pr-review-kit/agent-code-reviewer`، وملفُّه `agents/code-reviewer.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate code-reviewer :: <المهمّة>`
- `code-simplifier` (أدوات: read, list, glob, grep) — نصُّه الكامل `/skill pr-review-kit/agent-code-simplifier`، وملفُّه `agents/code-simplifier.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate code-simplifier :: <المهمّة>`
- `comment-analyzer` (أدوات: read, list, glob, grep) — نصُّه الكامل `/skill pr-review-kit/agent-comment-analyzer`، وملفُّه `agents/comment-analyzer.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate comment-analyzer :: <المهمّة>`
- `pr-test-analyzer` (أدوات: read, list, glob, grep) — نصُّه الكامل `/skill pr-review-kit/agent-pr-test-analyzer`، وملفُّه `agents/pr-test-analyzer.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate pr-test-analyzer :: <المهمّة>`
- `silent-failure-hunter` (أدوات: read, list, glob, grep) — نصُّه الكامل `/skill pr-review-kit/agent-silent-failure-hunter`، وملفُّه `agents/silent-failure-hunter.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate silent-failure-hunter :: <المهمّة>`
- `type-design-analyzer` (أدوات: read, list, glob, grep) — نصُّه الكامل `/skill pr-review-kit/agent-type-design-analyzer`، وملفُّه `agents/type-design-analyzer.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate type-design-analyzer :: <المهمّة>`

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
