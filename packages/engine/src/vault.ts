/**
 * S14 — الخزنة التي يشحنها المنتج.
 *
 * القياس الذي أوجبها (2026-09-02): عاملُ Rust يقرأ الأسرار بـ
 * `powershell.exe … -File $ABDO_VAULT_SCRIPT get <مقبض>` وحده، و`has` مثله؛
 * ولا **كتابة** في أيّ مكان — لا في TS ولا في Rust — بينما تقول القشرة
 * للمستخدم «أضفه من الإعدادات» لبابٍ لا يكتب. والمتغيّر نفسه خاصٌّ بالمالك:
 * مستخدمٌ نهائيّ لا يملكه، فـ`has` تعيد `false` أبداً.
 *
 * هذه الوحدة تسدّ الفجوة **بلا لمس Rust ولا إعادة بناء**: تشحن سكربتاً
 * يتكلّم العقد نفسه (`get` و`has`) ويزيد `set` للمحرّك وحده.
 *
 * ثوابتها:
 * - **قرار المالك يعلو**: `ABDO_VAULT_SCRIPT` إن كان مضبوطاً فهو الخزنة،
 *   ولا يُكتب فوقه ولا يُتجاوز إلى المشحون — وغيابُ ملفّه رفضٌ مسمّى لا
 *   ارتدادٌ صامت («الغياب رفضٌ لا إذن»).
 * - **القيمة على stdin أبداً لا في argv**: سطرُ أمرِ أيّ عمليّة مقروءٌ لكلّ
 *   عمليّةٍ على الجهاز. والسكربت المشحون يرفض أيّ وسيطٍ زائد، فتمريرُ القيمة
 *   وسيطاً **يفشل** ولا يعمل بصمت.
 * - **هيئةُ ما يُخزَّن تُبرهَن قبل التخزين**: `rustReaderShape` تحاكي قارئ
 *   Rust بايتاً ببايت، وما لا يعود منها كما دخل يُرفض بالاسم.
 * - **فشلٌ مُغلق**: خزنةٌ لا تُقرأ، أو كتابةٌ تفشل، أو مقبضٌ خارج النمط —
 *   رفضٌ مسمّى بلا حالةٍ جزئية وبلا نصٍّ صريح في أيّ رسالة.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import SHIPPED_VAULT_SCRIPT from "../assets/vault.ps1" with { type: "text" }
import { VAULT_HANDLE_RE, VAULT_VALUE_MAX_BYTES } from "./secret-intake"

export { SHIPPED_VAULT_SCRIPT }

/** متغيّرُ المالك — يُقرأ ولا يُكتب. */
export const OWNER_VAULT_ENV = "ABDO_VAULT_SCRIPT"
/** جذرُ الخزنة — يُمرَّر إلى السكربت صراحةً فلا يفترق مكانان. */
export const VAULT_DIR_ENV = "ABDO_VAULT_DIR"
/** تجاوزُ بيت الخزنة (اختبارات، وملفّ مستخدمٍ غير قياسيّ). */
export const VAULT_HOME_ENV = "ABDO_VAULT_HOME"

