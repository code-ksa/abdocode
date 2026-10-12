# Abdo Code Bridge — Privacy Policy / سياسة الخصوصية

_Last updated: 2026-10-10 (version 0.7.0) · Publisher: TechnologyKSA (Abdo Code)_

## English

**What the extension does.** Abdo Code Bridge connects the Abdo Code desktop application running on your own computer to the browser tab you are currently viewing. On the application's request it can read the page (text, links, form fields, computed styles), open http/https links you asked for, click, type into non-credential fields, press keys, scroll, capture a screenshot of the visible tab or of the whole page, save a copy of the page (its HTML and the stylesheet and script files the page itself loads) as a design reference, and read the tab's developer console and network request list (method, URL, status, timing).

**Data accessed.** Only the content, URL and title of the **active tab**, and only **when a command is issued**. Console and network reading starts only when the application asks for it, lasts at most ten minutes after the last request, and the browser shows its debugging notice the whole time; tokens found in URLs and messages (access tokens, keys, Bearer values) are masked before the text reaches the application. To copy a page, the extension downloads the stylesheet and script files that page already uses, from the same servers, as your browser does. The extension never reads passwords: fields recognised as credentials are refused and handed back to you to type yourself.

**Where data goes.** Exclusively to the Abdo Code application on the same machine, over a local socket bound to `127.0.0.1`. Nothing is transmitted to the developer, to Google, or to any other server. Screenshots are saved on your own disk by the application and never uploaded by the extension.

**Store declarations.** Because the active tab's content and URL leave the browser (to the local application), the Firefox package declares `data_collection_permissions` as `websiteContent` and `browsingActivity`, and the Chrome Web Store and Edge listings disclose the same two categories. Nothing else is collected.

**Storage.** The extension stores two values in browser storage: the local port and the pairing token you pasted. It does not store page content, history, or cookies.

**Third parties, tracking, sale of data.** None. No analytics, no advertising, no data sale or sharing.

**Your controls.** Remove the token or uninstall the extension at any time; disconnect from Abdo Code → Settings → Connectors. The browser also shows a notice whenever the extension operates a tab.

**Contact.** technoksaweb@gmail.com

## العربية

**ماذا تفعل الإضافة.** تصل تطبيق عبدو كود العامل على جهازك بالتبويب الذي تراه الآن. بطلب التطبيق تقرأ الصفحة (نصّاً وروابط وحقولاً وأنماطاً)، وتفتح روابط http/https التي طلبتها، وتنقر، وتكتب في الحقول غير السرّية، وتضغط مفاتيح، وتمرّر، وتلتقط لقطةً للتبويب الظاهر أو للصفحة كاملةً، وتحفظ نسخةً من الصفحة (HTML وملفّات الأنماط والسكربتات التي تحمّلها الصفحة نفسها) مرجعاً للتصميم، وتقرأ كونسول التبويب وقائمة طلبات شبكته (الطريقة والرابط والحالة والزمن).

**البيانات التي تصل إليها.** محتوى **التبويب الفعّال** ورابطه وعنوانه فقط، و**عند صدور أمرٍ فقط**. قراءةُ الكونسول والشبكة لا تبدأ إلا بطلب التطبيق، وتنتهي بعد عشر دقائق من آخر طلب، والمتصفّح يُظهر إشعار التنقيح طوالها؛ والرموزُ في الروابط والرسائل (رموز الدخول والمفاتيح وقيم Bearer) تُحجب قبل أن تصل التطبيق. ولنسخ صفحةٍ تنزّل الإضافةُ ملفّات الأنماط والسكربتات التي تستعملها الصفحة نفسها، من خوادمها، كما يفعل متصفّحك. لا تقرأ كلمات المرور أبداً: حقول الاعتماد تُرفض وتُسلَّم إليك لتكتبها بيدك.

**إلى أين تذهب البيانات.** إلى تطبيق عبدو كود على الجهاز نفسه حصراً عبر مقبسٍ محلّيّ على `127.0.0.1`. لا يُرسل شيء إلى تكنولوجيا السعودية ولا إلى أيّ خادم. اللقطات يحفظها التطبيق على قرصك ولا ترفعها الإضافة.

**التخزين.** قيمتان فقط: المنفذ المحلّيّ ورمز الاقتران. لا محتوى صفحات ولا سجلّ تصفّح ولا كوكيز.

**أطراف ثالثة أو تتبّع أو بيع بيانات.** لا شيء من ذلك.

**تحكّمك.** احذف الرمز أو أزل الإضافة متى شئت؛ أو افصل من عبدو كود ← الإعدادات ← الموصّلات. والمتصفّح يُعلمك كلّما شغّلت الإضافة تبويباً.

**التواصل.** technoksaweb@gmail.com
