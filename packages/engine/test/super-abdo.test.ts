import { describe, expect, test } from "bun:test"
import { missingReceiptsLine, parseSuperAbdoReview, resolveSuperAbdo, SUPER_ABDO_DEFAULTS, SUPER_ABDO_REPAIR_ROUNDS, superAbdoInstruction, superAbdoMissingReceipts, superAbdoVerificationProblem, validateSuperAbdo } from "../src/super-abdo"

const cliSource = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

const enabled = { ...SUPER_ABDO_DEFAULTS, enabled: true }

describe("Super Abdo strategy", () => {
  test("absence and malformed state disable the mode; authority is not an option", () => {
    expect(resolveSuperAbdo(undefined).enabled).toBe(false)
    expect(resolveSuperAbdo({ enabled: "true" }).enabled).toBe(false)
    expect(superAbdoInstruction(SUPER_ABDO_DEFAULTS)).toBe("")
    expect(validateSuperAbdo({ ...enabled, autoApprove: true })).toContain("unknown")
    expect(validateSuperAbdo({ ...enabled, maxRepairPasses: 5 })).toBeUndefined()
    for (const maxRepairPasses of [-1, 6, 1.5, "2", NaN]) {
      expect(validateSuperAbdo({ ...enabled, maxRepairPasses })).toBeDefined()
    }
    const source = { ...enabled }
    const snapshot = resolveSuperAbdo(source)
    source.enabled = false
    expect(snapshot.enabled).toBe(true)
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  test("completion checks enforce evidence after a change and fail closed on a failed latest check", () => {
    const write = { command: "write app.ts", mutated: true, passed: true }
    const successful = { command: "run bun test", passed: true }
    const failed = { command: "run bun test", passed: false }
    expect(superAbdoVerificationProblem(enabled, [])).toBeUndefined()
    expect(superAbdoVerificationProblem(enabled, [write])).toContain("No verification")
    expect(superAbdoVerificationProblem(enabled, [successful, write])).toContain("No verification")
    expect(superAbdoVerificationProblem(enabled, [write, successful])).toBeUndefined()
    expect(superAbdoVerificationProblem(enabled, [write, successful, failed])).toContain("failed")
    expect(superAbdoVerificationProblem(enabled, [write, failed, { command: "run bun run lint", passed: true }])).toContain("failed")
    expect(superAbdoVerificationProblem(enabled, [write, failed, successful])).toBeUndefined()
    expect(superAbdoVerificationProblem(enabled, [write, { command: "run bun test security.test.ts", passed: false }, { command: "run bun test trivial.test.ts", passed: true }])).toContain("failed")
    expect(superAbdoVerificationProblem(enabled, [write, { command: 'run echo "tests passed"', passed: true }])).toContain("No verification")
    expect(superAbdoVerificationProblem(enabled, [write, successful, write])).toContain("No verification")
    expect(superAbdoVerificationProblem(SUPER_ABDO_DEFAULTS, [write])).toBeUndefined()
    expect(superAbdoVerificationProblem({ ...enabled, verifyResults: false }, [write])).toBeUndefined()
  })

  test("review requires an explicit status and an actual reason", () => {
    expect(parseSuperAbdoReview("COMPLETE\nThe requested text-only answer is supplied and no effects were claimed.")?.status).toBe("COMPLETE")
    expect(parseSuperAbdoReview("INCOMPLETE\nThe last write has no verification receipt.")?.status).toBe("INCOMPLETE")
    for (const reply of ["COMPLETE", "COMPLETE\n— المقيس: دخل 12 توكيناً", "COMPLETE\nبلا سبب مذكور", "A review follows\nCOMPLETE\nAll good", "INCOMPLETE\nCOMPLETE"]) {
      expect(parseSuperAbdoReview(reply)).toBeUndefined()
    }
  })

  test("common language-specific verification commands count, unrelated successful tools do not", () => {
    const mutated = { command: "some.typed-operation", mutated: true, passed: true }
    for (const command of ["run npm run build", "run pnpm test", "run bun run typecheck", "run cargo test", "run python -m pytest -q", "run dotnet test", "run go test ./...", "run npx playwright test"]) {
      expect(superAbdoVerificationProblem(enabled, [mutated, { command, passed: true }])).toBeUndefined()
    }
    expect(superAbdoVerificationProblem(enabled, [mutated, { command: "read package.json", passed: true }])).toContain("No verification")
  })
})

describe("S11 — الحجبُ يسمّي الإيصالَ الناقص ويقف بعد جولةٍ واحدة (مقيس 2026-09-18: 116 تحذيرَ «ادّعى الاكتمالَ ونقضته البوّابات»)", () => {
  const write = { command: "write src/app.ts <<<\nexport const a = 1", mutated: true, passed: true }

  test("لا فحصَ بعد آخر تعديل ⇦ الأداةُ التي فحصت المشروعَ من قبل باسمها، وما تُظهره رمزُ خروج 0 بعد التعديل المسمّى", () => {
    const missing = superAbdoMissingReceipts([{ command: "run bun test", passed: true }, { command: "run npm run build", passed: true }, write], "No verification receipt follows the last change.")
    expect(missing).toEqual([
      { tool: "run bun test", shouldShow: "رمز خروج 0 بعد آخر تعديل «write src/app.ts <<<»" },
      { tool: "run npm run build", shouldShow: "رمز خروج 0 بعد آخر تعديل «write src/app.ts <<<»" },
    ])
    // بلا فحصٍ سابق يُسمّى فحصُ المشروع الافتراضيّ لا «الفحص المناسب».
    expect(superAbdoMissingReceipts([write], "x").map((m) => m.tool)).toEqual(["run npm test", "run npm run build"])
    const line = missingReceiptsLine(missing)
    expect(line).toContain("الإيصالاتُ الناقصة بالاسم: «run bun test» يجب أن يُظهر: رمز خروج 0 بعد آخر تعديل «write src/app.ts <<<»؛ «run npm run build» يجب أن يُظهر")
    expect(missingReceiptsLine([])).toBe("")
  })

  test("فحصٌ فشل في آخر تشغيله ⇦ يُسمّى هو وحده، لا الناجح", () => {
    const missing = superAbdoMissingReceipts([write, { command: "run bun test security.test.ts", passed: false }, { command: "run bun test trivial.test.ts", passed: true }], "A verification check still failed.")
    expect(missing).toEqual([{ tool: "run bun test security.test.ts", shouldShow: "رمز خروج 0 (آخرُ تشغيلٍ فشل) بعد آخر تعديل «write src/app.ts <<<»" }])
  })

  test("البوّاباتُ الحتميّة راضية والمراجِعُ سمّى فجوة ⇦ يُطلب إيصالُ أداةِ قياسٍ يُظهر الفجوةَ بنصّها؛ وبلا مشكلةٍ لا شيء", () => {
    const receipts = [write, { command: "run bun test", passed: true }]
    const missing = superAbdoMissingReceipts(receipts, "The login journey was never exercised in the browser.")
    expect(missing).toEqual([{ tool: "أداةُ قياسٍ (run/shot/chrome.page/chrome.look)", shouldShow: "The login journey was never exercised in the browser. بعد آخر تعديل «write src/app.ts <<<»" }])
    expect(superAbdoMissingReceipts(receipts, undefined)).toEqual([])
    expect(superAbdoMissingReceipts([], "  ")).toEqual([])
  })

  test("جولةُ إصلاحٍ واحدة: cli.ts يبثّ الحجبَ بالإيصالات المسمّاة، ويقف acceptance-pending بعد الجولة الأولى لا بعد سقف الإعدادات", () => {
    expect(SUPER_ABDO_REPAIR_ROUNDS).toBe(1)
    expect(cliSource).toContain("const named = missingReceiptsLine(superAbdoMissingReceipts(superEvidence, problem))")
    expect(cliSource).toContain('superStamp = "Super Abdo: completion withheld — " + problem + (named.length > 0 ? "\\n" + named : "")')
    expect(cliSource).toContain("const repairRounds = Math.min(superAbdo.maxRepairPasses, SUPER_ABDO_REPAIR_ROUNDS)")
    expect(cliSource).toContain("if (superRepairPasses >= repairRounds) break")
    expect(cliSource).toContain('continuationHint = "Super Abdo repair " + superRepairPasses + "/" + repairRounds + ": " + problem + "." + (named.length > 0 ? " " + named : "")')
    expect(cliSource).not.toContain("if (superRepairPasses >= superAbdo.maxRepairPasses) break")
    // الترتيب: الحجبُ يُبثّ باسم الإيصال قبل أن يُقرَّر التوقّف.
    const stamp = cliSource.indexOf("await emitEvent(turn.id, superStamp)")
    expect(stamp).toBeGreaterThan(cliSource.indexOf("const named = missingReceiptsLine("))
    expect(stamp).toBeLessThan(cliSource.indexOf("if (superRepairPasses >= repairRounds) break"))
  })
})

describe("🔴 مشروعٌ بلا مانيفست يجب أن يستطيع التحقّق — حارسٌ صائبٌ وبوّابةٌ بلا مخرجٍ منتَجٌ مسدود", () => {
  const enabled = { enabled: true, verifyResults: true, reviewResults: false } as const
  const write = { command: "write src/guard.js", mutated: true, passed: true }

  test("عدّاءو الاختبار بلا مديرِ حزمٍ يُعَدّون تحقّقاً", () => {
    // مقيس 2026-09-24: حارسُ مديرِ الحزم يرفض — بحقٍّ — `bun test` في مجلَّدٍ بلا
    // `package.json` (مديرُ الحزم يصعد فينفّذ سكربتاتِ مستودعٍ أعلى). وكانت كلُّ صيغةٍ
    // مقبولةٍ تمرّ بمديرِ حزمٍ أو إطارٍ يُستدعى عبره، فكان الدورُ يبقى «مرصوداً» أبداً.
    for (const command of ["run node --test", "run node --test test/", "run deno test", "run bun src/guard.test.ts"]) {
      expect(superAbdoVerificationProblem(enabled, [write, { command, passed: true }]), `«${command}» لم يُعَدّ تحقّقاً`).toBeUndefined()
    }
  })

  test("والفاشلُ منها يُوقف الإتمام كنظيره — القبولُ ليس تساهلاً", () => {
    expect(superAbdoVerificationProblem(enabled, [write, { command: "run node --test", passed: false }])).toContain("failed")
  })

  test("🔴 ولا يتّسع المقبولُ لأمرٍ لا يفحص شيئاً", () => {
    for (const command of ["run node app.js", "run node --version", "run deno run main.ts", "run bun install", "run echo done", "run bun src/guard.js"]) {
      expect(superAbdoVerificationProblem(enabled, [write, { command, passed: true }]), `«${command}» مرّ تحقّقاً وهو ليس فحصاً`).toContain("No verification")
    }
  })
})
