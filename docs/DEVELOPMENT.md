# عبدو كود — دليل التطوير

## الحالة الحالية

- 52 حزمة معرفة في مساحة العمل ومفحوصة ببوابة تركيب آلية.
- الحزم الجديدة مرتبطة بمحرك التكامل وتعمل بسياسة فشل مغلق.
- نواة Rust الحالية تغطي العقود، النواة الأساسية، السجل، الصلاحيات ووقت التشغيل.
- أدوار السياسة والأدوات والأدلة ما زالت في طبقة TypeScript/التكامل، وتحويلها إلى وحدات Rust مستقلة مدرج في خطة التطوير.
- واجهة الويب الموروثة محجوبة عن الإصدار العام إلى أن تنتهي مراجعة محتواها وأصلها بالكامل.

## البناء والتحقق

المتطلّبات: Bun 1.3+، Rust (stable)، وعلى ويندوز Visual Studio Build Tools وWebView2.

```powershell
bun install --frozen-lockfile
bun run structure
bun run typecheck
bun test scripts/composition-gate.test.ts scripts/provenance-surface-gate.test.ts
```

بوّابة المحرّك الكاملة (~2300 اختبار، دقائق):

```powershell
$env:ABDO_TEST_NATIVE_BINARY_DIR = "<repo>\packages\desktop\src-tauri\payload\bin"
bun test packages/engine/test packages/engine-host/test packages/memory/test packages/providers/test packages/tools/test packages/transport-contracts/test packages/browser/test packages/model-gateway/test packages/harness/test
```

بناء المثبّت (يجمّع المحرّك إلى `packages/desktop/src-tauri/payload/` ثمّ Tauri NSIS):

```powershell
bun packages/desktop/scripts/prepare.ts
cd packages/desktop/src-tauri
bunx @tauri-apps/cli build
```

خطة السبرنتات وحالة الربط موثقتان في `docs/ABDOCODE-RUST-SPRINT-PROGRAM.md`، وخريطة تقارب الحزم في `architecture/PACKAGE-CONVERGENCE-52.md`.

## النَّسَب — أفكارٌ مأخوذة، لا كودٌ مستعار

كلُّ ما في هذا المستودع مكتوبٌ هنا. بعضُ الأفكار قُرئت في مشاريعَ مفتوحةٍ ثمّ أُعيدت كتابتُها بطريقتنا وبمفاتيحَ يملكها المشغّل (بلا fork ولا اعتمادٍ ولا مقتطف): من **Pi** (badlogic/pi-mono) فكرةُ إظهار الأدوات بحسب النيّة، وطابورُ كتابة الملفّ الواحد، وتثبيتُ الجلسة عند المزوّد؛ من **Kilo** (Kilo-Org/kilocode) نقاطُ الرجوع لكلّ دور، وحارةُ المراجعة، وسوقُ الإضافات؛ من **Hermes Agent** و**OpenClaw** نزعُ الاعتمادات من بيئة الأبناء، والمساراتُ المحميّة على كلّ أسطح الكتابة، وحجرُ النصّ الوارد، والرفضُ الفوريّ حين لا مُوافِق. الجردُ الكامل بحالة كلّ فكرة (مأخوذة/مرفوضة/مملوكة أصلاً) في `docs/IDEAS-INVENTORY-HERMES-OPENCLAW-20260903.md` و`docs/IDEAS-INVENTORY-MINDSHUB-DSH-20260901.md`؛ وما وُعد به بلا كود يُقال إنّه بلا كود.

## حدود الأمان

لا تُحمّل هذه النسخة إعدادات أو أسرارًا أو قوائم مشاريع داخلية. الأسرار تُمرر صراحة عبر متغيرات `ABDO_SECRET_*` أو عبر مزود محلي يحدده المشغل في `ABDO_VAULT_SCRIPT`. لا يوجد اتصال تلقائي بمستودعات أو خوادم خارجية إلا ما يختاره المشغّل صراحةً (مزوّد النموذج، وثيقة الإصدار على مستودع التوزيع).
