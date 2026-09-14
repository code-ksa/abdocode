# Agent SDK dev — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `agent-sdk-dev` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/agent-sdk-dev` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill agent-sdk-dev/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (0)

- (لا مهاراتٍ مستقلّة في الأصل)

## الأوامرُ المنقولة مهاراتٍ (1)

- /new-sdk-app ⇦ `/skill agent-sdk-dev/cmd-new-sdk-app` — Create and setup a new Claude Agent SDK application

## الوكلاء (2)

- `agent-sdk-verifier-py` (أدوات: read, list, glob, grep) — نصُّه الكامل `/skill agent-sdk-dev/agent-agent-sdk-verifier-py`، وملفُّه `agents/agent-sdk-verifier-py.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate agent-sdk-verifier-py :: <المهمّة>`
- `agent-sdk-verifier-ts` (أدوات: read, list, glob, grep) — نصُّه الكامل `/skill agent-sdk-dev/agent-agent-sdk-verifier-ts`، وملفُّه `agents/agent-sdk-verifier-ts.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate agent-sdk-verifier-ts :: <المهمّة>`

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
