/**
 * ن3 (مقيس 09-15 على 4.0.39): مهمّةُ متصفّحٍ ذكرت المسارَ `ui-test/sample.txt` فأشعل «test» داخل المسار شرطَ الاختبارات،
 * فطالب الهارنسُ بـ`npm test` في مشروعٍ بلا سكربت اختبار وسقط الدورُ «empty assistant message» — الصنفُ نفسُه الذي أصلحناه في د7
 * (كلماتُ «أنشئ» تُشعل بوّابةَ البناء). القاعدة: كلماتُ القبول (build/test/typecheck) تُقرأ من كلمات المهمّة **لا من المسارات وأسماء
 * الملفّات**، وككلماتٍ كاملة (latest ≠ test، ui-test ≠ test).
 */

/** يُسقط ما يشبه مساراً أو اسمَ ملفّ: فيه شرطةٌ مائلة، أو امتدادٌ منقَّط، أو شرطةٌ تصل كلمتين لاتينيّتين (ui-test). */
export const goalWordsOnly = (goal: string): string =>
  goal
    .replace(/\S*[\\/]\S*/gu, " ")
    .replace(/\b[\w-]+\.[a-z0-9]{1,6}\b/giu, " ")
    .replace(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/giu, " ")

export const goalRequiresBuild = (goal: string): boolean => /(?:(?<![\p{L}\p{N}_-])build(?![\p{L}\p{N}_-])|البناء|ابنِ?|بناءً)/iu.test(goalWordsOnly(goal))
export const goalRequiresTypecheck = (goal: string): boolean => /(?:(?<![\p{L}\p{N}_-])typecheck(?![\p{L}\p{N}_-])|type-check|فحص الأنواع|التحقق النوعي)/iu.test(goal)
export const goalRequiresTests = (goal: string): boolean =>
  /(?:npm\s+(?:run\s+)?test|(?<![\p{L}\p{N}_-])tests?(?![\p{L}\p{N}_-])|اختبار|اختبارات)/iu.test(goalWordsOnly(goal))

/**
 * هل يكلّف الطلبُ بعملٍ على الاختبارات (كتابةً أو تشغيلاً أو إصلاحاً)، لا مجرّدَ ذكرِ الكلمة؟ (مقيس 2026-09-27:
 * «Find the Bun test runner documentation» أشعل البوّابة.) الفعلُ قبل الكلمة بمسافةٍ قصيرة، أو «tests pass»، أو npm test صريحاً.
 */
export const goalAsksForTestWork = (goal: string): boolean => {
  const words = goalWordsOnly(goal)
  return /npm\s+(?:run\s+)?test|(?<![\p{L}\p{N}_-])(?:write|add|create|implement|run|fix|update|cover)(?![\p{L}\p{N}_-])[^.\n]{0,40}?(?<![\p{L}\p{N}_-])tests?(?![\p{L}\p{N}_-])|(?<![\p{L}\p{N}_-])tests?(?![\p{L}\p{N}_-])[^.\n]{0,20}?(?<![\p{L}\p{N}_-])(?:pass|passing|green)(?![\p{L}\p{N}_-])|(?:اكتب|أضف|اضف|أنشئ|انشئ|شغّل|شغل|أصلح|اصلح|حدّث|غطِّ?)[^.\n]{0,40}?(?:اختبار|اختبارات)|(?:اختبار|اختبارات)[^.\n]{0,20}?(?:تنجح|تمرّ|خضراء)/iu.test(words)
}
