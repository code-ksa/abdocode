# إضافة عبدو كود للمتصفّح — التحميل اليدويّ والنشر في المتاجر

> **ما تفعله الإضافة**: تصل عبدو كود (على هذا الجهاز) بتبويبك الحاليّ: تقرأ الصفحة شجرةً نصّية، تفتح روابط
> http/https، تنقر، تكتب في الحقول غير السرّية، تضغط مفاتيح، تمرّر، وتلتقط لقطةً تُحفظ على قرصك. **لا تُرسل شيئاً إلا إلى
> `127.0.0.1`**، ولا تكتب كلمات المرور أبداً (حقول الاعتماد تُسلَّم لك بيدك). كلُّ فعلٍ يمرّ بعقد الموافقة في عبدو كود.

## ١) التحميل اليدويّ (للتجربة الآن)

| المتصفّح | الخطوات |
|---|---|
| **كروم** | `chrome://extensions` ← فعّل **وضع المطوّر** ← **تحميل غير معبّأ** ← اختر مجلّد `dist/unpacked/chrome-edge` (أو `extension/` مباشرة) |
| **إيدج** | `edge://extensions` ← فعّل **وضع المطوّر** ← **تحميل غير معبّأ** ← المجلّد نفسه |
| **سفاري** (ماك فقط) | يحتاج Xcode: `xcrun safari-web-extension-packager ./dist/unpacked/safari --app-name "Abdo Code Bridge" --bundle-identifier sa.example.abdocode.bridge --macos-only --copy-resources --project-location ./safari` ثمّ Safari ← Settings ← Developer ← **Allow unsigned extensions** (يُعاد ضبطه عند إغلاق سفاري) |

ثمّ في عبدو كود: **الإعدادات ← الموصّلات ← «إضافة المتصفّح»** ← **وصّل** ← انسخ الرمز ← افتح نافذة الإضافة (أيقونتها في شريط
الأدوات) ← الصق الرمز ← **حفظ واتصال**. تتحوّل الشارة إلى `on`.

**حدود سفاري (مقيسة من وثائق أبل وMDN)**: لا واجهة `debugger` للإضافات، فالنقر والكتابة تُبعث أحداثاً اصطناعيةً داخل الصفحة
(الإضافة تعلن ذلك في ردّها، وعبدو كود يخبرك)، وسفاري يطلب منك منح كلّ موقعٍ صلاحيةً من شارة الإضافة أوّل مرّة.

## ٢) الحزم الجاهزة للمتاجر

```bash
cd packages/browser-bridge && node scripts/pack.mjs --deliver "%USERPROFILE%\Desktop\AbdoCode-Extensions"
```

| الملفّ | المتجر |
|---|---|
| `dist/abdo-code-bridge-chrome-<v>.zip` | Chrome Web Store |
| `dist/abdo-code-bridge-edge-<v>.zip` | Microsoft Edge Add-ons (الحزمة نفسها) |
| `dist/abdo-code-bridge-safari-<v>.zip` | مادّة المحوّل على ماك (بلا صلاحية `debugger`) |
| `dist/abdo-code-bridge-firefox-<v>.zip` | Firefox Add-ons (AMO): صفحةُ أحداث بدل عامل الخدمة، بلا `debugger`، والمعرّف `abdo-code-bridge@abdocode.io`، وفايرفوكس 140+ (أندرويد 142+) |

## ٣) حسابات المطوّرين — الروابط (مؤكَّدة من الوثائق الرسمية 2026-09-06)

| المتجر | التسجيل | الرسم | الرفع |
|---|---|---|---|
| **Chrome Web Store** | <https://chrome.google.com/webstore/devconsole> (بحساب جوجل؛ البريد لا يتغيّر لاحقاً) | رسمُ تسجيلٍ لمرّةٍ واحدة — «بمبلغٍ تحدّده جوجل» (يظهر عند الدفع؛ المتداول ٥ دولارات) | New item ← ارفع zip ← Store listing ← Privacy ← Distribution ← Test instructions ← Submit for review |
| **Edge Add-ons** | <https://partner.microsoft.com/dashboard/microsoftedge/public/login> (حساب مايكروسوفت؛ حسابٌ فرديّ أسرع من حساب شركة) | **مجّاني** | Create new extension ← ارفع zip ← Properties ← Store listings ← Privacy ← Notes for certification ← Publish |
| **Firefox Add-ons (AMO)** | <https://addons.mozilla.org/developers/> (حساب Mozilla) | **مجّاني** | Submit a New Add-on ← On this site ← ارفع zip ← (قد يُطلب المصدر: الحزمةُ بلا تصغير فلا يلزم) ← الوصف والفئة ← Submit |
| **Safari / App Store** | <https://developer.apple.com/programs/enroll/> ثمّ <https://appstoreconnect.apple.com> | ٩٩ دولاراً سنوياً (يتفاوت بالمنطقة؛ الشركات تحتاج D-U-N-S) | Xcode ← Archive ← App Store Connect ← Review |

