# Rust analyzer LSP — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `rust-lsp` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/rust-analyzer-lsp` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill rust-lsp/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (1)

- `/skill rust-lsp/rust-analyzer-setup` — Set up rust-analyzer as the Rust language server for an Abdo Code project — install, verify, and read diagnostics, definitions and references from it while working on Rust code. (أصلُ عبدو كود)

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
