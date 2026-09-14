/**
 * S14-r — ما وجده الفريقُ الأحمر، مثبَّتاً عائلةً عائلة (2026-09-02).
 *
 * كلُّ حالةٍ هنا **قيست فالتةً** قبل الإصلاح: إمّا سرٌّ وصل القرص، وإمّا نثرٌ
 * بريءٌ حُجب أو فتح محرّراً على سطح المكتب. المجموعتان متلازمتان عمداً في ملفٍّ
 * واحد: تشديدُ الكشف بلا تثبيتِ الصمت يعيدنا إلى حارسٍ يُطفئه المستخدم.
 *
 * القاعدةُ التي تحكم الملفّ كلَّه (وهي التي انكسرت وكلّفت):
 * **«حَمَل اعتماداً» و«تغيّر الجسد» شيءٌ واحد**. دورٌ يُعلَن حاملاً ثم يُقبل
 * جسدُه حرفياً هو دعوى أمنٍ كاذبة — أسوأ من الصمت، لأن المستخدم يقرأ «حُجب ولم
 * يُخزَّن» فلا يذهب ينظّف الحالة.
 */
import { describe, expect, test } from "bun:test"
import { REDACTED } from "../src/secret-command-guard"
import { INTAKE_REFUSALS, classifyInboundSecret, intakeDesktopAbsent } from "../src/secret-intake"

/** حالةُ تسرّبٍ مقيسة: الجسد، والقيمةُ التي كانت تصل القرص، والشكلُ المتوقَّع. */
interface Leak {
  readonly body: string
  readonly secret: string
  readonly kind?: string
}