### إفصاحُ البيانات (يُطابق المتاجرَ الثلاثة — 2026-10)

- **كروم (سياساتُ 1 أغسطس 2026):** غرضٌ واحد = «يربط التبويبَ النشط بتطبيق عبدو كود على الجهاز نفسِه». في Privacy practices: محتوى الموقع (Website content) ونشاطُ التصفّح (عنوانُ التبويب) — يُرسلان إلى التطبيق المحلّيّ فقط، لا يُباعان ولا يُستعملان لغير الغرض.
- **إيدج:** الإفصاحُ نفسُه في Privacy، ورابطُ `PRIVACY.md`.
- **فايرفوكس:** يُعلَن في المانيفست `data_collection_permissions.required = ["websiteContent", "browsingActivity"]` (AMO يعدّ نقلاً كلَّ ما يغادر المتصفّح ولو إلى 127.0.0.1)، ويظهر للمستخدم عند التثبيت.

## ٤) نصوص المتجر (تُنسخ كما هي)

**الغرض الواحد (Single purpose)** — عربية:
> تتيح لتطبيق عبدو كود، العامل على هذا الجهاز، أن يقرأ التبويب الحاليّ ويعمل فيه بطلبٍ صريحٍ من المستخدم. لا شيء يغادر الجهاز.

English:
> Lets the Abdo Code desktop app, running on this computer, read and operate the user's current tab on the user's explicit request. Nothing is sent off-device.

**تبرير الصلاحيات**:

| الصلاحية | التبرير |
|---|---|
| `debugger` | أحداثُ ماوس وكيبورد موثوقة (مجال Input)، ولقطةُ الصفحة كاملةً (Page.captureScreenshot)، وقراءةُ كونسول التبويب وطلبات شبكته عند طلب المستخدم وحده (أداة devtools — الرموزُ تُحجب قبل أن تصل التطبيق المحلّيّ)؛ لا شيء يغادر الجهاز. |
| `<all_urls>` | الوكيل يعمل على أيّ صفحةٍ **سبق للمستخدم أن فتحها**، ويفتح روابط http/https يطلبها المستخدم؛ لا يمكن حصرها بنطاقاتٍ مسبقة. |
| `scripting` | قراءةُ شجرة العناصر والأنماط المحسوبة والتمرير داخل الصفحة. |
| `storage` | حفظُ منفذ الجسر المحلّيّ والرمز فقط. |
| `tabs` | معرفةُ التبويب الفعّال ونافذته لالتقاط اللقطة (`captureVisibleTab`) ومتابعةِ اكتمال التحميل بعد الفتح. |

**تبرير `debugger` بالإنجليزية** (لحقل المتجر):
> Trusted mouse and keyboard events (Input domain), full-page screenshots (Page.captureScreenshot), and reading the tab's console and network requests only when the user asks (devtools tool — tokens are redacted before they reach the local app). Nothing leaves the device.

**الشيفرة البعيدة (Remote code)**: **لا** — كلُّ الشيفرة داخل الحزمة؛ المقبس المحلّيّ ينقل مفرداتٍ مغلقة (page/look/scroll/open/tap/fill/key/shot) لا شيفرة.

**استخدام البيانات**: تقرأ محتوى التبويب الفعّال ورابطه وعنوانه ولقطته **عند الأمر فقط**؛ الوجهة الوحيدة عبدو كود على `127.0.0.1`؛ لا تخزين لمحتوى الصفحات؛ لا أطراف ثالثة. سياسة الخصوصية في `PRIVACY.md` — **تحتاج رابطاً عامّاً** (مثلاً على موقع تكنولوجيا السعودية) يُلصق في حقل Privacy policy في المتجرين.

**تعليمات الاختبار للمراجعين (Test instructions / Notes for certification)**: الإضافة تعتمد على تطبيق عبدو كود المثبَّت على الجهاز
(يُذكر ذلك في أوّل سطرٍ من الوصف). أرفق رابط تنزيل نسخة Preview موقَّعة + الخطوات: شغّل التطبيق ← الإعدادات ← الموصّلات ←
إضافة المتصفّح ← وصّل ← انسخ الرمز ← الصقه في نافذة الإضافة. بدون التطبيق تُظهر الإضافة «غير متّصل» بتصميمٍ مقصود.

## ٥) موادّ القائمة (تُنتَج قبل الرفع)

- أيقونة المتجر 128×128 PNG (المحتوى 96×96 وسط هامشٍ شفّاف 16 بكسل) — `extension/icons/icon128.png` صالحة كبداية.
- لقطات شاشة 1280×800 (١–٥) بواجهةٍ عربية: النافذة المنبثقة، الشارة `on`، فعلٌ على صفحة.
- بلاطة صغيرة 440×280 (مطلوبة في كروم)، وشعار 300×300 لإيدج، وبلاطة 1400×560 اختيارية.
- وصفٌ مفصَّل لإيدج بين ٢٥٠ و١٠٠٠٠ حرف لكلّ لغة (العربية والإنجليزية في `_locales`).