export const VAULT_REFUSALS = Object.freeze({
  HANDLE_SHAPE: "رُفض المقبض: حروف صغيرة وأرقام وشرطة فقط، يبدأ بحرفٍ أو رقم، وطولُه ≤121.",
  NO_PROFILE: "رُفضت الخزنة: لا مجلّد ملفّ مستخدم (APPDATA أو USERPROFILE) — لا مكان آمنٍ يُكتب فيه، ولا كتابة في المستودع.",
  UNSAFE_HOME: "رُفضت الخزنة: الوجهة داخل المستودع أو داخل مجلّدٍ مزامَن سحابياً — الخزنة لا تُزامَن.",
  OWNER_SCRIPT_MISSING: "رُفضت الخزنة: ABDO_VAULT_SCRIPT مضبوطٌ على ملفٍّ غير موجود — قرار المالك يعلو، ولا ارتداد صامت إلى الخزنة المشحونة. صحّح المسار أو انزع المتغيّر.",
  INSTALL_FAILED: "رُفضت الخزنة: تعذّرت كتابة سكربت الخزنة تحت ملفّ المستخدم.",
  SPAWN_FAILED: "رُفضت الخزنة: تعذّر تشغيل powershell.exe — الخزنة المشحونة تعمل على ويندوز.",
  VALUE_EMPTY: "رُفض التخزين: قيمة فارغة.",
  VALUE_TOO_LONG: `رُفض التخزين: القيمة تتجاوز ${VAULT_VALUE_MAX_BYTES} بايتاً — سقف قارئ العامل نفسه.`,
  VALUE_NEWLINE: "رُفض التخزين: القيمة تحوي سطراً جديداً أو محرف NUL — قارئ العامل يرفض هذه الهيئة، فلا تُخزَّن أصلاً.",
  VALUE_SHAPE: "رُفض التخزين: القيمة لا تعود من قارئ العامل كما دخلت (فراغٌ طرفيّ أو هيئةٌ مبتورة) — لا تخزينَ لقيمةٍ تُقرأ غير ما كُتبت.",
  WRITE_FAILED: "رُفض التخزين: كتابة الخزنة فشلت ولم يبقَ ملفّ نصفيّ.",
  DECRYPT_FAILED: "رُفضت القراءة: تعذّر فكّ ملفّ الخزنة. الحماية لكلّ مستخدمٍ وجهاز — ملفٌّ نُسخ من جهازٍ آخر أو لمستخدمٍ آخر لا يُفكّ هنا. السرّ لم يضِع؛ خزّنه على هذا الجهاز.",
  ARGV_REFUSED: "رُفضت الخزنة: مُرِّر وسيطٌ زائد إلى سكربت الخزنة — القيمة تُمرَّر على المدخل القياسيّ وحده.",
  UNKNOWN: "رُفضت الخزنة: انتهى سكربت الخزنة برمزٍ غير معروف.",
} as const)

export type VaultRefusal = (typeof VAULT_REFUSALS)[keyof typeof VAULT_REFUSALS]

/** أعلامُ powershell نفسها التي يستعملها عامل Rust — لا مجموعةَ ثانية. */
export const POWERSHELL_FLAGS: readonly string[] = Object.freeze([
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
])

/**
 * سطرُ الأمر — **لا يقبل قيمةً بالبناء**: وسائطُه السكربتُ والفعلُ والمقبض
 * وحدها. مُتاحٌ للاختبار كي يُثبَت أن القيمة لا تمرّ من هنا أبداً.
 */
export type VaultVerb = "get" | "has" | "set" | "forget" | "list" | "guard"

export const vaultArgv = (script: string, verb: VaultVerb, handle?: string): string[] =>
  handle === undefined ? ["powershell.exe", ...POWERSHELL_FLAGS, script, verb] : ["powershell.exe", ...POWERSHELL_FLAGS, script, verb, handle]

// ---------------------------------------------------------------------------
// هيئةُ القارئ — محاكاةٌ بايتيّة لـ`read_secret` في عامل Rust
// ---------------------------------------------------------------------------

/**
 * يحاكي `provider.rs::read_secret` خطوةً بخطوة: يرفض الفارغ وما تجاوز
 * 16384، يقصّ CR/LF/فراغ/جدولة من الآخر، **يُسقط كلّ شيءٍ حتى أوّل `=`**،
 * ثم يرفض ما بقي فارغاً أو حاملاً CR/LF/NUL. البادئة `v=` التي يطبعها
 * السكربت المشحون تجعل ذلك الإسقاط فاصلَنا نحن، فتنجو القيمُ التي تحوي `=`
 * (base64) بدل أن تُبتر — وهذا هو سبب البادئة، لا زينة.
 */
