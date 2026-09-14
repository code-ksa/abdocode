# Commit commands — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `commit-commands` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/commit-commands` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill commit-commands/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (0)

- (لا مهاراتٍ مستقلّة في الأصل)

## الأوامرُ المنقولة مهاراتٍ (3)

- /clean_gone ⇦ `/skill commit-commands/cmd-clean-gone` — Cleans up all git branches marked as [gone] (branches that have been deleted on the remote but still exist locally), including removing associated worktrees.
- /commit-push-pr ⇦ `/skill commit-commands/cmd-commit-push-pr` — Commit, push, and open a PR
- /commit ⇦ `/skill commit-commands/cmd-commit` — Create a git commit

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
