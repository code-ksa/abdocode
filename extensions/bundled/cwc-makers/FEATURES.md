# CWC makers — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `cwc-makers` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/cwc-makers` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill cwc-makers/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (2)

- `/skill cwc-makers/cardputer-buddy` — Iterate on the Cardputer-Adv MicroPython app bundle (Claude Buddy, Snake, Hello) after the device is already provisioned via m5-onboard. Use when the user wants to add a new app, push a single changed
- `/skill cwc-makers/m5-onboard` — End-to-end onboarding for a freshly-plugged-in M5Stack ESP32 device (Cardputer, Cardputer-Adv, Core, CoreS3, Stick) — detect on USB, flash UIFlow 2.0 firmware, and install the Claude Buddy MicroPython

## الأوامرُ المنقولة مهاراتٍ (1)

- /maker-setup ⇦ `/skill cwc-makers/cmd-maker-setup` — Onboard a Code-with-Claude Makers Cardputer — fetch the build-with-claude repo, flash firmware, and install the Claude Buddy apps.

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
