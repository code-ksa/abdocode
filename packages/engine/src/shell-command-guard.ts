/** حُرّاس أوامر الصدفة — أصناف مقيسة تُرَدّ بسببٍ مسمّى قبل التنفيذ.
 *
 * كتالوج السيناريوهات، بندا 1.3 و6.1: النموذج نفّذ `Stop-Process -Name node`
 * الأعمى مرتين (يقتل عمليات جلسات أخرى لا يملكها)، واستعمل `curl -s` وهي
 * في PowerShell اسم مستعار مشوّه لـInvoke-WebRequest أخفى فشل الاتصال
 * (KF-2) وانفجر بـ«Object reference not set» حياً.
 */

/**
 * الكشفُ يجري على **متغيّراتٍ مطبَّعة** لا على النصّ الخام.
 *
 * الفكرةُ من hermes-agent، والقياسُ لبيئتنا: حرّاسُنا كانوا يفحصون السلسلةَ
 * كما كتبها النموذج، وذلك يُلتفّ عليه بثلاث طرقٍ حقيقيّةٍ في PowerShell:
 *
 * 1. **الشرطةُ الخلفيّة** حرفُ هروبٍ فيه: `Stop-Proc` + backtick + `ess`
 *    أمرٌ صحيحٌ يعمل، ولا يطابقه `\bStop-Process\b` أبداً.
 * 2. **الاقتباسُ داخل الكلمة**: `Stop-Process -Na"me" node` يُنفَّذ، والنمطُ
 *    لا يراه.
 * 3. **الحاملُ الصدفيّ**: `powershell -EncodedCommand <base64>` يخفي الأمرَ
 *    كلَّه خلف ترميز، فيمرّ الحارسُ على نصٍّ لا معنى له ويقول «نظيف».
 *
 * فتُولَّد متغيّراتٌ ويُفحص كلٌّ منها؛ إصابةٌ في أيٍّ منها رفض. والتوليدُ
 * محدود: عمقٌ واحدٌ لفكّ الحامل، وسقفٌ للطول.
 *
 * **وما يتجاوز حدَّ التحليل خطِرٌ لا نظيف**: أمرٌ أطولُ من السقف لا يُقال عنه
 * «مرّ»، بل يُرفض بالاسم. الفشلُ إلى «نظيف» هو كيف يصير الحارسُ زينة.
 */
const DETECTION_MAX_CHARS = 8_000

/** فكُّ حاملٍ صدفيّ واحد: `-EncodedCommand <base64>` (UTF-16LE كما يوجبه PowerShell). */
const decodeEncodedCommand = (cmd: string): string | undefined => {
  const m = cmd.match(/-e(?:nc|ncodedcommand)?\s+([A-Za-z0-9+/=]{16,})/iu)
  if (m === null) return undefined
  try {
    const bytes = Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0))
    // UTF-16LE كما يوجبه PowerShell — يُفكّ بايتَين بايتَين بلا اعتمادٍ على
    // ترميزٍ قد لا تُعلنه أنواعُ البيئة، فيبقى الحارسُ يعمل حيث يُصرَّف.
    let text = ""
    for (let i = 0; i + 1 < bytes.length; i += 2) text += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8))
    return text
  } catch {
    return undefined
  }
}

/**
 * المتغيّراتُ التي يُفحص عليها الأمر. الأصلُ أوّلها دائماً — فما كان يُكشف
 * قبل هذا التغيير يبقى مكشوفاً بايتاً.
 */
