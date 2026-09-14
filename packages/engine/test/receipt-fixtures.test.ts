import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProductTools } from "@abdo/tools"
import { PLAYBOOKS } from "../src/error-playbooks"
import { PLUGINS, descriptorFor, pluginContext, resolvePlugin } from "../src/plugin-registry"
import {
  FIXTURE_FAMILIES,
  FIXTURE_REFUSALS,
  FixtureFormatError,
  TAP_LINE_CAP,
  captureFromFrameLog,
  captureFromTap,
  evaluateFixture,
  expectationsFor,
  fixtureFilesIn,
  listFixtures,
  loadFixtures,
  materialiseProject,
  openReceiptTap,
  parseFixtureJsonl,
  redactForDisk,
  runFixtureCommand,
  verdictDetailOf,
  type ReceiptFixture,
} from "../src/receipt-fixtures"
import { redactSecretValues, residualSecretMatches } from "../src/secret-command-guard"

const FIXTURES_DIR = new URL("./fixtures/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1")
const tmp = (): string => mkdtempSync(join(tmpdir(), "abdo-fx-"))
const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

// ---------------------------------------------------------------------------
// (١) إعادة التشغيل — سجلٌّ واحد = اختبارٌ واحد، والفرق يُسمّى
// ---------------------------------------------------------------------------

