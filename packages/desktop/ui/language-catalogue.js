// قائمةُ اللغات تُشتقّ من المالك الواحد في `native-locale.js`: ما تملك القشرةُ ترجمتَه هو وحده ما يُعرض.
// القائمةُ السابقة عرضت ١٩١ رمز ISO 639-1 كلُّها تسقط إلى الإنجليزية عدا اثنتين — قائمةٌ تكذب على المستخدم.
import { SUPPORTED_LANGUAGES } from './native-locale.js';
export function languageChoices() { return SUPPORTED_LANGUAGES.map(({ code, label }) => ({ code, label })); }
// رموزُ اللغات المقبولة عند الحفظ (`index.html` يفحص بها حقلَ اللغة) — مشتقّةٌ من المالك نفسِه فلا يقبل الحفظُ لغةً لا تُعرض.
export const LANGUAGE_CODES = Object.freeze(SUPPORTED_LANGUAGES.map(({ code }) => code));