## ٦) ما قِيسَ ولم يُدَّعَ

- الحزمة تجتاز فحص الجاهزية (`node scripts/pack.mjs --check`): أيقونات ٤ مقاسات، وصفٌ ≤١٣٢ حرفاً، بلا `eval`، بلا وجهةٍ غير محلّية.
- **المراجعة**: صلاحيتا `debugger` و`<all_urls>` تضعان الإضافة في مسار المراجعة المتعمّقة (أيامٌ إلى أسابيع) — متوقَّع، لا عيب.
- **سفاري لم يُجرَّب** على هذا الجهاز (ويندوز بلا Xcode)؛ المسار الاصطناعيّ مكتوبٌ بحسب وثائق MDN/أبل ويُقاس على ماك.

## ٧) النشر الآليّ

`scripts/publish.mjs` يبني الحزم (فايرفوكس بمعرّف القائمة الحيّة `abdo-code-bridge@technologyksa.sa`، slug `abdo-code-bridge`)
ثمّ يرفع وينشر عبر الواجهات الرسمية: **AMO API v5** و**Edge Add-ons API v1.1** و**Chrome Web Store API v2**. الواجهات الثلاث
**تحدّث عنصراً قائماً فقط** — أوّلُ نشرٍ في كلّ متجرٍ يدويٌّ من لوحته.

### المفاتيح التي ينشئها المالك (مرّةً واحدة)

| المتجر | أين تُنشأ | الأسرار |
|---|---|---|
| **فايرفوكس (AMO)** | addons.mozilla.org ← Tools ← **Manage API Keys** ← Generate new credentials | `AMO_JWT_ISSUER` (JWT issuer، بصيغة `user:…`)، `AMO_JWT_SECRET` (JWT secret) |
| **إيدج** | Partner Center ← Microsoft Edge ← **Publish API** ← (Enable the new experience) ← **Create API credentials**؛ ومعرّف المنتج من Extension overview ← Extension identity | `EDGE_CLIENT_ID`، `EDGE_API_KEY` (له تاريخ انتهاء يظهر في الصفحة — يُجدَّد قبله)، `EDGE_PRODUCT_ID` |
| **كروم** | ١) Google Cloud Console: فعّل **Chrome Web Store API** ← OAuth consent screen ← Credentials ← **OAuth client ID** ٢) refresh token بالنطاق `https://www.googleapis.com/auth/chromewebstore` (OAuth Playground بمعرّفك أنت) ٣) معرّف الناشر من Account في لوحة المطوّر ومعرّف العنصر من صفحته — **العنصر يجب أن يوجد في لوحة كروم قبلاً** | `CWS_CLIENT_ID`، `CWS_CLIENT_SECRET`، `CWS_REFRESH_TOKEN`، `CWS_PUBLISHER_ID`، `CWS_EXTENSION_ID` |

⚠️ شاشة موافقة جوجل في وضع **Testing** تُصدر refresh token ينتهي بعد ٧ أيام — انقلها إلى **In production** قبل استخراج الرمز.

### أين توضع

- **أسرار مستودع GitHub** (`code-ksa/abdocode` ← Settings ← Secrets and variables ← Actions) بالأسماء العشرة أعلاه حرفياً؛
  `.github/workflows/bridge-publish.yml` يربطها بمتغيّرات البيئة.
- و/أو **الخزنة المحلّية** عبر ملفٍّ يُفتح للمالك — **لا تُلصق في المحادثة أبداً**. السكربت يقرأ البيئة وحدها، لا يطبع سرّاً
  (كلّ خرجٍ يُقنَّع، حتى ما يعيده المتجر) ولا يكتبه على القرص.
- متجرٌ تنقصه مفاتيحه يُعلَن `skipped: missing <VAR>` ولا يُحسب نجاحاً؛ و`--require-all` يجعل التخطّي فشلاً.

### أمر الإصدار

```bash
# ١) ارفع "version" في extension/manifest.json (والإصدارَ المثبَّت في packages/engine/test/browser-extension-pack.test.ts) وأودِع
# ٢) الوسم يشغّل bridge-publish: يطابق الوسمَ بالمانيفست، يشغّل الاختبارين، ثمّ ينشر في المتاجر الثلاثة
git tag bridge-vX.Y.Z
git push origin bridge-vX.Y.Z
```

- من GitHub يدوياً: Actions ← bridge-publish ← Run workflow (`stores`، و`dry_run` لعرض الطلبات بلا نداء).
- محلّياً: `node scripts/publish.mjs --dry-run` (لا شبكة، الاعتمادات مقنَّعة) ثمّ
  `node scripts/publish.mjs --stores firefox,edge --notes "…"`.
- بعد النشر: AMO تُنشئ النسخة listed وتنتظر المراجعة؛ إيدج `InProgressSubmission` = تقديمٌ سابق ما زال قيد المراجعة
  (انتظر ثمّ أعد)؛ كروم `PENDING_REVIEW`. والإصدار يجب أن يتجاوز المنشور في كلّ متجر.
