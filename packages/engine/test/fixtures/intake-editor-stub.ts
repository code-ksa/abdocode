/**
 * محرّرُ نصٍّ مزيّف للاختبار — يقوم مقام notepad.exe فلا تُفتح نافذةٌ على
 * سطح مكتب المشغّل أثناء الاختبار. يُستدعى كتنفيذيّ مباشر تماماً كما يُستدعى
 * المحرّر الحقيقيّ: `bun <هذا الملفّ> [توجيه] <مسار القالب>` — لا نصّ صدفةٍ
 * ولا shell، ومسارُ القالب هو **آخر** وسيط كما يمرّره المحرّك.
 *
 * التوجيه من الوسائط لا من البيئة: المتغيّرات التي تُضبط بعد إقلاع العملية
 * لا يراها الابن في bun، فكان «المستخدم» يحفظ ملفاً فارغاً دائماً.
 *   --value=<قيمة>  يكتبها مكان سطر القيمة
 *   --noop          يخرج بلا كتابة (القالب كما هو)
 *   --hang          لا يخرج أبداً (لاختبار المهلة والقتل)
 */
import { readFileSync, writeFileSync } from "node:fs"

const args = process.argv.slice(2)
const path = args[args.length - 1]
const directives = args.slice(0, -1)
if (typeof path !== "string" || path.startsWith("--")) process.exit(2)

if (directives.includes("--hang")) {
  setInterval(() => {}, 1_000)
} else if (!directives.includes("--noop")) {
  // الوسيطُ أوّلاً؛ والبيئةُ احتياطاً حين يشغّل المحرّكُ المحرّرَ بنفسه
  // (المحرّك يرث البيئة عند إقلاعه فيراها الابن، بخلاف متغيّرٍ يُضبط بعده).
  const value = directives.find((arg) => arg.startsWith("--value="))?.slice("--value=".length)
    ?? process.env.ABDO_TEST_INTAKE_VALUE
    ?? ""
  const kept = readFileSync(path, "utf8").split(/\r\n|\n/u).filter((line) => line.startsWith("#"))
  writeFileSync(path, `${kept.join("\r\n")}\r\n${value}\r\n`, "utf8")
}
