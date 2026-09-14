/**
 * نزعُ الاعتمادات من بيئة كلّ عمليةٍ ابن — الفكرة من hermes-agent، والتنفيذ لنا.
 *
 * الفجوةُ المقيسة (2026-09-03): `run-command.ts` ينسخ `process.env` **كاملاً**
 * إلى الابن (سطر 122)، و`isolationEnv` لا ينزع إلا ستّة متغيّرات بروكسي
 * (`ISOLATION_STRIPPED_ENV`) وهي ليست سياسةَ أسرارٍ أصلاً. فأمرٌ واحدٌ يوافق
 * عليه المشغّل يقرأ كلَّ ما في بيئته — و`ABDO_SHELL_TOKEN` من ذلك: هو ما
 * تُصادَق به القشرةُ على المحرّك، فابنٌ يقرؤه ينتحل القشرة.
 *
 * (المزوّدون السحابيّون أهدأُ ممّا يبدو: مفاتيحهم يملكها عاملُ رست
 * (`credentialOwner: "rust-worker"`) وتُقرأ من الخزنة عند النداء، فلا تسكن
 * البيئة. الخطرُ الباقي حقيقيّ رغم ذلك: رمزُ القشرة، وما يصدّره المشغّلُ
 * نفسه في صدفته قبل تشغيلنا — وهذا ما لا نتحكّم فيه ولذلك يُنزع بالقاعدة.)
 *
 * **لماذا حجبٌ لا سماح**: قائمةُ سماحٍ (keep-list) كانت ستكسر كلَّ بناءٍ يعتمد
 * متغيّراً لم نتوقّعه — وقياسُنا أنّ الأدوات تحتاج بيئةً غنيّة لا فقيرة. فالقاعدة
 * هنا **تنزع ما تسمّيه وتُبقي ما عداه**: خطرُها أنها قد تُبقي سرّاً باسمٍ غريب،
 * وذلك تعالجه كنسةُ اللواحق، لا أن تُعطّل عمل المستخدم.
 *
 * **والنزعُ يُسمّى ولا يصمت**: تُعاد أسماءُ ما نُزع كي يقوله الإيصال. نزعٌ صامتٌ
 * يجعل عطلاً بيئيّاً بعد شهرٍ لغزاً بلا خيط.
 *
 * خالصةٌ من الأثر: كائنٌ يدخل وكائنٌ يخرج — لا `process` ولا قرص ولا بيئة
 * ضمنيّة، فتُختبر بجدولٍ صريح.
 */

/**
 * تُنزع **دائماً**، ولا يفتحها طلبُ تمريرٍ أبداً — ولذلك سُمّيت «دائماً».
 * كلُّ اسمٍ هنا يمنح حاملَه سلطةً على نظامنا نفسِه لا على مورد المستخدم.
 */
export const ALWAYS_STRIP_ENV: readonly string[] = Object.freeze([
  // رمزُ مصادقة القشرة على المحرّك: من يقرؤه ينتحل القشرة على أنبوبها.
  "ABDO_SHELL_TOKEN",
])

/**
 * بادئاتٌ تُنزع دائماً — **قاعدةُ شكلٍ لا قائمةُ أسماء**.
 *
 * العطلُ الذي وُجد في هذه الوحدة نفسِها (مراجعةٌ عدائيّة 2026-09-03): كانت
 * تسمّي `ABDO_VAULT_KEY` و`ABDO_VAULT_ROOT` و`ABDO_VAULT_PASSPHRASE` — وهي
 * **أسماءٌ لا يضبطها المنتَج إطلاقاً**، بينما الحقيقيّة الثلاث
 * (`ABDO_VAULT_SCRIPT` · `ABDO_VAULT_DIR` · `ABDO_VAULT_HOME`) تعبر إلى الابن
 * سالمة. أي أنّ الحارسَ كان يحرس أبواباً لا وجود لها ويترك الأبواب الحقيقيّة
 * مفتوحة — وهو عينُ عيبِ «القائمة المكتوبة باليد تهرم» الذي جاءت هذه الوحدة
 * أصلاً لتغلقه في مكانٍ آخر.
 *
 * البادئةُ لا تهرم: أيُّ متغيّرٍ جديدٍ باسم `ABDO_VAULT_*` يُنزع يومَ يُخترع،
 * بلا سطرٍ يُضاف هنا وبلا أحدٍ يتذكّر.
 */
export const ALWAYS_STRIP_PREFIXES: readonly string[] = Object.freeze([
  // كلُّ ما يشير إلى الخزنة: سكربتُها وبيتُها ومجلّدها. لا يحتاجها ابنٌ أبداً،
  // وهي خريطةُ الوصول إلى الأسرار وإن لم تكن السرَّ نفسه.
  "ABDO_VAULT",
])

/**
 * تُنزع **ما لم يُطلب تمريرُها صراحةً**. هذه اعتماداتُ المستخدم لموارده هو:
 * قد يحتاجها بناءٌ شرعيّ (تنصيبٌ من سجلٍّ خاصّ مثلاً)، فتُمرَّر عندئذٍ بالاسم
 * وحده وبقرارٍ ظاهر — لا بأن تبقى مفتوحةً للجميع افتراضاً.
 */
