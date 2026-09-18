# Hookify — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `hookify` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/hookify` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill hookify/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (1)

- `/skill hookify/writing-hookify-rules` — This skill should be used when the user asks to "create a hookify rule", "write a hook rule", "configure hookify", "add a hookify rule", or needs guidance on hookify rule syntax and patterns.

## الأوامرُ المنقولة مهاراتٍ (4)

- /configure ⇦ `/skill hookify/cmd-configure` — Enable or disable hookify rules interactively
- /help ⇦ `/skill hookify/cmd-help` — Get help with the hookify plugin
- /hookify ⇦ `/skill hookify/cmd-hookify` — Create hooks to prevent unwanted behaviors from conversation analysis or explicit instructions
- /list ⇦ `/skill hookify/cmd-list` — List all configured hookify rules

## الوكلاء (1)

- `conversation-analyzer` (أدوات: read, grep) — نصُّه الكامل `/skill hookify/agent-conversation-analyzer`، وملفُّه `agents/conversation-analyzer.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate conversation-analyzer :: <المهمّة>`

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- الخطّافات (PreToolUse, PostToolUse, Stop, UserPromptSubmit): عبدو كود لا يشغّل تنفيذاً مؤجَّلاً بلا موافقة — تُستبدل ببوّابات القبول والدروس.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