export function rustReaderShape(stdout: Uint8Array): { value: string } | { refusal: VaultRefusal } {
  if (stdout.length === 0) return { refusal: VAULT_REFUSALS.VALUE_EMPTY }
  if (stdout.length > VAULT_VALUE_MAX_BYTES) return { refusal: VAULT_REFUSALS.VALUE_TOO_LONG }
  let end = stdout.length
  while (end > 0) {
    const last = stdout[end - 1]!
    if (last === 13 || last === 10 || last === 32 || last === 9) end -= 1
    else break
  }
  let start = 0
  for (let index = 0; index < end; index += 1) {
    if (stdout[index] === 61) { start = index + 1; break }
  }
  const body = stdout.subarray(start, end)
  if (body.length === 0) return { refusal: VAULT_REFUSALS.VALUE_EMPTY }
  for (const byte of body) {
    if (byte === 13 || byte === 10 || byte === 0) return { refusal: VAULT_REFUSALS.VALUE_NEWLINE }
  }
  return { value: new TextDecoder().decode(body) }
}

// ---------------------------------------------------------------------------
// الموضع — يُقاس قبل أن يُكتب
// ---------------------------------------------------------------------------

export type VaultEnv = Readonly<Record<string, string | undefined>>

export interface VaultLocation {
  /** مسار سكربت الخزنة العامل. */
  readonly script: string
  /** جذرُ ملفّات `.sec`. */
  readonly store: string
  /** الخزنةُ خزنةُ المالك (ABDO_VAULT_SCRIPT) لا المشحونة. */
  readonly owner: boolean
}

/** علاماتُ مجلّدٍ مزامَن — الخزنة لا تُزامَن، والقياس قبل الكتابة لا بعدها. */
const SYNCED = /(?:^|[\\/])(?:onedrive|dropbox|google\s?drive|icloud\s?drive|yandex\.?disk)(?:[\\/]|$)/iu

/** بيتُ الخزنة تحت ملفّ المستخدم — أو رفضٌ مسمّى. */
export function vaultHome(env: VaultEnv): { home: string } | { refusal: VaultRefusal } {
  const explicit = env[VAULT_HOME_ENV]
  const appData = env.APPDATA
  const profile = env.USERPROFILE ?? env.HOME
  const home =
    explicit !== undefined && explicit.trim().length > 0
      ? resolve(explicit.trim())
      : appData !== undefined && appData.trim().length > 0
        ? join(resolve(appData.trim()), "abdocode")
        : profile !== undefined && profile.trim().length > 0
          ? join(resolve(profile.trim()), ".abdocode")
          : undefined
  if (home === undefined) return { refusal: VAULT_REFUSALS.NO_PROFILE }
  if (SYNCED.test(home)) return { refusal: VAULT_REFUSALS.UNSAFE_HOME }
  // لا تُكتب الخزنة داخل شجرة المنتج أبداً — ولا في مجلّد عملٍ صادف أنه هي.
  const repo = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1")), "..", "..", "..")
  if (home.toLowerCase().startsWith(`${repo.toLowerCase()}\\`) || home.toLowerCase() === repo.toLowerCase()) {
    return { refusal: VAULT_REFUSALS.UNSAFE_HOME }
  }
  return { home }
}

/** أين الخزنة الآن — بلا كتابةِ شيء. قرارُ المالك يُقاس أوّلاً. */
export function resolveVaultScript(env: VaultEnv): VaultLocation | { refusal: VaultRefusal } {
  const owner = env[OWNER_VAULT_ENV]
  const home = vaultHome(env)
  if (owner !== undefined && owner.trim().length > 0) {
    const script = resolve(owner.trim())
    if (!existsSync(script)) return { refusal: VAULT_REFUSALS.OWNER_SCRIPT_MISSING }
    const store = env[VAULT_DIR_ENV] !== undefined && env[VAULT_DIR_ENV]!.trim().length > 0
      ? resolve(env[VAULT_DIR_ENV]!.trim())
      : "home" in home ? join(home.home, "vault") : ""
    return { script, store, owner: true }
  }
  if ("refusal" in home) return home
  return { script: join(home.home, "vault.ps1"), store: join(home.home, "vault"), owner: false }
}

