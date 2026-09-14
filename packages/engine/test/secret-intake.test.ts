import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { REDACTED } from "../src/secret-command-guard"
import {
  INTAKE_PLACEHOLDER,
  INTAKE_REFUSALS,
  INTAKE_TIMEOUT_MS_DEFAULT,
  VAULT_HANDLE_RE,
  assistedIntake,
  classifyInboundSecret,
  editorArgv,
  intakeTemplate,
  intakeTimeoutMs,
  parseIntakeFile,
  rotationWarning,
  suggestedHandle,
  vaultHandleRefusal,
} from "../src/secret-intake"

const EDITOR_STUB = resolve(import.meta.dir, "fixtures", "intake-editor-stub.ts")

/**
 * جسدُ الأمر بنصّه (2026-09-02) أوّلاً — هو الحالة التي أوجبت السبرنت كلَّه:
 * «الحساب كذا و الباسورد كذا دخلهم في كذا».
 */
const OWNER_SENTENCE = "الحساب admin والباسورد Passw0rd2026 دخلهم في لوحة التحكم"

describe("classifyInboundSecret — العربية أوّلاً، والقيمة لا تنجو", () => {
  const positives: readonly { readonly body: string; readonly secret: string; readonly kind?: string }[] = [
    { body: OWNER_SENTENCE, secret: "Passw0rd2026", kind: "password" },
    { body: "كلمة السر: hunter2xy", secret: "hunter2xy", kind: "password" },
    { body: "المفتاح sk-live_9f2b7c1d4e6a8b0c2d4e حطه في الإعدادات", secret: "sk-live_9f2b7c1d4e6a8b0c2d4e", kind: "api-key" },
    { body: "التوكن ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", secret: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", kind: "api-key" },
    { body: "سجل دخول بحسابي: user@example.com / P@ss", secret: "user@example.com" },
    // اللهجات ورسمُ الحرف — «الباسوورد» و«الباصورد» و«الرقم السري» كلّها تُرى.
    { body: "الباسوورد Qwe123456", secret: "Qwe123456", kind: "password" },
    { body: "الباصورد: Zx9!kkQ2", secret: "Zx9!kkQ2", kind: "password" },
    { body: "الرقم السري 884422aa", secret: "884422aa", kind: "password" },
    { body: "پاسورد Str0ngOne", secret: "Str0ngOne", kind: "password" },
    // الإنجليزية
    { body: "the password is hunter2xy", secret: "hunter2xy", kind: "password" },
    { body: "use this api key sk-live_abcd1234efgh5678", secret: "sk-live_abcd1234efgh5678", kind: "api-key" },
    { body: "login with admin / Adm1n#2026", secret: "Adm1n#2026" },
    // JSON، سلسلة اتصال، وكتلة base64
    { body: 'الإعداد {"password": "s3cretValue"} انسخه', secret: "s3cretValue", kind: "password" },
    { body: "postgres://app:Sup3rS3cret@db:5432/prod", secret: "Sup3rS3cret", kind: "connection-string" },
    { body: "blob AAAAB3NzaC1yc2EAAAADAQABAAABgQDVeryLongBase64LookingValue1234567890", secret: "AAAAB3NzaC1yc2EAAAADAQABAAABgQDVeryLongBase64LookingValue1234567890", kind: "encoded-credential" },
    { body: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij", secret: "eyJhbGciOiJIUzI1NiJ9.abcdefghij", kind: "bearer-token" },
  ]

  for (const item of positives) {
    test(`يُصنَّف ويُحجب: ${item.body.slice(0, 44)}`, () => {
      const scan = classifyInboundSecret(item.body)
      expect(scan.carriesSecret).toBe(true)
      expect(scan.redacted).toContain(REDACTED)
      // الفحص الذي يهمّ: القيمة نفسها لم تعد في النصّ الذي سيُخزَّن.
      expect(scan.redacted).not.toContain(item.secret)
      expect(scan.spans.length).toBeGreaterThan(0)
      if (item.kind !== undefined) expect(scan.kinds).toContain(item.kind)
      // ولا موضعٌ يحمل نصّاً: الشكلُ والمدى فقط.
      for (const span of scan.spans) {
        expect(Object.keys(span).sort()).toEqual(["kind", "length", "start"])
        expect(span.length).toBeGreaterThan(0)
      }
    })
  }

  // ⛔ المطفأ الكاذب: هذه الجُمل تتحدّث **عن** الأسرار ولا تحمل واحداً.
  const negatives = [
    "نسيت كلمة السر، كيف أستعيدها؟",
    "اشرح لي إدارة الأسرار",
    "الباسورد يجب ألا يُكتب في المحادثة",
    "كيف أخزّن المفتاح في خزنة بدل الملف؟",
    "اقرأ ملف src/index.ts ثم اشرح الدالة",
    "شغّل npm run build وأخبرني بالنتيجة",
    "the password requirements are strict",
    "أضف حقل password إلى النموذج",
  ]
  for (const body of negatives) {
    test(`لا يُعدّ حاملاً: ${body.slice(0, 40)}`, () => {
      const scan = classifyInboundSecret(body)
      expect(scan.carriesSecret).toBe(false)
      expect(scan.redacted).toBe(body)
      expect(scan.redactions).toBe(0)
      expect(scan.kinds).toEqual([])
    })
  }

  test("الحجب متساوي القوى في النصّ — تمريرةٌ ثانية لا تغيّر بايتاً", () => {
    for (const item of positives) {
      const once = classifyInboundSecret(item.body).redacted
      expect(classifyInboundSecret(once).redacted).toBe(once)
    }
  })

  test("جسدٌ فارغ أو ليس نصّاً لا يرمي ولا يدّعي", () => {
    expect(classifyInboundSecret("").carriesSecret).toBe(false)
    expect(classifyInboundSecret(undefined).redacted).toBe("")
    expect(classifyInboundSecret(42).carriesSecret).toBe(false)
  })

  test("بادئةُ المزوّد تُعرف فيصير للمقبض اسمٌ يعرفه المستخدم", () => {
    expect(classifyInboundSecret("المفتاح sk-ant-api03-abcdef123456").providerHandle).toBe("abdocode-anthropic")
    expect(classifyInboundSecret("التوكن ghp_A1b2C3d4E5f6G7h8I9j0K1").providerHandle).toBe("github-token")
    expect(classifyInboundSecret(OWNER_SENTENCE).providerHandle).toBeUndefined()
    expect(suggestedHandle(classifyInboundSecret(OWNER_SENTENCE))).toBe("chat-password")
    expect(suggestedHandle(classifyInboundSecret("المفتاح sk-ant-api03-abcdef123456"))).toBe("abdocode-anthropic")
    // وكلُّ مقبضٍ مقترحٍ يطابق النمط بالبناء — لا مقبضَ يُرفض بعد اقتراحه.
    for (const item of positives) expect(VAULT_HANDLE_RE.test(suggestedHandle(classifyInboundSecret(item.body)))).toBe(true)
  })
})

describe("rotationWarning — يسمّي الشكل ولا يلمس القيمة", () => {
  test("سطرُ المشرف وجملةُ النموذج يقولان «محروق» ويسمّيان الشكل", () => {
    const warning = rotationWarning(["password"])
    expect(warning.operator).toContain("تدوير")
    expect(warning.operator).toContain("كلمة مرور")
    expect(warning.model).toContain("كلمة مرور")
    expect(warning.model).toContain("مقبض")
    expect(warning.step).toBeUndefined()
  })

  test("مقبضُ مزوّدٍ معروف يعطي خطوة التدوير الملموسة", () => {
    const warning = rotationWarning(["api-key"], "abdocode-anthropic")
    expect(warning.step).toContain("console.anthropic.com")
    expect(warning.operator).toContain("console.anthropic.com")
    expect(rotationWarning(["api-key"], "github-token").step).toContain("github.com/settings/tokens")
    // مقبضٌ لا نعرف خطوته: لا خطوةَ مخترعة، وجملةٌ عامّة صادقة.
    expect(rotationWarning(["api-key"], "chat-api-key").step).toBeUndefined()
  })

  test("⛔ التسرّب الكلاسيكيّ: الرفضُ الذي يشرح الرفض لا يحمل القيمة", () => {
    const scan = classifyInboundSecret(OWNER_SENTENCE)
    const warning = rotationWarning(scan.kinds, scan.providerHandle)
    for (const text of [warning.operator, warning.model, warning.step ?? ""]) {
      expect(text).not.toContain("Passw0rd2026")
      expect(text).not.toContain("admin")
    }
  })
})

describe("القالب — ما يفتحه المحرّر وما يُقرأ منه", () => {
  test("القالب يحمل المقبض والشكل ويشرح أن السرّ القديم محروق", () => {
    const text = intakeTemplate("chat-password", ["password"])
    expect(text).toContain("chat-password")
    expect(text).toContain("كلمة مرور")
    expect(text).toContain("محروق")
    expect(text).toContain(INTAKE_PLACEHOLDER)
    // نوت باد لا يعرف LF وحده — القالب بـCRLF كي لا يظهر سطراً واحداً.
    expect(text).toContain("\r\n")
  })

  test("القراءة: قيمةٌ واحدة تمرّ، وكلُّ ما عداها رفضٌ مسمّى", () => {
    expect(parseIntakeFile(`# شرح\r\nsk-new-value-123\r\n`).value).toBe("sk-new-value-123")
    expect(parseIntakeFile(intakeTemplate("h", [])).refusal).toBe(INTAKE_REFUSALS.TEMPLATE_UNTOUCHED)
    expect(parseIntakeFile("# شرح فقط\r\n\r\n").refusal).toBe(INTAKE_REFUSALS.TEMPLATE_EMPTY)
    expect(parseIntakeFile("# شرح\r\naaa\r\nbbb\r\n").refusal).toBe(INTAKE_REFUSALS.TEMPLATE_AMBIGUOUS)
    expect(parseIntakeFile(`# شرح\r\n${"x".repeat(20_000)}\r\n`).refusal).toBe(INTAKE_REFUSALS.TEMPLATE_TOO_LONG)
    expect(parseIntakeFile(undefined).refusal).toBe(INTAKE_REFUSALS.TEMPLATE_UNREADABLE)
    // الفراغُ الطرفيّ يُقصّ: مستخدمٌ يلصق قيمةً بمسافةٍ في آخرها لا يُعاقَب.
    expect(parseIntakeFile("#\r\n   value-with-space   \r\n").value).toBe("value-with-space")
  })

  test("المقبض يُرفض بالاسم خارج النمط — ولا تطبيع صامت", () => {
    for (const bad of ["Chat-Password", "../escape", "a/b", "", "-starts-with-dash", "x".repeat(122), "لاتيني"]) {
      expect(vaultHandleRefusal(bad)).toBe(INTAKE_REFUSALS.HANDLE_SHAPE)
    }
    expect(vaultHandleRefusal("abdocode-anthropic")).toBeUndefined()
    expect(vaultHandleRefusal("chat-password")).toBeUndefined()
  })
})

describe("editorArgv — تنفيذيٌّ مباشر، لا نصُّ صدفة", () => {
  test("ويندوز يفتح notepad.exe نفسه، ولا `cmd /c start` في أيّ منصّة", () => {
    expect(editorArgv({}, "win32")).toEqual(["notepad.exe"])
    expect(editorArgv({}, "darwin")).toEqual(["open", "-W", "-t"])
    expect(editorArgv({}, "linux")).toEqual(["nano"])
    for (const platform of ["win32", "darwin", "linux"]) {
      const argv = editorArgv({}, platform).join(" ")
      expect(argv).not.toContain("cmd")
      expect(argv).not.toContain("start")
      expect(argv).not.toContain("&")
    }
  })

  test("المشغّل يعيّن محرّره ووسيطاً ثابتاً واحداً", () => {
    expect(editorArgv({ ABDO_INTAKE_EDITOR: "code" }, "win32")).toEqual(["code"])
    expect(editorArgv({ ABDO_INTAKE_EDITOR: "code", ABDO_INTAKE_EDITOR_ARG: "-w" }, "win32")).toEqual(["code", "-w"])
  })

  test("المهلة محدودةٌ بالبناء — والقيمة المشوَّهة تعيد الافتراض لا انتظاراً مفتوحاً", () => {
    expect(intakeTimeoutMs(undefined)).toBe(INTAKE_TIMEOUT_MS_DEFAULT)
    expect(intakeTimeoutMs("nonsense")).toBe(INTAKE_TIMEOUT_MS_DEFAULT)
    expect(intakeTimeoutMs("0")).toBe(INTAKE_TIMEOUT_MS_DEFAULT)
    expect(intakeTimeoutMs("99999999")).toBe(INTAKE_TIMEOUT_MS_DEFAULT)
    expect(intakeTimeoutMs("30000")).toBe(30_000)
  })
})

describe("assistedIntake — الملفّ يُزفَّر ويُحذف في كلّ فرع", () => {
  const withDirectory = async (
    body: (directory: string) => Promise<void>,
  ): Promise<void> => {
    const directory = mkdtempSync(join(tmpdir(), "abdo-intake-"))
    try { await body(directory) } finally { rmSync(directory, { recursive: true, force: true }) }
  }

  /** المحرّر المزيّف — تنفيذيٌّ ووسائطُه، ومسارُ القالب يُلحق آخِراً. */
  const stubEditor = (...directives: string[]): string[] => [process.execPath, EDITOR_STUB, ...directives]

  test("دورةٌ كاملة: يُكتب القالب، يُفتح المحرّر تنفيذياً، تُخزَّن القيمة، ويُحذف الملفّ", async () => {
    await withDirectory(async (directory) => {
      const seen: { handle: string; value: string }[] = []
      const outcome = await assistedIntake({
        handle: "chat-api-key",
        kinds: ["api-key"],
        directory,
        editor: stubEditor("--value=sk-rotated-9f2b7c1d"),
        timeoutMs: 30_000,
        store: async (handle, value) => { seen.push({ handle, value }); return { ok: true } },
      })
      expect(outcome.ok).toBe(true)
      expect(outcome.refusal).toBeUndefined()
      expect(seen).toEqual([{ handle: "chat-api-key", value: "sk-rotated-9f2b7c1d" }])
      expect(outcome.templateRemains).toBe(false)
      expect(outcomeFilesGone(directory)).toBe(true)
    })
  }, 30_000)

  test("⛔ الطفرة (ج): فشلُ الخزنة لا يترك الملفّ — الحذف يقع على مسار الفشل أيضاً", async () => {
    await withDirectory(async (directory) => {
      const outcome = await assistedIntake({
        handle: "chat-password",
        kinds: ["password"],
        directory,
        editor: stubEditor("--value=value-that-will-not-store"),
        timeoutMs: 30_000,
        store: async () => ({ refusal: "رُفض التخزين: اختبار" }),
      })
      expect(outcome.ok).toBe(false)
      expect(outcome.refusal).toBe("رُفض التخزين: اختبار")
      expect(outcome.templateRemains).toBe(false)
      expect(outcomeFilesGone(directory)).toBe(true)
    })
  }, 30_000)

  test("محرّرٌ يُغلق بلا كتابة = رفضٌ مسمّى بلا حالةٍ جزئية", async () => {
    await withDirectory(async (directory) => {
      const outcome = await assistedIntake({
        handle: "chat-password",
        kinds: ["password"],
        directory,
        editor: stubEditor("--noop"),
        timeoutMs: 30_000,
        store: async () => { throw new Error("الخزنة لا تُلمس أصلاً") },
      })
      expect(outcome.refusal).toBe(INTAKE_REFUSALS.TEMPLATE_UNTOUCHED)
      expect(outcomeFilesGone(directory)).toBe(true)
    })
  }, 30_000)

  test("محرّرٌ لا يُغلق: مهلةٌ محدودة، قتلٌ، حذفُ الملفّ، ورفضٌ مسمّى", async () => {
    await withDirectory(async (directory) => {
      const started = Date.now()
      const outcome = await assistedIntake({
        handle: "chat-password",
        kinds: ["password"],
        directory,
        editor: stubEditor("--hang"),
        timeoutMs: 2_000,
        store: async () => { throw new Error("لا خزنةَ على مسار المهلة") },
      })
      expect(outcome.refusal).toBe(INTAKE_REFUSALS.EDITOR_TIMEOUT)
      expect(Date.now() - started).toBeLessThan(20_000)
      expect(outcomeFilesGone(directory)).toBe(true)
    })
  }, 30_000)

  test("محرّرٌ غير موجود = رفضٌ مسمّى، ولا ملفّ متروك ولا تعليق", async () => {
    await withDirectory(async (directory) => {
      const outcome = await assistedIntake({
        handle: "chat-password",
        kinds: ["password"],
        directory,
        editor: [join(directory, "no-such-editor-anywhere.exe")],
        timeoutMs: 5_000,
        store: async () => { throw new Error("لا خزنة") },
      })
      expect(outcome.ok).toBe(false)
      expect(outcome.refusal).toBe(INTAKE_REFUSALS.EDITOR_UNAVAILABLE)
      expect(outcomeFilesGone(directory)).toBe(true)
    })
  }, 30_000)

  test("مقبضٌ خارج النمط يُرفض قبل أن يُكتب أيّ ملفّ", async () => {
    await withDirectory(async (directory) => {
      const outcome = await assistedIntake({
        handle: "../escape",
        kinds: [],
        directory,
        editor: [process.execPath, EDITOR_STUB],
        timeoutMs: 5_000,
        store: async () => { throw new Error("لا خزنة") },
      })
      expect(outcome.refusal).toBe(INTAKE_REFUSALS.HANDLE_SHAPE)
      expect(readdirSync(directory)).toEqual([])
    })
  })

  test("القالب على القرص قبل المحرّر: يحمل المقبض ولا يحمل قيمة", async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, "chat-password.intake.txt")
      writeFileSync(path, intakeTemplate("chat-password", ["password"]), "utf8")
      const onDisk = readFileSync(path, "utf8")
      expect(onDisk).toContain("chat-password")
      expect(onDisk).toContain(INTAKE_PLACEHOLDER)
      expect(existsSync(path)).toBe(true)
    })
  })
})

/** لا ملفَّ إدخالٍ بقي — الفحص من القرص لا من قيمة الإرجاع. */
const outcomeFilesGone = (directory: string): boolean =>
  readdirSync(directory).filter((name) => name.endsWith(".intake.txt")).length === 0
