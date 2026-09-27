/**
 * English display for the engine's diagnostic lines — display only.
 *
 * The engine writes its turn diagnostics, execution summary and kernel receipts in Arabic, and
 * that wire text stays as it is: the journal keeps it, and the shell's own readers parse it
 * (trajectory epochs, approval decisions, the fabricated-output guard). Measured 2026-09-27 on
 * real turns: an English interface showed "— المقيس: دخل … توكيناً" under every answer, the
 * kernel receipt atop every file read, and `status` entirely in Arabic.
 *
 * A line is either translated completely or returned byte-for-byte: Arabic may remain only
 * inside «…» (a user's target, never ours to translate). Model and user text never passes here
 * unless it starts with an engine marker, and the rules are the engine's own formats.
 */

const ARABIC = /[\u0600-\u06FF]/u

/** Whole-line formats (from the engine generators), tried before fragments. */
const EXACT = [
  [/^— المقيس: دخل (\S+) توكيناً \(قدّرنا (\S+)\)، خرج (\S+)، في (\S+) ثانية، والسياق فهارس L0 كلّها\.$/u,
    (m) => `— Measured: ${m[1]} tokens in (estimated ${m[2]}), ${m[3]} out, in ${m[4]} s; context: all L0 indexes.`],
  [/^— حقب التنفيذ: (\d+) · الأدوات: (\d+) · التوقف: (.+)$/u, (m) => `— Epochs: ${m[1]} · tools: ${m[2]} · stop: ${m[3]}`],
  [/^قرأت النواةُ الملفَّ وتحقّقت منه — بصمة المحتوى (\S+)… والأطوار السبعة في دفتر النواة \(صفوفه الآن: (\d+)\)\.$/u,
    (m) => `The kernel read and verified the file — content digest ${m[1]}…, all seven phases in the kernel ledger (rows now: ${m[2]}).`],
  [/^…\[قُصّ: عُرض (\d+) من (\d+) حرفاً\]$/u, (m) => `…[clipped: showing ${m[1]} of ${m[2]} characters]`],
  [/^⚠ رد النموذج بلا أداة \(ليس إيصال إنجاز\):$/u, () => "⚠ The model replied without a tool (not a completion receipt):"],
  [/^بيئة الأبناء: لا اعتماد يُنزع$/u, () => "Child environment: no credential stripped"],
  [/^بيئة الأبناء: يُنزع (\d+) متغيّراً \((.*)\)$/u, (m) => `Child environment: ${m[1]} variables stripped (${m[2].replaceAll("، ", ", ")})`],
  [/^النواة: (حاضرة \(نسخة الـ72 ساعة\)|غائبة) · دفتر النواة: (\d+) صفّاً · قدرات المنتج: (\S+)$/u,
    (m) => `Kernel: ${m[1] === "غائبة" ? "missing" : "available (72-hour build)"} · kernel ledger: ${m[2]} rows · product capabilities: ${m[3]}`],
  [/^(\u2068?)بلا نموذج — نواةٌ وفهرس(\u2069?)( · .*)$/u, (m) => `${m[1]}No model — kernel and index${m[2]}${m[3]}`],
]

/** Fragments of marker lines, longest first where one contains another. */
const FRAGMENTS = [
  ["✓ نقطة حفظ الحقبة", "✓ epoch checkpoint"], ["↻ حقبة", "↻ epoch"], ["📐 أحكام الأدوات ح", "📐 tool verdicts e"],
  ["⏱ سقف الدور (حقبة", "⏱ turn cap (epoch"], ["💳 السحابة:", "💳 cloud:"], ["🚪 البوابة:", "🚪 gate:"],
  ["🧰 أدوات معروضة:", "🧰 tools shown:"], ["(الأساسيّة)", "(core)"], ["🧾 نظام:", "🧾 system:"], ["كتالوج", "catalogue"],
  ["📚 دروس المشروع:", "📚 project lessons:"], ["تُحقن قبل أوّل نداء", "injected before the first call"],
  ["استنتاج: لم يُشغَّل", "inference: not run"], ["هدفُ العمليّة:", "operation target:"], ["عمليّة:", "operation:"],
  ["لغة:", "language:"], ["(تبديل)", "(switch)"], ["لهجة:", "dialect:"], ["فعل:", "verb:"], ["نوع:", "kind:"], ["هدف:", "target:"],
  // كلمتان قائمتان بذاتهما تُطابَقان بفاصلهما: «نفي» وحدها تطابق داخل «التنفيذ».
  [" · نفي", " · negated"], [" · سؤال", " · question"],
  ["أدوات=", "tools="], ["السبب=", "reason="], ["ضغط القراءة=", "read compactions="], ["ضغط التنفيذ=", "exec compactions="],
  ["أثر الحقبة=", "epoch trail="], ["ضغط الكتابة=", "write compactions="], ["إعادة المكرَّر=", "duplicate replays="],
  ["صريح=", "explicit="], ["مستنتَج=", "inferred="], ["(أدوات:", "(tools:"], ["رفض سياسة=", "policy denials="], ["فشل=", "failed="],
  ["أسباب=", "reasons="], ["غير ممطوط=", "unmapped="],
  ["نداءات=", "calls="], ["إدخال=", "input="], ["مخبوء=", "cached="], ["إخراج=", "output="], ["فعّال=", "effective="],
  ["أكبر نداء=", "largest call="], ["سماحة=", "grace="], ["(مستعملة)", "(used)"],
  ["أُجيب مباشرة بلا أدوات", "answered directly without tools"], ["صُعِّد", "escalated"], ["تُركت", "skipped"], ["دخل=", "in="], ["خرج=", "out="],
  ["وضعُ العمل", "Work mode"], ["وكيلٌ موجِّه يقرأ المشروع أوّلاً", "an orienting agent reads the project first"], ["وكيلٌ واحد", "a single agent"],
  ["فريقٌ متوازٍ حتى", "a parallel team of up to"], ["لا توازي", "no parallel agents"], ["تحقّقٌ ومراجعةٌ مستقلّة", "independent verification and review"],
  ["لا مراجعةَ مستقلّة", "no independent review"], ["تفنيدٌ عدائيّ بثلاث عدسات بعد المراجعة", "three-lens adversarial refutation after review"],
  ["، ", ", "], ["،", ","],
]

