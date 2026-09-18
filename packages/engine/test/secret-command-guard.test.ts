import { describe, expect, test } from "bun:test"
import {
  REDACTED,
  redactSecretValues,
  residualSecretMatches,
  secretInCommandViolation,
  secretInSourceViolation,
  sweepResidualSecrets,
} from "../src/secret-command-guard"

describe("secret in command — S12 / KF-1", () => {
  test("refuses passwords and secret-shaped values in argv", () => {
    expect(secretInCommandViolation("psql -U admin -p SuperSecret123")).toContain("سطر الأمر")
    expect(secretInCommandViolation("PGPASSWORD=hunter2seventy node seed.js")).toContain("KF-1")
    expect(secretInCommandViolation('node deploy.js --api-key=sk-live-AbC123XyZ789kLmNoP')).toContain("سرٌّ حرفيّ")
  })

  test("allows env references, short flags and clean commands", () => {
    expect(secretInCommandViolation("node app.js --port 3000")).toBeUndefined()
    expect(secretInCommandViolation("psql -U admin -h localhost mydb")).toBeUndefined()
    expect(secretInCommandViolation("API_KEY=$env:API_KEY node app.js")).toBeUndefined()
    expect(secretInCommandViolation("npm run build")).toBeUndefined()
  })
})

describe("secret in source — S12 / KF-9", () => {
  const t = (target: string, after: string) => secretInSourceViolation({ normalizedTarget: target, after })

  test("refuses a secret literal inside a use-client component", () => {
    const src = '"use client"\nconst apiKey = "sk-live-9aB7cD3eF1gH5iJ2kL"\nexport default function P(){return null}'
    expect(t("app/dash/page.tsx", src)).toContain("use client")
  })

  test("refuses disabling TLS verification", () => {
    expect(t("app/lib/http.ts", "const a = { rejectUnauthorized: false }")).toContain("TLS")
  })

  test("refuses string-built SQL (injection)", () => {
    expect(t("app/api/x/route.ts", 'db.query(`SELECT * FROM users WHERE id = ${userId}`)')).toContain("حقن")
    expect(t("app/api/x/route.ts", 'db.prepare("SELECT * FROM u WHERE n = " + name)')).toContain("معاملات")
  })

  test("refuses real values in .env.example", () => {
    expect(t(".env.example", "API_KEY=sk-live-9aB7cD3eF1gH5iJ2kLmN")).toContain("المثال")
  })

  test("allows parameterized SQL, env reads, and non-client secrets stay for auth-guard", () => {
    expect(t("app/api/x/route.ts", 'db.query("SELECT * FROM u WHERE id = ?", [userId])')).toBeUndefined()
    expect(t("app/lib/db.ts", "const key = process.env.API_KEY")).toBeUndefined()
    // ملف اختبار يُستثنى.
    expect(t("app/x.test.ts", '"use client"\nconst k = "sk-live-9aB7cD3eF1gH5iJ2kL"')).toBeUndefined()
  })
})