describe("receipt fixtures — replay", () => {
  const files = fixtureFilesIn(FIXTURES_DIR)

  test("the fixtures directory is not empty (an empty catalog is itself a failure)", () => {
    expect(files.length).toBeGreaterThan(0)
    expect(loadFixtures(FIXTURES_DIR).records.length).toBeGreaterThan(0)
  })

  const loaded = loadFixtures(FIXTURES_DIR)
  for (const record of loaded.records) {
    test(`${record.family}:${record.id}`, () => {
      let projectDir: string | undefined
      if (record.project !== undefined) {
        projectDir = tmp()
        materialiseProject(record.project, projectDir)
      }
      const verdict = evaluateFixture(record, projectDir)
      expect(verdict.diffs.join(" · ")).toBe("")
      expect(verdict.ok).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// (٢) التغطية — كتالوجٌ حيٌّ لأصناف الفشل، لا عيّنة
// ---------------------------------------------------------------------------

describe("receipt fixtures — coverage", () => {
  const inventory = listFixtures(FIXTURES_DIR)

  test("every playbook id ships with at least one incident record", () => {
    expect(inventory.uncoveredPlaybooks).toEqual([])
    expect(PLAYBOOKS.length).toBeGreaterThan(50)
  })

  test("every declared family has at least one record", () => {
    expect(inventory.emptyFamilies).toEqual([])
    expect(Object.keys(inventory.byFamily).sort()).toEqual([...FIXTURE_FAMILIES].sort())
  })

  test("live and synthetic records are counted apart — nothing synthetic is dressed as a trace", () => {
    expect(inventory.live + inventory.synthetic).toBe(inventory.total)
    expect(inventory.live).toBeGreaterThan(0)
    for (const record of loadFixtures(FIXTURES_DIR).records) {
      if (record.source === "catalog") expect(typeof record.catalog).toBe("string")
    }
  })

  // يُمشى على **كل** نصٍّ في السجل لا على حقلين: الحارسُ الذي يفحص
  // `output` و`command` وحدهما لا يرى سرّاً في `verdict.detail` ولا في
  // `incident` — وهناك كان يمرّ.
  const everyString = (value: unknown): string[] => {
    if (typeof value === "string") return [value]
    if (Array.isArray(value)) return value.flatMap(everyString)
    if (typeof value === "object" && value !== null) return Object.values(value).flatMap(everyString)
    return []
  }

  // النصُّ الآتي من خارجنا (أمرٌ ومخرَجٌ وتفصيلُ حكمٍ ووصفُ حادثة) هو ما
  // يفحصه `buildAndWrite` نفسه بالمصفاة الطويلة — والحقلان الأخيران هما
  // اللذان كان الكاتب ينساهما. أمّا المؤشّرات (id/catalog…) فيكتبها المشرف
  // ومسارُ ملفٍ فيها يطابق قاعدةَ الأربعين بلا أن يكون سرّاً، فتُفحص
  // بالمفردات وحدها.
  const TOOL_TEXT = new Set(["command", "output", "incident"])
  const POINTERS = new Set(["id", "family", "source", "captured", "catalog"])

  test("no shipped fixture carries anything secret-shaped — EVERY string field of the record", () => {
    const records = loadFixtures(FIXTURES_DIR).records
    // الفحص غير فارغ: السجلات تحمل حقولاً نصيّةً كثيرة فعلاً.
    expect(records.flatMap((record) => everyString(record)).length).toBeGreaterThan(records.length * 4)
    for (const record of records) {
      // حقلٌ نصيٌّ جديد بلا تصنيف يُحمِّر هذا السطر قبل أن يُشحن غيرَ مفحوص.
      const unclassified = Object.entries(record).filter(([key, value]) => typeof value === "string" && !TOOL_TEXT.has(key) && !POINTERS.has(key)).map(([key]) => key)
      expect(`${record.id}: ${unclassified.join(",")}`).toBe(`${record.id}: `)
      for (const text of [record.command, record.output, record.incident, verdictDetailOf(record.verdict)]) {
        expect(`${record.id}: ${residualSecretMatches(text).join(",")}`).toBe(`${record.id}: `)
      }
      for (const text of everyString(record)) {
        expect(`${record.id}: ${redactSecretValues(text).redactions}`).toBe(`${record.id}: 0`)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// (٣) المحمّل — فشلٌ مغلق باسم الملف والسطر
// ---------------------------------------------------------------------------

describe("receipt fixtures — loader is fail-closed", () => {
  const good = {
    id: "x/1", family: "tiering", source: "synthetic", captured: "2026-09-02",
    incident: "حادثة", command: "run npm test", output: "boom\nانتهى الأمر برمز 1",
    expect: { failed: true },
  }
  const line = (patch: Record<string, unknown>): string => JSON.stringify({ ...good, ...patch })

  const refuses = (text: string, reasonPart: string, atLine: number): void => {
    let caught: unknown
    try { parseFixtureJsonl(text, "f.jsonl") } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(FixtureFormatError)
    const error = caught as FixtureFormatError
    expect(error.line).toBe(atLine)
    expect(error.file).toBe("f.jsonl")
    expect(error.message).toContain(`f.jsonl:${atLine}`)
    expect(error.reason).toContain(reasonPart)
  }

  test("a clean file parses, and blank lines are skipped without shifting the line count", () => {
    const records = parseFixtureJsonl(`${line({})}\n\n${line({ id: "x/2" })}\n`, "f.jsonl")
    expect(records.map((r) => r.id)).toEqual(["x/1", "x/2"])
    expect(records[0]!.repeat).toBe(1)
    expect(records[0]!.truncated).toBe(false)
  })

  test("CRLF-terminated lines parse identically to LF", () => {
    const lf = parseFixtureJsonl(`${line({})}\n${line({ id: "x/2" })}\n`, "f.jsonl")
    const crlf = parseFixtureJsonl(`${line({})}\r\n${line({ id: "x/2" })}\r\n`, "f.jsonl")
    expect(JSON.stringify(crlf)).toBe(JSON.stringify(lf))
  })

  test("unknown family / source / verdict reason / expect key are refused by name and line", () => {
    refuses(`${line({})}\n${line({ id: "x/2", family: "ghosts" })}\n`, "family غير معروفة", 2)
    refuses(line({ source: "invented" }), "source غير معروف", 1)
    refuses(line({ verdict: { ok: false, reason: "made_up", denied: false } }), "verdict.reason غير معروف", 1)
    refuses(line({ expect: { nonsense: 1 } }), "مفتاحٌ غير معروف", 1)
    refuses(line({ note: "extra" }), "حقلٌ غير معروف", 1)
    refuses(line({ expect: { playbooks: ["no-such-playbook"] } }), "معرّف كتيّبٍ غير موجود", 1)
  })

  test("a missing output, a missing expect, a bad date and a bad repeat are refused", () => {
    refuses(line({ output: "" }), "output نصٌّ غير فارغ", 1)
    refuses(JSON.stringify({ ...good, expect: undefined }), "expect كائنٌ إلزاميّ", 1)
    refuses(line({ captured: "2026/09/02" }), "captured تاريخٌ", 1)
    refuses(line({ repeat: 0 }), "repeat", 1)
  })

  test("an EMPTY expect is refused for the same reason a missing one is — it asserts nothing", () => {
    refuses(line({ expect: {} }), "توقّعٌ فارغ", 1)
    // وليس رفضاً عاماً للكائن: توقّعٌ بمفتاحٍ واحدٍ صالحٍ يمرّ.
    expect(parseFixtureJsonl(line({ expect: { failed: true } }), "f.jsonl")).toHaveLength(1)
  })

  test("a family with its own oracle must pin it — coverage is asserted, not assumed", () => {
    refuses(line({ family: "acceptance" }), "expect.acceptance إلزاميّ", 1)
    refuses(line({ family: "adapter" }), "expect.adapter إلزاميّ", 1)
    refuses(line({ family: "acceptance", expect: { acceptance: { exitZero: true } } }), "expect.acceptance كائن", 1)
    expect(parseFixtureJsonl(line({ family: "acceptance", expect: { acceptance: { exitZero: false, testPassed: false } } }), "f.jsonl")).toHaveLength(1)
  })

  test("a duplicate id inside one file is refused at the SECOND line", () => {
    refuses(`${line({})}\n${line({})}\n`, "id مكرّر", 2)
  })

  test("a malformed JSON line names itself and is never skipped", () => {
    refuses(`${line({})}\n{not json}\n`, "JSON غير صالح", 2)
  })
})

// ---------------------------------------------------------------------------
// (٤) الحجب — أسرارٌ واقعية لا تبلغ القرص أبداً
// ---------------------------------------------------------------------------

describe("receipt fixtures — redaction before anything is written", () => {
  // كل شكلٍ يظهر به سرٌّ في مخرَج أداةٍ حقيقيّ. القائمة توسَّع ولا تُقلَّم:
  // ستّة أشكالٍ كانت تُرضي التنفيذَ بالبناء (بادئةٌ معروفة أو ≥٤٠ محرفاً)،
  // فشحنت عشرةُ أشكالٍ تسرّب وهي خضراء.
  const secrets: { name: string; text: string; needle: string }[] = [
    { name: "مفتاح API في إسناد", text: "OPENAI_API_KEY=sk-live_ABCDEFGHIJKLMNOP1234", needle: "sk-live_ABCDEFGHIJKLMNOP1234" },
    { name: "ترويسة Bearer", text: "curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.QWxhZGRpbjpvcGVuIHNlc2FtZQ'", needle: "eyJhbGciOiJIUzI1NiJ9" },
    { name: "ترويسة bearer بحروفٍ صغيرة", text: "authorization: bearer 0123456789abcdef0123456789abcdef", needle: "0123456789abcdef0123456789abcdef" },
    { name: "ترويسة Basic", text: "Authorization: Basic YWRtaW46aHVudGVyMlBhc3M=", needle: "YWRtaW46aHVudGVyMlBhc3M=" },
    { name: "رابط اتصال بكلمة مرور", text: "DATABASE_URL=postgres://app:Sup3rS3cretPassw0rd@db.internal:5432/prod", needle: "Sup3rS3cretPassw0rd" },
    { name: "سطر .env", text: "CLIENT_SECRET=\"GOCSPX-3kQ1mZz9Xy7WvUt6Rs5Qp4No3Ml\"", needle: "GOCSPX-3kQ1mZz9Xy7WvUt6Rs5Qp4No3Ml" },
    { name: "رمز جيثب عارٍ", text: "remote: Invalid credentials for ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", needle: "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8" },
    { name: "كتلة base64", text: "TOKEN dGhpcy1pcy1hLXZlcnktbG9uZy1iYXNlNjQtc2VjcmV0LXZhbHVlLWhlcmU9PQ==", needle: "dGhpcy1pcy1hLXZlcnktbG9uZy1iYXNlNjQtc2VjcmV0" },
    { name: "مفتاح داخل JSON", text: "{\"api_key\":\"abcd1234efgh5678ijkl\",\"ok\":false}", needle: "abcd1234efgh5678ijkl" },
    { name: "مفتاح بشرطة داخل JSON", text: "{\"api-key\": \"Kk39dMz01QpLxr72Bt58\"}", needle: "Kk39dMz01QpLxr72Bt58" },
    { name: "كلمة مرور داخل JSON", text: "{\"password\":\"S3cretValue123456\"}", needle: "S3cretValue123456" },
    { name: "رمز متداخل في JSON", text: "{\"auth\":{\"token\":\"9f8e7d6c5b4a39281706\"}}", needle: "9f8e7d6c5b4a39281706" },
    { name: "عبارة مرورٍ بحروفٍ فقط", text: "CLIENT_SECRET=correcthorsebatterystaple", needle: "correcthorsebatterystaple" },
    { name: "كلمة مرور قصيرة مختلطة", text: "DB_PASSWORD=Passw0rd2026", needle: "Passw0rd2026" },
    { name: "كلمة مرور مسمّاة قصيرة جداً", text: "PASSWORD=hunter22", needle: "hunter22" },
    { name: "PGPASSWORD في argv", text: "PGPASSWORD=abc123def456 psql -h db", needle: "abc123def456" },
    { name: "‏--password= في argv", text: "psql --password=Sup3rS3cretPass -h db", needle: "Sup3rS3cretPass" },
    { name: "‏--password بفراغ", text: "psql --password Sup3rS3cretPassX -h db", needle: "Sup3rS3cretPassX" },
    { name: "‏-p ملتصقة (mysql)", text: "mysql -pTr0ub4dor3x -h db", needle: "Tr0ub4dor3x" },
    { name: "مفتاح AWS", text: "AWS key AKIAIOSFODNN7EXAMPLE used", needle: "AKIAIOSFODNN7EXAMPLE" },
    { name: "مفتاح جوجل", text: "GOOGLE key AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6", needle: "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6" },
    { name: "رمز سلاك", text: "slack said xoxb-FIXTURE-NOTREAL-ABCdefGHIjklMNOpqrST", needle: "xoxb-FIXTURE-NOTREAL-ABCdefGHIjklMNOpqrST" },
  ]

  test("every realistic secret shape is gone from the redacted text", () => {
    for (const { name, text, needle } of secrets) {
      const redacted = redactForDisk(`$ npm run deploy\n${text}\nانتهى الأمر برمز 1`)
      expect(`${name}: ${redacted.text}`).toContain("«مُحجَّب»")
      expect(redacted.redactions).toBeGreaterThan(0)
      expect(`${name}: ${redacted.text}`).not.toContain(needle)
      expect(residualSecretMatches(redacted.text)).toEqual([])
    }
  })

  // الحدُّ المقيس للبقايا (قِيس بالمشرف 2026-09-02، ويُثبَّت كي لا يتغيّر صدفةً):
  // المصفاة الطويلة تلتقط ما طوله ≥٤٠ محرفاً أو ما يحمل بادئةً معروفة. رمزٌ
  // **عارٍ** (بلا اسمٍ ولا بادئةٍ ولا ترويسة) وأقصرُ من ذلك ينجو إلى ملف
  // الالتقاط — وهو ملفٌّ محليٌّ مستثنى من git، والترقية إلى سجلٍّ مودَعٍ ترفض
  // البقايا. تسميةُ الحدّ صدقٌ لا عيب: من يخفضه يوازن ضدّ محو بصمات الأدلّة.
  test("the residual sweep has a measured floor: named and prefixed secrets die, a short bare token survives", () => {
    const bare = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAM" // ٣٢ محرفاً، بلا اسمٍ ولا بادئة
    expect(bare.length).toBeLessThan(40)
    expect(redactForDisk(`error: rejected\n${bare}\nexit 1`).text).toContain(bare)
    // الشكل نفسه حالما يحمل اسماً أو بادئةً أو يبلغ الحدّ الطويل — يُحجب:
    expect(redactForDisk(`API_KEY=${bare}`).text).not.toContain(bare)
    expect(redactForDisk(`Authorization: Bearer ${bare}`).text).not.toContain(bare)
    expect(redactForDisk(`error\n${bare}12345678\nexit 1`).text).not.toContain(`${bare}12345678`)
    // وبصمة الدليل العارية (sha256) تنجو من المصفاة الطويلة — حجبُها يمحو
    // الأثر لا السرّ. (بصمةٌ خلف اسمٍ مثل `sha256=` تُحجب بالمفردات، وهو مقيس.)
    const digest = "a".repeat(64)
    expect(redactForDisk(`digest ${digest} ok`).text).toContain(digest)
    expect(redactForDisk(`sha256=${digest}`).text).not.toContain(digest)
  })

  // الفحص الحاكم: لا نسأل الدالّة ماذا تعيد، بل نسأل **القرص** ماذا يحمل.
  // حقلٌ ينساه الكاتب (كان `verdict.detail`) يمرّ من فحص العائد ولا يمرّ من
  // هذا. والسرّ يُدسّ في الحقول الثلاثة معاً: الأمر والمخرَج وتفصيل الحكم.
  test("NOTHING secret reaches the bytes of the tap file — every field, every shape", () => {
    for (const { name, text, needle } of secrets) {
      const root = tmp()
      const tap = openReceiptTap(root, "leak")
      tap.observe(`run ${text}`, `$ cmd\n${text}\nانتهى الأمر برمز 1`, {
        ok: false, reason: "tool_failed", denied: false, detail: `nonzero_exit: ${text}`,
      }, 1)
      expect(existsSync(tap.file)).toBe(true)
      const bytes = readFileSync(tap.file, "utf8")
      expect(`${name} في ملف المِلقَط: ${bytes.includes(needle)}`).toBe(`${name} في ملف المِلقَط: false`)
      const row = JSON.parse(bytes.trim().split("\n")[0]!) as { redactions: number; verdict: { detail?: string } }
      expect(row.redactions).toBeGreaterThan(0)
      expect(`${name} في تفصيل الحكم: ${String(row.verdict.detail)}`).not.toContain(needle)
    }
  })

  test("NOTHING secret reaches the bytes of a promoted fixture — write or refuse, never leak", () => {
    let promoted = 0
    for (const { name, text, needle } of secrets) {
      const root = tmp()
      const dir = tmp()
      const tap = openReceiptTap(root, "leak")
      tap.observe(`run ${text}`, `$ cmd\n${text}\nانتهى الأمر برمز 1`, {
        ok: false, reason: "tool_failed", denied: false, detail: `nonzero_exit: ${text}`,
      }, 1)
      const result = captureFromTap({ stateRoot: root, turnId: "leak", seq: 1, family: "tiering", fixturesDir: dir, incident: `حادثة ${text}` })
      if (result.ok) promoted += 1
      else expect(`${name}: ${result.refusal}`).toBe(`${name}: ${FIXTURE_REFUSALS.residualSecret}`)
      const onDisk = fixtureFilesIn(dir).map((file) => readFileSync(join(dir, file), "utf8")).join("")
      expect(`${name} في ملف السجلات: ${onDisk.includes(needle)}`).toBe(`${name} في ملف السجلات: false`)
    }
    // ولا يكون الفحص فارغاً بالرفض الشامل: أكثر السجلات تُرقّى فعلاً.
    expect(promoted).toBeGreaterThan(secrets.length / 2)
  })

  test("a secret that lives ONLY in verdict.detail is redacted in the tap and in the fixture", () => {
    const token = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
    const root = tmp()
    const dir = tmp()
    const tap = openReceiptTap(root, "detail-only")
    tap.observe("run npm run deploy", "remote: rejected\nانتهى الأمر برمز 1", {
      ok: false, reason: "tool_failed", denied: false, detail: `nonzero_exit: git push --token ${token}`,
    }, 1)
    expect(readFileSync(tap.file, "utf8")).not.toContain(token)
    const result = captureFromTap({ stateRoot: root, turnId: "detail-only", seq: 1, family: "tiering", fixturesDir: dir })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readFileSync(result.path, "utf8")).not.toContain(token)
    expect(result.record.verdict?.ok).toBe(false)
    expect(residualSecretMatches(JSON.stringify(result.record))).toEqual([])
  })

  test("a redacted receipt still passes the settings SECRETISH guard — read from cli.ts, not copied by hand", () => {
    const literal = /const SECRETISH = (\/.+?\/)\r?\n/u.exec(source)
    expect(literal).not.toBeNull()
    const body = literal![1]!
    const guard = new RegExp(body.slice(1, body.lastIndexOf("/")))
    // الحارس حيّ فعلاً: يمسك بعض الخام (وإلا كان الفحص التالي تحصيل حاصل)…
    const caughtRaw = secrets.filter(({ text }) => guard.test(text))
    expect(caughtRaw.length).toBeGreaterThanOrEqual(3)
    // …ولا يمسك شيئاً بعد الحجب: سجلٌّ محجوب يمرّ من باب الإعدادات كما هو.
    for (const { name, text } of secrets) {
      const redacted = redactForDisk(text).text
      expect(`${name}: ${guard.test(redacted) ? redacted : "نظيف"}`).toBe(`${name}: نظيف`)
    }
  })

  test("evidence digests, env references and clean prose survive untouched", () => {
    const digest = "a".repeat(0) + "3b2f1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b"
    const clean = `بصمة الدليل ${digest}\nAPI_KEY=$env:API_KEY\nTOKEN=MY_ENV_NAME\nskipped_because_of_cache 12 files`
    const redacted = redactForDisk(clean)
    expect(redacted.text).toBe(clean)
    expect(redacted.redactions).toBe(0)
  })

  test("redaction is idempotent — a second pass changes nothing and counts zero", () => {
    const once = redactSecretValues("API_KEY=sk-live_ABCDEFGHIJKLMNOP1234")
    const twice = redactSecretValues(once.text)
    expect(twice.text).toBe(once.text)
    expect(twice.redactions).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// (٥) المِلقَط — إيصالات run وحدها، مسقوفة، ولا يرمي أبداً
// ---------------------------------------------------------------------------

describe("receipt fixtures — the tap", () => {
  test("a run receipt lands redacted; read and write receipts create neither file nor directory", () => {
    const root = tmp()
    const tap = openReceiptTap(root, "t1")
    expect(existsSync(tap.dir)).toBe(false)
    tap.observe("read app/page.tsx", "محتوى الملف\nانتهى الأمر برمز 0", undefined, 1)
    tap.observe("write app/page.tsx :: x", "✍ كُتب", undefined, 1)
    expect(existsSync(tap.dir)).toBe(false)
    expect(tap.count).toBe(0)

    tap.observe("run npm test", "TOKEN=sk-live_ABCDEFGHIJKLMNOP1234\nfail\nانتهى الأمر برمز 1", { ok: false, reason: "nonzero_exit", denied: false }, 2)
    expect(existsSync(tap.file)).toBe(true)
    const text = readFileSync(tap.file, "utf8")
    expect(text).not.toContain("sk-live")
    expect(text).toContain("«مُحجَّب»")
    const row = JSON.parse(text.trim().split("\n")[0]!) as Record<string, unknown>
    expect(row).toMatchObject({ seq: 1, epoch: 2, redactions: 1 })
    expect(row.verdict).toEqual({ ok: false, reason: "nonzero_exit", denied: false })
    expect(tap.count).toBe(1)
    expect(tap.errors).toBe(0)
  })

  test(`the cap is ${TAP_LINE_CAP} rows plus one {"capped":true} line, then silence`, () => {
    const root = tmp()
    const tap = openReceiptTap(root, "t2")
    for (let i = 0; i < TAP_LINE_CAP + 5; i++) tap.observe("run npm test", `attempt ${i}\nانتهى الأمر برمز 1`, undefined, 1)
    const lines = readFileSync(tap.file, "utf8").trim().split("\n")
    expect(lines.length).toBe(TAP_LINE_CAP + 1)
    expect(JSON.parse(lines[TAP_LINE_CAP]!)).toEqual({ capped: true })
    expect(tap.count).toBe(TAP_LINE_CAP)
  })

  test("an unwritable state root counts an error and never throws into the turn", () => {
    const root = tmp()
    const blocked = join(root, "blocked")
    writeFileSync(blocked, "not a directory", "utf8")
    const tap = openReceiptTap(blocked, "t3")
    expect(() => tap.observe("run npm test", "fail\nانتهى الأمر برمز 1", undefined, 1)).not.toThrow()
    expect(tap.errors).toBe(1)
    expect(tap.count).toBe(0)
  })

  test("a turn id carrying path separators cannot escape the tap directory", () => {
    const root = tmp()
    const tap = openReceiptTap(root, "../../etc/passwd")
    tap.observe("run npm test", "fail\nانتهى الأمر برمز 1", undefined, 1)
    expect(tap.file.startsWith(tap.dir)).toBe(true)
    expect(existsSync(tap.file)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (٦) الترقية — من مِلقَط، ومن سجلّ أُطر مقطوع
// ---------------------------------------------------------------------------

describe("receipt fixtures — capture from the tap", () => {
  const seeded = (): { root: string; dir: string } => {
    const root = tmp()
    const tap = openReceiptTap(root, "turn-1")
    tap.observe("run npm run build", "TOKEN=sk-live_ABCDEFGHIJKLMNOP1234\nError: database is locked\nانتهى الأمر برمز 1", { ok: false, reason: "nonzero_exit", denied: false }, 3)
    return { root, dir: tmp() }
  }

  test("a tapped receipt becomes a fixture with computed expectations and zero secrets", () => {
    const { root, dir } = seeded()
    const result = captureFromTap({ stateRoot: root, turnId: "turn-1", seq: 1, family: "playbooks", fixturesDir: dir, incident: "حادثة قفل قاعدة" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.source).toBe("tap")
    expect(result.record.truncated).toBe(false)
    expect(result.record.id).toBe("turn-1/ep3/1")
    expect(result.record.expect.failed).toBe(true)
    expect(result.record.expect.playbooks).toContain("sqlite-locked")
    expect(result.record.expect.wallAt).toBe(null)
    expect(result.record.expect.fact).toBe(null)
    const written = readFileSync(result.path, "utf8")
    expect(written).not.toContain("sk-live")
    expect(written.endsWith("\n")).toBe(true)
    expect(parseFixtureJsonl(written, result.path)).toHaveLength(1)
  })

  test("refusals are returned, never thrown, and nothing is written", () => {
    const { root, dir } = seeded()
    const missing = captureFromTap({ stateRoot: root, turnId: "ghost", seq: 1, family: "playbooks", fixturesDir: dir })
    expect(missing).toEqual({ ok: false, refusal: FIXTURE_REFUSALS.noTapFile("ghost") })
    expect(captureFromTap({ stateRoot: root, turnId: "turn-1", seq: 9, family: "playbooks", fixturesDir: dir })).toEqual({ ok: false, refusal: FIXTURE_REFUSALS.noSeq(9, "turn-1") })
    expect(captureFromTap({ stateRoot: root, turnId: "turn-1", seq: 1, family: "ghosts", fixturesDir: dir })).toEqual({ ok: false, refusal: FIXTURE_REFUSALS.unknownFamily("ghosts") })
    expect(fixtureFilesIn(dir)).toEqual([])
  })

  test("a duplicate id refuses and leaves the file byte-identical until --force", () => {
    const { root, dir } = seeded()
    const first = captureFromTap({ stateRoot: root, turnId: "turn-1", seq: 1, family: "playbooks", fixturesDir: dir })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const before = readFileSync(first.path)
    const again = captureFromTap({ stateRoot: root, turnId: "turn-1", seq: 1, family: "playbooks", fixturesDir: dir })
    expect(again).toEqual({ ok: false, refusal: FIXTURE_REFUSALS.duplicateId("turn-1/ep3/1") })
    expect(readFileSync(first.path).equals(before)).toBe(true)
    const forced = captureFromTap({ stateRoot: root, turnId: "turn-1", seq: 1, family: "playbooks", fixturesDir: dir, force: true, incident: "أُعيد" })
    expect(forced.ok).toBe(true)
    expect(loadFixtures(dir).records).toHaveLength(1)
  })

  test("a secret the vocabulary cannot name still blocks the promotion — nothing is written", () => {
    const root = tmp()
    const dir = tmp()
    const tapFile = join(root, "receipt-tap", "manual.jsonl")
    const { mkdirSync } = require("node:fs") as typeof import("node:fs")
    mkdirSync(join(root, "receipt-tap"), { recursive: true })
    // سطرٌ كُتب بيدٍ (لا عبر المِلقَط) فلم يمرّ بالمصفاة: يجب أن يُرفض عند الترقية.
    writeFileSync(tapFile, `${JSON.stringify({ seq: 1, epoch: 1, command: "run npm test", output: "raw AKIAIOSFODNN7EXAMPLEQQ99 and Zm9vYmFyYmF6cXV4Y29ycmVjdGhvcnNlYmF0dGVyeXN0YXBsZXI" })}\n`, "utf8")
    const result = captureFromTap({ stateRoot: root, turnId: "manual", seq: 1, family: "tiering", fixturesDir: dir })
    expect(result).toEqual({ ok: false, refusal: FIXTURE_REFUSALS.residualSecret })
    expect(fixtureFilesIn(dir)).toEqual([])
  })
})

describe("receipt fixtures — capture from a frame log", () => {
  const log = (dir: string): string => {
    const path = join(dir, "round.jsonl")
    const long = `Module not found: Can't resolve '@/lib/db'${" .".repeat(320)}`
    writeFileSync(path, [
      JSON.stringify({ kind: "tool", turnId: "t9", cmd: "run npm run build" }),
      JSON.stringify({ kind: "tool-result", turnId: "other", cmd: "run npm test", output: "ignored", verdict: { ok: true } }),
      JSON.stringify({ kind: "tool-result", turnId: "t9", cmd: "run npm run build", output: long.slice(0, 600), verdict: { ok: false, reason: "nonzero_exit", denied: false } }),
      JSON.stringify({ kind: "tool-result", turnId: "t9", cmd: "run npm test", output: "short and bare" }),
    ].join("\n") + "\n", "utf8")
    return path
  }

  test("a head-sliced frame is marked truncated and judged by its verdict field", () => {
    const dir = tmp()
    const result = captureFromFrameLog({ logPath: log(dir), turnId: "t9", index: 1, family: "playbooks", fixturesDir: dir, incident: "من سجلّ جولة" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.source).toBe("frame")
    expect(result.record.truncated).toBe(true)
    expect(result.note).toContain("مقطوع")
    // النصّ لا يحمل علامة رمز الخروج (قُطع) — الحكم وحده يقول «فشل».
    expect(result.record.output).not.toContain("انتهى الأمر برمز")
    expect(result.record.expect.failed).toBe(true)
  })

  test("frames of another turn are not counted, and a frame with neither verdict nor exit marker is refused", () => {
    const dir = tmp()
    const path = log(dir)
    expect(captureFromFrameLog({ logPath: path, turnId: "t9", index: 2, family: "tiering", fixturesDir: dir })).toEqual({ ok: false, refusal: FIXTURE_REFUSALS.frameWithoutJudgement })
    expect(captureFromFrameLog({ logPath: path, turnId: "t9", index: 5, family: "tiering", fixturesDir: dir })).toEqual({ ok: false, refusal: FIXTURE_REFUSALS.noFrame(5, "t9") })
    expect(captureFromFrameLog({ logPath: join(dir, "nope.jsonl"), turnId: "t9", index: 1, family: "tiering", fixturesDir: dir })).toEqual({ ok: false, refusal: FIXTURE_REFUSALS.noLog(join(dir, "nope.jsonl")) })
  })
})

// ---------------------------------------------------------------------------
// (٧) الأمر — رفضٌ مسمّى وهو مطفأ، وتحقّقٌ بلا bun test
// ---------------------------------------------------------------------------

describe("receipt fixtures — the supervisor command", () => {
  const ctx = (patch: Partial<Parameters<typeof runFixtureCommand>[1]> = {}) => ({
    enabled: true, compiled: false, fixturesDir: FIXTURES_DIR, stateRoot: tmp(), ...patch,
  })

  test("OFF returns the one fixed refusal for every subcommand, and touches no disk", () => {
    for (const args of [[], ["list"], ["verify"], ["capture", "t", "1", "walls"]]) {
      expect(runFixtureCommand(args, ctx({ enabled: false }))).toBe("«fixture» معطَّل: plugins.receiptFixtures=false")
    }
  })

  test("a compiled binary refuses to write into the source test tree", () => {
    expect(runFixtureCommand(["capture", "t", "1", "walls"], ctx({ compiled: true }))).toBe(FIXTURE_REFUSALS.compiled)
    // القراءة تبقى ممكنة من الثنائيّ — الرفض عن الكتابة وحدها.
    expect(runFixtureCommand(["list"], ctx({ compiled: true }))).toContain("سجلات الحوادث")
  })

  test("verify replays the shipped catalogue and list reports coverage honestly", () => {
    const verified = runFixtureCommand(["verify"], ctx())
    expect(verified.startsWith("✓")).toBe(true)
    expect(verified).not.toContain("✗")
    const listed = runFixtureCommand(["list"], ctx())
    expect(listed).toContain("حيّ=")
    expect(listed).toContain("مصنوع=")
    expect(listed).toContain(`كل كتيّبات السجلّ (${PLAYBOOKS.length})`)
  })

  test("a bad shape and an empty directory refuse by name", () => {
    expect(runFixtureCommand(["nonsense"], ctx())).toBe(FIXTURE_REFUSALS.usage)
    expect(runFixtureCommand(["capture", "only-one-word"], ctx())).toBe(FIXTURE_REFUSALS.usage)
    const empty = tmp()
    expect(runFixtureCommand(["list"], ctx({ fixturesDir: empty }))).toBe(FIXTURE_REFUSALS.noFixtures(empty))
    expect(runFixtureCommand(["verify"], ctx({ fixturesDir: empty }))).toBe(FIXTURE_REFUSALS.noFixtures(empty))
  })

  test("capture through the command writes exactly one record and prints the computed expectations", () => {
    const root = tmp()
    const dir = tmp()
    const tap = openReceiptTap(root, "turn-9")
    tap.observe("run npm run build", "Error: EMFILE: too many open files\nانتهى الأمر برمز 1", undefined, 1)
    const out = runFixtureCommand(["capture", "turn-9", "1", "playbooks", "حادثة", "مقابض"], { enabled: true, compiled: false, fixturesDir: dir, stateRoot: root })
    expect(out.startsWith("✓ سُجّل")).toBe(true)
    expect(out).toContain("emfile")
    const records = loadFixtures(dir).records
    expect(records).toHaveLength(1)
    expect(records[0]!.incident).toBe("حادثة مقابض")
    expect(evaluateFixture(records[0]!).ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// (٨) التوصيل — التثبيتات الثابتة على cli.ts والسجلّ
// ---------------------------------------------------------------------------

describe("receipt fixtures — wiring pins", () => {
  test("the toggle is a registry descriptor read through the registry — never the legacy idiom", () => {
    expect(descriptorFor("receiptFixtures")).toMatchObject({ defaultOn: true, applies: "next-turn", site: "turn", wired: true })
    expect(descriptorFor("receiptFixtures")!.requiresVault).toEqual([])
    expect(PLUGINS.map((d) => d.name)).toContain("receiptFixtures")
    expect(source).toContain('const fixturesOn = plugins.read("receiptFixtures", "turn")')
    expect(source).not.toContain("plugins?.receiptFixtures")
    expect(source.match(/loadSettings\(\)\.plugins\?\./gu)).toBeNull()
  })

  test("the tap is built once, only behind the toggle, and observed in BOTH receipt paths", () => {
    expect(source).toContain("const tap = fixturesOn ? openReceiptTap(STATE_ROOT, turn.id) : undefined")
    expect(source.match(/openReceiptTap\(/gu)).toHaveLength(1)
    expect(source.match(/tap\?\.observe\(/gu)).toHaveLength(2)
    // لا نداءَ بلا `?.`: المفتاح المطفأ يعني صفر عمل، لا استثناء.
    expect(source).not.toContain("tap.observe(")
    const acceptance = source.indexOf("allReceipts.push({ command, output, verdict, mutated })")
    const onResult = source.indexOf("allReceipts.push({ command: cmd, output, verdict, mutated })")
    expect(acceptance).toBeGreaterThan(0)
    expect(onResult).toBeGreaterThan(0)
    expect(source.indexOf("tap?.observe(command, output, verdict, epoch)")).toBeGreaterThan(acceptance)
    expect(source.indexOf("tap?.observe(cmd, output, verdict, epoch)")).toBeGreaterThan(onResult)
  })

  test("the command is reachable from supervisor text and argv, and from nowhere else", () => {
    expect(source.match(/case "fixture"/gu)).toHaveLength(2)
    expect(source).toContain('case "fixture": return fixtureCommand(tail)')
    expect(source).toContain('enabled: pluginOnNow("receiptFixtures")')
    expect(source).toContain('fixturesDir: resolve(ROOT, "..", "test", "fixtures")')
    expect(source).toContain("compiled: COMPILED")
    // رفضٌ مسمّى أو صيغةٌ خاطئة ⇒ خروج بـ2، كنمط read.
    expect(source).toContain('if (out.startsWith("«fixture» معطَّل") || out.startsWith("رُفض") || out.startsWith("✗") || out.startsWith("الصيغة:")) process.exitCode = 2')
    // ليست أداةً للنموذج: لا في الكتالوج ولا في مُصنِّف الأدوات.
    expect(ProductTools.isTool("fixture")).toBe(false)
    expect(ProductTools.agentCallable("fixture")).toBe(false)
  })

  test("OFF resolves to false through the registry, so the tap is never constructed", () => {
    const ctx = pluginContext({ rail: "strict", platform: "win32", lane: "agent", mode: "auto", provider: "ollama" })
    expect(resolvePlugin({ receiptFixtures: false }, "receiptFixtures", ctx, { rulesOn: true }).effective).toBe(false)
    expect(resolvePlugin({}, "receiptFixtures", ctx, { rulesOn: true }).effective).toBe(true)
    expect(resolvePlugin({ receiptFixtures: "yes" }, "receiptFixtures", ctx, { rulesOn: true })).toMatchObject({ effective: false, why: "invalid-value" })
    // القيمة تُقرأ في ذلك السطر وحده — لا قراءة ثانية قد تفترق عنها وسط الدور.
    expect(source.match(/plugins\.read\("receiptFixtures"/gu)).toHaveLength(1)
    expect(source.match(/pluginOnNow\("receiptFixtures"\)/gu)).toHaveLength(1)
  })

  test("the model-facing receipt text is untouched: the tap only reads what the paths already have", () => {
    // IDEA 9 علّق حقلاً جانبياً على الإطار (`locations` خلف مفتاحه) — والنصّ
    // الذي يراه النموذج هو `output` وحده، مقصوصاً بالحدّ نفسه كما كان. التثبيت
    // يمتدّ بالذيل الجديد ولا يُقصّ إليه: قصُّه كان سيجعل الحارس لا يحرس شيئاً.
    expect(source).toContain("emit({ kind: \"tool-result\", turnId: turn.id, cmd, output: output.slice(0, 16000), outputTruncated: output.length > 16000, epoch, ...verdictFrame(verdict, idempotencyKey), ...(deliverablesOn ? { locations: locationsFromReceipt(cmd, output, verdict) } : {}) })")
    expect(source).toContain("allReceipts.push({ command: cmd, output, verdict, mutated })")
    expect(source).toContain("allReceipts.push({ command, output, verdict, mutated })")
  })
})

// ---------------------------------------------------------------------------
// (٩) الحساب — العائلات والحقول المشتقّة
// ---------------------------------------------------------------------------

describe("receipt fixtures — expectations come from the detectors, not from the record", () => {
  const base: ReceiptFixture = {
    id: "u/1", family: "walls", source: "synthetic", truncated: false, captured: "2026-09-02",
    incident: "وحدة", command: "run npm test", output: "EACCES: permission denied\nانتهى الأمر برمز 1",
    repeat: 2, expect: {},
  }

  test("stateful detectors are fed `repeat` times with a FRESH tracker per record", () => {
    expect(expectationsFor(base).wallAt).toBe(2)
    expect(expectationsFor({ ...base, repeat: 1 }).wallAt).toBe(null)
    // لا تسرّب بين السجلات: النداء الثاني يبدأ من متتبّعٍ جديد.
    expect(expectationsFor({ ...base, repeat: 1 }).wallAt).toBe(null)
  })

  test("a diff names the key, the expected and the actual", () => {
    const wrong = { ...base, expect: { tier: "transient" as const, wallAt: 1 } }
    const verdict = evaluateFixture(wrong)
    expect(verdict.ok).toBe(false)
    expect(verdict.diffs.join("\n")).toContain("tier: المتوقَّع \"transient\" · الواقع \"external_wall\"")
    expect(verdict.diffs.join("\n")).toContain("wallAt")
  })

  // عائلةُ القبول تسأل كاشفَها هي (`exitZero` + `projectTestPassed`)، لا
  // كواشفَ العائلات الأخرى: تخريبُ بوّابة القبول يجب أن يُحمِّر سجلاً.
  test("the acceptance family asks the acceptance oracles, and only for its own family", () => {
    const acceptance = (output: string) => expectationsFor({
      ...base, family: "acceptance" as const, repeat: 1, command: "run npm test", output,
    }).acceptance
    expect(acceptance("Tests  27 passed (27)\nانتهى الأمر برمز 0")).toEqual({ exitZero: true, testPassed: true })
    // عمليةٌ ناجحة بلا اختبارٍ واحد ليست بوّابةً مجتازة.
    expect(acceptance("No test files found, exiting with code 0\nانتهى الأمر برمز 0")).toEqual({ exitZero: true, testPassed: false })
    expect(acceptance("1 failing\nانتهى الأمر برمز 1")).toEqual({ exitZero: false, testPassed: false })
    // عائلةٌ أخرى لا تُستجوب فيها بوّابة القبول (كما الـadapter).
    expect(expectationsFor({ ...base, repeat: 1 }).acceptance).toBe(null)
  })

  test("a shipped acceptance record fails the moment the recorded oracle verdict is flipped", () => {
    const shipped = loadFixtures(FIXTURES_DIR).records.filter((r) => r.family === "acceptance")
    expect(shipped.length).toBeGreaterThanOrEqual(3)
    for (const record of shipped) {
      expect(record.expect.acceptance).toBeDefined()
      const flipped = { ...record, expect: { ...record.expect, acceptance: { exitZero: !record.expect.acceptance!.exitZero, testPassed: !record.expect.acceptance!.testPassed } } }
      expect(evaluateFixture(flipped).diffs.join("")).toContain("acceptance")
    }
    // والتغطيةُ صادقة: كلا الحكمين مثبَّتٌ في مكانٍ ما من العائلة.
    expect(shipped.some((r) => r.expect.acceptance!.testPassed)).toBe(true)
    expect(shipped.some((r) => !r.expect.acceptance!.exitZero)).toBe(true)
  })

  test("a module-resolution expectation without a scaffolded project is a failure, not a pass", () => {
    const record = { ...base, family: "module-resolution" as const, expect: { moduleHintContains: ["الملف الفعلي"] } }
    expect(evaluateFixture(record).ok).toBe(false)
    expect(evaluateFixture(record).diffs.join("")).toContain("يحتاج مجلّد مشروعٍ مُهيّأ")
  })
})
