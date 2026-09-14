# Explanatory output style — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `explain-style` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/explanatory-output-style` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill explain-style/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (1)

- `/skill explain-style/explanatory-style` — Explanatory output style — while doing the task, add short "Insight" notes that explain why an implementation choice was made, which codebase pattern it follows, and what trade-off it accepts. Use whe (أصلُ عبدو كود)

## الأوامرُ المنقولة مهاراتٍ (0)

- (لا أوامر)

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- الخطّافات (SessionStart): عبدو كود لا يشغّل تنفيذاً مؤجَّلاً بلا موافقة — تُستبدل ببوّابات القبول والدروس.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
