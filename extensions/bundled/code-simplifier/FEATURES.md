# Code simplifier — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `code-simplifier` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/code-simplifier` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill code-simplifier/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (0)

- (لا مهاراتٍ مستقلّة في الأصل)

## الأوامرُ المنقولة مهاراتٍ (0)

- (لا أوامر)

## الوكلاء (1)

- `code-simplifier` (أدوات: read, list, glob, grep) — نصُّه الكامل `/skill code-simplifier/agent-code-simplifier`، وملفُّه `agents/code-simplifier.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate code-simplifier :: <المهمّة>`

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
