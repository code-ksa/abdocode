# Ralph loop — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `ralph-loop` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/ralph-loop` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill ralph-loop/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (0)

- (لا مهاراتٍ مستقلّة في الأصل)

## الأوامرُ المنقولة مهاراتٍ (3)

- /cancel-ralph ⇦ `/skill ralph-loop/cmd-cancel-ralph` — Cancel active Ralph Loop
- /help ⇦ `/skill ralph-loop/cmd-help` — Explain Ralph Loop plugin and available commands
- /ralph-loop ⇦ `/skill ralph-loop/cmd-ralph-loop` — Start Ralph Loop in current session

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- الخطّافات (Stop): عبدو كود لا يشغّل تنفيذاً مؤجَّلاً بلا موافقة — تُستبدل ببوّابات القبول والدروس.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
