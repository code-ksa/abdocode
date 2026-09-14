# PDF viewer — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `pdf-viewer` · **النوع**: knowledge-work · **الإصدار**: 0.2.0
- **الأصل**: anthropics/knowledge-work-plugins / `pdf-viewer` @ `1f517b9de47e` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill pdf-viewer/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (1)

- `/skill pdf-viewer/view-pdf` — Interactive PDF viewer. Use when the user wants to open, show, or view a PDF and collaborate on it visually — annotate, highlight, stamp, fill form fields, place signature/initials, or review markup t

## الأوامرُ المنقولة مهاراتٍ (4)

- /annotate ⇦ `/skill pdf-viewer/cmd-annotate` — Collaboratively annotate a PDF — propose markup, review together, iterate
- /fill-form ⇦ `/skill pdf-viewer/cmd-fill-form` — Fill PDF form fields interactively with live visual feedback
- /open ⇦ `/skill pdf-viewer/cmd-open` — Open a PDF in the interactive viewer
- /sign ⇦ `/skill pdf-viewer/cmd-sign` — Place a signature or initials image on a PDF

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (1)

- **pdf** — stdio `npx -y @modelcontextprotocol/server-pdf --stdio` — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
