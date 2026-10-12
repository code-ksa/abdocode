/**
 * م11 — إصلاحٌ حتميّ معلَن لعادة النماذج (omni ثمّ super-120b، 2026-09-14): أمرٌ يبدأ بمسارٍ مقتبس ينتهي بـ.exe يفشل في PowerShell
 * بـ«Unexpected token» لأنّ المسارَ المقتبس تعبيرٌ لا نداء — يحتاج عامل النداء `&`. القواعدُ الثلاث للإصلاح الآليّ (سبرنت 47):
 * ميكانيكيّ (نمطٌ واحد)، محدود (لا يمسّ أمراً يحمل & أو . أو Start-Process أو cmd /c في صدره)، معلَن (يعود بملاحظةٍ تُبثّ للمشغّل).
 * الوحدة نقيّة.
 */

export interface CallRepair { readonly command: string; readonly note: string }

const QUOTED_EXE_HEAD = /^\s*(["'])(?:[A-Za-z]:\\|\\\\|\.{0,2}[\\/])[^"'\r\n]*\.(?:exe|cmd|bat|com)\1(?=\s|$)/iu

/** يعيد الأمرَ بعد إضافة `&` حين يبدأ بمسارٍ مقتبس قابلٍ للتنفيذ؛ وإلا undefined (لا إصلاح). */
export function powershellCallOperatorRepair(command: string): CallRepair | undefined {
  const head = command.trimStart()
  if (!QUOTED_EXE_HEAD.test(head)) return undefined
  return {
    command: `& ${head}`,
    note: "أُصلح الأمر آليّاً: أُضيف عاملُ النداء & قبل المسار المقتبس (PowerShell يعدّ المسارَ المقتبس تعبيراً لا نداءً).",
  }
}

/**
 * 09-30 — مقيس على مهمّة OpenRouter (المثبَّت 4.0.98): `npm install -D tailwindcss … && npx tailwindcss init -p` رُفض «&& غير مدعوم
 * في PowerShell 5.1» مرّتين في حقبةٍ واحدة، فذهب لكلٍّ منهما نداءُ نموذجٍ كامل ليعيد الصياغة. الترجمةُ حتميّة:
 * `A && B && C` ⇦ `A; if ($?) { B; if ($?) { C } }`، و`A || B` ⇦ `A; if (-not $?) { B }`. تُقسَم السلسلةُ خارج الاقتباس وحده؛
 * والخلطُ بين && و|| (أولويّةُ bash لا تُترجم بأمان) والصدفُ البعيدة (ssh/wsl/bash… تنفّذ هناك بلينكس) تبقى بلا إصلاح فيرفضها الحارس كما كان.
 */
// 10-08: docker run/compose تُسلسَل محلّيّاً (`docker compose build && docker compose up -d`) فتُترجم؛ exec وحده يُقصد به داخلُ الحاوية.
const REMOTE_SHELL_HEAD = /^\s*(?:ssh|scp|wsl|bash|sh|zsh|plink|docker\s+exec)\b/iu

const splitTopLevel = (command: string): { readonly parts: string[]; readonly ops: string[] } | undefined => {
  const parts: string[] = []
  const ops: string[] = []
  let quote: string | undefined
  let current = ""
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!
    if (quote !== undefined) {
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue }
    const pair = command.slice(i, i + 2)
    if (pair === "&&" || pair === "||") { parts.push(current.trim()); ops.push(pair); current = ""; i += 1; continue }
    current += ch
  }
  if (quote !== undefined) return undefined
  parts.push(current.trim())
  return { parts, ops }
}

/** يعيد الأمرَ مترجماً إلى PowerShell 5.1 حين يحمل سلسلةَ && خالصة أو || واحدة خارج الاقتباس؛ وإلا undefined. */
export function powershellChainRepair(command: string): CallRepair | undefined {
  if (!/&&|\|\|/u.test(command) || REMOTE_SHELL_HEAD.test(command)) return undefined
  const split = splitTopLevel(command)
  if (split === undefined || split.ops.length === 0) return undefined
  if (split.parts.some((part) => part.length === 0)) return undefined
  const kinds = new Set(split.ops)
  if (kinds.size > 1) return undefined
  if (kinds.has("||") && split.ops.length > 1) return undefined
  const [first, ...rest] = split.parts
  let tail = ""
  for (let i = rest.length - 1; i >= 0; i -= 1) tail = kinds.has("&&") ? `; if ($?) { ${rest[i]}${tail} }` : `; if (-not $?) { ${rest[i]}${tail} }`
  return {
    command: `${first}${tail}`,
    note: `أُصلح الأمر آليّاً: ${split.ops.length} × «${split.ops[0]}» تُرجمت إلى PowerShell 5.1 (${kinds.has("&&") ? "if ($?)" : "if (-not $?)"}) — المقاطعُ بترتيبها ويقف كلٌّ عند فشل سابقه.`,
  }
}

/**
 * 10-08 (مقيس في بروفة النشر): `docker exec test-server mkdir -p /root/.ssh && chmod 700 /root/.ssh` ⇦ PowerShell «The token '&&' is not
 * a valid statement separator» — وفي bash نفسِه كان chmod سيجري على هذا الجهاز لا في الحاوية. النموذجُ يقصد الحاوية: السلسلةُ تُلفّ
 * `sh -c '…'` بعد أعلام docker exec واسمِ الحاوية (حتميّ ومعلَن). اقتباسٌ مفرد داخل السلسلة أو `sh -c` قائمٌ ⇦ بلا إصلاح (يردّه الحارس).
 */
const DOCKER_EXEC_HEAD = /^\s*docker\s+exec\s+/iu
const DOCKER_EXEC_VALUE_FLAGS = new Set(["-u", "--user", "-w", "--workdir", "-e", "--env", "--env-file", "--detach-keys"])

export function dockerExecChainRepair(command: string): CallRepair | undefined {
  if (!DOCKER_EXEC_HEAD.test(command) || !/&&|\|\|/u.test(command)) return undefined
  const split = splitTopLevel(command)
  if (split === undefined || split.ops.length === 0 || split.parts.some((part) => part.length === 0)) return undefined
  const tokens = split.parts[0]!.replace(DOCKER_EXEC_HEAD, "").trim().split(/\s+/u)
  const flags: string[] = []
  let i = 0
  for (; i < tokens.length && tokens[i]!.startsWith("-"); i += 1) {
    flags.push(tokens[i]!)
    if (DOCKER_EXEC_VALUE_FLAGS.has(tokens[i]!) && i + 1 < tokens.length) flags.push(tokens[++i]!)
  }
  const container = tokens[i]
  const first = tokens.slice(i + 1).join(" ")
  if (container === undefined || first.length === 0 || /^(?:sh|bash|ash|zsh)\b/u.test(first)) return undefined
  let inner = first
  split.ops.forEach((op, k) => { inner += ` ${op} ${split.parts[k + 1]}` })
  if (inner.includes("'")) return undefined
  return {
    command: `docker exec ${[...flags, container].join(" ")} sh -c '${inner}'`,
    note: `أُصلح الأمر آليّاً: سلسلةُ «${split.ops[0]}» بعد docker exec لُفّت sh -c '…' — كانت تُرفض في PowerShell 5.1، وفي bash يجري ما بعدها على هذا الجهاز لا في الحاوية.`,
  }
}

/** سلسلةُ &&/|| خارج الاقتباس بعد صدفٍ بعيدة لم تُصلَح ⇦ تُردّ بالصيغة المقتبسة. `undefined` = نظيف. */
export function remoteChainViolation(command: string): string | undefined {
  const head = REMOTE_SHELL_HEAD.exec(command)
  if (head === null) return undefined
  const split = splitTopLevel(command)
  if (split === undefined || split.ops.length === 0) return undefined
  const word = head[0].trim().split(/\s+/u).slice(0, 2).join(" ")
  return `رُفض: «${split.ops[0]}» خارج الاقتباس لا يعمل في PowerShell 5.1، وبعد «${word}» كان سيُشغّل ما بعده على هذا الجهاز لا هناك. اقتبس السلسلةَ كلَّها لتجري هناك: ssh host 'A && B' · docker exec <حاوية> sh -c 'A && B' · wsl bash -lc 'A && B'.`
}

/**
 * 10-01 — مقيس على مهمّة OpenRouter: `Remove-Item -Recurse -Force src/app/api/models/[id]` لم يحذف شيئاً ولم يشكُ — PowerShell يعدّ `[id]`
 * نمطَ بدلٍ (حرفٌ من i أو d) فلا يطابق المجلّد — فضاع نداءان قبل أن يصل النموذجُ إلى -LiteralPath. مجلّداتُ Next.js الديناميكيّة
 * (`[id]`، `[provider]`، `[...slug]`) تجعل الفخَّ يوميّاً. أمرٌ واحد (بلا ; ولا | ولا {) لأحد هذه الأوامر، مسارُه يحمل [ ] بلا * ولا ?،
 * وبلا -LiteralPath، يصير مسارُه `-LiteralPath '…'`. نمطُ البدل الحقيقيّ (* أو ?) لا يُمسّ.
 */
const LITERAL_CMDLETS = new Set(["remove-item", "rm", "del", "ri", "rmdir", "get-childitem", "gci", "ls", "dir", "get-item", "gi", "test-path", "get-content", "gc", "cat", "type", "copy-item", "cp", "copy", "move-item", "mv", "move", "rename-item", "ren", "resolve-path", "rvpa"])
const VALUE_FLAGS = /^-(?:filter|include|exclude|depth|destination|newname|encoding|tail|totalcount|head|first|last|delimiter|readcount|itemtype|value|pathtype)$/iu

const tokenize = (command: string): string[] | undefined => {
  const out: string[] = []
  let current = ""
  let quote: string | undefined
  for (const ch of command) {
    if (quote !== undefined) { current += ch; if (ch === quote) quote = undefined; continue }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue }
    if (/\s/u.test(ch)) { if (current.length > 0) { out.push(current); current = "" } continue }
    current += ch
  }
  if (quote !== undefined) return undefined
  if (current.length > 0) out.push(current)
  return out
}