/**
 * يكتب السكربت المشحون **مرّةً** تحت ملفّ المستخدم — ولا يفعل شيئاً إن كان
 * المالك قد أعلن خزنته. الكتابة بـUTF-8 **بعلامة ترتيب**: PowerShell 5.1
 * يقرأ ملفّاً بلا علامةٍ بترميز النظام، فتتشوّه تعليقاته العربية.
 */
export function ensureShippedVault(env: VaultEnv): (VaultLocation & { installed: boolean }) | { refusal: VaultRefusal } {
  const located = resolveVaultScript(env)
  if ("refusal" in located) return located
  if (located.owner) return { ...located, installed: false }
  const desired = `﻿${SHIPPED_VAULT_SCRIPT}`
  try {
    if (existsSync(located.script) && readFileSync(located.script, "utf8") === desired) return { ...located, installed: false }
    mkdirSync(dirname(located.script), { recursive: true })
    writeFileSync(located.script, desired, { encoding: "utf8" })
  } catch {
    return { refusal: VAULT_REFUSALS.INSTALL_FAILED }
  }
  return { ...located, installed: true }
}

/**
 * ⚠ العطلُ المقيس (2026-09-04، على النسخة **المشحونة**): المحرّكُ يعرف خزنتَه
 * ويقرأها، لكنّ ولدَيه من Rust لا يعرفانها — كلاهما يشترط `ABDO_VAULT_SCRIPT`
 * ولا أحدَ يضبطها. فكان `provider-has` يعود **صفراً لكلّ مزوّد**، وتسقط
 * الجولةُ صامتةً إلى نموذجٍ محلّيّ وتُبلغ سبباً كاذباً: «أولاما لا يستجيب».
 * مفتاحٌ يحفظه المشغّل من الواجهة لا يعمل أبداً، والرسالةُ تدلّه على الجهة
 * الخطأ. القياس: `provider-has qwen` = 0 بلا المتغيّر، و1 معه، والاعتمادُ
 * نفسُه في مكانه.
 *
 * فهذه الدالّةُ **تُعلن** ما حُلّ: قيمتان تُضافان إلى بيئة العملية فيرثهما
 * عاملُ المزوّدين. وقرارُ المالك يعلو — قيمةٌ موجودةٌ لا تُدهَس أبداً؛ والدالّةُ
 * خالصةٌ تعيد ما يجب ضبطه، والمُطبِّقُ سطرٌ واحدٌ عند المُنادي.
 *
 * وأدواتُ المشروع **لا ترث هذا**: `ALWAYS_STRIP_PREFIXES` في مجرِّد البيئة
 * يقطع `ABDO_VAULT*` عن كلّ ولدٍ يشغّله النموذج. العاملُ وحده يحمل المفتاح.
 */
export function vaultEnvOverlay(env: VaultEnv): { overlay: Record<string, string> } | { refusal: VaultRefusal } {
  // ‏`ensure` لا `resolve`: مسارٌ نُعلنه ولا ملفَّ عنده يجعل العاملَ يفشل
  // بصمتٍ كما كان — فالإعلانُ يلي الوجود، لا يسبقه.
  const located = ensureShippedVault(env)
  if ("refusal" in located) return located
  // خزنةُ المالك مُعلنةٌ أصلاً في البيئة — لا شيء يُضاف ولا شيء يُدهَس.
  if (located.owner) return { overlay: {} }
  const overlay: Record<string, string> = { [OWNER_VAULT_ENV]: located.script }
  const dir = env[VAULT_DIR_ENV]
  if (dir === undefined || dir.trim().length === 0) overlay[VAULT_DIR_ENV] = located.store
  return { overlay }
}

