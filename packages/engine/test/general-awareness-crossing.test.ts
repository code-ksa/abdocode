// سكّة العبور بين المشاريع — حالاتٌ قيسها المشرف 2026-09-03 بعد أن عبر
// «almanara-clinic» مكتوباً «almanara clinic»: شرطةٌ صارت فراغاً فسقطت
// المطابقة الحرفية. تُثبَّت هنا لأن تسريباً هنا يسلّم بيانات عميلٍ لعميلٍ آخر.
import { test, expect } from "bun:test"
import { EMPTY_GENERAL_STORE, projectTokensOf, promoteLesson } from "../src/general-awareness"

const PROJECT_DIR = "C:/work/almanara-clinic"
const CTX = { projectTokens: projectTokensOf(PROJECT_DIR), now: 1_800_000_000_000 }

const MUST_REFUSE: ReadonlyArray<readonly [string, string]> = [
  ["plain project name", "في مشروع almanara-clinic استعمل بناء الإنتاج قبل الفحص"],
  ["zero-width joiner inside the name", "في مشروع almanara\u200d-clinic استعمل بناء الإنتاج قبل الفحص"],
  ["hyphen swapped for a space", "في مشروع almanara clinic استعمل بناء الإنتاج قبل الفحص دائماً"],
  ["hyphen swapped for an underscore", "في مشروع almanara_clinic استعمل بناء الإنتاج قبل الفحص دائماً"],
  ["hyphen swapped for a dot", "في مشروع almanara.clinic استعمل بناء الإنتاج قبل الفحص دائماً"],
  ["name uppercased", "IN ALMANARA-CLINIC ALWAYS RUN THE BUILD BEFORE THE AUDIT STEP"],
  ["path form", "احذر مسار C:/work/almanara-clinic/src قبل أي تعديل على القوالب"],
  ["url with the host", "الواجهة على https://almanara-clinic.example.com تحتاج ترويسة اللغة"],
  ["internal host", "قاعدة البيانات على db.almanara-internal.local تحتاج مهلة أطول"],
  ["ipv4 and port", "الخادم المُدار يعمل على 127.0.0.1:4310 في هذا النوع من المشاريع"],
  ["email", "المالك عبر owner@almanara-clinic.example.com يوافق قبل النشر"],
  ["file with extension", "الملف src/app/booking-page.tsx يحتاج مراجعة قبل البناء"],
]

const MUST_ACCEPT: readonly string[] = [
  "عند فشل البناء بخطأ أنواع اقرأ أول خطأ فقط: البقية غالباً تتالٍ منه",
  "في مستودعات pnpm لا تستعمل npm audit مباشرةً — استعمل مدير الحزم نفسه",
  "أوامر ويندوز الطويلة تحتاج مهلةً أطول من الافتراضية وإلا قُطعت وهي سليمة",
  // A secret riding a general lesson is REDACTED and then allowed — the secret is gone,
  // no project identity remains. Refusing this would be over-refusal, not safety.
  "ثبّت الحزم دائماً بالمفتاح sk-live_A1b2C3d4E5f6G7h8I9j0K1 قبل البناء",
]

test("لا هويّةَ مشروعٍ تعبر ولو غُسلت: الفاصل يُبدَّل أو يُحذف أو يُرفع", () => {
  const leaked: string[] = []
  for (const [label, text] of MUST_REFUSE) {
    const r = promoteLesson(EMPTY_GENERAL_STORE, { cls: "playbook", text } as never, CTX) as { ok: boolean; store?: unknown }
    if (r.ok) leaked.push(`${label}: PROMOTED → ${JSON.stringify(r.store).slice(0, 150)}`)
  }
  if (leaked.length > 0) console.log("LEAKED:\n" + leaked.join("\n"))
  console.log(`refused ${MUST_REFUSE.length - leaked.length}/${MUST_REFUSE.length}`)
  expect(leaked).toEqual([])
})

test("والسكّة لا تمنع الدرس العامّ الصادق — ولا يعبر سرٌّ خلف حجبه", () => {
  const rejected: string[] = []
  for (const text of MUST_ACCEPT) {
    const r = promoteLesson(EMPTY_GENERAL_STORE, { cls: "playbook", text } as never, CTX) as { ok: boolean; refused?: string; store?: { lessons: { text: string }[] } }
    if (!r.ok) rejected.push(`${text.slice(0, 46)} → ${r.refused ?? "?"}`)
    else if (text.includes("sk-live") && JSON.stringify(r.store).includes("sk-live")) rejected.push("SECRET SURVIVED REDACTION")
  }
  if (rejected.length > 0) console.log("WRONG:\n" + rejected.join("\n"))
  console.log(`accepted ${MUST_ACCEPT.length - rejected.length}/${MUST_ACCEPT.length}`)
  expect(rejected).toEqual([])
})
