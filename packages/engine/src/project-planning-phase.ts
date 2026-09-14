/** Planning is a bounded phase, not a build with fewer permissions by prose. */
const PLANNING_TOOLS = new Set(["project-template", "templates", "project-inspect", "project-locate", "project-open", "project-orient", "project-create", "read", "list", "glob", "grep", "write", "edit"])

export const planningToolAllowed = (name: string, planning: boolean): boolean =>
  !planning || PLANNING_TOOLS.has(name)

export const projectDocumentReadLimit = (file: string, defaultLimit: number): number =>
  /(?:^|[\\/])ABDO-(?:SPRINTS|HANDOFF)\.md$/iu.test(file) ? 14_000 : defaultLimit

export const planningWriteViolation = (target: string, planningOnly: boolean): string | undefined => {
  if (!planningOnly) return undefined
  const normalized = target.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase()
  return normalized === "abdo-sprints.md" || normalized === "abdo-handoff.md"
    ? undefined
    : "مرحلة التخطيط تسمح فقط بـABDO-SPRINTS.md وABDO-HANDOFF.md؛ لا تكتب ملفات المنتج قبل فتح مرحلة التنفيذ"
}