const FAMILIES: readonly { readonly name: string; readonly why: string; readonly cases: readonly Leak[] }[] = [
  {
    name: "الحشوُ العربيّ بين الاسم والقيمة",
    why: "الملكيّة واللقب والإضافة هي الطريقةُ الافتراضية لتسليم كلمة مرور بالعربية؛ اشتراطُ الالتصاق أسقط القاعدةَ كلَّها.",
    cases: [
      { body: "الباسورد الأول: aaa111bbb والباسورد الثاني: ccc222ddd", secret: "aaa111bbb", kind: "password" },
      { body: "الباسورد الأول: aaa111bbb والباسورد الثاني: ccc222ddd", secret: "ccc222ddd", kind: "password" },
      { body: "الباسورد بتاعي hunter2xy", secret: "hunter2xy", kind: "password" },
      { body: "الباسورد حقي hunter2xy", secret: "hunter2xy", kind: "password" },
      { body: "الباسورد تبعي hunter2xy", secret: "hunter2xy", kind: "password" },
      { body: "باسورد الراوتر 4471aabb", secret: "4471aabb", kind: "password" },
      { body: "كلمة سر الواي فاي 4471aabb", secret: "4471aabb", kind: "password" },
      { body: "الرقم السري للحساب هو 8899aabb", secret: "8899aabb", kind: "password" },
      { body: "الپاسوورد الجديد Passw0rd2026", secret: "Passw0rd2026", kind: "password" },
      { body: "الباسوردات القديمة: Passw0rd2026", secret: "Passw0rd2026", kind: "password" },
      { body: "سر التطبيق: abc12345", secret: "abc12345" },
      { body: "كود التفعيل 839201bb", secret: "839201bb", kind: "password" },
    ],
  },
  {
    name: "الواصلُ والترتيب",
    why: "فاصلةٌ أو سهمٌ أو رابطةٌ متبوعةٌ بنقطتين، أو قيمةٌ تسبق اسمَها — كلُّها أشكالٌ طبيعية كانت تُسقط المطابقة.",
    cases: [
      { body: "الباسورد،hunter2xy", secret: "hunter2xy", kind: "password" },
      { body: "الباسورد -> hunter2xy", secret: "hunter2xy", kind: "password" },
      { body: "hunter2xy هو الباسورد", secret: "hunter2xy", kind: "password" },
      { body: "كلمة السر هي: open sesame door now", secret: "sesame door now", kind: "password" },
      { body: "كلمة المرور هي: Blue Sky 99", secret: "Blue Sky 99", kind: "password" },
      { body: "بيانات الدخول: admin / hunter2xy", secret: "hunter2xy" },
      { body: "credentials: admin / Passw0rd2026", secret: "Passw0rd2026" },
    ],
  },
  {
    name: "الرسمُ العربيّ: تشكيلٌ وألفٌ مقصورةٌ ومحارفُ صفريّةُ العرض وأرقامٌ هنديّة",
    why: "ضمّةٌ واحدة أو ياءٌ بلا نقطتين أو محرفٌ غيرُ مرئيّ ملصوقٌ من طرفيّة كان يُعطّل الحارسَ كلَّه — ومَن يكتب بالرسم القاموسيّ وحده يُحمى.",
    cases: [
      { body: "الْبَاسْوُورْد: hunter2xy", secret: "hunter2xy", kind: "password" },
      { body: "كلمةُ السر: hunter2xy", secret: "hunter2xy", kind: "password" },
      { body: "الرقم السرى: 4471aabb", secret: "4471aabb", kind: "password" },
      { body: "الرقم السرى: Passw0rd2026", secret: "Passw0rd2026", kind: "password" },
      { body: "البا\u200cسورد: hunter2xy", secret: "hunter2xy", kind: "password" },
      { body: "باسوردي hunter2xy", secret: "hunter2xy", kind: "password" },
      { body: "الباسورد: hunt\u200ber2xy دخله في اللوحة", secret: "er2xy", kind: "password" },
      { body: "الباسورد: hunt\u200ber2xy", secret: "er2xy", kind: "password" },
      { body: "الباسورد ٩٨٧٦٥٤٣٢١ دخله في لوحة التحكم", secret: "٩٨٧٦٥٤٣٢١", kind: "password" },
      { body: "الرقم السري: ١٢٣٤٥٦٧٨٩", secret: "١٢٣٤٥٦٧٨٩", kind: "password" },
      { body: "كلمة السر: سري٢٠٢٦", secret: "سري٢٠٢٦", kind: "password" },
      { body: "الكود ٤٨٣٩٢٠ دخله في الموقع", secret: "٤٨٣٩٢٠", kind: "password" },
      { body: "الباسورد: سرّي٢٠٢٦قوي", secret: "سرّي٢٠٢٦قوي", kind: "password" },
      { body: "كلمة السر: Pass٢٠٢٦", secret: "Pass٢٠٢٦", kind: "password" },
      { body: "الباسورد: Passwörd2026", secret: "Passwörd2026", kind: "password" },
    ],
  },
  {
    name: "أسماءٌ لم تكن في المفردات",
    why: "«الكود» هو الاسمُ العاديّ لرمزِ تفعيلٍ عربيّاً، و«السر» وحدها أشيعُ من «كلمة السر»، و«pass» تكتبها كلُّ لوحةِ إعدادات.",
    cases: [
      { body: "الكود: 483920aa", secret: "483920aa", kind: "password" },
      { body: "الشفرة: Zx9kkQ22", secret: "Zx9kkQ22", kind: "password" },
      { body: "pass: hunter2xy", secret: "hunter2xy", kind: "password" },
      { body: "السر: Passw0rd2026", secret: "Passw0rd2026", kind: "password" },
      { body: "سري: Passw0rd2026", secret: "Passw0rd2026", kind: "password" },
      { body: "باس: Passw0rd2026", secret: "Passw0rd2026", kind: "password" },
      { body: "رمز التحقق: 483920", secret: "483920", kind: "password" },
      { body: "عبارة الاسترداد: witch collapse practice feed shame open despair creek road again ice least", secret: "witch collapse practice", kind: "password" },
    ],
  },
  {
    name: "أرضيّاتُ الطول والهيئة",
    why: "PIN وCVV ورمزُ مصرفٍ قصيرةٌ كلُّها، وكلمةُ مرورٍ بحروفٍ فقط شكلٌ شائع — والأرضيّاتُ الثلاث كانت فوق الواقع.",
    cases: [
      { body: "الباسورد: 1234", secret: "1234", kind: "password" },
      { body: "PIN: 4821", secret: "4821", kind: "password" },
      { body: "كلمة السر: abc12", secret: "abc12", kind: "password" },
      { body: "الباسورد: 8842179", secret: "8842179", kind: "password" },
      { body: "PASSWORD=ab12", secret: "ab12", kind: "password" },
      { body: "the password is cat", secret: "cat", kind: "password" },
      { body: "الباسورد hunter دخله في اللوحة", secret: "hunter", kind: "password" },
      { body: "الباسورد بتاعي hunterxyz دخله في اللوحة", secret: "hunterxyz", kind: "password" },
    ],
  },
  {
    name: "عباراتُ المرور متعدّدةُ الكلمات",
    why: "توصيةُ الأمن نفسها تدفع إليها، وكلُّ قواعد القيمة كانت تقف عند أوّل فراغ فتُحجب كلمةٌ ويُكتب الباقي.",
    cases: [
      { body: "the password is correct horse battery staple", secret: "horse battery staple", kind: "password" },
      { body: "الباسورد: my secret pass 2026", secret: "my secret pass 2026", kind: "password" },
      { body: "الباسورد: قطة سوداء تمشي ببطء — دخلها في اللوحة", secret: "قطة سوداء تمشي ببطء", kind: "password" },
    ],
  },
  {
    name: "صنفُ المحارف داخل القيمة",
    why: "قائمةُ السماح لم تعرف الأقواسَ والفواصلَ والفواصلَ المنقوطة، وهي محارفُ كلماتِ مرورٍ يولّدها كلُّ مولّد.",
    cases: [
      { body: "الباسورد: Abc12(xyz)", secret: "Abc12(xyz)", kind: "password" },
      { body: "كلمة السر: My,Pass,2026", secret: "My,Pass,2026", kind: "password" },
      { body: "الباسورد: Se[cret]99x", secret: "Se[cret]99x", kind: "password" },
      { body: "كلمة المرور: a<b>c123456", secret: "a<b>c123456", kind: "password" },
      { body: "الباسورد: {json}Pass99", secret: "{json}Pass99", kind: "password" },
      { body: "كلمة السر: pa`ss`word9", secret: "pa`ss`word9", kind: "password" },
      { body: "الباسورد: pass;word;99", secret: "pass;word;99", kind: "password" },
      { body: "كلمة المرور: Passw0rd(2026)", secret: "Passw0rd(2026)", kind: "password" },
      { body: "الباسورد: Passw0rd,Extra9", secret: "Passw0rd,Extra9", kind: "password" },
      { body: "الباسورد: \u201chunter2xy\u201d", secret: "hunter2xy", kind: "password" },
      { body: "دخل هذا في الإعدادات: {\"الباسورد\": \"hunter2xy\"}", secret: "hunter2xy", kind: "password" },
    ],
  },
  {
    name: "استثناءُ الهيئة بعد اسمٍ صريح",
    why: "«اسمُ متغيّر بيئة» و«مسار» و«مرجع» استثناءاتٌ صُنعت لحجب الأوامر، وأُعيد استعمالها حيث سبق القيمةَ اسمٌ سرّيٌّ صريح — فصارت أنتجَ مَنفذ.",
    cases: [
      { body: "الباسورد: ADMIN2026", secret: "ADMIN2026", kind: "password" },
      { body: "كلمة السر: SECRET_PASS_2026", secret: "SECRET_PASS_2026", kind: "password" },
      { body: "الباسورد: /Passw0rd2026", secret: "/Passw0rd2026", kind: "password" },
      { body: "كلمة السر: c:/Passw0rd99", secret: "c:/Passw0rd99", kind: "password" },
      { body: "الباسورد: $ecretPass99", secret: "$ecretPass99", kind: "password" },
    ],
  },
  {
    name: "أشكالُ الأوامر ولهجاتُ الروابط",
    why: "الاعتمادُ في سطر أمرٍ على منصّة المنتج نفسها (ويندوز) كان أوسعَ ثغرة: net use وplink وcurl -u ورابطُ Redis بلا اسم مستخدم.",
    cases: [
      { body: "redis://:S3cretP4ss@cache.example.com:6379/0", secret: "S3cretP4ss", kind: "connection-string" },
      { body: "curl -u admin:S3cretP4ss https://api.example.com/v1/me", secret: "S3cretP4ss", kind: "password" },
      { body: "curl --user admin:S3cretP4ss https://api.example.com", secret: "S3cretP4ss", kind: "password" },
      { body: "net use \\\\fs01\\share /user:CORP\\admin S3cretP4ss /persistent:yes", secret: "S3cretP4ss", kind: "password" },
      { body: "cmdkey /add:fs01 /user:CORP\\admin /pass:S3cretP4ss", secret: "S3cretP4ss", kind: "password" },
      { body: "plink -pw S3cretP4ss admin@10.0.0.5", secret: "S3cretP4ss", kind: "password" },
      { body: "docker login -u me -p S3cretP4ss registry.example.com", secret: "S3cretP4ss", kind: "password" },
      { body: "echo 'S3cretP4ss' | sudo -S systemctl restart nginx", secret: "S3cretP4ss", kind: "password" },
      { body: "echo \"S3cretP4ss\" | docker login -u me --password-stdin registry.io", secret: "S3cretP4ss", kind: "password" },
    ],
  },
  {
    name: "أسماءُ الإسناد المختصرة وترويساتُ الجلسة",
    why: "ملفُّ .env الحقيقيّ يكتب DB_PASS لا DB_PASSWORD، وكعكةُ الجلسة اعتمادٌ حاملٌ كالرمز تماماً.",
    cases: [
      { body: "DB_PASS=hunter2xyzq", secret: "hunter2xyzq", kind: "password" },
      { body: "DB_PWD=Str0ngPass1", secret: "Str0ngPass1", kind: "password" },
      { body: "REDIS_AUTH=Str0ngPass1", secret: "Str0ngPass1", kind: "password" },
      { body: "{\"username\":\"admin\",\"pass\":\"S3cretP4ss\"}", secret: "S3cretP4ss", kind: "password" },
      { body: "{\"credentials\":{\"login\":\"admin\",\"pw\":\"S3cretP4ss\"}}", secret: "S3cretP4ss", kind: "password" },
      { body: "curl -H \"Cookie: session=abcd1234efgh5678\" https://app.example.com", secret: "abcd1234efgh5678", kind: "password" },
      { body: "curl -H \"X-Auth: S3cretP4ss12\" https://api.example.com", secret: "S3cretP4ss12", kind: "password" },
      { body: "{\"password\": \"Pa ss 99xy\"}", secret: "Pa ss 99xy", kind: "password" },
    ],
  },
  {
    name: "رموزُ مزوّدين ودروعُ المفاتيح والكتلُ المُرمَّزة",
    why: "رمزُ GitLab وnpm طولُه ٢٢–٣٦ محرفاً: لا بادئةَ تعرفه ولا يبلغ أرضيّةَ الأربعين. ودرعُ المفتاح الخاصّ — الإشارةُ الوحيدة التي لا تُخطئ — لم تكن مقروءةً أصلاً.",
    cases: [
      { body: "glpat-ABC123xyz456DEF789", secret: "glpat-ABC123xyz456DEF789", kind: "api-key" },
      { body: "npm_abcdefgh1234567890abcdef1234", secret: "npm_abcdefgh1234567890abcdef1234", kind: "api-key" },
      { body: "dckr_pat_ABCdef123456789", secret: "dckr_pat_ABCdef123456789", kind: "api-key" },
      { body: "hf_ABCdefGHIjkl123456789", secret: "hf_ABCdefGHIjkl123456789", kind: "api-key" },
      { body: "dXNlcjpTM2NyZXRQNHNz", secret: "dXNlcjpTM2NyZXRQNHNz", kind: "encoded-credential" },
      { body: "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIObC7gT1kXqP2mNvRs\nQzWxYuIoPaSdFgHjKlZxCvBnMy\n-----END EC PRIVATE KEY-----", secret: "MHcCAQEEIObC7gT1kXqP2mNvRs", kind: "encoded-credential" },
      { body: "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNza\n-----END OPENSSH PRIVATE KEY-----", secret: "b3BlbnNza", kind: "encoded-credential" },
      { body: "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----MHcCAQEEIObC7gT1kXqP-----END PRIVATE KEY-----", secret: "MHcCAQEEIObC7gT1kXqP", kind: "encoded-credential" },
    ],
  },
]