/** يعيد الأمرَ بـ-LiteralPath حين يحمل مسارُه أقواساً مربّعة بلا نمط بدل؛ وإلا undefined. */
export function powershellLiteralPathRepair(command: string): CallRepair | undefined {
  if (!/\[[^\]]*\]/u.test(command) || /[;|{}]/u.test(command)) return undefined
  const tokens = tokenize(command.trim())
  if (tokens === undefined || tokens.length < 2) return undefined
  if (!LITERAL_CMDLETS.has(tokens[0]!.toLowerCase())) return undefined
  if (tokens.some((t) => /^-(?:literalpath|lp|pspath)$/iu.test(t))) return undefined
  let at = -1
  let drop = -1
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i]!
    if (/^-path$/iu.test(t)) { at = i + 1; drop = i; break }
    if (t.startsWith("-")) { if (VALUE_FLAGS.test(t)) i += 1; continue }
    at = i
    break
  }
  const raw = at > 0 ? tokens[at] : undefined
  if (raw === undefined) return undefined
  const path = raw.replace(/^(['"])(.*)\1$/u, "$2")
  if (!/\[[^\]]*\]/u.test(path) || /[*?]/u.test(path)) return undefined
  const repaired = tokens.map((t, i) => (i === at ? `-LiteralPath '${path.replace(/'/gu, "''")}'` : t)).filter((_, i) => i !== drop)
  return {
    command: repaired.join(" "),
    note: `أُصلح الأمر آليّاً: «${path}» يحمل [ ] فيعدّه PowerShell نمطَ بدلٍ لا يطابق المجلّد — استُعمل -LiteralPath.`,
  }
}

/**
 * 10-09 (مقيس على crm-pipeline بـnemotron-ultra): ثلاثةُ أدوارٍ بلا سبرنتٍ مغلق، وفي سجلّها `ls -la crm.db` و`curl -s -o /dev/null -w
 * "%{http_code}" http://localhost:3400/…` تُرفض باسم «صيغة Linux» فيعيد النموذجُ الصياغةَ نداءً كاملاً كلَّ مرّة. ما له ترجمةٌ واحدةٌ بلا
 * التباس يُترجم ويُعلَن (القواعدُ الثلاث نفسُها: ميكانيكيّ، محدود، معلَن): `curl` ⇦ `curl.exe` (curl الحقيقيّةُ المشحونةُ مع ويندوز —
 * البرنامجُ نفسُه بالوسائط نفسِها، و`-o /dev/null` ⇦ `-o NUL`)، و`ls -la|-l|-a [مسار]` ⇦ `Get-ChildItem -Force [مسار]`، و`2>/dev/null`
 * و`>/dev/null` ⇦ `$null`، و`mkdir -p <مسار>` ⇦ `New-Item -ItemType Directory -Force <مسار>`. والهدّامُ (`rm -rf`) يبقى رفضاً، والصدفةُ
 * البعيدة (ssh/wsl/bash/docker) لا تُمسّ: ما بعد رأسها يُنفَّذ في لينكس.
 */
const REMOTE_LINUX_HEAD = /^\s*(?:ssh|scp|wsl|bash|sh|zsh|plink|docker\s+(?:exec|run|compose))\b/iu
export function linuxismRepair(command: string): CallRepair | undefined {
  if (REMOTE_LINUX_HEAD.test(command)) return undefined
  const done: string[] = []
  let cmd = command
  if (/(?:^|[;|&(]\s*)curl(?=\s)/iu.test(cmd) && !/curl\.exe/iu.test(cmd)) {
    cmd = cmd.replace(/(^|[;|&(]\s*)curl(?=\s)/giu, "$1curl.exe").replace(/(\s-o\s+)\/dev\/null\b/giu, "$1NUL")
    done.push("curl ⇦ curl.exe")
  }
  const ls = /(^|[;|]\s*)ls\s+-(?:la|al|l|a)\b(\s+[^\s;|&]+)?/iu
  if (ls.test(cmd)) { cmd = cmd.replace(ls, (_m, lead: string, path?: string) => `${lead}Get-ChildItem -Force${path ?? ""}`); done.push("ls -la ⇦ Get-ChildItem -Force") }
  const mkdir = /(^|[;|]\s*)mkdir\s+-p\s+([^\s;|&]+)(?=\s*(?:$|[;|]))/iu
  if (mkdir.test(cmd)) { cmd = cmd.replace(mkdir, (_m, lead: string, path: string) => `${lead}New-Item -ItemType Directory -Force ${path} | Out-Null`); done.push("mkdir -p ⇦ New-Item -ItemType Directory -Force") }
  if (/[12]?>\s*\/dev\/null/u.test(cmd)) { cmd = cmd.replace(/([12]?>)\s*\/dev\/null/gu, "$1$$null"); done.push("/dev/null ⇦ $null") }
  if (done.length === 0) return undefined
  return { command: cmd, note: `أُصلح الأمر آليّاً من صيغة Linux إلى PowerShell 5.1: ${done.join("، ")} — الأمرُ المنفَّذ: ${cmd.slice(0, 200)}` }
}
