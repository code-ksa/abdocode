import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  OWNER_VAULT_ENV,
  POWERSHELL_FLAGS,
  SHIPPED_VAULT_SCRIPT,
  VAULT_REFUSALS,
  ensureShippedVault,
  resolveVaultScript,
  rustReaderShape,
  vaultArgv,
  vaultForget,
  vaultGet,
  vaultGuard,
  vaultHas,
  vaultList,
  vaultSet,
} from "../src/vault"

/** بيتٌ خارج المستودع دوماً — الخزنة لا تُكتب في شجرة المنتج ولا في مزامَن. */
const freshHome = (): string => mkdtempSync(join(tmpdir(), "abdo-vault-"))
const envFor = (home: string): Record<string, string | undefined> => ({
  ABDO_VAULT_HOME: home,
  SystemRoot: process.env.SystemRoot,
  windir: process.env.windir,
  PATH: process.env.PATH,
  Path: process.env.Path,
  PATHEXT: process.env.PATHEXT,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
})

const windows = process.platform === "win32"
/** الخزنة المشحونة تتكلّم PowerShell — تُقاس حيث تعمل، ولا تُدَّعى حيث لا تعمل. */
const onWindows = windows ? test : test.skip

describe("رقعة القارئ — محاكاةٌ بايتيّة لقارئ عامل Rust", () => {
  test("القصُّ من الآخر، والإسقاط حتى أوّل «=»، ورفضُ الهيئة الممنوعة", () => {
    expect(rustReaderShape(new TextEncoder().encode("v=plain-value\r\n"))).toEqual({ value: "plain-value" })
    // ⛔ الفخّ المقيس: القارئ يُسقط حتى **أوّل** «=» — فبادئة `v=` تجعل ذلك
    // الإسقاط فاصلَنا، وقيمةٌ فيها «=» (base64) تنجو كاملةً بدل أن تُبتر.
    expect(rustReaderShape(new TextEncoder().encode("v=AA==BB+/=="))).toEqual({ value: "AA==BB+/==" })
    expect(rustReaderShape(new Uint8Array())).toEqual({ refusal: VAULT_REFUSALS.VALUE_EMPTY })
    expect(rustReaderShape(new TextEncoder().encode("v="))).toEqual({ refusal: VAULT_REFUSALS.VALUE_EMPTY })
    expect(rustReaderShape(new TextEncoder().encode("v=a\nb"))).toEqual({ refusal: VAULT_REFUSALS.VALUE_NEWLINE })
    expect(rustReaderShape(new TextEncoder().encode(`v=${"x".repeat(20_000)}`))).toEqual({ refusal: VAULT_REFUSALS.VALUE_TOO_LONG })
  })
})

describe("سطرُ الأمر — القيمة لا تمرّ منه أبداً", () => {
  test("الأعلام أعلامُ عامل Rust نفسها، والوسائط ثلاثةٌ لا أكثر", () => {
    expect(POWERSHELL_FLAGS).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
    expect(vaultArgv("C:/v.ps1", "set", "chat-api-key")).toEqual([
      "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:/v.ps1", "set", "chat-api-key",
    ])
    expect(vaultArgv("C:/v.ps1", "list")).toHaveLength(8)
  })

  test("⛔ الطفرة (ب): السكربت المشحون **يرفض** أيّ وسيطٍ زائد بدل تجاهله", () => {
    // فلو مرّر أحدٌ القيمة وسيطاً رابعاً لفشل النداء بالاسم (رمز 9) ولم
    // «يعمل بصمت» وقد سرّب السرّ إلى قائمة العمليات.
    expect(SHIPPED_VAULT_SCRIPT).toContain("ValueFromRemainingArguments")
    expect(SHIPPED_VAULT_SCRIPT).toContain("exit 9")
    expect(SHIPPED_VAULT_SCRIPT).toContain("OpenStandardInput")
    expect(SHIPPED_VAULT_SCRIPT).not.toContain("Read-Host")
  })
})

