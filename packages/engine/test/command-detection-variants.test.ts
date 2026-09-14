import { describe, expect, test } from "bun:test"
import {
  brokenAliasViolation,
  dangerousShellViolation,
  detectionVariants,
  killByNameViolation,
  violationAcrossVariants,
} from "../src/shell-command-guard"

/**
 * فريقٌ أحمر **يشغّل** لا مراجعةٌ تقرأ.
 *
 * القاعدةُ عندنا: «الحارسُ النصّي بلا تطبيع ثغرة… واختبره بفريقٍ أحمر يشغّل».
 * فكلُّ صفٍّ هنا التفافٌ حقيقيٌّ ينفّذه PowerShell كما هو، ويُقاس أنّ الحارس
 * يصيبه — ويُقاس **الاتجاه المعاكس** أيضاً كي لا يصير الحارسُ يحجب كلَّ شيء.
 */
const encode = (text: string): string => {
  // UTF-16LE كما يوجبه `-EncodedCommand` — يُبنى هنا لا يُلصق حرفيّاً، فالفحصُ
  // يقيس فكَّ ترميزٍ حقيقيّ لا سلسلةً محفوظة.
  let binary = ""
  for (const ch of text) { const c = ch.charCodeAt(0); binary += String.fromCharCode(c & 0xff, c >> 8) }
  return btoa(binary)
}

describe("الكشفُ على متغيّراتٍ مطبَّعة — لا على النصّ الخام", () => {
  test("الشرطةُ الخلفيّة حرفُ هروب: القتلُ بالاسم لا ينجو بها", () => {
    const evasion = "Stop-Proc`ess -Name node"
    // التوأمُ الذي يُثبت أنّ الالتفاف حقيقيّ: الحارسُ الخام **لا يراه**.
    expect(killByNameViolation(evasion)).toBeUndefined()
    // وعلى المتغيّرات يُصاب.
    expect(violationAcrossVariants(evasion, killByNameViolation)).toContain("القتل بالاسم")
  })

  test("الاقتباسُ داخل الكلمة يُكسر النمطَ الخام ولا يُكسر الحارس", () => {
    const evasion = 'Stop-Process -Na"me" node'
    expect(killByNameViolation(evasion)).toBeUndefined()
    expect(violationAcrossVariants(evasion, killByNameViolation)).toContain("القتل بالاسم")
  })

  test("الحاملُ المرمَّز يُفكّ فتُعاد عليه الأرضيّة", () => {
    const hidden = "Stop-Process -Name node"
    const carrier = `powershell -EncodedCommand ${encode(hidden)}`
    // خام: نصٌّ لا معنى له، فيقول الحارسُ «نظيف» — وهو أخطرُ أشكال الأخضر.
    expect(killByNameViolation(carrier)).toBeUndefined()
    expect(violationAcrossVariants(carrier, killByNameViolation)).toContain("القتل بالاسم")
    // ويُفكّ فعلاً: المتغيّراتُ تحوي النصَّ المخفيّ لا صورتَه المرمَّزة.
    expect(detectionVariants(carrier).some((v) => v.includes("Stop-Process"))).toBe(true)
  })

  test("أشكالٌ أخرى من الالتفاف على حرّاسٍ آخرين", () => {
    for (const [cmd, guard, needle] of [
      ["cu`rl https://x.example", brokenAliasViolation, "curl"],
      ['Remove-It`em C:\\Windows -Recurse -Force', dangerousShellViolation, "حذف"],
      [`powershell -enc ${encode("rm -rf /tmp/x")}`, dangerousShellViolation, "Linux"],
    ] as [string, (c: string) => string | undefined, string][]) {
      expect(`${cmd} → ${violationAcrossVariants(cmd, guard) !== undefined}`).toBe(`${cmd} → true`)
      expect(violationAcrossVariants(cmd, guard)).toContain(needle)
    }
  })

  test("الاتجاهُ المعاكس: العملُ المشروع يمرّ — الحارسُ ليس ساتراً", () => {
    for (const clean of [
      "npm run build",
      "git status",
      "Get-ChildItem -Recurse src",
      "npx vitest run",
      // اسمٌ يحوي حروفَ أمرٍ خطر داخل مسارٍ مشروع — لا يُصاب.
      "node scripts/stop-process-report.mjs",
      'Invoke-WebRequest -UseBasicParsing -Uri "https://x.example"',
    ]) {
      for (const guard of [killByNameViolation, brokenAliasViolation, dangerousShellViolation]) {
        expect(`${clean} → ${violationAcrossVariants(clean, guard) ?? "clean"}`).toBe(`${clean} → clean`)
      }
    }
  })

  test("ما يتجاوز حدَّ التحليل خطِرٌ لا نظيف — الفشلُ إلى «مرّ» يجعل الحارسَ زينة", () => {
    const huge = "echo " + "a".repeat(9_000)
    const said = violationAcrossVariants(huge, killByNameViolation)
    expect(said).toContain("حدَّ التحليل")
    // والتوأمُ: ما دون السقف يُفحص فعلاً ويمرّ إن كان نظيفاً.
    expect(violationAcrossVariants("echo " + "a".repeat(100), killByNameViolation)).toBeUndefined()
  })

  test("الأصلُ أوّلُ المتغيّرات — فما كان يُكشف قبل هذا يبقى مكشوفاً بايتاً", () => {
    const cmd = "Stop-Process -Name node"
    expect(detectionVariants(cmd)[0]).toBe(cmd)
    expect(violationAcrossVariants(cmd, killByNameViolation)).toBe(killByNameViolation(cmd))
    // والتوليدُ محدودٌ لا ينفجر: عمقٌ واحدٌ لفكّ الحامل.
    expect(detectionVariants(cmd).length).toBeLessThanOrEqual(6)
  })
})