export function detectionVariants(cmd: string): readonly string[] {
  const out = [cmd]
  const push = (value: string | undefined) => {
    if (typeof value === "string" && value.length > 0 && !out.includes(value)) out.push(value)
  }
  // (١) نزعُ هروب PowerShell — الشرطةُ الخلفيّة تصل الحرفَ بما بعده.
  push(cmd.replace(/`/gu, ""))
  // (٢) نزعُ الاقتباس داخل الكلمة، وتوحيدُ الفراغ.
  push(cmd.replace(/["']/gu, "").replace(/\s+/gu, " "))
  // (٣) الاثنان معاً — أبسطُ التفافٍ يجمعهما.
  push(cmd.replace(/[`"']/gu, "").replace(/\s+/gu, " "))
  // (٤) الحاملُ المرمَّز، وعليه تُعاد الأرضيّةُ نفسُها (عمقٌ واحدٌ لا أكثر).
  const decoded = decodeEncodedCommand(cmd)
  if (decoded !== undefined) {
    push(decoded)
    push(decoded.replace(/[`"']/gu, "").replace(/\s+/gu, " "))
  }
  return Object.freeze(out)
}

/**
 * يُشغّل حارساً على كلّ المتغيّرات. أوّلُ إصابةٍ ترجع بسببها.
 *
 * وأمرٌ يتجاوز سقفَ التحليل يُرفض: لا يُقال عنه «نظيف» لأنّ فحصَه تعذّر.
 */
export function violationAcrossVariants(
  cmd: string,
  guard: (candidate: string) => string | undefined,
): string | undefined {
  if (cmd.length > DETECTION_MAX_CHARS) {
    return `رُفض أمرٌ يتجاوز حدَّ التحليل (${cmd.length} حرفاً > ${DETECTION_MAX_CHARS}): ما لا يُفحص لا يُقال عنه آمن. قسّمه إلى خطواتٍ أقصر.`
  }
  for (const candidate of detectionVariants(cmd)) {
    const said = guard(candidate)
    if (said !== undefined) return said
  }
  return undefined
}

/** قتلٌ بالاسم لا بالملكية: يصيب عمليات لا يملكها الدور. */
export function killByNameViolation(cmd: string): string | undefined {
  const byName =
    /\bStop-Process\b[^|;]*\s-Name\b/iu.test(cmd) ||
    /\btaskkill\b[^|;]*\s\/IM\b/iu.test(cmd) ||
    /\bGet-Process\b[^|;]*\|\s*Stop-Process\b/iu.test(cmd) ||
    /\bpkill\b|\bkillall\b/iu.test(cmd)
  if (!byName) return undefined
  return (
    "رُفض القتل بالاسم: يصيب عمليات جلسات أخرى لا تملكها — «قتلها قرارها لا قرارك». " +
    "خوادم هذا الدور توقفها النواة بنفسها عند نهايته؛ وإن احتجت إيقاف عملية بعينها فحدّدها برقمها بعد قياس ملكيتها."
  )
}

/** أوامر خطرة أو بصيغة صدفةٍ خاطئة على PowerShell. `undefined` = نظيف. */
export function dangerousShellViolation(cmd: string): string | undefined {
  // صيغة Linux على PowerShell (كتالوج 8.14 — يوسّع رفض runExec القائم).
  const linuxisms: [RegExp, string][] = [
    [/(?:^|[;&|]\s*)rm\s+-[rf]/iu, "rm -rf ← Remove-Item -Recurse -Force"],
    [/(?:^|[;&|]\s*)ls\s+-la?\b/iu, "ls -la ← Get-ChildItem"],
    [/(?:^|[;&|]\s*)mkdir\s+-p\b/iu, "mkdir -p ← New-Item -ItemType Directory -Force"],
    [/(?:^|[;&|]\s*)cat\s+.*\|\s*grep\b/iu, "cat|grep ← Select-String"],
    [/(?:^|[;&|]\s*)touch\s+/iu, "touch ← New-Item -ItemType File"],
    [/2>\/dev\/null|>\s*\/dev\/null/iu, "/dev/null ← $null"],
    [/&&|\|\|/u, "&& / || غير مدعومين في PowerShell 5.1 ← ; مع if ($?)"],
    [/\bexport\s+[A-Z_]+=/iu, "export VAR= ← $env:VAR = 'value'"],
  ]
  for (const [re, fix] of linuxisms) if (re.test(cmd)) return `رُفض أمرٌ بصيغة Linux على PowerShell: ${fix}.`

  // حذفٌ هدّامٌ واسع (كتالوج — القاعدة العليا: الحذف يسبقه سرد وموافقة).
  // **الترتيبُ لا يُشترط**: النمطُ القديم كان يوجب `-Recurse` قبل المسار،
  // فيمرّ منه `Remove-Item C:\Windows -Recurse -Force` — أمرٌ صحيحٌ هدّامٌ
  // بترتيبٍ طبيعيّ يكتبه أحدٌ بلا نيّةِ التفاف. وجده فريقٌ أحمر يشغّل.
  const wideDelete =
    /\bRemove-Item\b/iu.test(cmd) &&
    /(?:-Recurse\b|\s-r\b)/iu.test(cmd) &&
    /(?:C:\\?(?:\s|$)|C:\\Windows|C:\\Users\b|C:\\Program\s|\s\/(?:\s|$)|~(?:\s|$))/iu.test(cmd)
  if (wideDelete || /rd\s+\/s\s+\/q\s+[A-Za-z]:\\?\s*$/iu.test(cmd)) {
    return "رُفض حذفٌ هدّامٌ واسع النطاق: يمسّ جذر النظام أو مجلد المستخدم. حدّد المسار الدقيق داخل المشروع، والحذف الحقيقي يسبقه سردُ المحذوف وموافقة."
  }
  // إعادة توجيه تعطّل التحقق أو تجلب-تنفّذ من الشبكة.
  if (/(?:iwr|Invoke-WebRequest|curl)\b[^\n|]*\|\s*(?:iex|Invoke-Expression|bash|sh)\b/iu.test(cmd)) {
    return "رُفض جلب-وتنفيذ من الشبكة (fetch|iex): تنفيذ شيفرةٍ غير مفحوصة. نزّل إلى ملفٍ، افحصه، ثم شغّله."
  }
  return undefined
}

/** curl/wget في PowerShell أسماء مستعارة مشوّهة تكذب أو تنفجر. */
export function brokenAliasViolation(cmd: string): string | undefined {
  // curl الحقيقية بمسار كامل أو curl.exe الصريحة تمرّ — المستعارة وحدها تُرَدّ.
  if (/(?:^|[\s;|&])curl(?:\s|$)/iu.test(cmd) && !/curl\.exe/iu.test(cmd)) {
    return "رُفض curl: في PowerShell هو اسم مستعار مشوّه لـInvoke-WebRequest (أخفى فشل اتصال في KF-2 وانفجر حيّاً). استعمل Invoke-WebRequest -UseBasicParsing -Uri <الرابط> مباشرة."
  }
  if (/(?:^|[\s;|&])wget(?:\s|$)/iu.test(cmd) && !/wget\.exe/iu.test(cmd)) {
    return "رُفض wget: اسم مستعار PowerShell مشوّه. استعمل Invoke-WebRequest -UseBasicParsing -Uri <الرابط> -OutFile <الملف>."
  }
  return undefined
}

/** كتالوج 1.13: أوامر مراقبةٍ لا تعود — تعلّق جولة الأدوات إلى الأبد.
 *
 * الحقبة تنتظر خروج الأمر، وأوامر watch/monitor مصمَّمة ألّا تخرج:
 * vitest/jest الافتراضيان في وضع مراقبة، وnodemon وtail -f ومثلها.
 * الردّ يسمّي الصيغة الدفعية الصحيحة — الخوادم لها مسار الإدارة الخاص.
 */
export function watchModeViolation(cmd: string): string | undefined {
  const trimmed = cmd.trim()
  if (/\bvitest\b(?!.*\brun\b)/iu.test(trimmed)) {
    return "رُفض vitest بوضع المراقبة الافتراضي — لا يخرج أبداً فيعلّق الجولة. استعمل: npx vitest run"
  }
  if (/\b(?:jest|vitest|tsc|chokidar)\b[^\n]*(?:--watch(?:All)?\b|\s-w\b)/iu.test(trimmed) || /\bnodemon\b/iu.test(trimmed)) {
    return "رُفض أمر بوضع --watch/nodemon — يراقب ولا يخرج فيعلّق الجولة. شغّل الصيغة الدفعية بلا --watch؛ والخوادم تُشغَّل بأمر start/dev المُدار."
  }
  if (/\btail\s+-f\b/iu.test(trimmed) || /\bGet-Content\b[^\n]*-Wait\b/iu.test(trimmed)) {
    return "رُفضت متابعة سجلٍّ حيّة (tail -f / Get-Content -Wait) — لا تخرج أبداً. اقرأ آخر الأسطر دفعةً: Get-Content <ملف> -Tail 50"
  }
  if (/\bnpx?\s+(?:serve|http-server)\b/iu.test(trimmed) || /\bpython\s+-m\s+http\.server\b/iu.test(trimmed)) {
    return "رُفض خادم ملفات ساكن يدوي — يعلّق الجولة. إن احتجت خادماً فاجعله سكربت start في package.json ليتولاه مسار التشغيل المُدار."
  }
  return undefined
}
