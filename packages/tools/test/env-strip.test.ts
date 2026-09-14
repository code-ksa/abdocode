import { describe, expect, test } from "bun:test"
import { stripChildEnv, ALWAYS_STRIP_ENV, STRIP_UNLESS_PASSED_ENV } from "../src/env-strip"

/**
 * الفحصُ السلبيُّ وحده يمرّ وهو فارغ: «لا يتسرّب السرّ» صادقٌ عن بيئةٍ فارغة.
 * فلكلّ نزعٍ هنا **توأمٌ إيجابي** يثبت أنّ ما يجب أن يعبر عبر فعلاً — وأنّ
 * الحارس لم يصر ساتراً يحجب كلّ شيء (وهو الاتجاه المعاكس الذي تحذّر منه
 * قاعدةُ الحرّاس عندنا).
 */
describe("نزعُ الاعتمادات عن بيئة الابن", () => {
  const REAL = {
    // حاملةٌ للعمل — يجب أن تعبر كلُّها.
    PATH: "C:/Windows/System32",
    SystemRoot: "C:/Windows",
    TEMP: "C:/Temp",
    APPDATA: "C:/Users/x/AppData/Roaming",
    NUMBER_OF_PROCESSORS: "8",
    NODE_ENV: "test",
    // أسرارٌ يجب أن تُنزع.
    ABDO_SHELL_TOKEN: "shell-secret",
    GITHUB_TOKEN: "ghp_xxx",
    OPENAI_API_KEY: "sk-xxx",
    SOME_NEW_PROVIDER_API_KEY: "unknown-vendor",
    DB_PASSWORD: "hunter2",
    STRIPE_SECRET: "sk_live_xxx",
  }

  test("الحاملُ للعمل يعبر كلُّه — الحارسُ ليس ساتراً", () => {
    const { env } = stripChildEnv(REAL)
    for (const name of ["PATH", "SystemRoot", "TEMP", "APPDATA", "NUMBER_OF_PROCESSORS", "NODE_ENV"]) {
      expect(`${name}=${env[name]}`).toBe(`${name}=${REAL[name as keyof typeof REAL]}`)
    }
  })

  test("الأسرارُ تُنزع — بالاسم المعروف وباللاحقة لما لا نعرفه", () => {
    const { env, stripped } = stripChildEnv(REAL)
    for (const name of ["ABDO_SHELL_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "SOME_NEW_PROVIDER_API_KEY", "DB_PASSWORD", "STRIPE_SECRET"]) {
      expect(`${name} present=${name in env}`).toBe(`${name} present=false`)
    }
    // التوأمُ الإيجابي: النزعُ حدث فعلاً ولم تكن البيئةُ فارغةً أصلاً.
    expect(stripped.length).toBe(6)
    expect(Object.keys(env).length).toBe(6)
  })

  test("مقابضُ الخزنة الحقيقيّة تُنزع بقاعدة شكلٍ لا بقائمةِ أسماءٍ تهرم", () => {
    // العطلُ المقيس في هذه الوحدة نفسِها: كانت تسمّي أسماءً لا يضبطها المنتَج
    // وتترك الثلاثةَ الحقيقيّة تعبر. البادئةُ تلتقطها كلَّها وما يُخترع بعدها.
    const { env, stripped } = stripChildEnv({
      ABDO_VAULT_SCRIPT: "C:/vault.ps1", ABDO_VAULT_DIR: "C:/v", ABDO_VAULT_HOME: "C:/h",
      ABDO_VAULT_ANYTHING_NEW: "future", PATH: "p",
    })
    expect(Object.keys(env)).toEqual(["PATH"])
    expect([...stripped].sort()).toEqual(["ABDO_VAULT_ANYTHING_NEW", "ABDO_VAULT_DIR", "ABDO_VAULT_HOME", "ABDO_VAULT_SCRIPT"])
  })

  test("«دائماً» تعني دائماً: طلبُ التمرير لا يفتح رمزَ القشرة ولا الخزنة", () => {
    const { env, stripped, passed } = stripChildEnv({ ...REAL, ABDO_VAULT_SCRIPT: "C:/v.ps1" }, { pass: ["ABDO_SHELL_TOKEN", "ABDO_VAULT_SCRIPT"] })
    expect("ABDO_VAULT_SCRIPT" in env).toBe(false)
    expect(stripped).toContain("ABDO_VAULT_SCRIPT")
    expect("ABDO_SHELL_TOKEN" in env).toBe(false)
    expect(stripped).toContain("ABDO_SHELL_TOKEN")
    expect(passed).not.toContain("ABDO_SHELL_TOKEN")
    // والتوأم: طلبُ تمريرٍ مشروع **يعمل** — وإلا كان الفحصُ يثبت جموداً لا سياسة.
    const legit = stripChildEnv(REAL, { pass: ["GITHUB_TOKEN"] })
    expect(legit.env["GITHUB_TOKEN"]).toBe("ghp_xxx")
    expect(legit.passed).toEqual(["GITHUB_TOKEN"])
    expect(legit.stripped).not.toContain("GITHUB_TOKEN")
  })

  test("النزعُ يُسمّى ولا يصمت — الإيصال يستطيع قولَ ما نُزع", () => {
    const { stripped } = stripChildEnv(REAL)
    expect(stripped).toEqual([...stripped].sort())
    expect(stripped).toContain("OPENAI_API_KEY")
    // ولا تُذكر قيمةٌ قطّ — الأسماءُ وحدها، فالإيصالُ لا يصير مسرباً ثانياً.
    expect(JSON.stringify(stripped)).not.toContain("sk-xxx")
  })

  test("اسمٌ ينتهي بلاحقةِ سرٍّ وليس سرّاً يُعفى بالاسم لا بالحظّ", () => {
    const { env } = stripChildEnv({ GIT_ASKPASS: "/usr/bin/askpass", SSH_ASKPASS: "x", FOO_TOKEN: "s" })
    expect(env["GIT_ASKPASS"]).toBe("/usr/bin/askpass")
    expect(env["SSH_ASKPASS"]).toBe("x")
    expect("FOO_TOKEN" in env).toBe(false)
  })

  test("خالصةٌ: لا تُغيّر مصدرَها ولا تقرأ بيئةً ضمنيّة", () => {
    const source = { PATH: "p", SECRET_TOKEN: "s" }
    const before = JSON.stringify(source)
    stripChildEnv(source)
    expect(JSON.stringify(source)).toBe(before)
    // قيمةٌ غيرُ نصّية تُسقَط ولا تُمرَّر undefined إلى الابن.
    expect(stripChildEnv({ A: undefined, B: "b" }).env).toEqual({ B: "b" })
  })

  test("القائمتان مجمَّدتان — ولا تتقاطعان (اسمٌ في الاثنتين يجعل «ما لم يُطلب» كذبة)", () => {
    expect(Object.isFrozen(ALWAYS_STRIP_ENV)).toBe(true)
    expect(Object.isFrozen(STRIP_UNLESS_PASSED_ENV)).toBe(true)
    const overlap = ALWAYS_STRIP_ENV.filter((n) => STRIP_UNLESS_PASSED_ENV.includes(n))
    expect(overlap).toEqual([])
    expect(ALWAYS_STRIP_ENV.length).toBeGreaterThan(0)
    expect(STRIP_UNLESS_PASSED_ENV.length).toBeGreaterThan(0)
  })

  test("فريقٌ أحمر: أشكالٌ حقيقيّة لأسماء الأسرار لا تعبر", () => {
    const attempts = {
      ANTHROPIC_API_KEY: "1", MINIMAX_API_KEY: "2", GROQ_API_KEY: "3",
      HF_TOKEN: "4", SLACK_TOKEN: "5", MYSQL_PASSWORD: "6",
      SERVICE_ACCOUNT_CREDENTIALS: "7", DEPLOY_PRIVATE_KEY: "8",
      AWS_SECRET_ACCESS_KEY: "9", CARGO_REGISTRY_TOKEN: "10",
    }
    const { env, stripped } = stripChildEnv(attempts)
    expect(Object.keys(env)).toEqual([])
    expect(stripped.length).toBe(Object.keys(attempts).length)
  })
})