const MARKER = /^(?:🧭|🧰|🧾|↻|✓|📐|💳|⏱|🚪|📚)\s/u

/** Arabic left outside «…» — a user's quoted target may stay as written. */
const residualArabic = (text) => ARABIC.test(text.replace(/«[^»]*»/gu, ""))

function translateOne(line, allowFragments) {
  if (!ARABIC.test(line)) return line
  for (const [pattern, render] of EXACT) {
    const match = pattern.exec(line)
    if (match) return render(match)
  }
  if (!allowFragments || !MARKER.test(line)) return line
  let out = line
  for (const [ar, en] of FRAGMENTS) out = out.replaceAll(ar, en)
  return residualArabic(out) ? line : out
}

/**
 * One engine event payload. Its first line is an engine line; the lines after it may be tool
 * output (file contents), so only the exact receipt formats apply there — never fragments.
 */
export function engineLineForDisplay(payload, language) {
  if (language === "ar" || typeof payload !== "string" || !ARABIC.test(payload)) return payload
  const [first, ...rest] = payload.split("\n")
  return [translateOne(first, true), ...rest.map((line) => translateOne(line, false))].join("\n")
}

/** Tool-card output: receipts and clip notes only; the content itself is the user's. */
export function engineOutputForDisplay(output, language) {
  if (language === "ar" || typeof output !== "string" || !ARABIC.test(output)) return output
  return output.split("\n").map((line) => translateOne(line, false)).join("\n")
}

/** When a conditional plugin reader runs — the engine registry's `readWhen`, in English. */
const READ_WHEN = new Map([
  ["حين يُرفض الطلبُ نفسُه ثلاثاً", "when the same request is refused three times"],
  ["حين يُطرح سؤالُ موافقة", "when an approval question is asked"],
  ["حين يُطرح سؤالُ موافقةٍ أو يُحسم", "when an approval question is asked or decided"],
  ["حين تعود نتيجةُ أداة", "when a tool result returns"],
  ["حين تُستدعى أداةٌ بجسر MCP", "when a tool is called through the MCP bridge"],
  ["حين يُسأل هل التفويضُ متاح", "when delegation availability is checked"],
  ["حين يُبنى كتالوجُ الوكلاء للتفويض", "when the delegation agent catalogue is built"],
  ["عند حدّ حقبة", "at an epoch boundary"],
  ["حين يقع نداءُ نموذج", "when a model call happens"],
  ["في غير وضع الدردشة", "outside chat mode"],
  ["حين يظهر سرٌّ في المحادثة", "when a secret appears in the conversation"],
  ["حين ينتج الإطارُ الدلاليُّ قيمة", "when the semantic frame yields a value"],
])

export function readWhenForDisplay(text, language) {
  if (language === "ar") return text
  return READ_WHEN.get(text) ?? text
}

/** Provider labels inside engine text (the engine names built-ins by their Arabic label). */
export function providerLabelsForDisplay(text, catalog, displayLabel, language) {
  if (language === "ar" || typeof text !== "string" || !ARABIC.test(text)) return text
  let out = text
  for (const provider of catalog?.PROVIDERS || []) {
    if (!ARABIC.test(provider.label)) continue
    const english = displayLabel(catalog, provider.id, provider.label, "en")
    if (english !== provider.label) out = out.replaceAll(provider.label, english)
  }
  return out
}