// المفردات نفسها في الاتجاه المعاكس: ما يُرفض تمريره يُحجب قبل كتابته.
describe("redactSecretValues — one vocabulary, in reverse", () => {
  test("named assignments whose value passes the module's own test are redacted", () => {
    const long = redactSecretValues("PASSWORD=Xy7kQ2mNvB8sTz4WcR1e")
    expect(long.text).toBe(`PASSWORD=${REDACTED}`)
    expect(long.redactions).toBe(1)
    expect(redactSecretValues('CLIENT_SECRET="GOCSPX-3kQ1mZz9Xy7WvUt6Rs5Qp4No3Ml"').text).toContain(REDACTED)
  })

  test("references and env names are NOT secrets — the exemptions carry over unchanged", () => {
    for (const clean of ["API_KEY=$VAULT_REF", "TOKEN=MY_ENV_NAME", "API_KEY=${VAULT}", "PASSWORD=%PGPASS%"]) {
      const result = redactSecretValues(clean)
      expect(result.text).toBe(clean)
      expect(result.redactions).toBe(0)
    }
  })

  test("a named secret value is redacted by its NAME, not by its entropy", () => {
    // عبارةُ مرورٍ بحروفٍ فقط، وكلمةٌ مختلطةٌ دون العشرين، وأخرى من ثمانية
    // محارف: كلُّها كانت تُكتب حرفيةً لأن الحاجب اشترط رقماً و٢٠ محرفاً.
    for (const [text, secret] of [
      ["CLIENT_SECRET=correcthorsebatterystaple", "correcthorsebatterystaple"],
      ["DB_PASSWORD=Passw0rd2026", "Passw0rd2026"],
      ["PASSWORD=hunter22", "hunter22"],
    ] as const) {
      const result = redactSecretValues(text)
      expect(result.text).not.toContain(secret)
      expect(result.text).toContain(REDACTED)
      expect(result.redactions).toBe(1)
    }
  })

  test("a JSON-quoted key is seen — the commonest shape a secret takes in tool output", () => {
    for (const [text, secret] of [
      ['{"api_key":"abcd1234efgh5678ijkl","ok":false}', "abcd1234efgh5678ijkl"],
      ['{"api-key": "Kk39dMz01QpLxr72Bt58"}', "Kk39dMz01QpLxr72Bt58"],
      ['{"password":"S3cretValue123456"}', "S3cretValue123456"],
      ['{"auth":{"token":"9f8e7d6c5b4a39281706"}}', "9f8e7d6c5b4a39281706"],
    ] as const) {
      const result = redactSecretValues(text)
      expect(result.text).not.toContain(secret)
      expect(result.text).toContain(REDACTED)
    }
  })

  test("Authorization headers are redacted in both cases and both schemes", () => {
    expect(redactSecretValues("authorization: bearer 0123456789abcdef0123456789abcdef").text)
      .toBe(`authorization: ${REDACTED}`)
    expect(redactSecretValues("Authorization: Basic YWRtaW46aHVudGVyMlBhc3M=").text)
      .toBe(`Authorization: Basic ${REDACTED}`)
    // ولا يبتلع النثر: «Basic authentication» ليست اعتماداً مُرمَّزاً.
    expect(redactSecretValues("Basic authentication required by the proxy"))
      .toEqual({ text: "Basic authentication required by the proxy", redactions: 0 })
  })

  /**
   * الاتجاه الملزم — الحارس والحاجب مفرداتٌ واحدة فعلاً: **كلُّ** نصٍّ
   * يرفضه `secretInCommandViolation` يجب أن يغيّره `redactSecretValues`.
   * كان مكسوراً: يرفض `PGPASSWORD=…` و`--password=…` و`-p…` ثم يكتبها
   * حرفيةً في مِلقَط الإيصالات — والرفضُ نفسه إيصالُ `run` يُلتقط.
   */
  test("INVARIANT: everything the guard refuses, the redactor changes", () => {
    const refused = [
      "psql -U admin -p SuperSecret123",
      "PGPASSWORD=hunter2seventy node seed.js",
      "PGPASSWORD=abc123def456 psql -h db",
      "psql --password=Sup3rS3cretPass -h db",
      "psql --password Sup3rS3cretPassX -h db",
      "mysql -pTr0ub4dor3x -h db",
      "node deploy.js --api-key=sk-live-AbC123XyZ789kLmNoP",
      'curl -d {"api_key":"abcd1234efgh5678ijkl"} https://api.example.com',
    ]
    for (const cmd of refused) {
      expect(`${cmd} ⇦ رفض؟`).toBe(secretInCommandViolation(cmd) === undefined ? `${cmd} ⇦ لم يُرفض` : `${cmd} ⇦ رفض؟`)
      const redacted = redactSecretValues(cmd)
      expect(`${cmd} ⇦ ${redacted.text}`).not.toBe(`${cmd} ⇦ ${cmd}`)
      expect(redacted.redactions).toBeGreaterThan(0)
      expect(redacted.text).toContain(REDACTED)
    }
    // وأمرٌ نظيفٌ لا يُرفض ولا يُحجب — الاتجاه ليس «احجب كل شيء».
    for (const clean of ["npm run build", "node app.js --port 3000", "psql -U admin -h localhost mydb"]) {
      expect(secretInCommandViolation(clean)).toBeUndefined()
      expect(redactSecretValues(clean)).toEqual({ text: clean, redactions: 0 })
    }
  })

  test("bare known-prefix tokens, Bearer headers and URL credentials are redacted", () => {
    expect(redactSecretValues("pushed as ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8").text).toBe(`pushed as ${REDACTED}`)
    expect(redactSecretValues("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc").text).toBe(`Authorization: ${REDACTED}`)
    expect(redactSecretValues("postgres://app:Sup3rS3cret@db:5432/prod").text).toBe(`postgres://app:${REDACTED}@db:5432/prod`)
    expect(redactSecretValues("AWS key AKIAIOSFODNN7EXAMPLE used").text).toBe(`AWS key ${REDACTED} used`)
  })

  test("ordinary receipt prose survives — «skipped_because…» is not a key", () => {
    const prose = "skipped_because_cache_hit 12 files\npkg-lock unchanged\nrktest ran"
    expect(redactSecretValues(prose)).toEqual({ text: prose, redactions: 0 })
  })

  test("a sha256 evidence digest survives both the redactor and the long sweep", () => {
    const digest = "3b2f1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b"
    expect(redactSecretValues(`بصمة الدليل ${digest}`).text).toContain(digest)
    expect(sweepResidualSecrets(`بصمة الدليل ${digest}`)).toEqual({ text: `بصمة الدليل ${digest}`, redactions: 0 })
    expect(residualSecretMatches(`بصمة الدليل ${digest}`)).toEqual([])
  })

  // مقيس 2026-09-17 في إيصال أداةِ بحثٍ في فهرس سكربتات: مسارٌ من ٤١ محرفاً حُجب فضاع الدليل على المحكّم.
  test("a long lowercase repository path survives the long sweep; a base64 blob with slashes does not", () => {
    const line = "sample-repo/scripts/measure-qa/cdp-eval-probe.mjs — تقييمُ سطرٍ من JS داخل الصفحة (2026-09-17)"
    expect(sweepResidualSecrets(line)).toEqual({ text: line, redactions: 0 })
    expect(residualSecretMatches(line)).toEqual([])
    const nested = "packages/engine/test/native-protocol-text-fallback.test.ts"
    expect(sweepResidualSecrets(nested)).toEqual({ text: nested, redactions: 0 })
    // التوأم الإيجابيّ: سرٌّ مُرمَّز يحمل `/` يخلط الحالتين أو يحمل `+`/`=` فيُحجب كما كان.
    const b64 = "dGhpcy9pcy9hL3NlY3JldC90b2tlbi93aXRoL3NsYXNoZXM="
    expect(sweepResidualSecrets(b64)).toEqual({ text: REDACTED, redactions: 1 })
    const lowerSlashPlus = "abcd/efgh/ijkl/mnop/qrst/uvwx/yzab/cdef/ghij+k"
    expect(sweepResidualSecrets(lowerSlashPlus).redactions).toBe(1)
    const noSlash = "abcdefghijklmnopqrstuvwxyz0123456789abcdefgh"
    expect(sweepResidualSecrets(noSlash).redactions).toBe(1)
  })

  test("redaction is idempotent, and the long sweep names what the vocabulary could not", () => {
    const once = redactSecretValues("API_KEY=sk-live_ABCDEFGHIJKLMNOP1234")
    expect(redactSecretValues(once.text)).toEqual({ text: once.text, redactions: 0 })
    const blob = "Zm9vYmFyYmF6cXV4Y29ycmVjdGhvcnNlYmF0dGVyeXN0YXBsZXI="
    expect(redactSecretValues(blob).redactions).toBe(0)
    expect(residualSecretMatches(blob)).toHaveLength(1)
    expect(sweepResidualSecrets(blob)).toEqual({ text: REDACTED, redactions: 1 })
  })
})
