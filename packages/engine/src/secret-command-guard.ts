/** S12 — قضبان الأسرار على مستوى الأمر والكتابة.
 *
 * كتالوج العائلة ٣ + KF-1/7/9. السر لا يمرّ في سطر أمرٍ (يصل اللوج)،
 * ولا يُثبّت في مكوّن client (ينشر للإنترنت)، ولا يُضمَّن نصياً في SQL
 * (حقن). حارس انحدار ضيّق: أنماطٌ مقيسة تُرَدّ بسببٍ مسمّى، لا مدقّق أمنٍ
 * شامل.
 */

/** بديلُ القيمة المحجوبة — علامةٌ ظاهرة للمشرف لا فراغٌ صامت. تُعرَّف هنا
 * (لا تحت قسم الحجب) لأن فحوص القيم أدناه تستثنيها: قيمةٌ محجوبةٌ سلفاً ليست
 * سرّاً يُحجب مرّةً ثانية — بهذا يبقى الحجب متساوي القوى. */
export const REDACTED = "«مُحجَّب»"

/** بادئات المفاتيح المعروفة — **مصدرٌ واحد**: يقرأه فحصُ القيمة أدناه
 * ويقرأه الحجب (§redactSecretValues) بنسخته العامّة. لا تعبيرَ ثانياً.
 *
 * وُسّعت 2026-09-02 ببادئات مزوّدين حقيقية كانت تسقط بين شبكتين: رمزُ GitLab
 * وnpm وDocker Hub وHugging Face طولُه ٢٢–٣٦ محرفاً، فلا بادئةَ تعرفه ولا
 * يبلغ أرضيّةَ «البقيّة الطويلة» (٤٠). البادئاتُ العاميّة (`npm_`/`hf_`)
 * تشترط رقماً في الذيل كي لا تبتلع `npm_lifecycle_event` في نثر الإيصالات.
 */
const VENDOR_PREFIX_TOKEN =
  "(?:glpat-|github_pat_|dckr_pat_|shpat_|xapp-|dop_v1_|figd_|nvapi-|gsk_|sq0(?:atp|csp)-|r8_)[A-Za-z0-9_-]{8,}" +
  "|(?:npm_|hf_)(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{16,}"
const KNOWN_PREFIX_TOKEN = new RegExp(
  `(?:(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[baprs]|AKIA|AIza|eyJ)[-_A-Za-z0-9]{8,}|${VENDOR_PREFIX_TOKEN})`,
  "u",
)

/**
 * مرجعٌ لا قيمة: علامةُ حجبٍ سابقة، أو `$VAR`/`${VAR}`/`%VAR%`، أو قراءةُ
 * بيئةٍ في الكود (`process.env.X`). **يُستثنى دائماً وفي كل اتجاه** — لا
 * اسمٌ صريحٌ قبله يجعله سرّاً، لأنه ليس قيمةً أصلاً بل إشارةٌ إليها.
 */
