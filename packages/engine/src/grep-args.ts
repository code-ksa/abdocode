/**
 * وسائطُ grep كما يكتبها النموذج — بصيغة GNU grep غالباً: `grep -rn "نمط" src --include="*.tsx" | head -30`.
 * 🔴 مقيس 10-02: الأداةُ قسمت الوسائطَ على المسافات وعدّت الثانيَ glob — فـ`grep -i avatar . -r` بحث في glob «.» فعاد
 * «لا مطابقة» عن مشروعٍ فيه عشراتُ المطابقات، و`grep -n "x" f` جعل «-n» نمطاً، و`"sprint"` بقي بعلامتَي تنصيصه.
 * نفيٌ كاذبٌ يبني عليه النموذجُ قراراً — أسوأُ من رفض. هنا: تنصيصٌ يُحترم، وأعلامُ GNU الشائعة تُفهم، وما لا يُفهم يُسمّى.
 */

/** تقسيمٌ كالصدفة: المسافةُ تفصل إلا داخل '…' أو "…"، وعلامتا التنصيص لا تبقيان في الكلمة. */
export function tokenizeArgs(text: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | undefined
  let started = false
  for (const ch of text) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else cur += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue }
    if (/\s/u.test(ch)) {
      if (started) { out.push(cur); cur = ""; started = false }
      continue
    }
    cur += ch
    started = true
  }
  if (started) out.push(cur)
  return out
}

export interface GrepArgs {
  readonly pattern?: string
  /** المساراتُ كما كُتبت (ملفّ أو مجلّد أو glob) — فارغةٌ = المشروعُ كلّه. */
  readonly paths: readonly string[]
  readonly ignoreCase: boolean
  readonly context: number
  readonly type: string
  readonly files: boolean
  readonly count: boolean
  readonly fixed: boolean
  readonly word: boolean
  /** أنماطُ `--include` على اسم الملفّ. */
  readonly includes: readonly string[]
  /** ما لم يُفهم أو لا معنى له هنا (`| head -30`، علمٌ مجهول) — يُسمّى في الجواب ولا يُبتلع. */
  readonly ignored: readonly string[]
}

const clampContext = (value: string | undefined): number => Math.min(5, Math.max(0, Number.parseInt(value ?? "2", 10) || 0))

/** أعلامُ GNU المفردة التي لا تغيّر البحثَ هنا (أرقامُ الأسطر تُطبع دائماً، والبحثُ عوديٌّ دائماً). */
const NEUTRAL_LETTERS = new Set(["n", "r", "R", "H", "E", "s", "I"])

export function parseGrepArgs(tokens: readonly string[]): GrepArgs {
  let ignoreCase = false, context = 0, type = "", files = false, count = false, fixed = false, word = false
  const positional: string[] = []
  const includes: string[] = []
  const ignored: string[] = []
  let flagsDone = false
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!
    if (t === "|" || t.startsWith("|")) { ignored.push(tokens.slice(i).join(" ")); break }
    if (flagsDone || !t.startsWith("-") || t === "-") { positional.push(t); continue }
    if (t === "--") { flagsDone = true; continue }
    if (t === "-i" || t === "--ignore-case") ignoreCase = true
    else if (t === "-C" || t === "-A" || t === "-B") context = Math.max(context, clampContext(tokens[++i]))
    // -c عدٌّ كما في GNU grep (كان سياقاً فيبتلع النمطَ بعده: `grep -c x f` ⇦ النمطُ «f»).
    else if (t === "-c") count = true
    else if (/^-[CAB]\d+$/u.test(t)) context = Math.max(context, clampContext(t.slice(2)))
    else if (/^--context=\d+$/u.test(t)) context = Math.max(context, clampContext(t.split("=")[1]))
    else if (t === "--type") type = (tokens[++i] ?? "").replace(/^\./u, "").toLowerCase()
    else if (t === "--files" || t === "-l" || t === "--files-with-matches") files = true
    else if (t === "--count") count = true
    else if (t === "--include") { const g = tokens[++i]; if (g) includes.push(g) }
    else if (t.startsWith("--include=")) includes.push(t.slice("--include=".length))
    else if (t === "--line-number" || t === "--recursive" || t === "--extended-regexp" || t === "--with-filename") { /* محايد */ }
    else if (t === "--fixed-strings") fixed = true
    else if (t === "--word-regexp") word = true
    else if (/^-[a-zA-Z]+$/u.test(t)) {
      // عنقودٌ مثل -rn أو -rni: كلُّ حرفٍ علم.
      for (const letter of t.slice(1)) {
        if (letter === "i") ignoreCase = true
        else if (letter === "l") files = true
        else if (letter === "c") count = true
        else if (letter === "F") fixed = true
        else if (letter === "w") word = true
        else if (!NEUTRAL_LETTERS.has(letter)) ignored.push(`-${letter}`)
      }
    } else ignored.push(t)
  }
  const [pattern, ...paths] = positional
  return { ...(pattern === undefined ? {} : { pattern }), paths, ignoreCase, context, type, files, count, fixed, word, includes, ignored }
}

/** النمطُ النهائيّ: `-F` حرفيّ، و`-w` كلمةٌ كاملة. */
export function effectivePattern(args: GrepArgs): string | undefined {
  if (args.pattern === undefined) return undefined
  const base = args.fixed ? args.pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") : args.pattern
  return args.word ? `\\b(?:${base})\\b` : base
}
