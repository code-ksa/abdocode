# الحزمُ المضمَّنة مع عبدو كود — `extensions/`

هذا خطُّ **المنتج** (بوّابةُ الخطّين تتخطّاه): ما يُشحن مع التطبيق فوق النواة المفتوحة المعمار.

| المجلّد | ما فيه |
|---|---|
| `bundled/<id>/` | حزمةٌ بعقد سطح المكتب: `abdocode-extension.json` (الحقولُ الخمسة) + `skills/<name>/SKILL.md` + `LICENSE` + `NOTICE.md` + `FEATURES.md` (ميزاتُها المثبَتة) + `agents/*.agent.md` حيث وُجد وكلاء |
| `overlays/<id>/skills/` | مهاراتٌ من تأليفنا تُدمج فوق المنقول عند التوليد (أصلٌ فارغٌ أو مهاراتٌ لا مصدرَ عامّاً لها: morning، import-memory، learn…) |
| `test/bundled-extensions.test.ts` | عقدُ الاستيراد على كلّ حزمة: المانيفست، المهارات (≤64KB، اسمٌ صالح)، لا اعتمادَ يشبهه (حارسا المحرّك والمستورِد)، لا اسمَ منتجٍ أصليّ في النثر خارج سطور الأصل، الرخصةُ والإشعار |
| `bundled/PORT-REPORT.md` | تقريرُ آخر توليد: العدُّ لكلّ حزمة وما رُفض لرخصته |

## التوليد

```bash
node scripts/port-plugins.mjs --upstream <مجلّد النسخ المثبّتة> --out extensions/bundled
bun test extensions/test/bundled-extensions.test.ts
```

المصادرُ (مثبّتةٌ على SHA في التقرير): `anthropics/claude-plugins-official` (الإضافاتُ التطويرية، Apache-2.0)،
`anthropics/knowledge-work-plugins` (إضافاتُ العمل وpdf-viewer، Apache-2.0)، `anthropics/skills` (المهاراتُ، Apache-2.0 لكلٍّ).
ما رخصتُه ملكيّة **لا يُنقل**: `claude-security` (استُبدل بأصلنا `abdo-security`)، ومهاراتُ docx/pdf/pptx/xlsx.

## كيف تصل المستخدم

1. `packages/desktop/scripts/prepare.ts` ينسخ `bundled/` إلى `payload/extensions/bundled` فتُشحن مع التطبيق.
2. المحرّك يعيدها بإطار `extensions-bundled` (يقرؤها من جوار المحرّك أو من جذر المستودع أو `ABDO_BUNDLED_EXTENSIONS`).
3. الإعدادات ← الامتدادات ← «المضمَّنة مع عبدو كود» ← **راجع وثبّت** ← تفعيل. التثبيتُ نسخةٌ خاصّة في ملفّ المستخدم، ولا سكربتَ يعمل.
4. بعد التفعيل يرى النموذجُ المهاراتِ في إعلان النظام ويحمّل ما يناسب بأداة `skill <حزمة/مهارة>`، والمستخدم يستعملها بـ`/skill` أو من زرّ «استخدام في الرسالة التالية».

## الالتزام بالرخصة (Apache-2.0)

- `LICENSE` الأصليّ في كلّ حزمة، و`NOTICE.md` يسمّي المستودعَ والـSHA وتاريخَ التعديل ونوعَه.
- كلُّ ملفٍّ عُدِّل يحمل سطرَ تغييرٍ بعد مقدّمته (§4b).