/**
 * أيُّ أسماءِ متغيّراتٍ يجوز **منحُها** لعمليّةٍ خارجيّة.
 *
 * القيدُ الحاكم: **ما يُجرَّد لا يُمنَح**. بدونه يصير المنحُ باباً حول التجريد
 * نفسِه — «امنح هذا الخادمَ `ABDO_SHELL_TOKEN`» — وهو عينُ الثغرة التي أُغلقت
 * في 2026-09-04. وبيتُ القاعدة هنا لا عند المُستفيد: من يعرف ما يُجرَّد هو من
 * يقرّر ما يُمنَح، ومُستفيدٌ ثانٍ لا يعيد كتابةَ القائمة فتفترقان.
 *
 * والاسمُ بصيغةِ بيئةٍ قياسيّة كي لا يُحقن اسمٌ غريبُ الشكل.
 */
export const grantableEnvName = (name: string): boolean => {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(name)) return false
  if (ALWAYS_STRIP_ENV.includes(name)) return false
  return !ALWAYS_STRIP_PREFIXES.some((prefix) => name.startsWith(prefix))
}

export const STRIP_UNLESS_PASSED_ENV: readonly string[] = Object.freeze([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "DOCKER_AUTH_CONFIG",
  "CARGO_REGISTRY_TOKEN",
])

/**
 * كنسةُ اللواحق — شبكةُ الأمان لما لم تسمّه القائمتان.
 *
 * السرُّ الذي يهرب من قائمةٍ مكتوبةٍ باليد هو القاعدةُ لا الاستثناء: اسمٌ
 * جديدٌ لمزوّدٍ جديد يظهر في بيئة المشغّل ولا يعرفه جدولُنا. اللاحقةُ تلتقطه
 * بشكله. والاستثناءُ من هذه القاعدة يُعدّ بـ`grep` واحدٍ على `PASSTHROUGH_EXACT`.
 */
const SECRET_SUFFIX = /(?:_API_KEY|_APIKEY|_ACCESS_KEY|_SECRET|_SECRET_KEY|_TOKEN|_PASSWORD|_PASSWD|_CREDENTIALS|_PRIVATE_KEY)$/iu

/**
 * أسماءٌ تنتهي بلاحقةِ سرٍّ وليست سرّاً — تُعفى بالاسم كي لا تكسر الكنسةُ عملاً
 * حقيقيّاً. تُبقى قصيرةً عمداً: كلُّ إعفاءٍ ثقبٌ يُبرَّر مرّةً ويُقرأ للأبد.
 */
const PASSTHROUGH_EXACT: ReadonlySet<string> = new Set([
  // شائعٌ في أدوات البناء ويعني «هل نطلب رمزاً؟» لا الرمز نفسه.
  "GIT_ASKPASS",
  "SSH_ASKPASS",
])

export interface EnvStripOptions {
  /** أسماءٌ من `STRIP_UNLESS_PASSED_ENV` (أو من كنسة اللواحق) يُصرَّح بتمريرها. */
  readonly pass?: readonly string[]
}

export interface EnvStripResult {
  /** البيئةُ كما تُسلَّم للابن. */
  readonly env: Record<string, string>
  /** أسماءُ ما نُزع — مرتّبةً، كي يقولها الإيصال ولا يصمت النزع. */
  readonly stripped: readonly string[]
  /** ما مُرّر بطلبٍ صريح — يُقال أيضاً: التمريرُ قرارٌ يُرى لا افتراضٌ يُنسى. */
  readonly passed: readonly string[]
}

const isSecretName = (name: string): boolean =>
  !PASSTHROUGH_EXACT.has(name) && SECRET_SUFFIX.test(name)

/**
 * يبني بيئةَ الابن من بيئةٍ مصدرٍ، نازعاً الاعتمادات ومسمّياً ما نزع.
 *
 * الترتيب مقصود: «دائماً» تُفحص **قبل** طلب التمرير، فطلبٌ يسمّي
 * `ABDO_SHELL_TOKEN` لا يفتحه — وإلّا صار «دائماً» اسماً بلا معنى.
 */
export function stripChildEnv(
  source: Readonly<Record<string, string | undefined>>,
  options: EnvStripOptions = {},
): EnvStripResult {
  const requested = new Set(options.pass ?? [])
  const always = new Set<string>(ALWAYS_STRIP_ENV)
  const unlessPassed = new Set<string>(STRIP_UNLESS_PASSED_ENV)

  const env: Record<string, string> = {}
  const stripped: string[] = []
  const passed: string[] = []

  const alwaysByShape = (name: string): boolean =>
    always.has(name) || ALWAYS_STRIP_PREFIXES.some((prefix) => name.startsWith(prefix))

  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string") continue
    if (alwaysByShape(name)) { stripped.push(name); continue }
    const sensitive = unlessPassed.has(name) || isSecretName(name)
    if (!sensitive) { env[name] = value; continue }
    if (requested.has(name)) { env[name] = value; passed.push(name); continue }
    stripped.push(name)
  }

  return {
    env,
    stripped: Object.freeze(stripped.sort()),
    passed: Object.freeze(passed.sort()),
  }
}
