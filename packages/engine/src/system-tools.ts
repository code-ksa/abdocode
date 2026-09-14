/** 6.3 — أدوات النظام بمسارات مطلقة: العارية خارج PATH تفشل صامتة.
 *
 * قيس مرتين في ليلة واحدة: `taskkill` العارية فشلت داخل catch صامت فبقي
 * خادمٌ «مقتول» حياً، و`cmd` العارية أفشلت اختباراً. بيئات bun المفرّغة
 * لا تحمل System32 في PATH — فكل نداء لأداة نظام يمرّ من هنا حصراً.
 */
import { existsSync } from "node:fs"

const SYSTEM32 = `${process.env["SystemRoot"] ?? "C:/Windows"}/System32`

const KNOWN = {
  taskkill: `${SYSTEM32}/taskkill.exe`,
  tasklist: `${SYSTEM32}/tasklist.exe`,
  netstat: `${SYSTEM32}/NETSTAT.EXE`,
  cmd: `${SYSTEM32}/cmd.exe`,
  where: `${SYSTEM32}/where.exe`,
  powershell: `${SYSTEM32}/WindowsPowerShell/v1.0/powershell.exe`,
} as const

export type SystemTool = keyof typeof KNOWN

/** المسار المطلق للأداة — والغياب خطأ مسمّى لا فشل صامت. */
export function systemTool(name: SystemTool): string {
  const path = KNOWN[name]
  if (!existsSync(path)) throw new Error(`أداة النظام ${name} غائبة عن ${path} — لا تنفيذ أعمى بالاسم العاري`)
  return path
}