describe("موضعُ الخزنة — يُقاس قبل أن يُكتب", () => {
  test("بلا ملفّ مستخدمٍ لا خزنة — والغياب رفضٌ لا إذن", () => {
    expect(resolveVaultScript({})).toEqual({ refusal: VAULT_REFUSALS.NO_PROFILE })
  })

  test("وجهةٌ مزامَنة سحابياً تُرفض بالاسم", () => {
    const synced = resolveVaultScript({ ABDO_VAULT_HOME: join(tmpdir(), "OneDrive", "abdo") })
    expect(synced).toEqual({ refusal: VAULT_REFUSALS.UNSAFE_HOME })
  })

  test("داخل شجرة المنتج مرفوضٌ أيضاً — لا خزنة في المستودع", () => {
    const inRepo = resolve(import.meta.dir, "..", "..", "..", "tmp", "vault-home")
    expect(resolveVaultScript({ ABDO_VAULT_HOME: inRepo })).toEqual({ refusal: VAULT_REFUSALS.UNSAFE_HOME })
  })

  test("خزنةُ المالك تعلو ولا يُكتب فوقها — وغيابُ ملفّها رفضٌ لا ارتداد", () => {
    const home = freshHome()
    try {
      const ownerScript = join(home, "owner-vault.ps1")
      // (أ) مضبوطٌ على ملفٍّ غائب: رفضٌ مسمّى، لا سقوطٌ صامت إلى المشحونة.
      expect(resolveVaultScript({ ...envFor(home), [OWNER_VAULT_ENV]: ownerScript }))
        .toEqual({ refusal: VAULT_REFUSALS.OWNER_SCRIPT_MISSING })
      // (ب) موجود: هو الخزنة، ولا يُثبَّت المشحون ولا يُكتب فوقه بايت.
      writeFileSync(ownerScript, "# خزنة المالك\n", "utf8")
      const before = readFileSync(ownerScript, "utf8")
      const located = ensureShippedVault({ ...envFor(home), [OWNER_VAULT_ENV]: ownerScript })
      expect(located).toMatchObject({ owner: true, installed: false, script: resolve(ownerScript) })
      expect(readFileSync(ownerScript, "utf8")).toBe(before)
      expect(existsSync(join(home, "vault.ps1"))).toBe(false)
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  test("بلا متغيّر المالك: المشحون يُكتب مرّةً، ثم لا يُعاد", () => {
    const home = freshHome()
    try {
      const first = ensureShippedVault(envFor(home))
      expect(first).toMatchObject({ owner: false, installed: true })
      expect(existsSync(join(home, "vault.ps1"))).toBe(true)
      // بعلامة ترتيبٍ كي يقرأ PowerShell 5.1 تعليقاته العربية صحيحةً.
      const bytes = readFileSync(join(home, "vault.ps1"))
      expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf])
      expect(ensureShippedVault(envFor(home))).toMatchObject({ installed: false })
    } finally { rmSync(home, { recursive: true, force: true }) }
  })
})

describe("الأفعال الحيّة — get/has/set تتّفق على القرص", () => {
  onWindows("دورةٌ كاملة: غائبٌ ⇒ مضبوطٌ ⇒ مقروءٌ ⇒ منسيّ — والقيمة لا تُطبع إلا لقارئها", async () => {
    const home = freshHome()
    const env = envFor(home)
    try {
      // الغياب غيابٌ صريح، لا سلسلةٌ فارغة تُقرأ نجاحاً.
      expect(await vaultHas("chat-api-key", env)).toBe(false)
      expect(await vaultGet("chat-api-key", env)).toEqual({ absent: true })
      // قيمةٌ فيها «=» و«+» و«/» — أصعبُ ما يمرّ بقارئ Rust.
      const value = "sk-live_AA==BB+/rotated-2026"
      expect(await vaultSet("chat-api-key", value, env)).toEqual({ ok: true })
      expect(await vaultHas("chat-api-key", env)).toBe(true)
      expect(await vaultGet("chat-api-key", env)).toEqual({ value })
      expect(await vaultList(env)).toEqual({ handles: ["chat-api-key"] })
      // ولا نصَّ صريحاً على القرص: الملفّ محميٌّ بـDPAPI لا مكتوبٌ عارياً.
      const stored = readFileSync(join(home, "vault", "chat-api-key.sec"), "utf8")
      expect(stored).not.toContain(value)
      expect(stored).not.toContain("rotated")
      expect(await vaultForget("chat-api-key", env)).toEqual({ ok: true })
      expect(await vaultHas("chat-api-key", env)).toBe(false)
      expect(await vaultForget("chat-api-key", env)).toEqual({ absent: true })
    } finally { rmSync(home, { recursive: true, force: true }) }
  }, 60_000)

  onWindows("قيمةٌ تحمل CR أو LF تُرفض بالاسم — العقد نفسه الذي يرفضه قارئ Rust", async () => {
    const home = freshHome()
    const env = envFor(home)
    try {
      expect(await vaultSet("chat-password", "two\nlines", env)).toEqual({ refusal: VAULT_REFUSALS.VALUE_NEWLINE })
      expect(await vaultSet("chat-password", "carriage\rreturn", env)).toEqual({ refusal: VAULT_REFUSALS.VALUE_NEWLINE })
      expect(await vaultSet("chat-password", "", env)).toEqual({ refusal: VAULT_REFUSALS.VALUE_EMPTY })
      // ولا ملفَّ نصفيّاً بقي بعد أيّ رفض.
      expect(existsSync(join(home, "vault", "chat-password.sec"))).toBe(false)
    } finally { rmSync(home, { recursive: true, force: true }) }
  }, 60_000)

  onWindows("مقبضٌ خارج النمط يُرفض قبل أيّ عملية", async () => {
    const home = freshHome()
    const env = envFor(home)
    try {
      for (const bad of ["Chat-Key", "../escape", "a b"]) {
        expect(await vaultSet(bad, "x", env)).toEqual({ refusal: VAULT_REFUSALS.HANDLE_SHAPE })
        expect(await vaultGet(bad, env)).toEqual({ refusal: VAULT_REFUSALS.HANDLE_SHAPE })
        expect(await vaultHas(bad, env)).toEqual({ refusal: VAULT_REFUSALS.HANDLE_SHAPE })
      }
      expect(existsSync(join(home, "vault"))).toBe(false)
    } finally { rmSync(home, { recursive: true, force: true }) }
  }, 60_000)

  onWindows("guard يُنشئ جذر الخزنة ويقصره على المستخدم — فيه يُكتب قالبُ الإدخال", async () => {
    const home = freshHome()
    const env = envFor(home)
    try {
      const guarded = await vaultGuard(env)
      expect(guarded).toEqual({ store: join(home, "vault") })
      expect(existsSync(join(home, "vault"))).toBe(true)
      expect(readdirSync(join(home, "vault"))).toEqual([])
    } finally { rmSync(home, { recursive: true, force: true }) }
  }, 60_000)
})