for (const family of FAMILIES) {
  describe(`عائلة: ${family.name}`, () => {
    test(`السببُ المقيس: ${family.why.slice(0, 60)}`, () => { expect(family.cases.length).toBeGreaterThan(0) })
    for (const item of family.cases) {
      test(`لا تنجو القيمة: ${item.body.replace(/\n/gu, " ⏎ ").slice(0, 56)}`, () => {
        const scan = classifyInboundSecret(item.body)
        // (١) القيمةُ نفسها لم تعد في النصّ الذي سيُقبل ويُخزَّن ويُرسَل.
        expect(scan.redacted).not.toContain(item.secret)
        // (٢) والدورُ مُعلَنٌ حاملاً، فالتحذيرُ يخرج والطريقُ إلى الخزنة يُفتح.
        expect(scan.carriesSecret).toBe(true)
        expect(scan.redactions).toBeGreaterThan(0)
        // (٣) الشكلُ يُسمّى بما هو: مقبضُ الخزنة وخطوةُ التدوير تُشتقّان منه،
        // فكلمةُ مرورٍ تُسمّى «اسم حساب» تُخزَّن تحت مقبضٍ خاطئ.
        if (item.kind !== undefined) expect(scan.kinds).toContain(item.kind)
      })
    }
  })
}