// ---------------------------------------------------------------------------
// الأفعال — رمزُ الخروج يُترجم إلى رفضٍ مسمّى، ولا رفضَ مجهول
// ---------------------------------------------------------------------------

const EXIT_REFUSAL: Readonly<Record<number, VaultRefusal>> = Object.freeze({
  2: VAULT_REFUSALS.UNKNOWN,
  3: VAULT_REFUSALS.HANDLE_SHAPE,
  4: VAULT_REFUSALS.DECRYPT_FAILED,
  5: VAULT_REFUSALS.VALUE_EMPTY,
  6: VAULT_REFUSALS.VALUE_TOO_LONG,
  7: VAULT_REFUSALS.VALUE_NEWLINE,
  8: VAULT_REFUSALS.NO_PROFILE,
  9: VAULT_REFUSALS.ARGV_REFUSED,
  10: VAULT_REFUSALS.WRITE_FAILED,
})

interface RunResult {
  readonly code: number
  readonly stdout: Uint8Array
}

const runVault = async (
  location: VaultLocation,
  env: VaultEnv,
  verb: VaultVerb,
  handle: string | undefined,
  stdin: Uint8Array | undefined,
): Promise<RunResult | { refusal: VaultRefusal }> => {
  const argv = vaultArgv(location.script, verb, handle)
  try {
    const child = Bun.spawn(argv, {
      // الجذر يُمرَّر صراحةً فلا يختلف ما يكتبه السكربت عمّا يقرؤه المحرّك.
      env: { ...(env as Record<string, string | undefined>), [VAULT_DIR_ENV]: location.store },
      stdin: stdin ?? "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
    const stdout = new Uint8Array(await new Response(child.stdout).arrayBuffer())
    const code = await child.exited
    return { code, stdout }
  } catch {
    return { refusal: VAULT_REFUSALS.SPAWN_FAILED }
  }
}

export type VaultGet = { readonly value: string } | { readonly absent: true } | { readonly refusal: VaultRefusal }

/** يقرأ القيمة بهيئة قارئ Rust نفسها. الغياب غيابٌ صريح لا سلسلةٌ فارغة. */
export async function vaultGet(handle: string, env: VaultEnv): Promise<VaultGet> {
  if (!VAULT_HANDLE_RE.test(handle)) return { refusal: VAULT_REFUSALS.HANDLE_SHAPE }
  const located = ensureShippedVault(env)
  if ("refusal" in located) return located
  const run = await runVault(located, env, "get", handle, undefined)
  if ("refusal" in run) return run
  if (run.code === 1) return { absent: true }
  if (run.code !== 0) return { refusal: EXIT_REFUSAL[run.code] ?? VAULT_REFUSALS.UNKNOWN }
  return rustReaderShape(run.stdout)
}

/** حضورٌ لا قيمة — الفعل نفسه الذي يستدعيه عامل Rust في `has`. */
export async function vaultHas(handle: string, env: VaultEnv): Promise<boolean | { refusal: VaultRefusal }> {
  if (!VAULT_HANDLE_RE.test(handle)) return { refusal: VAULT_REFUSALS.HANDLE_SHAPE }
  const located = ensureShippedVault(env)
  if ("refusal" in located) return located
  const run = await runVault(located, env, "has", handle, undefined)
  if ("refusal" in run) return run
  if (run.code === 0) return true
  if (run.code === 1) return false
  return { refusal: EXIT_REFUSAL[run.code] ?? VAULT_REFUSALS.UNKNOWN }
}

/**
 * يكتب القيمة — **على المدخل القياسيّ وحده**. وقبل الكتابة يُبرهَن أن ما
 * سيقرؤه العامل هو عينُ ما نكتبه (`rustReaderShape`)، فلا تُخزَّن قيمةٌ
 * تُقرأ مبتورةً. المتغيّر المحليّ الحامل للقيمة يُزفَّر بعد الإرسال.
 */
export async function vaultSet(handle: string, value: string, env: VaultEnv): Promise<{ ok: true } | { refusal: VaultRefusal }> {
  if (!VAULT_HANDLE_RE.test(handle)) return { refusal: VAULT_REFUSALS.HANDLE_SHAPE }
  if (value.length === 0) return { refusal: VAULT_REFUSALS.VALUE_EMPTY }
  if (/[\r\n\0]/u.test(value)) return { refusal: VAULT_REFUSALS.VALUE_NEWLINE }
  const bytes = new TextEncoder().encode(`v=${value}`)
  if (bytes.length - 2 > VAULT_VALUE_MAX_BYTES) return { refusal: VAULT_REFUSALS.VALUE_TOO_LONG }
  const proof = rustReaderShape(bytes)
  if ("refusal" in proof) return proof
  if (proof.value !== value) return { refusal: VAULT_REFUSALS.VALUE_SHAPE }
  const located = ensureShippedVault(env)
  if ("refusal" in located) return located
  const payload = new TextEncoder().encode(value)
  try {
    const run = await runVault(located, env, "set", handle, payload)
    if ("refusal" in run) return run
    if (run.code !== 0) return { refusal: EXIT_REFUSAL[run.code] ?? VAULT_REFUSALS.UNKNOWN }
    return { ok: true }
  } finally {
    payload.fill(0)
  }
}

export async function vaultForget(handle: string, env: VaultEnv): Promise<{ ok: true } | { absent: true } | { refusal: VaultRefusal }> {
  if (!VAULT_HANDLE_RE.test(handle)) return { refusal: VAULT_REFUSALS.HANDLE_SHAPE }
  const located = ensureShippedVault(env)
  if ("refusal" in located) return located
  const run = await runVault(located, env, "forget", handle, undefined)
  if ("refusal" in run) return run
  if (run.code === 1) return { absent: true }
  if (run.code !== 0) return { refusal: EXIT_REFUSAL[run.code] ?? VAULT_REFUSALS.UNKNOWN }
  return { ok: true }
}

/**
 * يُنشئ جذر الخزنة ويقصر صلاحياته على المستخدم وحده بالوراثة، ويعيد المسار.
 * يُستدعى قبل كتابة ملفّ قالب الإدخال: الملفّ يُكتب **داخل** هذا الجذر فيرث
 * حمايته، بدل ملفٍّ مؤقّتٍ عامّ يقرؤه كلُّ من على الجهاز.
 */
export async function vaultGuard(env: VaultEnv): Promise<{ store: string } | { refusal: VaultRefusal }> {
  const located = ensureShippedVault(env)
  if ("refusal" in located) return located
  const run = await runVault(located, env, "guard", undefined, undefined)
  if ("refusal" in run) return run
  if (run.code !== 0) return { refusal: EXIT_REFUSAL[run.code] ?? VAULT_REFUSALS.UNKNOWN }
  return { store: located.store }
}

/** المقابض الموجودة — أسماءٌ فقط، ولا قيمةَ تُقرأ ولا تُطبع. */
export async function vaultList(env: VaultEnv): Promise<{ handles: string[] } | { refusal: VaultRefusal }> {
  const located = ensureShippedVault(env)
  if ("refusal" in located) return located
  const run = await runVault(located, env, "list", undefined, undefined)
  if ("refusal" in run) return run
  if (run.code !== 0) return { refusal: EXIT_REFUSAL[run.code] ?? VAULT_REFUSALS.UNKNOWN }
  const handles = new TextDecoder().decode(run.stdout).split(/\r\n|\n/u).map((line) => line.trim()).filter((line) => line.length > 0)
  return { handles }
}
