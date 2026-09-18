import { describe, expect, test } from "bun:test"
import { REASONS, type ToolVerdict } from "@abdo/engine-host"
import { IntentLedger, LESSONS_PER_TURN_CAP, LESSON_WORD_CAP, capWords, distillIntentLesson, intentInstruction } from "../src/intent-field"

const NONZERO: ToolVerdict = { ok: false, reason: "nonzero_exit", denied: false }
const DENIED: ToolVerdict = { ok: false, reason: "guard_refused", denied: true }
const OK: ToolVerdict = { ok: true }

const FAILURE = "Error: Cannot find module './x/y.js'\nانتهى الأمر برمز 1"
const words = (value: string): number => value.split(/\s+/u).filter((w) => w.length > 0).length

describe("intent lesson distillation", () => {
  test("distils a breakage into a word-capped known_error keyed by the normalized signature", () => {
    const lesson = distillIntentLesson("أشغّل الاختبارات", "run npm test", FAILURE, NONZERO)
    expect(lesson).toBeDefined()
    expect(lesson!.kind).toBe("known_error")
    expect(lesson!.key.startsWith("lesson:")).toBe(true)
    expect(words(lesson!.value)).toBeLessThanOrEqual(LESSON_WORD_CAP)
    expect(lesson!.value).toContain("أشغّل الاختبارات")
    expect(lesson!.value).toContain("nonzero_exit")
    expect(REASONS).toContain("nonzero_exit")
    // البصمة تعمّم: مسارٌ ورقمٌ مختلفان، مفتاحٌ واحد.
    const other = distillIntentLesson(
      "أشغّل الاختبارات", "run npm test",
      "Error: Cannot find module './a/b.js'\nانتهى الأمر برمز 7", NONZERO,
    )
    expect(other!.key).toBe(lesson!.key)
  })

  test("no lesson without a stated intent, from a denial, from success, or from a non-run receipt", () => {
    expect(distillIntentLesson(undefined, "run npm test", FAILURE, NONZERO)).toBeUndefined()
    expect(distillIntentLesson("   ", "run npm test", FAILURE, NONZERO)).toBeUndefined()
    expect(distillIntentLesson("أشغّل", "run npm test", FAILURE, DENIED)).toBeUndefined()
    expect(distillIntentLesson("أشغّل", "run npm test", "انتهى الأمر برمز 0", OK)).toBeUndefined()
    // إيصال write يردّد محتوىً فيه كلمة error — لا يُقطَّر أبداً، بحكمٍ أو بغيره.
    expect(distillIntentLesson("أكتب", "write a.ts <<<\nconst error = 1", "خطأ في المحتوى", undefined)).toBeUndefined()
    expect(distillIntentLesson("أكتب", "write a.ts <<<\nx", FAILURE, NONZERO)).toBeUndefined()
  })

  test("an unverdicted run failure still distils, and names the union literal tool_failed", () => {
    const lesson = distillIntentLesson("أبني", "run npm run build", FAILURE, undefined)
    expect(lesson!.value).toContain("tool_failed")
    expect(REASONS).toContain("tool_failed")
    expect(distillIntentLesson("أبني", "run npm run build", "انتهى الأمر برمز 0", undefined)).toBeUndefined()
  })

  test("secrets never reach a stored lesson", () => {
    const leaky = "fatal: Authorization sk-ABCDEFGHIJKLMNOPQRSTU rejected\nانتهى الأمر برمز 1"
    const lesson = distillIntentLesson("أدفع الفرع", "run git push", leaky, NONZERO)
    expect(lesson!.value).not.toContain("sk-abcdefghijklmnopqrstu")
    expect(lesson!.key).not.toContain("sk-abcdefghijklmnopqrstu")
    expect(lesson!.value).toContain("«مُحجَّب»")
  })

  /**
   * الحالة أعلاه يمسكها `sweepResidualSecrets` وحده (بديلُه `sk-[A-Za-z0-9]{12,}`)،
   * فكانت خضراء ولو أُسقط `redactSecretValues` من التركيب. هذه الحالات لا
   * يمسكها إلّا هو، والتأكيد على **النصّ كاملاً** لا على وجود «مُحجَّب» في
   * موضعٍ ما — فحجبٌ جزئيّ يُسقط الاختبار كما يجب.
   */
  test.each([
    ["fatal: PGPASSWORD=hunter2trustno1 rejected\nانتهى الأمر برمز 1", "fatal: pgpassword=«مُحجَّب» rejected انتهى الأمر برمز N", "hunter2trustno1"],
    ["fatal: postgres://app:S3cretPass@db/x refused\nانتهى الأمر برمز 1", "fatal: postgres://app:«مُحجَّب»@db/x refused انتهى الأمر برمز N", "s3cretpass"],
    ["fatal: Authorization: Bearer abcDEF123456ghiJKL rejected\nانتهى الأمر برمز 1", "fatal: authorization: «مُحجَّب» rejected انتهى الأمر برمز N", "abcdef"],
  ])("named, url and header credentials are redacted, not merely marked", (leaky, expectedSignature, residue) => {
    const lesson = distillIntentLesson("أدفع الفرع", "run git push", leaky, NONZERO)
    expect(lesson!.value).toBe(`أدفع الفرع → فشل (nonzero_exit, unclassified): ${expectedSignature}`)
    expect(lesson!.key).toBe(`lesson:${expectedSignature}`)
    expect(lesson!.value.toLowerCase()).not.toContain(residue)
  })

  /**
   * الحجب **قبل** التطبيع: `normalizeErrorSignature` يبدأ بـ`toLowerCase()`،
   * وبادئات الحارس العارية حسّاسةٌ لحالة الحرف — فالترتيب المعكوس كان يمرّر
   * `akiaiosfodnnNexample` إلى درسٍ دائم يُحقن لاحقاً في المُوجِّه.
   */
  test.each([
    ["AKIAIOSFODNN7EXAMPLE", "akiaiosfodnn"],
    ["AIzaSyA1B2C3D4E5F6G7H8I9J0K", "aizasy"],
    ["eyJhbGciOiJIUzI1NiJ9", "eyjhbgci"],
  ])("case-sensitive credential prefixes are redacted before the signature is lowercased", (token, residue) => {
    const lesson = distillIntentLesson("أدفع الفرع", "run git push", `fatal: ${token} denied\nانتهى الأمر برمز 1`, NONZERO)
    expect(lesson!.value).toBe("أدفع الفرع → فشل (nonzero_exit, unclassified): fatal: «مُحجَّب» denied انتهى الأمر برمز N")
    expect(lesson!.key).toBe("lesson:fatal: «مُحجَّب» denied انتهى الأمر برمز N")
    expect(lesson!.value.toLowerCase()).not.toContain(residue)
  })

  test("capWords keeps a sentence, never a paragraph", () => {
    expect(words(capWords("كلمة ".repeat(80)))).toBe(LESSON_WORD_CAP)
    expect(capWords("  أ   ب  ")).toBe("أ ب")
    expect(intentInstruction()).toContain("— النية:")
  })
})