/**
 * ⛔ المطفأ الكاذب. هذه الجُمل تتحدّث **عن** الأسرار أو تلصق مساراً أو تراجع
 * كوداً — ولا تحمل اعتماداً. كلُّ واحدةٍ منها كانت تُصنَّف حاملةً: تُشوَّه
 * فيعجز النموذجُ عن تنفيذ الطلب، ويُفتح نوت باد على سطح مكتب المستخدم، ويُكتب
 * ملفٌّ في الخزنة، ويُقال له «سرُّك محروق فدوّره» ولا سرَّ في الأفق.
 */
const SILENT: readonly { readonly body: string; readonly why: string }[] = [
  { body: "كيف أسجل الدخول إلى لوحة التحكم؟", why: "سؤالٌ بريء — «أسجل» ليست «سجل»، وحدودُ الكلمة لم تكن مطبَّقة على النيّة" },
  { body: "سجل الدخول لا يعمل عندي، ما السبب؟", why: "بلاغُ عطلٍ لا تسليمُ اعتماد" },
  { body: "استخدم المفتاح المناسب لكل بيئة ولا تخلط بينها", why: "«استخدم ال…» أشيعُ تركيبٍ في العربية" },
  { body: "استعمل هذا الأسلوب في بقية الملفات من فضلك", why: "نيّةٌ عامّة بلا قيمة" },
  { body: "ضع في اعتبارك أن الاختبار بطيء على ويندوز", why: "«ضع في» فعلٌ وحرفٌ لا تسليم" },
  { body: "أدخل في التفاصيل من فضلك ولا تختصر", why: "«أدخل في» فعلٌ وحرفٌ لا تسليم" },
  { body: "حط في بالك أن الخادم بطيء الليلة", why: "لهجةٌ عاديّة" },
  { body: "هذه بياناتي في ملف التعريف العام على الموقع", why: "«بياناتي» في سياقٍ عامّ" },
  { body: "اقرأ docs/operations/LONG-RUNNING-SPRINT-PROGRAM-NOTES.md ولخّصه", why: "مسارُ ملفٍّ طويل — كانت المصفاةُ الطويلة تمحوه فيعجز الطلب" },
  { body: "راجع الكوميت 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a وأخبرني", why: "بصمةُ كوميت أربعينيّة" },
  { body: "افتح /usr/local/lib/node_modules/typescript/lib/tsserver.js", why: "مسارٌ مطلق" },
  { body: "الفرع feature/routing-and-secret-intake-work-in-progress جاهز", why: "اسمُ فرعٍ طويل" },
  { body: "الحزمة typescript-eslint/eslint-plugin-and-parser-bundle قديمة", why: "اسمُ حزمة" },
  { body: "المعرّف 550e8400-e29b-41d4-a716-446655440000-and-more-suffix", why: "معرّفٌ عالميّ" },
  { body: "المسار C:/work/projects/business-suite/packages/core/src", why: "مسارُ ويندوز" },
  { body: "The password is stored as a bcrypt hash, never in plain text.", why: "توثيقٌ إنجليزيّ — الجملةُ تنقطع عند كلمةِ بناء" },
  { body: "Use this API key rotation policy for all of our services.", why: "سياسةٌ لا مفتاح" },
  { body: "login with SSO is not supported yet, only email.", why: "«login with» بلا اعتمادٍ ذي هيئة" },
  { body: "Here is my account of what happened during the outage.", why: "«account» بمعناها اللغويّ" },
  { body: "the token is refreshed automatically every hour", why: "خبرٌ عن الرمز لا قيمته" },
  { body: "Password requirements: minimum twelve characters.", why: "عنوانٌ لا إسناد" },
  { body: "secret: management is hard and we should automate it", why: "نقطتان في نثرٍ إنجليزيّ" },
  { body: "token: refresh flow needs a diagram", why: "نقطتان في نثرٍ إنجليزيّ" },
  { body: "في الاختبار نستعمل password: \"your-password-here\" كقيمة وهمية", why: "قيمةٌ نائبةٌ معروفة" },
  { body: "هل apiKey: process.env.API_KEY صحيح هنا؟", why: "مرجعُ بيئةٍ لا قيمة" },
  { body: "الملف يحوي {\"password\": \"changeme\"} وهي قيمة المثال", why: "قيمةٌ نائبةٌ معروفة" },
  { body: "الدالة validatePassword(password: string) تتحقق من الطول فقط", why: "نوعٌ لا قيمة" },
  { body: "في التوثيق نكتب Authorization: Bearer <token> كمثال", why: "مثالٌ بين قوسين زاويّين" },
  { body: "أضف اختباراً لحالة api_key: undefined", why: "قيمةٌ نائبةٌ معروفة" },
  { body: "السطر DB_PASSWORD=example ناقص في .env.example", why: "قيمةٌ نائبةٌ معروفة" },
  { body: "الكود: يعمل بشكل جيد الآن", why: "خبرٌ عربيّ بعد نقطتين — لا هيئةَ اعتماد" },
  { body: "نسيت كلمة السر، كيف أستعيدها؟", why: "الفاصلةُ واصلٌ ضعيف، والقيمةُ بعدها عربيّةٌ صِرفة" },
  { body: "اشرح لي إدارة الأسرار", why: "«الأسرار» ليست «السر» — النظرةُ الخلفية تمنع" },
  { body: "الباسورد يجب ألا يُكتب في المحادثة", why: "لا واصلَ صريح، وأوّلُ كلمةٍ بناء" },
  { body: "كيف أخزّن المفتاح في خزنة بدل الملف؟", why: "«في» كلمةُ بناء" },
  { body: "the password requirements are strict", why: "واصلُ فراغٍ باسمٍ لاتينيّ يشترط هيئةَ اعتماد" },
  { body: "أضف حقل password إلى النموذج", why: "اسمُ حقلٍ لا قيمة" },
]

