/**
 * 10-08 — طرقُ النشر تُعرف لكلّ نموذج لا لنموذجٍ يتذكّرها. حين تُفتح عائلةُ الخوادم (نيّةُ نشرٍ أو خادمٍ أو حاوية) يُلحق هذا الموجزُ
 * بالمهارات: الطرقُ الثلاث، ومتى تصلح كلٌّ منها، والفخاخُ المقيسة على ويندوز (محرّكُ Docker مطفأ، {{…}} في PowerShell، WSL بلا sshd
 * وsudo بكلمة مرور). الموجزُ معرفةٌ لا إذن: الموافقاتُ والحرّاسُ كما هي.
 */
export const DEPLOY_ROUTES_BRIEF = [
  "",
  "طرقُ النشر — اختر الأنسبَ للحالة وقِس كلَّ خطوة، ولا تُعلن نشراً لم يُفحص رابطُه:",
  "1) خادمٌ عنده SSH (VPS، Hetzner، DigitalOcean…): server add <اسم> user@host[:port] --path /srv/app ⇦ أضِف المفتاحَ العامّ الذي يعيده مرّةً على الخادم ⇦ server test <اسم> (يقيس node وpm2 وdocker) ⇦ deploy <اسم> --build \"npm ci && npm run build\" --start \"…\" --check <رابط>. الرجوع: deploy <اسم> --rollback.",
  "2) خادمٌ تجريبيّ محلّيّ حين لا خادمَ جاهزاً: **server sandbox <اسم>** يبنيه في نداءٍ واحد (حاويةٌ على 127.0.0.1، مفتاحٌ في الخزنة مثبَّت، ملفٌّ مسجَّل، اتّصالٌ مقيس) ثمّ deploy <اسم> --env — لا تبنِ حاويةَ SSH بيدك. وإن احتجتَ يدويّاً: حاويةُ Docker. قِس المحرّك أوّلاً (run docker info)؛ إن لم يُجب فشغّل Docker Desktop (run Start-Process 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe') وأعد القياس حتى يجيب. ابنِ صورةَ **خادمٍ** من node:24 فيها openssh-server في مجلّدٍ خارج المشروع — الصورةُ لا تحوي المشروعَ (لا COPY . . ولا .env في صورةٍ أبداً؛ deploy هو من يحمل الشيفرة)؛ والبناءُ الطويل بـ run --bg docker build … ثمّ logs حتى ينتهي لا run عاديّ تقطعه المهلة، وشغّلها مقيّدةً بالحلقة المحلّيّة (-p 127.0.0.1:2222:22)، وضع المفتاحَ العامّ من server add في /root/.ssh/authorized_keys داخلها (docker exec، والصلاحيّات 700/600). الدخولُ بالمفتاح وحده: PasswordAuthentication no ولا كلمةَ مرورٍ للجذر (chpasswd) في الصورة — ولو كانت الحاويةُ محلّيّة، ثمّ server add test root@127.0.0.1:2222 ثمّ deploy.",
  "   إن لم يُجب المحرّكُ خلال دقيقتين بعد التشغيل فلا تنتظر في حلقة: Docker Desktop سقط على الأرجح — اقرأ سببه من %LOCALAPPDATA%\\Docker\\backend.error.json (read). فخٌّ مقيس (10-08، مرّتين): مقبسٌ يتيم لا يُحذف («The file cannot be accessed by the system») — مثل %LOCALAPPDATA%\\Docker\\run\\dockerInference و%LOCALAPPDATA%\\docker-secrets-engine\\engine.sock (المسارُ كما يكتبه الخطأ حرفاً — لا تخمّنه). أوقف Docker Desktop (stop بالرقم أو أغلقه)، وأعد تسميةَ **المجلّد الذي يحوي المقبس** (المسارُ بلا اسم الملفّ — المقبسُ نفسُه لا يُعاد تسميتُه ولا يُحذف)، مثل: Rename-Item \"$env:LOCALAPPDATA\\docker-secrets-engine\" \"docker-secrets-engine.stale\" بلا -ErrorAction SilentlyContinue كي يظهر الفشلُ إن أخطأتَ المسار، ثمّ Test-Path المسارَ القديم (لا تحذفه، ولا «Reset to factory defaults» فهو يمحو الصور والحاويات)، ثمّ شغّله وأعد القياس؛ وكرّر إن سمّى مقبساً آخر.",
  "3) WSL: يصلح خادماً تجريبيّاً إن كان sshd يعمل فيه فعلاً؛ تثبيتُه يحتاج sudo بكلمة مرور — لا تُدخل كلمةَ مرور، واختر Docker.",
  "الأسرار: إن احتاج المشروعُ مفاتيح (.env) فاحفظها أوّلاً بـ secrets import .env (القيمُ إلى الخزنة، والأسماءُ وحدها إلى .abdo/secrets.json)، ثمّ deploy <خادم> --env يكتب .env الإصدار من الخزنة. لا تكتب قيمةً في رسالة ولا في ملفّ مُودَع.",
  "قواعد: لا نشرَ إلى خادم إنتاجٍ بلا إذنٍ صريح من المستخدم؛ الأسرارُ من الخزنة لا في الملفّات، و.env لا يُرفع؛ في PowerShell اقتبس قوالبَ Go ('{{.Names}}').",
].join("\n")

export const deployRoutesBrief = (families: ReadonlySet<string>): string => families.has("servers") ? DEPLOY_ROUTES_BRIEF : ""