describe("the per-turn intent ledger", () => {
  test("counts stated and missing intents, and a missing intent never blocks or teaches", () => {
    const ledger = new IntentLedger()
    expect(ledger.observe("run npm test", undefined, FAILURE, NONZERO)).toEqual({})
    expect(ledger.observe("run npm test", "", FAILURE, NONZERO)).toEqual({})
    expect(ledger.snapshot()).toMatchObject({ stated: 0, missing: 2, lessons: 0 })
    expect(ledger.line(1)).toBe("🎯 نيّات الحقبة 1: مصرَّح=0 · غائب=2 · دروس=0 (مستنتَج=0) · حُلّ=0")
    const empty = new IntentLedger()
    expect(empty.line(3)).toBe("🎯 نيّات الحقبة 3: —")
  })

  test("dedupes by signature, caps the turn, counts inferred, and records a resolution", () => {
    const ledger = new IntentLedger()
    const first = ledger.observe("run npm test", "أشغّل الاختبارات", FAILURE, NONZERO)
    expect(first.lesson).toBeDefined()
    // البصمة نفسها بمسارٍ آخر: لا درسَ ثانياً في الدور نفسه.
    const again = ledger.observe("run npm test", "أشغّل الاختبارات", "Error: Cannot find module './q/w.js'\nانتهى الأمر برمز 9", NONZERO)
    expect(again.lesson).toBeUndefined()
    expect(ledger.snapshot()).toMatchObject({ stated: 2, lessons: 1, deduped: 1 })
    // النيّة نفسها نجحت لاحقاً = تصحيحٌ مقيس بمفتاح resolved.
    const fixed = ledger.observe("run npm test -- --runInBand", "أشغّل الاختبارات", "انتهى الأمر برمز 0", OK)
    expect(fixed.resolved!.kind).toBe("resolved_error")
    expect(fixed.resolved!.key.startsWith("resolved:")).toBe(true)
    expect(fixed.resolved!.key.slice("resolved:".length)).toBe(first.lesson!.key.slice("lesson:".length))
    expect(fixed.resolved!.value).toContain("نجح بعد")
    expect(words(fixed.resolved!.value)).toBeLessThanOrEqual(LESSON_WORD_CAP)
    // ولا تُعاد الحلّة مرتين لنيّةٍ واحدة.
    expect(ledger.observe("run npm test", "أشغّل الاختبارات", "انتهى الأمر برمز 0", OK).resolved).toBeUndefined()
    expect(ledger.snapshot().resolved).toBe(1)
    // الحكم الغائب يُقطّر ويُعدّ مستنتَجاً.
    const inferred = ledger.observe("run npm run build", "أبني", "Error: TS1005 expected\nانتهى الأمر برمز 2", undefined)
    expect(inferred.lesson).toBeDefined()
    expect(ledger.snapshot().inferred).toBe(1)
    expect(ledger.line(2)).toContain("مستنتَج=1")
  })

  test("the turn cap holds across epochs while the epoch counters reset", () => {
    const ledger = new IntentLedger()
    for (let i = 0; i < LESSONS_PER_TURN_CAP + 3; i += 1) {
      ledger.observe("run npm test", `نيّة ${i}`, `Error: distinct failure ${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}\nانتهى الأمر برمز 1`, NONZERO)
    }
    expect(ledger.snapshot()).toMatchObject({ lessons: LESSONS_PER_TURN_CAP, capped: 3 })
    ledger.reset()
    expect(ledger.snapshot()).toMatchObject({ stated: 0, missing: 0, lessons: 0, capped: 0 })
    // التصفير عدّاداتُ حقبةٍ لا رفعُ سقفِ دور: بعده لا درسَ جديد.
    expect(ledger.observe("run npm test", "نيّة جديدة", "Error: yet another zz\nانتهى الأمر برمز 1", NONZERO).lesson).toBeUndefined()
    expect(ledger.snapshot()).toMatchObject({ lessons: 0, capped: 1 })
  })

  /** الحلّ كتابةٌ دائمة كالدرس — فدورةُ فشلٍ‑ثمّ‑نجاحٍ مكرّرة تُكتب مرّةً واحدة. */
  test("a repeated fail/succeed cycle yields exactly one resolved_error", () => {
    const ledger = new IntentLedger()
    const emitted: string[] = []
    for (let i = 0; i < 5; i += 1) {
      ledger.observe("run npm i", "أثبّت الاعتمادات", "npm err! code E1\nانتهى الأمر برمز 1", NONZERO)
      const fixed = ledger.observe("run npm i", "أثبّت الاعتمادات", "انتهى الأمر برمز 0", OK)
      if (fixed.resolved !== undefined) emitted.push(fixed.resolved.key)
    }
    expect(emitted).toHaveLength(1)
    expect(ledger.snapshot()).toMatchObject({ lessons: 1, resolved: 1 })
  })

  /** درسٌ أُسقط لا يُسلِّح حلّاً: التسليح بعد البوّابتين لا قبلهما. */
  test("a deduped lesson never arms a later resolution", () => {
    const ledger = new IntentLedger()
    expect(ledger.observe("run npm test", "نيّة أولى", FAILURE, NONZERO).lesson).toBeDefined()
    // البصمة نفسها بنيّةٍ أخرى: يُدفَع عن التخزين، فلا كسرَ مخزَّناً باسم هذه النيّة.
    expect(ledger.observe("run npm test", "نيّة ثانية", FAILURE, NONZERO).lesson).toBeUndefined()
    expect(ledger.observe("run npm test", "نيّة ثانية", "انتهى الأمر برمز 0", OK).resolved).toBeUndefined()
    expect(ledger.snapshot()).toMatchObject({ lessons: 1, deduped: 1, resolved: 0 })
  })

  /** الحلّ يُطابَق بالأمر لا بنصّ النيّة وحده — وإلّا ادّعى الدفتر إصلاحاً لم يقع. */
  test("a success on an unrelated command with the same intent is no resolution", () => {
    const ledger = new IntentLedger()
    ledger.observe("run npm test", "أصلح الاختبارات", "Error: 3 tests failed\nانتهى الأمر برمز 1", NONZERO)
    expect(ledger.observe("run echo ok", "أصلح الاختبارات", "ok\nانتهى الأمر برمز 0", OK).resolved).toBeUndefined()
    expect(ledger.snapshot().resolved).toBe(0)
    // الأمر نفسه بوسائط أخرى يبقى تصحيحاً صادقاً.
    const honest = ledger.observe("run npm test -- --runInBand", "أصلح الاختبارات", "انتهى الأمر برمز 0", OK)
    expect(honest.resolved!.kind).toBe("resolved_error")
    expect(ledger.snapshot().resolved).toBe(1)
  })

  /** ميزانيةٌ واحدة: الحلّ يستهلك من سقف الدور، والسقف يمنعه كما يمنع الدرس. */
  test("lessons and resolutions share one per-turn write budget", () => {
    const ledger = new IntentLedger()
    const fail = (i: number): void => {
      ledger.observe("run npm test", `نيّة ${i}`, `Error: distinct failure ${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}\nانتهى الأمر برمز 1`, NONZERO)
    }
    for (let i = 0; i < LESSONS_PER_TURN_CAP - 1; i += 1) fail(i)
    expect(ledger.snapshot()).toMatchObject({ lessons: LESSONS_PER_TURN_CAP - 1, capped: 0 })
    // الكتابة السادسة حلٌّ — فيستنفد السقف.
    expect(ledger.observe("run npm test -- -t x", "نيّة 0", "انتهى الأمر برمز 0", OK).resolved).toBeDefined()
    fail(LESSONS_PER_TURN_CAP)
    expect(ledger.snapshot()).toMatchObject({ lessons: LESSONS_PER_TURN_CAP - 1, resolved: 1, capped: 1 })
    // وحلٌّ آخر بعد امتلاء السقف يُعدّ مسقوفاً لا يُكتب.
    expect(ledger.observe("run npm test -- -t y", "نيّة 1", "انتهى الأمر برمز 0", OK).resolved).toBeUndefined()
    expect(ledger.snapshot()).toMatchObject({ resolved: 1, capped: 2 })
  })
})
