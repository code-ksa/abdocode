<p align="center">
  <img src="packages/desktop/src-tauri/icons/icon.png" width="96" alt="AbdoCode">
</p>

<h1 align="center">عبدو كود — AbdoCode</h1>

<p align="center">وكيل برمجة يعمل على جهازك، بنواة Rust صغيرة وحتميّة، ويشتغل مع أيّ نموذج: محلّي على Ollama أو سحابيّ بمفتاحك.</p>

<p align="center">
  <a href="https://github.com/code-ksa/abdocode/releases/latest"><b>⬇ تنزيل أحدث إصدار لويندوز</b></a>
</p>

---

## لماذا صنعته

أنا عبدالرحمن أبو إسماعيل، مؤسّس **تكنولوجيا السعودية** ([technologyksa.com](https://technologyksa.com)) وصانع **مبرمج** ([moparmeg-ksa.com](https://moparmeg-ksa.com)). كنت أحتاج وكيلاً يبني المشاريع فعلاً على جهازي — يكتب، ويشغّل، ويتحقّق من نتيجته بنفسه — ولا يدّعي نجاحاً لم يحدث. لم أجد ما يرضيني، فبنيت عبدو كود.

الفكرة بسيطة: **النموذج يقترح، والنواة تحكم**. كلّ أثر على جهازك يمرّ من بوّابة واحدة، ويُقاس بإيصاله لا بكلام النموذج.

## ماذا يفعل

- يكتب ويعدّل ويشغّل داخل مشروعك، مع معاينة كلّ تغيير قبل تطبيقه ونقطة رجوع لكلّ دور.
- يعمل مع النماذج الصغيرة والكبيرة سواء: القضبان تشتدّ مع الضعيف وترقّ مع القويّ، تلقائيّاً.
- يرى: لقطات المتصفّح، والصور المحفوظة في مشروعك (رندرات، تصاميم) تصل نموذج الرؤية.
- يراجع نفسه: «راجع تغييراتي» تشغّل ثلاث عدسات مستقلّة على فرق الدور قبل أن تثق به.
- متصفّح وكيل مدمج، وإضافة كروم/إيدج للعمل في متصفّحك أنت، وتحكّم عن بُعد من هاتفك على شبكتك المحلّيّة.
- مفاتيحك في خزنة ويندوز (DPAPI) على جهازك، ولا حساب سحابيّ مطلوب.

## التثبيت

1. نزّل `AbdoCode-<الإصدار>-x64-setup.exe` من صفحة [الإصدارات](https://github.com/code-ksa/abdocode/releases/latest).
2. تحقّق من البصمة إن أردت: `SHA256SUMS.txt` في الإصدار نفسه.
3. شغّل المثبّت (يثبَّت للمستخدم الحاليّ، بلا صلاحيّات مدير).
4. افتح الإعدادات ← المزوّدون، واربط نموذجاً: Ollama محلّيّاً، أو مزوّداً سحابيّاً بمفتاحك.

يعمل على ويندوز 10/11 (64-bit). يستحسن وجود Ollama للنماذج المحلّيّة.

## للمطوّرين

المصدر هنا للاطّلاع والبناء المحلّيّ. الأدوات: Bun وRust. تفاصيل البناء والبوّابات في [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

```powershell
bun install --frozen-lockfile
bun run structure
bun run typecheck
```

## الترخيص

عبدو كود مملوك لصاحبه وجميع الحقوق محفوظة. الكود منشور للاطّلاع والاستخدام الشخصيّ، والاستخدام التجاريّ يحتاج ترخيصاً كتابيّاً — التفاصيل في [`LICENSE`](LICENSE) و[`COMMERCIAL.md`](COMMERCIAL.md).

للتواصل: technoksaweb@gmail.com

---

<details>
<summary><b>English</b></summary>

**AbdoCode** is a coding agent that runs on your Windows machine with a small, deterministic Rust kernel. It works with any model — local via Ollama or cloud with your own key — and every effect on your machine goes through one gate and is measured by its receipt, not by what the model says.

Built by **Abdelrahman Abu Ismail**, founder of **TechnologyKSA** and maker of **Mubarmij**. Download the installer from [Releases](https://github.com/code-ksa/abdocode/releases/latest). Source is published for reading and local builds; commercial use requires a written license (see `LICENSE`).

</details>
