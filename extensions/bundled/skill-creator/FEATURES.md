# Skill creator — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `skill-creator` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/skill-creator` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill skill-creator/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (1)

- `/skill skill-creator/skill-creator` — Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill

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
