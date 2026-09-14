# ABDO.md management — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `abdo-md-mgmt` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/claude-md-management` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill abdo-md-mgmt/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (1)

- `/skill abdo-md-mgmt/claude-md-improver` — Audit and improve CLAUDE.md files in repositories. Use when user asks to check, audit, update, improve, or fix CLAUDE.md files. Scans for all CLAUDE.md files, evaluates quality against templates, outp

## الأوامرُ المنقولة مهاراتٍ (1)

- /revise-claude-md ⇦ `/skill abdo-md-mgmt/cmd-revise-claude-md` — Update CLAUDE.md with learnings from this session

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