describe("⛔ المطفأ الكاذب — ما يجب أن يبقى صامتاً", () => {
  for (const item of SILENT) {
    test(`صامتٌ (${item.why.slice(0, 44)}): ${item.body.slice(0, 40)}`, () => {
      const scan = classifyInboundSecret(item.body)
      expect(scan.carriesSecret).toBe(false)
      expect(scan.redactions).toBe(0)
      expect(scan.kinds).toEqual([])
      // والأهمّ: الجسدُ يصل النموذجَ كما كتبه المستخدم، فالطلبُ قابلٌ للتنفيذ.
      expect(scan.redacted).toBe(item.body)
    })
  }
})

describe("العقدُ البنيويّ — لا دعوى بلا أثر، ولا أثر بلا دعوى", () => {
  const everyBody = [...FAMILIES.flatMap((f) => f.cases.map((c) => c.body)), ...SILENT.map((s) => s.body)]

  test("⛔ «حَمَل اعتماداً» ⇔ «تغيّر الجسد» — لا دورٌ يُعلَن حاملاً ثم يُقبل حرفياً", () => {
    for (const body of everyBody) {
      const scan = classifyInboundSecret(body)
      expect(`${body.slice(0, 30)} ⇦ ${scan.carriesSecret} / ${scan.redactions > 0}`)
        .toBe(`${body.slice(0, 30)} ⇦ ${scan.carriesSecret} / ${scan.carriesSecret}`)
      if (scan.carriesSecret) expect(scan.redacted).not.toBe(body)
    }
  })

  test("النيّةُ وحدها لا تُعلن اعتماداً — وإلا فُتح محرّرٌ على سطح المكتب بلا سرّ", () => {
    for (const body of ["سجل الدخول بحسابك ثم أخبرني", "use this api key policy", "put them in the settings"]) {
      const scan = classifyInboundSecret(body)
      expect(scan.carriesSecret).toBe(false)
      expect(scan.redacted).toBe(body)
    }
  })

  test("الحجبُ متساوي القوى على كامل المجموعة — تمريرةٌ ثانية لا تغيّر بايتاً", () => {
    for (const body of everyBody) {
      const once = classifyInboundSecret(body).redacted
      expect(classifyInboundSecret(once).redacted).toBe(once)
    }
  })

  test("لا موضعَ يحمل نصّاً — الشكلُ والمدى فقط، وعلامةُ الحجب هي الأثر", () => {
    for (const family of FAMILIES) {
      for (const item of family.cases) {
        const scan = classifyInboundSecret(item.body)
        expect(scan.redacted).toContain(REDACTED)
        for (const span of scan.spans) expect(Object.keys(span).sort()).toEqual(["kind", "length", "start"])
      }
    }
  })
})