const isReferenceValue = (value: string): boolean => {
  if (value.includes(REDACTED)) return true
  if (stripMarks(value) === stripMarks(REDACTED)) return true // بعد التطبيع أيضاً
  // ولبُّ العلامة بلا قوسيها: قارئُ القيمة يرى القوسين اقتباساً فيسلّم اللبَّ
  // وحده، فكانت التمريرةُ الثانية تحجب الحجبَ («‹‹مُحجَّب››») فتكسر التساوي.
  if (stripMarks(value).replace(/^["'«]+|["'»]+$/gu, "") === REDACTED_CORE) return true
  // اسمُ مرجعٍ لا قيمة: `$VAULT_REF`، `${VAULT}`، `$env:API_KEY`، `%PGPASS%`.
  // شرطُ «لا حرفٌ صغيرٌ **و**رقمٌ معاً» يفصل الاسمَ عن كلمةِ مرورٍ تبدأ بـ`$`
  // (`$ecretPass99`) — وكانت تفلت لأن أوّلَ محرفٍ وحده كان الحكم.
  const looksLikeName = /^\$\{?[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)?\}?$/u.test(value)
  if (looksLikeName && !(/[a-z]/u.test(value) && /[0-9]/u.test(value))) return true
  if (/^%[A-Za-z_]+%$/.test(value)) return true
  return /^(?:process\.env|import\.meta\.env|os\.environ|Deno\.env|ENV)\b/u.test(value)
}

/**
 * استثناءٌ بالهيئة وحدها: اسمُ متغيّر بيئةٍ SCREAMING_SNAKE، أو مسار/رابط.
 * يُسقط **حين يسبق القيمةَ اسمٌ سرّيٌّ صريح**: `الباسورد: ADMIN2026` كلمةُ
 * مرورٍ لا اسمُ متغيّر، و`الباسورد: /Passw0rd2026` كلمةُ مرورٍ لا مسار.
 * كان الاستثناءُ يُطبَّق هناك أيضاً فصار أنتجَ مَنفذٍ في المفردات كلّها.
 */
const isShapeExemptValue = (value: string): boolean => {
  if (/^[A-Z][A-Z0-9_]*$/.test(value)) return true // اسم env
  return /^(?:https?:\/\/|\/|\.\/|[a-z]:[\\/])/i.test(value) // مسار/رابط
}

/** ما ليس سرّاً بأيّ معيار — **مصدرٌ واحد** للاستثناءات يقرأه فحصُ القيمة
 * العارية وفحصُ القيمة المسمّاة معاً، فلا يفترق ما يُستثنى هنا عمّا هناك. */
const isExemptValue = (value: string): boolean => isReferenceValue(value) || isShapeExemptValue(value)

// قيمة سرٍّ حقيقية **بلا اسمٍ يدلّ عليها**: طويلة وعشوائية.
const looksLikeSecretValue = (value: string): boolean => {
  if (value.length < 12) return false
  if (isExemptValue(value)) return false
  // إمّا مفتاح ذو بادئة معروفة، أو عالي الإنتروبيا (حروف+أرقام مختلطة).
  if (KNOWN_PREFIX_TOKEN.test(value)) return true
  const hasMix = /[A-Za-z]/.test(value) && /[0-9]/.test(value)
  return hasMix && value.length >= 20 && !/\s/.test(value)
}

/** أدنى طولٍ لقيمةٍ مسنَدةٍ إلى اسمٍ سرّيّ — **الحدّ نفسه** الذي يرفض به
 * `SECRET_ARGV` أدناه (٦). لا حدَّان لشيءٍ واحد. */
const NAMED_SECRET_MIN = 6

/**
 * قيمةٌ مسنَدةٌ إلى **اسمٍ سرّيّ** (`PASSWORD=…`, `"api_key": …`): الاسمُ نفسه
 * هو الدليل، فلا إنتروبيا تُشترط ولا طولَ عشرين. كان الاشتراط يجعل الحاجبَ
 * أضعف من الحارس: يرفض `PGPASSWORD=abc123def456` ثم يكتبه حرفياً على القرص،
 * ويكتب `CLIENT_SECRET=correcthorsebatterystaple` (حروفٌ بلا رقم) و
 * `DB_PASSWORD=Passw0rd2026` (١٢ محرفاً) كما هي. الاستثناءات وحدها تبقى.
 */
const looksLikeNamedSecretValue = (value: string): boolean =>
  value.length >= NAMED_SECRET_MIN && !isExemptValue(value) && !/\s/.test(value)

/**
 * الاسمُ قد يأتي مقتبساً في JSON (`{"api_key": "…"}`) — وهو أشيعُ شكلٍ يظهر
 * به مفتاحٌ في مخرَج أداة. الاقتباسُ اختياريّ حول الاسم وقبل الفاصل.
 *
 * الاختصاراتُ (`pass`/`pwd`/`pw`/`auth`/`session`) أُضيفت 2026-09-02: ملفُّ
 * `.env` الحقيقيّ يكتب `DB_PASS=`، وDocker يكتب `"pass"`، وكعكةُ الجلسة
 * اعتمادٌ حاملٌ كالرمز. ومعها لزمت النظرةُ الخلفية `(?<![A-Za-z])` كي لا
 * يبتلع `pass` كلمةَ `bypass:` — وهي تُبقي `DB_PASS=` (السابقُ `_` لا حرف).
 */
const SECRET_ASSIGN = /(?<![A-Za-z])["']?(?:passwords?|passwd|passphrase|passcode|pass|pwd|pw|secret|token|api[_-]?key|apikey|auth[_-]?token|auth|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|cookie|session|sid)["']?\s*[=:]\s*["']?([^\s"']+)/giu

/**
 * كلمةُ مرورٍ في argv — **مصدرٌ واحد** يقرأه الرفض والحجب معاً: هذه القائمة
 * يرفضها `secretInCommandViolation` ويحجبها `redactSecretValues`. كانت
 * منسوخةً في الرفض وحده، فكان الأمرُ المرفوضُ يُكتب بنصّه في مِلقَط الإيصالات
 * (الرفضُ نفسه إيصالُ `run`) — الحارس يسمّيه سرّاً والحاجب لا يراه.
 *
 * الترتيب ملزم: `-pw` (plink، عميلُ SSH القياسيّ على ويندوز) قبل `-p`، وإلا
 * جلس المحلّل على `w` فمات على الفراغ وأفلتت كلمةُ المرور.
 */
const SECRET_ARGV_RULES: readonly { readonly head: string; readonly value: string }[] = Object.freeze([
  { head: "(?<![\\w-])-pw\\s*[\"']?", value: "[^\\s\"']{4,}" },
  { head: "(?<![\\w-])-p\\s*[\"']?", value: "[^\\s\"'-]{6,}" },
  { head: "(?<![\\w-])--password[=\\s]+[\"']?", value: "[^\\s\"']{6,}" },
  { head: "(?<![\\w-])PGPASSWORD=", value: "[^\\s]{6,}" },
  // `curl -u user:pass` / `--user user:pass` — أشيعُ لصقةِ اعتمادٍ في محادثة،
  // ولا `://` فيها فلا تراها قاعدةُ رابط الاتصال.
  { head: "(?<![\\w-])--?u(?:ser)?[=\\s]+[\"']?[^\\s:\"']+:", value: "[^\\s\"']{4,}" },
  // `net use \\\\fs01\\share /user:CORP\\admin PASSWORD` — كلمةُ المرور وسيطةٌ
  // موضعيّة بلا اسمٍ قبلها، ومنصّةُ المنتج نفسها هي ويندوز.
  { head: "(?<![\\w-])/user:\\S+\\s+", value: "[^\\s/-][^\\s]{3,}" },
  { head: "(?<![\\w-])[Nn]et\\s+user\\s+\\S+\\s+", value: "[^\\s/-][^\\s]{3,}" },
])
const SECRET_ARGV = new RegExp(SECRET_ARGV_RULES.map((r) => `${r.head}${r.value}`).join("|"), "u")
const SECRET_ARGV_REDACT = SECRET_ARGV_RULES.map((r) => new RegExp(`(${r.head})(${r.value})`, "gu"))

/**
 * قواعدُ ذاتُ سياقٍ بعد القيمة، لا تنقسم إلى «رأسٍ وقيمة» — تُقرأ في الحجب
 * وفي الكشف معاً (مفردةٌ واحدة، جدولٌ واحد).
 * ١) درعُ المفتاح الخاص: `-----BEGIN … PRIVATE KEY-----` هي الإشارةُ الوحيدة
 *    في هذا الفضاء كلّه التي لا تُخطئ أبداً، ولم تكن مقروءةً أصلاً: المفتاحُ
 *    كان يُلتقط عرَضاً بأرضيّة الأربعين محرفاً، فمفتاحُ EC (أسطرٌ قصيرة) يمرّ.
 * ٢) الأنبوبُ إلى المدخل القياسيّ (`echo 'X' | docker login --password-stdin`)
 *    هو الشكلُ **الآمن** الذي يقصده المستخدم الحريص — وكان الوحيد الذي لا يُرى.
 */
const PEM_PRIVATE_KEY = /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/gu
const SECRET_PIPE_STDIN =
  /(?<![\w-])echo\s+(?:-[neE]+\s+)?["']?([^"'\n|]{4,}?)["']?\s*\|[^\n]{0,120}?(?:--password-stdin|--stdin|sudo\s+-S|chpasswd|passwd\s)/gu

/** أمرُ صدفةٍ يمرّر سراً في argv فيصل اللوج/التاريخ. `undefined` = نظيف. */
export function secretInCommandViolation(cmd: string): string | undefined {
  // psql/mysql بكلمة مرور في الوسيطة — الصنف المقيس في القاعدة العليا.
  if (SECRET_ARGV.test(cmd)) {
    return "رُفض تمرير كلمة مرور في سطر الأمر: تُكتب في سجل الأصداف والعمليات (KF-1). استعمل ملف ~/.pgpass أو متغير بيئةٍ محقونٍ لا مكشوفٍ في argv."
  }
  for (const m of cmd.matchAll(SECRET_ASSIGN)) {
    if (looksLikeSecretValue(m[1]!)) {
      return "رُفض سرٌّ حرفيّ في سطر الأمر: يصل سجلّ الأوامر (KF-1/8). مرّره عبر ملفٍ أو متغيّر بيئةٍ من الخزنة، لا نصاً في argv."
    }
  }
  return undefined
}

/** كتابة مصدرٍ تُدخل سراً في ملف client، أو تعطّل TLS، أو تحقن SQL. */
export function secretInSourceViolation(input: { normalizedTarget: string; after: string }): string | undefined {
  const { normalizedTarget: target, after: source } = input

  // 3.12 — قيمة حقيقية في .env.example (يُفحص قبل بوابة الكود: ليس كوداً).
  if (/\.env\.(?:example|sample|template)$/u.test(target)) {
    for (const m of source.matchAll(SECRET_ASSIGN)) {
      if (looksLikeSecretValue(m[1]!)) return "رُفضت قيمة حقيقية في ملف المثال: .env.example يحمل أسماءً وقيماً وهميةً فقط (your-key-here)، لا أسراراً فعلية."
    }
    return undefined
  }

  const isCode = /\.[cm]?[jt]sx?$/iu.test(target)
  if (!isCode) return undefined
  const isTest = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(target)
  if (isTest) return undefined

  // 3.5 — سرٌّ في مكوّن "use client" (يُحزم للمتصفح).
  const isClient = /^\s*["']use client["']/mu.test(source)
  if (isClient) {
    for (const m of source.matchAll(SECRET_ASSIGN)) {
      if (looksLikeSecretValue(m[1]!)) {
        return "رُفض سرٌّ في مكوّن \"use client\": يُحزم إلى المتصفح فيُنشر للإنترنت (KF-9). انقله إلى Server Component أو route handler، واقرأه من البيئة."
      }
    }
  }

  // 9.9 — تعطيل تحقق TLS في المصدر.
  if (/rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0/u.test(source)) {
    return "رُفض تعطيل تحقق TLS في المصدر: يفتح الاتصال للاعتراض. أصلح سبب خطأ الشهادة (شهادة جذر/ساعة/بروكسي) ولا تعطّل التحقق."
  }

  // 5.11 — تضمين متغير نصياً في استعلام SQL (حقن).
  const sqlConcat = /(?:query|execute|exec|prepare|run|all|get)\s*\(\s*[`"'][^`"']*(?:SELECT|INSERT|UPDATE|DELETE|DROP|WHERE)[^`"']*(?:\$\{|["']\s*\+|`\s*\+)/iu
  if (sqlConcat.test(source)) {
    return "رُفض بناء SQL بتضمين متغيّر نصياً (حقن — حادثةٌ مقيسة: 28 موضعاً في مشروعٍ واحد). استعمل معاملات مرتبطة (?، $1) ومرّر القيم منفصلةً، لا سلسلةً مبنية."
  }

  return undefined
}

// ---------------------------------------------------------------------------
// الحجب — المفردات نفسها، في الاتجاه المعاكس (S13.2 / التقاط الإيصالات)
// ---------------------------------------------------------------------------
//
// الحارسان أعلاه **يرفضان**؛ هذا القسم **يحجب** ليُكتب نصُّ إيصالٍ على القرص
// بأمان. المفردات واحدة عمداً — والوحدةُ الآن مقيسةٌ لا مُدّعاة: الرفضُ
// والحجب يقرآن `SECRET_ASSIGN` و`SECRET_ARGV_RULES` و`isExemptValue`
// و`KNOWN_PREFIX_TOKEN` نفسها، واختبارٌ يثبت الاتجاه الملزم: **كلُّ نصٍّ
// يرفضه `secretInCommandViolation` يغيّره `redactSecretValues`**. كان
// الاتجاه مكسوراً: `PGPASSWORD=…` يُرفض ثم يُكتب حرفياً في المِلقَط.

/**
 * الرمز العاري (بلا اسمٍ قبله) — البادئات نفسها، لكن الثنائية منها (sk/pk/rk
 * وأخواتها) يلزمها فاصل `-`/`_` بعدها. السبب مقيس: `KNOWN_PREFIX_TOKEN` بلا
 * فاصلٍ يبتلع نثر الإيصالات نفسه («skipped_because_of…»، «pkg-lock…») فيمحو
 * الأثرَ الذي جئنا نحفظه. التضييق هنا للحجب وحده — فحصُ القيمة أعلاه لم
 * يُمسّ، والمصفاة الطويلة أدناه (`SECRETISH_RESIDUAL`) تلتقط ما فات.
 */
const BARE_KEY_TOKEN = new RegExp(
  `(?<![A-Za-z0-9_-])(?:(?:(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[baprs])[-_]|AKIA|AIza|eyJ)[A-Za-z0-9_-]{8,}|${VENDOR_PREFIX_TOKEN})`,
  "gu",
)
/** الترويسة غير حسّاسة لحالة الأحرف: `authorization: bearer …` شكلٌ شائع كما
 * `Authorization: Bearer …`، وحصرُ المطابقة بالكبيرة كان يكتب الرمز كاملاً.
 * وصنفُ المحارف يقف عند الاقتباس و`<`: كان `\S+` يبتلع علامةَ الإغلاق فيترك
 * الأمرَ مكسوراً نحوياً، ويبتلع `<token>` في التوثيق فيحجب مثالاً لا سرّاً. */
const BEARER_HEADER = /Bearer\s+[^\s"'<>]+/giu
/**
 * `Authorization: Basic <base64>` — اعتمادُ مستخدمٍ وكلمةِ مرورٍ مُرمَّزاً،
 * ولا اسمَ قبله ولا بادئةَ فيه فلا تراه أيُّ قاعدةٍ أخرى. تُشترط هيئةٌ
 * base64 معقولة (`looksLikeEncodedCredential`) كي لا تُبتلع عبارةُ
 * «Basic authentication» في نثر الإيصالات.
 */
const BASIC_HEADER = /(?<![A-Za-z0-9])([Bb]asic\s+)([A-Za-z0-9+/]{10,}={0,2})(?![A-Za-z0-9+/=])/gu
const looksLikeEncodedCredential = (value: string): boolean =>
  /[+/=]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)) || (/[A-Za-z]/.test(value) && /[0-9]/.test(value))
/** بيانات اعتمادٍ داخل رابط اتصال (`postgres://user:pass@host`) — لا اسم قبلها
 * فلا يراها SECRET_ASSIGN. اسمُ المستخدم **قد يكون فارغاً**: `redis://:pass@`
 * هو الشكلُ الذي توثّقه Redis نفسها وتسلّمه كلُّ لوحةِ استضافة. */
const URL_CREDENTIALS = /(:\/\/[^:/\s@]*:)([^@\s]+)(@)/gu

/**
 * كتلةُ base64 قصيرة تفكّ إلى `user:pass` — اعتمادُ Basic بلا ترويسته. عشرون
 * محرفاً لا تبلغ أرضيّةَ الأربعين، ولصقُ الشكل المُرمَّز (من فرقٍ أو إعداد)
 * أمرٌ عاديّ. الفحصُ بالفكّ لا بالطول: صفرُ إيجابيّاتٍ كاذبة بالبناء.
 */
const B64_PAIR_TOKEN = /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9+/=])/gu
const decodesToCredentialPair = (value: string): boolean => {
  if (value.length % 4 !== 0) return false
  try {
    const decoded = atob(value)
    return /^[\x20-\x7E]+:[\x20-\x7E]+$/u.test(decoded)
  } catch {
    return false
  }
}

/**
 * نسخةٌ من `SECRETISH` (cli.ts) موسَّعةً بمحارف base64 وحدها (`+ / =`) —
 * توسيعُ صنفِ المحارف يزيد ما يُمسك ولا ينقصه، فكلُّ ما يرفضه حارسُ الإعدادات
 * يرفضه هذا يقيناً (اختبار يثبت الاتجاهين). يُستعمل مصفاةً أخيرة: ما بقي بعد
 * الحجب طويلاً وعشوائياً يُحجب في التقاط، ويُرفض عند الترقية إلى fixture.
 */
export const SECRETISH_RESIDUAL = /sk-[A-Za-z0-9]{12,}|[Bb]earer\s|[A-Za-z0-9_+/=-]{40,}/
const SECRETISH_RESIDUAL_G = new RegExp(SECRETISH_RESIDUAL.source, "gu")
/** بصمة دليلٍ (sha256) ليست سرّاً — حجبها يمحو «بصمة الدليل» من الأثر. */
const EVIDENCE_DIGEST = /^[0-9a-f]{64}$/u

/**
 * يحجب قيم الأسرار في نصٍّ قبل كتابته. لا يرمي أبداً، ومتساوي القوى
 * (تمريرةٌ ثانية على ناتجه تعيد صفر حجب).
 */
export function redactSecretValues(text: string): { text: string; redactions: number } {
  if (typeof text !== "string" || text.length === 0) return { text: "", redactions: 0 }
  let redactions = 0
  // (٠) درعُ المفتاح الخاص كاملاً قبل كل شيء: أيُّ قاعدةٍ أخرى تقصّه نصفين.
  let out = text.replace(PEM_PRIVATE_KEY, () => { redactions += 1; return REDACTED })
  // (١) إسنادٌ باسمٍ سرّيّ: الاسمُ دليل، فالعتبةُ عتبةُ الحارس نفسها.
  out = out.replace(SECRET_ASSIGN, (match: string, value: string) => {
    if (!looksLikeNamedSecretValue(value)) return match
    redactions += 1
    return match.slice(0, match.length - value.length) + REDACTED
  })
  // (٢) كلمةُ المرور في argv — القائمةُ التي يرفضها الحارس بعينها.
  for (const rule of SECRET_ARGV_REDACT) {
    out = out.replace(rule, (match: string, head: string, value: string) => {
      if (isExemptValue(value)) return match
      redactions += 1
      return `${head}${REDACTED}`
    })
  }
  // (٢ب) القيمةُ المُمرَّرة بالأنبوب إلى المدخل القياسيّ.
  out = out.replace(SECRET_PIPE_STDIN, (match: string, value: string) => {
    if (isExemptValue(value)) return match
    redactions += 1
    return match.replace(value, REDACTED)
  })
  // (٣) ترويسة Bearer كاملةً (كلمتها وحدها تطابق SECRETISH فلا تُترك)، ثم
  // اعتمادُ Basic المُرمَّز، ثم الرمز العاري، ثم كتلةُ base64 التي تفكّ اعتماداً.
  out = out.replace(BEARER_HEADER, () => { redactions += 1; return REDACTED })
  out = out.replace(BASIC_HEADER, (match: string, head: string, value: string) => {
    if (!looksLikeEncodedCredential(value) || isExemptValue(value)) return match
    redactions += 1
    return `${head}${REDACTED}`
  })
  out = out.replace(BARE_KEY_TOKEN, () => { redactions += 1; return REDACTED })
  out = out.replace(B64_PAIR_TOKEN, (match: string) => {
    if (!decodesToCredentialPair(match)) return match
    redactions += 1
    return REDACTED
  })
  // (٤) كلمة المرور داخل رابط الاتصال.
  out = out.replace(URL_CREDENTIALS, (_match: string, head: string, _password: string, tail: string) => {
    redactions += 1
    return `${head}${REDACTED}${tail}`
  })
  return { text: out, redactions }
}

/** ما بقي شبيهاً بسرٍّ بعد الحجب — بصمات الدليل (sha256) ليست منه. */
export function residualSecretMatches(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return []
  const found: string[] = []
  for (const match of text.matchAll(SECRETISH_RESIDUAL_G)) {
    if (EVIDENCE_DIGEST.test(match[0])) continue
    found.push(match[0])
  }
  return found
}

/** مصفاةٌ أخيرة قبل الكتابة: كلُّ بقيّةٍ طويلة تُحجب (بصمة الدليل تبقى). */
export function sweepResidualSecrets(text: string): { text: string; redactions: number } {
  if (typeof text !== "string" || text.length === 0) return { text: "", redactions: 0 }
  let redactions = 0
  const out = text.replace(SECRETISH_RESIDUAL_G, (match: string) => {
    if (EVIDENCE_DIGEST.test(match)) return match
    redactions += 1
    return REDACTED
  })
  return { text: out, redactions }
}

// ---------------------------------------------------------------------------
// الاتجاه الثالث: الجسدُ الوارد — تسليمُ اعتمادٍ داخل المحادثة نفسها
// ---------------------------------------------------------------------------
//
// أمر المالك 2026-09-02: «يجب عند اخبار المستخدم له الحساب كذا و الباسورد كذا
// دخلهم في كذا يطلع تحذير تدوير الاسرار…». الحارسان أعلاه يريان **الأمر**
// و**كتابة المصدر**؛ ولا أحد كان يرى **جسد الدور**. القسم أدناه يمدّ المفردات
// نفسها إلى الجسد: لا تعبيرَ منفصلاً، ولا علامةَ حجبٍ ثانية.
//
// ثلاثة دروسٍ مدفوعة أعادت بناءه 2026-09-02 بعد جولة فريقٍ أحمر:
//
// ١) **الكشفُ والحجبُ جدولٌ واحد بالبناء**. كانا تمريرتين متوازيتين تفترقان:
//    كلمةُ مرور `docker login -p` تُحجب ولا تُسمّى (فلا تحذيرَ تدوير)، وقيمةٌ
//    تُسمّى ولا تُحجب (فالتحذيرُ يقول «لم يُخزَّن» والقرصُ يحمله). الآن
//    `redactInboundBody` **يُبنى من مواضع `inboundSecretSpans` وحدها**، فـ
//    «حَمَل سرّاً» و«تغيّر الجسد» صارا الشيء نفسه لا دعويين متجاورتين.
//
// ٢) **الرسمُ يُطوى مرّةً واحدة قبل المطابقة**. تشكيلةٌ واحدة في «كلمةُ»، أو
//    ألفٌ مقصورة في «السرى»، أو محرفٌ صفريُّ العرض ملصوقٌ من طرفيّة، أو رقمٌ
//    هنديّ «٩٨٧» — كلٌّ منها كان يُسقط الحارسَ كلَّه. يُطبَّع النصّ (تشكيل،
//    تطويل، محارف اتجاهٍ وصفريّةُ عرض، ألف/ياء/تاء مربوطة، أرقام) مع خريطةِ
//    مواضع تعيد كلّ مطابقةٍ إلى **النصّ الأصليّ** — فالحجبُ يقع على الأصل.
//
// ٣) **النيّةُ وحدها لا تفتح محرّراً**. كان «حَمَل سرّاً» = موضعٌ **أو** نيّة،
//    فسؤالٌ بريء («كيف أسجل الدخول؟») يفتح نوت باد ويكتب في الخزنة. صارت:
//    موضعٌ مقيس **فقط**. النيّةُ تبقى موسِّعاً للمطابقة لا مُنشئاً لها.

/** شكلُ الاعتماد كما رُئي — يُسمّى للمشرف، والقيمة لا تُذكر أبداً. */
export type SecretShape =
  | "api-key"
  | "password"
  | "bearer-token"
  | "connection-string"
  | "encoded-credential"
  | "account-handle"

/** اسمُ الشكل بالعربية — مصدرٌ واحد لسطر التحذير ولنصّ القالب. */
export const SECRET_SHAPE_LABEL: Readonly<Record<SecretShape, string>> = Object.freeze({
  "api-key": "مفتاح واجهة (API key)",
  password: "كلمة مرور",
  "bearer-token": "رمز حامل (Bearer token)",
  "connection-string": "سلسلة اتصال بقاعدة بيانات",
  "encoded-credential": "اعتماد مُرمَّز أو قيمة عشوائية طويلة",
  "account-handle": "اسم حساب/بريد دخول",
})

/** موضعٌ رُئي فيه اعتماد — الشكل والمدى فقط، بلا نصٍّ منقول. */
export interface SecretSpan {
  readonly kind: SecretShape
  readonly start: number
  readonly length: number
}

// ── (أ) التطبيع: رسمٌ واحد للكشف، وخريطةٌ تعيده إلى النصّ الأصليّ ────────────

/** ما يُسقَط قبل المطابقة: تشكيل، تطويل، علاماتُ اتجاهٍ وصفريّةُ العرض. */
const DROPPED_MARK = /[\u0640\u064B-\u065F\u0670\u06D6-\u06ED\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/u
const DROPPED_MARK_G = new RegExp(DROPPED_MARK.source, "gu")
/** لبُّ علامة الحجب بلا قوسيها ولا تشكيلها — يُقارَن به قارئُ القيمة. */
const REDACTED_CORE = REDACTED.replace(DROPPED_MARK_G, "").replace(/^«|»$/gu, "")
/** نزعُ العلامات وحده — يُستعمل في مقارنة علامة الحجب بعد التطبيع. تصريحُ
 * دالّةٍ لا ثابتاً: يقرؤه `isReferenceValue` أعلاه، والرفعُ يجعله متاحاً. */
function stripMarks(value: string): string {
  return value.replace(DROPPED_MARK_G, "")
}

/** طيُّ الرسم: ألفٌ وياءٌ وتاءٌ مربوطة وكافٌ فارسية، واقتباسٌ ذكيّ. 1:1 دوماً. */
const FOLD_ONE: Readonly<Record<string, string>> = Object.freeze({
  "\u0623": "\u0627", "\u0625": "\u0627", "\u0622": "\u0627", "\u0671": "\u0627",
  "\u0649": "\u064A", "\u06CC": "\u064A", "\u0626": "\u064A",
  "\u0629": "\u0647", "\u06A9": "\u0643", "\u0624": "\u0648",
  "\u201C": "\"", "\u201D": "\"", "\u201E": "\"", "\u201F": "\"",
  "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u2032": "'",
})

interface NormalizedText {
  readonly text: string
  /** موضعُ كلِّ محرفٍ مطبَّعٍ في النصّ الأصليّ. */
  readonly at: readonly number[]
}

/**
 * يطوي الرسم ويحفظ الخريطة. كلُّ طيٍّ 1:1 وكلُّ إسقاطٍ يترك فجوةً في الخريطة،
 * فمدى `[at[i], at[j]+1)` في الأصل يشمل ما أُسقط بينهما بالضرورة — وبهذا
 * يُحجب سرٌّ فيه محرفٌ صفريُّ العرض **كاملاً** لا مقسوماً نصفين.
 */
function normalizeForDetection(raw: string): NormalizedText {
  let text = ""
  const at: number[] = []
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (DROPPED_MARK.test(ch)) continue
    const folded = FOLD_ONE[ch]
    if (folded !== undefined) {
      text += folded
    } else {
      const code = ch.charCodeAt(0)
      if (code >= 0x0660 && code <= 0x0669) text += String.fromCharCode(48 + code - 0x0660)
      else if (code >= 0x06F0 && code <= 0x06F9) text += String.fromCharCode(48 + code - 0x06F0)
      else text += ch
    }
    at.push(i)
  }
  return { text, at }
}

// ── (ب) أصنافُ الكلمات: ما لا يكون قيمةَ اعتمادٍ أبداً ──────────────────────

/** كلماتُ بناءٍ — وجودُها داخل عبارةٍ يقول «هذه جملةٌ لا قيمة». */
const FUNCTION_WORD = new Set<string>([
  // عربية (بالرسم المطبَّع)
  "في", "من", "على", "عن", "الى", "ان", "انه", "انها", "لا", "ولا", "ما", "هل", "هذا", "هذه", "هذي",
  "ذلك", "التي", "الذي", "كان", "تكون", "يكون", "يجب", "لازم", "مع", "او", "ثم", "لكن", "ولكن", "كل",
  "لكل", "بعض", "عند", "عندي", "بعد", "قبل", "حتي", "كي", "لكي", "هو", "هي", "هم", "نحن", "انت", "انا",
  "سوف", "قد", "لم", "لن", "ليس", "ليست", "غير", "بلا", "بدون", "فقط", "ايضا", "مثل", "حول", "بين",
  "تحت", "فوق", "خلال", "وهو", "وهي", "لماذا", "كيف", "متي", "اين", "الان", "ايضاً",
  // إنجليزية
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "in", "on", "at", "of", "to",
  "for", "with", "and", "or", "not", "no", "but", "if", "then", "else", "this", "that", "these",
  "those", "it", "its", "we", "you", "your", "our", "they", "their", "my", "me", "i", "his", "her",
  "has", "have", "had", "will", "would", "should", "could", "can", "may", "must", "do", "does", "did",
  "so", "as", "by", "from", "into", "over", "under", "about", "after", "before", "when", "while",
  "where", "why", "how", "all", "any", "every", "each", "some", "most", "more", "less", "only",
  "also", "never", "always", "still", "just", "than", "too", "very", "per", "via", "use", "using",
  "used", "here", "there",
])

/** كلماتُ حالٍ — «the password is **expired**» خبرٌ لا قيمة. */
const STATE_WORD = new Set<string>([
  "stored", "hashed", "encrypted", "rotated", "refreshed", "revoked", "expired", "invalid", "valid",
  "wrong", "missing", "empty", "blank", "required", "optional", "set", "unset", "enabled", "disabled",
  "broken", "working", "fine", "ok", "okay", "weak", "strong", "short", "long", "same", "different",
  "ready", "unknown", "supported", "unsupported", "needed", "gone", "safe", "secure", "public",
  "private", "hidden", "burned",
  "خاطيه", "صحيحه", "ضعيفه", "قويه", "مطلوبه", "ناقصه", "محفوظه", "مشفره", "منتهيه", "مفقوده",
  "محجوب", "محروق", "جديده", "قديمه",
])

/** قيمٌ نائبةٌ معروفة — نصٌّ توضيحيٌّ لا اعتماد. */
const PLACEHOLDER_VALUE = new Set<string>([
  "changeme", "change-me", "example", "examples", "your-password-here", "your-key-here",
  "yourpassword", "yourkey", "placeholder", "todo", "tbd", "xxx", "xxxx", "xxxxx", "undefined",
  "null", "none", "true", "false", "string", "number", "boolean", "secret", "password", "passwd",
  "redacted", "dummy", "fake", "sample", "test", "foo", "bar", "baz", "value", "mypassword",
  "yourvalue", "somevalue", "token", "apikey", "api_key",
])

/** مسارٌ أو معرّفٌ لا اعتماد — يُستثنى من المصفاة الطويلة في الجسد الوارد. */
const looksLikePathOrIdentifier = (value: string): boolean => {
  if (/^[0-9a-f]{7,}$/iu.test(value)) return true // بصمةُ كوميت أو مُلخَّص
  if (/[/\\]/u.test(value) && /^[\w.@~:+-]*(?:[/\\][\w.@~:+-]*)+$/u.test(value)) return true // مسار
  if (/^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/u.test(value)) return true // اسمُ فرعٍ/حزمةٍ صغير الحروف
  return false
}

// ── (ج) قارئُ القيمة: ما يُنهي القيمة هو الحدّ، لا قائمةُ محارفَ مسموحة ─────
//
// كان صنفُ المحارف قائمةَ سماحٍ لا تعرف `( ) [ ] { } , ; \` < >`، وهي محارفُ
// كلماتِ مرورٍ عاديّة، فتقف المطابقةُ عند أوّلها وتسقط القيمةُ كلُّها تحت
// الحدّ الأدنى فلا تُحجب. الآن: القيمةُ تمتدّ حتى فراغٍ أو سطرٍ جديد، أو حتى
// علامةِ الإغلاق إن فُتحت باقتباس.

const OPEN_QUOTE: Readonly<Record<string, string>> = Object.freeze({ "\"": "\"", "'": "'", "«": "»" })
/** ترقيمُ نهايةِ جملةٍ يُقصّ من ذيل القيمة — «services.» ليست قيمةً بنقطتها. */
const TRAILING_PUNCT = /[.,;:!?…،؛"'»]+$/u

/** يقصّ ذيلَ الترقيم والأقواسَ غيرَ المتوازنة. */
function trimValueTail(value: string): string {
  let out = value.replace(TRAILING_PUNCT, "")
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"]] as const) {
    while (out.endsWith(close) && out.split(close).length > out.split(open).length) out = out.slice(0, -1)
  }
  return out
}

interface ReadValue {
  readonly value: string
  /** موضعُ القيمة ومداها في النصّ المطبَّع. */
  readonly start: number
  readonly end: number
  readonly quoted: boolean
}

/** يقرأ قيمةً واحدة عند `pos` (بعد استهلاك الواصل). `undefined` = لا قيمة. */
function readValueAt(text: string, pos: number): ReadValue | undefined {
  const opener = text[pos]
  const closer = opener === undefined ? undefined : OPEN_QUOTE[opener]
  if (closer !== undefined) {
    const end = text.indexOf(closer, pos + 1)
    if (end > pos + 1) {
      const value = text.slice(pos + 1, end)
      if (!value.includes("\n")) return { value, start: pos + 1, end, quoted: true }
    }
  }
  let end = pos
  while (end < text.length && !/[\s]/u.test(text[end]!)) end += 1
  if (end === pos) return undefined
  const raw = text.slice(pos, end)
  const value = trimValueTail(raw)
  if (value.length === 0) return undefined
  return { value, start: pos, end: pos + value.length, quoted: false }
}

const hasDigit = (v: string): boolean => /[0-9]/u.test(v)
const hasLatin = (v: string): boolean => /[A-Za-z]/u.test(v)
const isArabicOnly = (v: string): boolean => /^[\u0600-\u06FF]+$/u.test(v)
const isPlainWord = (v: string): boolean => /^[\p{L}\p{N}]+$/u.test(v)
const isProseWord = (v: string): boolean => FUNCTION_WORD.has(v.toLowerCase()) || STATE_WORD.has(v.toLowerCase())
const isPlaceholder = (v: string): boolean => PLACEHOLDER_VALUE.has(v.toLowerCase())

/** هيئةُ اعتمادٍ ظاهرة: بادئةٌ معروفة، أو خلطُ حروفٍ وأرقام، أو رمزٌ غيرُ حرفيّ. */
const looksCredentialShaped = (v: string): boolean => {
  if (KNOWN_PREFIX_TOKEN.test(v)) return true
  if (hasLatin(v) && hasDigit(v)) return true
  return /[^\p{L}\p{N}]/u.test(v)
}

// ── (د) جدولُ الأسماء — بالرسم المطبَّع، ومعه ما يقبله كلُّ اسم ─────────────

interface LabelRule {
  readonly pattern: string
  readonly kind: SecretShape
  /** لا يقبل إلا واصلاً صريحاً (`:` `=` «هو») — للأسماء الشائعة في النثر. */
  readonly strict?: true
  /** يقبل عبارةً متعدّدةَ الكلمات بعد واصلٍ صريح (كلمةُ مرورٍ/عبارةُ استرداد). */
  readonly phrase?: true
  /** لا يُشترط حضورُ نيّةِ تسليم — الأسماءُ العامّة (حساب/يوزر) تشترطها. */
  readonly needsIntent?: true
  /** واصلٌ صريحٌ إضافيّ يخصّ هذا الاسم وحده (`login **with** …`). لا يُعمَّم:
   * جعلُ `with` واصلاً لكل اسمٍ يحوّل «the password with 12 characters» قيمة. */
  readonly altJoin?: string
  /** لا تُقبل إلا قيمةٌ ذاتُ هيئةِ اعتماد — لا كلمةَ نثرٍ سليمة. يخصّ أسماءَ
   * الحسابات الإنجليزية: «login with SSO is not supported» جملةٌ لا تسليم. */
  readonly shapedOnly?: true
}

const LABEL_RULES: readonly LabelRule[] = Object.freeze([
  // كلمةُ المرور بكلّ رسمها ولهجتها، مع لواحق الملكية والجمع.
  { pattern: "(?:ال)?(?:باسوورد|باسورد|باصورد|پاسوورد|پاسورد|باسوردات|باسووردات)(?:ي|ك|نا|ه|ها|هم)?", kind: "password", phrase: true },
  { pattern: "كلم(?:ه|ات)\\s+(?:ال)?(?:سر|مرور)", kind: "password", phrase: true },
  { pattern: "(?:ال)?رقم\\s+(?:ال)?سري", kind: "password", phrase: true },
  { pattern: "رمز\\s+(?:ال)?(?:دخول|مرور|تحقق)", kind: "password" },
  { pattern: "بيانات\\s+(?:ال)?دخول", kind: "password" },
  { pattern: "(?:ال)?كود", kind: "password" },
  { pattern: "(?:ال)?شفره", kind: "password" },
  { pattern: "(?:ال)?سر(?:ي)?", kind: "password", strict: true },
  { pattern: "(?:ال)?باس", kind: "password", strict: true },
  { pattern: "passwords?|passwd|passcode|pass\\s?phrases?|passphrases?|pwd", kind: "password", phrase: true },
  { pattern: "pass|pin|credentials?", kind: "password", strict: true },
  // عبارةُ الاسترداد — أثمنُ اعتمادٍ يلصقه مستخدمٌ غيرُ تقنيّ، وكانت بلا اسم.
  { pattern: "عباره\\s+(?:ال)?استرداد|كلمات\\s+(?:ال)?استرداد|(?:ال)?عباره\\s+(?:ال)?سريه|seed\\s?phrase|recovery\\s?phrase|backup\\s?phrase|mnemonic", kind: "password", phrase: true },
  // المفتاح والرمز.
  { pattern: "(?:ال)?مفتاح(?:\\s+(?:ال)?(?:api|واجهه|سري))?", kind: "api-key" },
  { pattern: "(?:ال)?توكن", kind: "api-key" },
  { pattern: "api[\\s_-]?keys?|apikeys?|access[\\s_-]?tokens?|secret[\\s_-]?keys?|bearer[\\s_-]?tokens?|tokens?", kind: "api-key" },
  { pattern: "secrets?", kind: "api-key", strict: true },
  // اسمُ الحساب — لا يُحجب إلا مع نيّةِ تسليمٍ معلنة (يقلّل الإفراط).
  { pattern: "(?:ال)?حساب(?:ي)?|اسم\\s+(?:ال)?مستخدم|(?:ال)?يوزر", kind: "account-handle", needsIntent: true },
  { pattern: "usernames?|user\\s?names?|accounts?|logins?", kind: "account-handle", strict: true, needsIntent: true, altJoin: "with|using|as", shapedOnly: true },
])

/**
 * حدودُ الكلمة في العربية لا تُؤخذ بـ`\b`: JS يعدّ الحرف العربي «غير كلمة»
 * فتطابق `\b` داخل الكلمة نفسها (درسٌ مدفوع في مجموعة نيّات اللهجات).
 * البديل المقيس: نظرةٌ خلفية/أمامية على صنف الحروف `\p{L}`.
 */
const NOT_LETTER_BEFORE = "(?<![\\p{L}\\p{N}_])"
const NOT_LETTER_AFTER = "(?![\\p{L}\\p{N}_])"
/**
 * السوابق المتّصلة (و/ف/ب/ل/ك): «**و**الباسورد» كلمةٌ واحدة في الرسم، والنظرة
 * الخلفية أعلاه تراها حرفاً قبل الاسم فتمنع المطابقة — فكانت جملةُ المالك
 * نفسها («الحساب admin **و**الباسورد …») تفلت من قاعدة كلمة المرور.
 */
const CLITIC = "[وفبلك]?"

const labelRegex = (rule: LabelRule): RegExp =>
  new RegExp(`${NOT_LETTER_BEFORE}${CLITIC}(?:${rule.pattern})${NOT_LETTER_AFTER}`, "giu")

const COMPILED_LABELS: readonly { readonly rule: LabelRule; readonly re: RegExp }[] = Object.freeze(
  LABEL_RULES.map((rule) => Object.freeze({ rule, re: labelRegex(rule) })),
)
/** أيُّ اسمٍ سرّيٍّ كان — تُوقف العبارةُ عنده («…والباسورد الثاني: …»). */
const ANY_LABEL = new RegExp(`^(?:${CLITIC}(?:${LABEL_RULES.map((r) => r.pattern).join("|")}))$`, "iu")

// ── (هـ) نيّةُ التسليم: موسِّعٌ للمطابقة، لا مُنشئٌ لها ──────────────────────
//
// «الغياب رفضٌ لا إذن» تخصّ القيمة لا النيّة: نيّةٌ بلا قيمةٍ مقيسة ليست
// اعتماداً، وجعلُها كذلك كان يفتح نوت باد على سطح المكتب لسؤالٍ بريء. وحدودُ
// الكلمة لازمة هنا أيضاً: «أسجل الدخول» ليست «سجل الدخول».

const HANDOVER_INTENT = new RegExp(
  NOT_LETTER_BEFORE +
    "(?:" +
    [
      "(?:د(?:خّ?ل|خِّل)|ادخل|أدخل)\\s*(?:هم|ها|ه)?\\s*(?:في|ب|على)",
      "سجّ?ل\\s+(?:ال)?دخول\\s*(?:ب|في|إلى|الى)",
      "(?:است?عمل|استخدم)\\s+(?:هذا|هذه|هالـ?|ال)?\\s*(?:الباسورد|الحساب|المفتاح|التوكن|كلمة|الاعتماد)",
      "(?:حطّ?|ضع)\\s*(?:هم|ها|ه)\\s+(?:في|ب)",
      "(?:هذا|هذه)\\s+(?:حسابي|بياناتي|اعتمادي)",
      "بحسابي|حسابي\\s+هو",
      "the\\s+(?:password|pass\\s?phrase|passphrase|api\\s*key|token|secret|credentials)\\s+(?:is|are)",
      "use\\s+(?:this|these|my)\\s+(?:api\\s*key|key|token|password|credentials|account)",
      "(?:log\\s?in|login|sign\\s?in)\\s+(?:with|using|as)\\s",
      "put\\s+(?:them|it|these)\\s+in",
      "here\\s+(?:is|are)\\s+(?:my|the)\\s+(?:password|credentials|api\\s*key|token)",
    ].join("|") +
    ")",
  "iu",
)

/** هل أعلن الجسدُ نيّةَ تسليمِ اعتماد؟ خالصةٌ ولا ترمي. */
export function handoverIntent(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false
  return HANDOVER_INTENT.test(normalizeForDetection(text).text)
}

// ── (و) قواعدُ الهيئة: المفرداتُ القائمة، كلٌّ بشكلها ───────────────────────

const SHAPE_RULES: readonly {
  readonly re: RegExp
  readonly kind: SecretShape
  readonly group: number
  readonly accept?: (value: string) => boolean
}[] = Object.freeze([
  Object.freeze({ re: new RegExp(PEM_PRIVATE_KEY.source, "gu"), kind: "encoded-credential" as const, group: 0 }),
  Object.freeze({ re: new RegExp(BEARER_HEADER.source, "giu"), kind: "bearer-token" as const, group: 0 }),
  Object.freeze({ re: new RegExp(BASIC_HEADER.source, "gu"), kind: "encoded-credential" as const, group: 2, accept: (v: string) => looksLikeEncodedCredential(v) && !isExemptValue(v) }),
  Object.freeze({ re: new RegExp(BARE_KEY_TOKEN.source, "gu"), kind: "api-key" as const, group: 0 }),
  Object.freeze({ re: new RegExp(B64_PAIR_TOKEN.source, "gu"), kind: "encoded-credential" as const, group: 0, accept: decodesToCredentialPair }),
  Object.freeze({ re: new RegExp(URL_CREDENTIALS.source, "gu"), kind: "connection-string" as const, group: 2, accept: (v: string) => !isReferenceValue(v) }),
  Object.freeze({ re: new RegExp(SECRET_PIPE_STDIN.source, "gu"), kind: "password" as const, group: 1, accept: (v: string) => !isExemptValue(v) && !isPlaceholder(v) }),
  // كلمةُ المرور في argv — الجدولُ نفسه الذي يقرؤه الحجب، فما يُحجب يُسمّى.
  ...SECRET_ARGV_RULES.map((rule) =>
    Object.freeze({ re: new RegExp(`(?:${rule.head})(${rule.value})`, "gu"), kind: "password" as const, group: 1, accept: (v: string) => !isExemptValue(v) && !isPlaceholder(v) }),
  ),
])

/**
 * قبولُ قيمةٍ مسنَدةٍ إلى اسمٍ سرّيّ **في الجسد الوارد**. المفردةُ واحدة
 * (`SECRET_ASSIGN`)، والفرقُ في القبول لا في التعبير: نصُّ محادثةٍ بشريّة يحمل
 * نثراً («secret: management is hard») وقيماً نائبةً («changeme») لا يحملهما
 * إيصالُ أداة. النقطتان المتبوعتان بفراغٍ وكلمةٍ إنجليزيةٍ صِرفة = جملة.
 */
const inboundAssignAccept = (match: string, value: string): boolean => {
  const trimmed = trimValueTail(value)
  if (trimmed.length < 4 || isReferenceValue(trimmed) || isPlaceholder(trimmed)) return false
  if (isShapeExemptValue(trimmed) && !/[=]\s*$/u.test(match.slice(0, match.length - value.length))) {
    // مسارٌ/رابطٌ بعد نقطتين في نثرٍ — لا بعد إسنادٍ صريح.
    if (!looksCredentialShaped(trimmed)) return false
  }
  const prose = /:\s+$/u.test(match.slice(0, match.length - value.length))
  if (prose && /^[a-z]+$/u.test(trimmed)) return false // «token: refresh flow…»
  return trimmed.length >= 4
}

// ── (ز) الماسحُ: اسمٌ ← حشوٌ عربيّ ← واصلٌ ← قيمة ────────────────────────────

type JoinKind = "explicit" | "weak" | "space" | "none"

interface JoinRead { readonly next: number; readonly kind: JoinKind }

/** الروابطُ الصريحة الأساسية — «هو/هي/is/are»، ويُلحق بها واصلُ الاسم إن كان له. */
const JOIN_WORDS = "هو|هي|هوه|is|are"

/** يقرأ الواصل بعد الاسم. الاقتباسُ المُغلِق يُتخطّى (مفتاحُ JSON عربيّ). */
function readJoin(text: string, from: number, altJoin?: string): JoinRead {
  let pos = from
  if (pos < text.length && (text[pos] === "\"" || text[pos] === "'" || text[pos] === "»")) pos += 1
  const rest = text.slice(pos)
  // «كلمة السر **هي:** …» — الرابطةُ ثم النقطتان معاً شكلٌ عاديّ، واشتراطُ
  // فراغٍ بعد الرابطة وحده كان يُسقط الجملةَ إلى واصلٍ فضفاض فتُرفض قيمتُها.
  const words = altJoin === undefined ? JOIN_WORDS : `${JOIN_WORDS}|${altJoin}`
  const explicit = new RegExp(
    `^(?:[ \\t]*(?:[:=]+|->|=>|\\u2192)[ \\t]*|[ \\t]+(?:${words})(?:[ \\t]*[:=]+[ \\t]*|[ \\t]+))`,
    "u",
  ).exec(rest)
  if (explicit !== null) return { next: pos + explicit[0].length, kind: "explicit" }
  const weak = /^(?:[ \t]*[،,؛;|][ \t]*)/u.exec(rest)
  if (weak !== null) return { next: pos + weak[0].length, kind: "weak" }
  const space = /^[ \t]+/u.exec(rest)
  if (space !== null) return { next: pos + space[0].length, kind: "space" }
  return { next: pos, kind: "none" }
}

interface PhraseRead { readonly value: string; readonly start: number; readonly end: number }

/**
 * يقرأ عبارةً من كلماتٍ سليمة (حروف/أرقام بلا رموز) حتى نهايةِ السطر أو علامةِ
 * قطع. تتوقّف عند كلمةِ بناءٍ أو حالٍ — وحينها **تسقط العبارةُ كلُّها**:
 * انقطاعُها بكلمةِ بناءٍ دليلُ أنها جملةٌ لا قيمة. وهذا هو الفرقُ المقيس بين
 * «the password is correct horse battery staple» (عبارةُ مرورٍ تصل نهايةَ
 * السطر) و«the token is refreshed automatically every hour» (جملةٌ تنقطع عند
 * «every»).
 */
function readPhrase(text: string, from: number): PhraseRead | undefined {
  let pos = from
  const words: string[] = []
  let end = from
  while (words.length < 24) {
    const m = /^[^\s\n]+/u.exec(text.slice(pos))
    if (m === null) break
    const word = m[0]
    if (!isPlainWord(word)) break
    if (words.length > 0 && isProseWord(word)) return undefined
    // اسمٌ سرّيٌّ آخر يقطع العبارة **حين يقود قيمةً أخرى** («…والباسورد الثاني:
    // …»)، لا حين يقع كلمةً داخلها («الباسورد: my **secret** pass 2026»).
    if (words.length > 0 && ANY_LABEL.test(word) && readJoin(text, pos + word.length).kind === "explicit") return undefined
    words.push(word)
    end = pos + word.length
    const after = text.slice(end)
    if (/^[ \t]*(?:\n|$)/u.test(after) || /^[ \t]*[—–;؛…]/u.test(after) || /^[ \t]*-\s/u.test(after)) {
      return { value: text.slice(from, end), start: from, end }
    }
    const gap = /^[ \t]+/u.exec(after)
    if (gap === null) break
    pos = end + gap[0].length
  }
  return undefined
}

/** حدُّ أدنى لقيمةٍ ذاتِ هيئةِ اعتماد بعد اسمٍ صريح — PIN وCVV منها. */
const LABELLED_SHAPED_MIN = 4
/** حدُّ أدنى لكلمةٍ سليمةٍ بعد اسمٍ صريح («the password is **cat**»). */
const LABELLED_WORD_MIN = 3

interface LabelledValue { readonly start: number; readonly end: number }

/**
 * زوجُ «حسابٌ / كلمةُ مرور» بعد واصلٍ صريح — الشكلُ الذي يكتبه المستخدم فعلاً:
 * «بيانات الدخول: admin / hunter2xy». كان يسقط لأن الضفّة اليسرى كلمةٌ سليمة
 * فتُقرأ عبارةً تنقطع عند «/» فتُرفض، والقيمةُ الحقيقية على اليمين تُكتب.
 */
function pairAfterJoin(norm: string, at: number): LabelledValue[] {
  const m = /^([^\s/|]{3,})[ \t]*[/|][ \t]*([^\s/|]{3,})(?=[ \t]*(?:\n|$|[—–;؛.،,]))/u.exec(norm.slice(at))
  if (m === null) return []
  const left = trimValueTail(m[1]!)
  const right = trimValueTail(m[2]!)
  if (left.length < LABELLED_WORD_MIN || right.length < LABELLED_WORD_MIN) return []
  for (const v of [left, right]) if (isProseWord(v) || isPlaceholder(v) || isReferenceValue(v)) return []
  if (!looksCredentialShaped(left) && !looksCredentialShaped(right)) return []
  const leftAt = at + m[0].indexOf(left)
  const rightAt = at + m[0].lastIndexOf(right)
  return [
    { start: leftAt, end: leftAt + left.length },
    { start: rightAt, end: rightAt + right.length },
  ]
}

/**
 * ترتيبٌ معكوس: «hunter2xy **هو** الباسورد» — القيمةُ تسبق الاسم. تُشترط هيئةُ
 * اعتمادٍ ظاهرة كي لا تُبتلع «الاسمُ هو الباسورد».
 */
function valueBeforeLabel(norm: string, labelStart: number): LabelledValue[] {
  const before = norm.slice(0, labelStart)
  const m = /([^\s]{4,})[ \t]+(?:هو|هي|هوه|is|are)[ \t]+$/u.exec(before)
  if (m === null) return []
  const value = trimValueTail(m[1]!)
  if (value.length < LABELLED_SHAPED_MIN || !looksCredentialShaped(value)) return []
  if (isExemptValue(value) || isPlaceholder(value) || isProseWord(value)) return []
  const at = before.lastIndexOf(value)
  return at < 0 ? [] : [{ start: at, end: at + value.length }]
}

/**
 * يستخرج القيمةَ التي تلي اسماً سرّيّاً في النصّ المطبَّع. يتخطّى حتى ثلاثِ
 * كلماتٍ عربيةٍ حشواً («الباسورد **بتاعي**»، «الباسورد **الأول**:»، «باسورد
 * **الراوتر**»، «سر **التطبيق**:») — وهي الطريقةُ الافتراضية التي يسلّم بها
 * متحدّثُ العربية كلمةَ مرور، وكانت تُسقط القاعدةَ كلَّها. الحشوُ يُتخطّى حتى
 * للأسماء الصارمة: صرامتُها في **الواصل** لا في المسافة بينها وبين قيمتها.
 */
function valueAfterLabel(
  norm: string,
  labelEnd: number,
  rule: LabelRule,
  intent: boolean,
  labelIsArabic: boolean,
): LabelledValue[] {
  const none: LabelledValue[] = []
  let pos = labelEnd
  for (let filler = 0; filler <= 3; filler += 1) {
    const join = readJoin(norm, pos, rule.altJoin)
    if (join.kind === "none") return none
    if (join.kind === "explicit") {
      const pair = pairAfterJoin(norm, join.next)
      if (pair.length > 0) return pair
      const read = readValueAt(norm, join.next)
      if (read === undefined) return none
      if (read.quoted) {
        const quoted = read.value.trim()
        if (quoted.length < LABELLED_WORD_MIN || isReferenceValue(quoted) || isPlaceholder(quoted)) return none
        return [{ start: read.start, end: read.end }]
      }
      const value = read.value
      if (isReferenceValue(value) || isPlaceholder(value)) return none
      // هيئةُ اعتمادٍ ظاهرة: تُقبل وحدها بلا شرطِ نهايةِ سطر. والاستثناءُ
      // بالهيئة (اسمُ env، مسار) **لا يُطبَّق هنا**: اسمٌ سرّيٌّ صريحٌ سبقها.
      if (looksCredentialShaped(value)) {
        return value.length >= LABELLED_SHAPED_MIN ? [{ start: read.start, end: read.end }] : none
      }
      if (rule.shapedOnly === true) return none
      const phrase = readPhrase(norm, read.start)
      if (phrase === undefined) return none
      const words = phrase.value.split(/\s+/u)
      if (words.length > 1) {
        if (rule.phrase !== true) return none
        return [{ start: phrase.start, end: phrase.end }]
      }
      const only = words[0]!
      if (isProseWord(only) || only.length < LABELLED_WORD_MIN) return none
      if (isArabicOnly(only) && !hasDigit(only) && !intent && rule.phrase !== true) return none
      return [{ start: phrase.start, end: phrase.end }]
    }
    const read = readValueAt(norm, join.next)
    if (read === undefined) return none
    const value = read.value
    if (isArabicOnly(value) || (isPlainWord(value) && !hasLatin(value) && !hasDigit(value))) {
      // كلمةٌ عربيةٌ صِرفة: حشوٌ يُتخطّى — إن لم تكن كلمةَ بناءٍ أو حالٍ أو اسماً.
      if (join.kind === "weak") return none
      if (isProseWord(value) || ANY_LABEL.test(value)) return none
      pos = read.end
      continue
    }
    if (rule.strict === true) return none
    if (isExemptValue(value) || isPlaceholder(value) || isProseWord(value)) return none
    if (labelIsArabic) {
      // اسمٌ عربيّ ثم رمزٌ لاتينيّ/رقميّ: في جملةٍ عربية هذا هو السرّ نفسه.
      if (value.length < LABELLED_SHAPED_MIN) return none
      return [{ start: read.start, end: read.end }]
    }
    if (!looksCredentialShaped(value) || value.length < NAMED_SECRET_MIN) return none
    return [{ start: read.start, end: read.end }]
  }
  return none
}

export interface InboundRedaction {
  readonly text: string
  readonly redactions: number
}

/**
 * مواضعُ الاعتماد في النصّ **الأصلي** — الشكل والمدى فقط. هي المصدرُ الوحيد
 * للحجب أيضاً (`redactInboundBody` مبنيٌّ عليها)، فلا يفترق ما يُسمّى عمّا
 * يُمحى: كلُّ موضعٍ يُحجب، وكلُّ حجبٍ له موضعٌ مسمّى.
 */
export function inboundSecretSpans(text: string): SecretSpan[] {
  if (typeof text !== "string" || text.length === 0) return []
  const spans: SecretSpan[] = []
  const push = (kind: SecretShape, start: number, length: number): void => {
    if (length <= 0 || start < 0) return
    if (spans.some((s) => s.start === start && s.length === length)) return
    spans.push({ kind, start, length })
  }

  // (١) الهيئاتُ المعروفة — على النصّ الأصليّ، فالمواضع مباشرة.
  for (const rule of SHAPE_RULES) {
    for (const match of text.matchAll(rule.re)) {
      const value = match[rule.group] ?? ""
      if (value.length === 0) continue
      if (rule.accept !== undefined && !rule.accept(value)) continue
      const from = match.index ?? 0
      const at = rule.group === 0 ? from : text.indexOf(value, from)
      push(rule.kind, at, value.length)
    }
  }
  // (١ب) الإسنادُ باسمٍ سرّيّ — بقبولٍ يخصّ نصَّ المحادثة (نثرٌ وقيمٌ نائبة).
  for (const match of text.matchAll(new RegExp(SECRET_ASSIGN.source, "giu"))) {
    const value = match[1] ?? ""
    if (value.length === 0 || !inboundAssignAccept(match[0], value)) continue
    const trimmed = trimValueTail(value)
    const at = text.indexOf(trimmed, match.index ?? 0)
    push("password", at, trimmed.length)
  }

  // (٢) الأسماءُ الطبيعية — على النصّ المطبَّع، ثم تُردّ المواضع إلى الأصل.
  const norm = normalizeForDetection(text)
  const intent = HANDOVER_INTENT.test(norm.text)
  const toOriginal = (start: number, end: number): { start: number; length: number } | undefined => {
    if (start >= norm.at.length || end <= start) return undefined
    const from = norm.at[start]!
    const last = norm.at[Math.min(end, norm.at.length) - 1]!
    return { start: from, length: last + 1 - from }
  }
  for (const { rule, re } of COMPILED_LABELS) {
    if (rule.needsIntent === true && !intent) continue
    for (const match of norm.text.matchAll(re)) {
      const labelStart = match.index ?? 0
      const labelIsArabic = /[\u0600-\u06FF]/u.test(match[0])
      const found = [
        ...valueAfterLabel(norm.text, labelStart + match[0].length, rule, intent, labelIsArabic),
        ...valueBeforeLabel(norm.text, labelStart),
      ]
      for (const one of found) {
        const mapped = toOriginal(one.start, one.end)
        if (mapped === undefined) continue
        const original = text.slice(mapped.start, mapped.start + mapped.length)
        if (isReferenceValue(original)) continue
        push(rule.kind, mapped.start, mapped.length)
      }
    }
  }

  // (٣) المصفاةُ الطويلة — بقيّةٌ عشوائيةٌ طويلة. في الجسد الوارد تُستثنى
  // المساراتُ والمعرّفات: كانت تبتلع مسارَ ملفٍّ وبصمةَ كوميتٍ واسمَ فرع،
  // فتُتلف الطلبَ نفسه وتفتح محرّراً على سطح المكتب بلا سرٍّ في الأفق.
  for (const match of text.matchAll(SECRETISH_RESIDUAL_G)) {
    const value = match[0]
    if (EVIDENCE_DIGEST.test(value)) continue
    if (/^[Bb]earer\s$/u.test(value)) continue // كلمةُ الترويسة بلا رمزٍ بعدها
    if (looksLikePathOrIdentifier(value)) continue
    push("encoded-credential", match.index ?? 0, value.length)
  }
  return spans.sort((a, b) => a.start - b.start || b.length - a.length)
}

/**
 * حجبُ الجسد الوارد — **من المواضع وحدها**. المواضعُ المتداخلة تُدمج فتصير
 * علامةً واحدة، فلا يبقى نصفُ سرٍّ ولا تُقصّ كتلةٌ نصفين. متساوي القوى في
 * النصّ: علامةُ الحجب مستثناةٌ بالرسم المطبَّع فلا تُحجب فوق حجب.
 */
export function redactInboundBody(text: string): InboundRedaction {
  if (typeof text !== "string" || text.length === 0) return { text: "", redactions: 0 }
  const spans = inboundSecretSpans(text)
  if (spans.length === 0) return { text, redactions: 0 }
  let out = ""
  let cursor = 0
  let redactions = 0
  for (const span of spans) {
    const start = span.start
    const end = span.start + span.length
    if (end <= cursor) continue
    if (start <= cursor) {
      // تداخلٌ مع موضعٍ سابق: يمتدّ الحجبُ ولا تُضاف علامةٌ ثانية.
      cursor = end
      continue
    }
    out += text.slice(cursor, start) + REDACTED
    redactions += 1
    cursor = end
  }
  out += text.slice(cursor)
  return { text: out, redactions }
}
