import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { detectStack, detectStackForProject, stackById } from "./project-stacks"

export interface SprintPlanWrite {
  readonly projectDir: string
  readonly normalizedTarget: string
  readonly after: string
}

const PLAN = "abdo-sprints.md"

/** فاصل مقاطع السبرنتات وصيغ الحالة — مشتركة بين حارس التقدم وعدّاد المفتوح (سماحة سقف الدور). */
const SPRINT_SECTION_SPLIT = /^(?:#{1,6}\s+)?(?=(?:ال)?سبرنت\s+\d+|sprint\s+\d+)/gimu
const SPRINT_STATUS_LINE = /^\s*\*{0,2}(?:الحالة|status)\*{0,2}\s*[:：-]\s*\*{0,2}([^\r\n]*)/imu
const SPRINT_DONE = /^(?:\[[xX]\](?:\s.*)?|(?:✅\s*)?(?:مكتمل|completed|done)[.!\s*]*)$/iu
const sprintSectionsOf = (text: string): string[] => text.split(SPRINT_SECTION_SPLIT).slice(1)
const sprintIsOpen = (section: string): boolean => {
  const status = section.match(SPRINT_STATUS_LINE)?.[1]?.trim() ?? ""
  return !SPRINT_DONE.test(status)
}

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0

/**
 * A long autonomous run must leave its route through the work on disk.  The
 * environment switch keeps this opt-in: ordinary one-shot edits are not forced
 * to invent a project plan, while qualification harnesses can fail closed.
 */
export const sprintPlanWriteViolation = (write: SprintPlanWrite, required: boolean): string | undefined => {
  if (!required) return undefined
  const target = write.normalizedTarget.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase()
  const planExists = existsSync(join(write.projectDir, "ABDO-SPRINTS.md"))

  if (!planExists && target !== PLAN) {
    return "خطة السبرنتات غير موجودة؛ أول كتابة يجب أن تكون ABDO-SPRINTS.md قبل أي ملف منتج"
  }
  if (target !== PLAN) {
    const current = readFileSync(join(write.projectDir, "ABDO-SPRINTS.md"), "utf-8")
    return sprintPlanWriteViolation({ projectDir: write.projectDir, normalizedTarget: "ABDO-SPRINTS.md", after: current }, required)
  }

  const text = write.after
  if (text.length < 1_200) return "خطة السبرنتات مختصرة جداً لمهمة منتج كاملة"
  if (text.length > 14_000) {
    return `خطة السبرنتات متضخمة (${text.length} حرفاً؛ الحد 14000). اختصر النطاق وقوائم الملفات، لكن أبقِ Next.js وRTL وSQLite ولوحة الإدارة وتواصل العملاء وستة أدلة تشغيل وABDO-HANDOFF.md وNEXT_ACTION`
  }
  if (!planExists && /(?:✅\s*(?:مكتمل|تم)|\[[xX]\]|(?:\*{0,2}(?:الحالة|status)\*{0,2})\s*[:：-]\s*\*{0,2}(?!(?:غير|not)\s+)(?:مكتمل|completed))/iu.test(text)) {
    return "الخطة الأولية أعلنت عملاً مكتملاً قبل وجود أي إيصال؛ ابدأ السبرنتات كغير مكتملة ثم غيّر الحالة بعد تشغيل البوابة فعلياً"
  }
  if (count(text, /(?:سبرنت|sprint)\s*(?:[-:#]?\s*\d+)?/giu) < 7) {
    return "الخطة يجب أن تحتوي سبعة سبرنتات واضحة على الأقل"
  }

  const requiredSections: readonly [RegExp, string][] = [
    [/(?:الحالة|status)/iu, "الحالة"],
    [/(?:بوابة\s*القبول|معيار\s*القبول|acceptance\s*gate)/iu, "بوابة القبول"],
    [/(?:الدليل|الأدلة|evidence)/iu, "الأدلة"],
    [/(?:ABDO-HANDOFF\.md)/iu, "ملف التسليم ABDO-HANDOFF.md"],
    [/(?:NEXT_ACTION)/u, "NEXT_ACTION"],
  ]
  const missing = requiredSections.filter(([pattern]) => !pattern.test(text)).map(([, label]) => label)
  if (missing.length > 0) return `الخطة تفتقد: ${missing.join("، ")}`

  // الثوابت بحسب الحزمة المكتشفة من الخطة نفسها — لا فرضٌ لـNext على مشروع
  // React أو Fastify أو HTML (كان يرفضها قبل أن تبدأ).
  // المستودع القائم يقرّر الحزمة؛ النثر للمشروع الفارغ وحده (قيس 2026-09-02).
  const detected = detectStackForProject(write.projectDir, text)
  const stack = detected.stack
  // ثوابت الهدف تُلزم خطةَ مشروعٍ جديد؛ مشروعٌ قائم ثوابتُه في ملفاته لا في نثر الخطة.
  const missingAnchors = detected.source === "repo" ? [] : stack.anchors.filter(([pattern]) => !pattern.test(text)).map(([, label]) => label)
  if (missingAnchors.length > 0) return `الخطة (${stack.label}) فقدت ثوابت هدف المنتج: ${missingAnchors.join("، ")}`

  // خلط الموجّهين خاصٌّ بـNext وحده.
  if (stack.id === "next" && /\bapp\//iu.test(text) && /\bpages\//iu.test(text)) {
    return "الخطة تخلط App Router مع Pages Router؛ استخدم app/ وحده، بما في ذلك الإدارة وroute handlers"
  }
  if (/(?:ABDO_SEARCH|بحث\s+خارجي|مستودع(?:ات)?\s+خارجي)/iu.test(text)) {
    return "الخطة فتحت اتصالاً أو بحثاً خارجياً رغم وضع المشروع المستقل؛ احذف البحث الخارجي واعمل من مصادر المشروع والحزم المسموحة فقط"
  }

  // الأدلة القابلة للقياس بعدّة الحزمة نفسها (npm/cargo/go/cl/المتصفح) —
  // النمط في StackProfile.evidence، فكل حزمةٍ تحمل عدّتها لا عدّة npm وحدها.
  const executableEvidence = count(text, stack.evidence)
  if (executableEvidence < 6) {
    return `بوابات الخطة (${stack.label}) وصفية؛ أضف ستة أدلة تشغيل قابلة للقياس على الأقل بعدّة الحزمة (البناء والاختبارات والتشغيل)`
  }

  const sprintSections = sprintSectionsOf(text)
  if (sprintSections.length < 7) return "الخطة تحتاج سبعة عناوين سبرنت مرقمة على أسطر مستقلة؛ اكتب مثلاً سبرنت 1 ثم حقوله"
  const finalSprint = sprintSections.at(-1) ?? ""
  const finalEvidence = new RegExp(stack.evidence.source, "iu")
  if (!finalEvidence.test(finalSprint)) {
    return "بوابة السبرنت النهائي دائرية؛ يجب أن تجمع دليلاً فعلياً من البناء أو الاختبارات أو المتصفح بدلاً من عبارة القبول النهائي"
  }

  const oversized = sprintSections.findIndex((section) => count(section, /`[^`\r\n]+(?:\.[a-z0-9]+|\/)[^`\r\n]*`/giu) > 18)
  if (oversized >= 0) return `السبرنت ${oversized + 1} أكبر من أن يُقبل كوحدة مستقلة؛ قسّمه إلى سبرنتات أصغر ذات بوابة واحدة`

  if (/prisma\/schema\.prisma/iu.test(text) && /\bdb\.json\b/iu.test(text) && !/(?:مصدر\s+الحقيقة|source\s+of\s+truth)[^\r\n]*(?:prisma|sqlite)/iu.test(text)) {
    return "الخطة تقترح Prisma وdb.json بلا تحديد مصدر حقيقة واحد؛ اختر مخزناً أساسياً واحداً ولا تنشئ مسارين متوازيين"
  }
  return undefined
}

/**
 * قالبٌ يجتاز كلّ فحوص الحارس أعلاه — يُلحق برسالة الرفض فينسخه النموذج
 * الضعيف بدل أن يخمّن شكلاً بـ١٢ شرطاً (قيس: qwen9b رُفض مرتين ثم جمد على
 * from-scratch). الهدف يوضع في العنوان؛ الحقول ثابتة.
 */
export const sprintPlanTemplate = (goalTitle = "المنتج", stackHint?: string): string => {
  // الحزمة من التلميح الصريح (id) أو من نصّ الهدف، وإلا Next افتراضاً.
  const stack = (stackHint !== undefined ? stackById(stackHint) : undefined) ?? detectStack(goalTitle)
  return stack.template(goalTitle)
}

export const sprintPlanReady = (projectDir: string, required: boolean): boolean => {
  if (!required) return true
  const path = join(projectDir, "ABDO-SPRINTS.md")
  if (!existsSync(path)) return false
  const after = readFileSync(path, "utf-8")
  return sprintPlanWriteViolation({ projectDir, normalizedTarget: "ABDO-SPRINTS.md", after }, true) === undefined
}

/** Necessary progress gate, not proof that model-authored status claims are
 * true. Build/test/runtime receipts must still be checked independently. */
export const sprintProgressViolation = (projectDir: string, required: boolean): string | undefined => {
  if (!required) return undefined
  if (!sprintPlanReady(projectDir, true)) return "خطة السبرنتات مفقودة أو غير صالحة"
  const text = readFileSync(join(projectDir, "ABDO-SPRINTS.md"), "utf-8")
  const pending = sprintSectionsOf(text).find(sprintIsOpen)
  if (pending !== undefined) return `الخطة ما زالت مفتوحة: ${pending.split("\n", 1)[0]}. اتبع بواباتها وحدّث الحالة بالأدلة بعد نجاحها، لا لمجرد اجتياز البناء`
  const handoff = join(projectDir, "ABDO-HANDOFF.md")
  if (!existsSync(handoff) || !/\bNEXT_ACTION\b/u.test(readFileSync(handoff, "utf-8"))) return "تسليم الاستئناف ABDO-HANDOFF.md مع NEXT_ACTION غير موجود"
  return undefined
}

/**
 * عدد السبرنتات المفتوحة في ABDO-SPRINTS.md — دليلٌ لسماحة سقف الدور (سبرنت واحد
 * باقٍ = قريب من الإنجاز). الملف غائب أو غير مقروء = undefined: الغياب ليس دليلاً،
 * فلا سماحة عليه. الحالات ادّعاءات النموذج لا إثبات — لذلك السماحة محدودة ولمرة.
 */
export const openSprintCount = (projectDir: string): number | undefined => {
  let text: string
  try {
    text = readFileSync(join(projectDir, "ABDO-SPRINTS.md"), "utf-8")
  } catch {
    return undefined
  }
  return sprintSectionsOf(text).filter(sprintIsOpen).length
}