describe("الإدخال المُعان — أثرٌ على جهاز المستخدم لا يُحدَث إلا حين يمكن إنهاؤه", () => {
  test("جلسةٌ بلا سطح مكتب تُرفض بالاسم قبل أن يُكتب ملفّ أو يُشغَّل محرّر", () => {
    expect(intakeDesktopAbsent({ SESSIONNAME: "Services", USERPROFILE: "C:/Users/x" }, "win32")).toBe(true)
    expect(intakeDesktopAbsent({ USERPROFILE: "" }, "win32")).toBe(true)
    expect(intakeDesktopAbsent({}, "linux")).toBe(true)
    expect(intakeDesktopAbsent({ ABDO_INTAKE_HEADLESS: "1", DISPLAY: ":0" }, "linux")).toBe(true)
    expect(INTAKE_REFUSALS.EDITOR_HEADLESS).toContain("secret set")
  })

  test("والجلسةُ السويّة لا تُعطَّل: الأنابيبُ ليست دليلَ غياب سطح مكتب", () => {
    expect(intakeDesktopAbsent({ USERPROFILE: "C:/Users/x", SESSIONNAME: "Console" }, "win32")).toBe(false)
    expect(intakeDesktopAbsent({}, "darwin")).toBe(false)
    expect(intakeDesktopAbsent({ DISPLAY: ":0" }, "linux")).toBe(false)
    // ومحرّرٌ عيّنه المشغّل بنفسه قرارُه هو — لا يُنقض بقياسٍ عن الشاشة.
    expect(intakeDesktopAbsent({ ABDO_INTAKE_EDITOR: "code" }, "linux")).toBe(false)
  })
})
