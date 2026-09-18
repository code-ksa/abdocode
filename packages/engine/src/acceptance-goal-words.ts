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
