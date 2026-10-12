---
name: node-24
description: تثبيتُ Node.js 24 أو الترقيةُ إليه على أوبونتو أو ويندوز، وتثبيتُ الإصدار في المشروع (engines و.nvmrc)، والتحقّقُ بالبناء والاختبارات بعد الترقية. استعملها حين يطلب المستخدم Node 24 أو يفشل بناءٌ بسبب إصدار Node.
---

# Node 24 — ثبّت، ثبّت الإصدار في المشروع، أثبت

## 1. ما المثبَّت الآن؟

- محلّياً: `run node -v; npm -v` — وعلى الخادم: `server run <اسم> -- "node -v; npm -v; which node"`.
- اقرأ `package.json` (حقل `engines`) و`.nvmrc` إن وُجدا، وملفَّ القفل: الترقيةُ تمسّ كلَّ ما بُني بإصدارٍ سابق.

## 2. التثبيت

**أوبونتو (الخادم):** من مستودع NodeSource الرسميّ للإصدار 24، ثمّ `node -v` يجب أن يبدأ بـ`v24.`:

```
server run <اسم> -- "curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh && sudo -E bash /tmp/nodesource_setup.sh && sudo apt-get install -y nodejs && node -v"
```

- لا تشغّل سكربتاً من الشبكة عبر أنبوبٍ مباشرةً إلى bash؛ نزّله ملفّاً ثمّ شغّله (كما أعلاه) كي يُقرأ إن لزم.
- خادمٌ عليه عمليّاتٌ حيّة: الترقيةُ تُعيد تشغيلَها على الإصدار الجديد عند أوّل إعادة تشغيل — قل ذلك للمستخدم واطلب موافقته قبل الترقية على الإنتاج.

**ويندوز (جهاز التطوير):** `run winget install --id OpenJS.NodeJS.LTS -e` أو nvm-windows (`nvm install 24 && nvm use 24`) إن كان مثبّتاً. افتح طرفيّةً جديدة ثمّ `node -v`.

## 3. ثبّت الإصدار في المشروع

- `package.json`: `"engines": { "node": ">=24 <25" }` — وأضفه فقط إن كان المشروع يحتاجه فعلاً.
- `.nvmrc` بسطرٍ واحد: `24`.
- في Dockerfile: `FROM node:24-bookworm-slim` بدل وسمٍ عائم مثل `latest`.

## 4. أثبت أنّ الترقية سليمة

1. `run npm ci` (لا `npm install`): ملفُّ القفل هو العقد.
2. `run npm run build` ثمّ `run npm test` — الاثنان بعد الترقية، لا قبلها.
3. حزمٌ أصليّة (native addons مثل `better-sqlite3`, `sharp`, `bcrypt`): خطأ `NODE_MODULE_VERSION` يعني أنّها بُنيت بإصدارٍ آخر ⇦ `npm rebuild` أو حذفُ `node_modules` وإعادةُ `npm ci` (موافقةٌ قبل الحذف).
4. اذكر في التسليم: الإصدارُ قبل وبعد، والأوامرُ الثلاثة ونتيجةُ كلٍّ منها.
