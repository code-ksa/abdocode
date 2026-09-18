/** Planning is a bounded phase, not a build with fewer permissions by prose.
 *
 * 09-16 — الخطّةُ تُعتمد قبل كود المنتج (كما ExitPlanMode عند كلود): النموذجُ يكتب
 * ABDO-SPRINTS.md (ووثائقَ ABDO-PLANS/*.md)، ثمّ يطلب «plan-approve» فيمرّ ببوّابة
 * الموافقة، والاعتمادُ يُربط ببصمة الخطّة فيسقط إن تغيّرت — لا موافقةَ ضمنيّة. */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const PLANNING_TOOLS = new Set(["project-template", "templates", "project-inspect", "project-locate", "project-open", "project-orient", "project-create", "read", "list", "glob", "grep", "write", "edit", "plan", "plan-approve"])

export const PLAN_FILE = "ABDO-SPRINTS.md"
export const PLAN_APPROVAL_FILE = "ABDO-PLANS/APPROVED.json"
export const PLAN_APPROVE_TOOL = "plan-approve"

export const planningToolAllowed = (name: string, planning: boolean): boolean =>
  !planning || PLANNING_TOOLS.has(name)

export const projectDocumentReadLimit = (file: string, defaultLimit: number): number =>
  /(?:^|[\\/])(?:ABDO-(?:SPRINTS|HANDOFF)\.md|ABDO-PLANS[\\/][^\\/]+\.md)$/iu.test(file) ? 14_000 : defaultLimit

export const planningWriteViolation = (target: string, planningOnly: boolean): string | undefined => {
  if (!planningOnly) return undefined
  const normalized = target.replaceAll("\\", "/").replace(/^\.\//u, "").toLowerCase()
  return normalized === "abdo-sprints.md" || normalized === "abdo-handoff.md" || /^abdo-plans\/[a-z0-9._-]+\.md$/u.test(normalized)
    ? undefined
    : `مرحلة التخطيط تسمح فقط بـABDO-SPRINTS.md وABDO-HANDOFF.md وABDO-PLANS/*.md؛ لا تكتب ملفات المنتج قبل اعتماد الخطّة بـ«${PLAN_APPROVE_TOOL}» وفتح مرحلة التنفيذ`
}

export type PlanApprovalState = "no-plan" | "unapproved" | "stale" | "approved"

/** بصمةُ الخطّة بلا CR — الملفُّ يُكتب على ويندوز ويُقرأ بأيّ نهايةٍ فلا يُسقط الاعتمادَ حرفٌ خفيّ. */
export const planDigest = (planText: string): string =>
  createHash("sha256").update(planText.replace(/\r\n/gu, "\n")).digest("hex")

/** الحكمُ خالصٌ من الأثر: نصُّ الخطّة وسجلُّ الاعتماد كما قُرئا. سجلٌّ معطوب = قديم، لا معتمَد. */
export const planApprovalVerdict = (planText: string | undefined, approvalJson: string | undefined): PlanApprovalState => {
  if (planText === undefined) return "no-plan"
  if (approvalJson === undefined) return "unapproved"
  try {
    const parsed = JSON.parse(approvalJson) as { readonly digest?: unknown }
    return typeof parsed.digest === "string" && parsed.digest === planDigest(planText) ? "approved" : "stale"
  } catch {
    return "stale"
  }
}

const readIf = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf-8") : undefined)

export const planApprovalState = (projectDir: string): PlanApprovalState =>
  planApprovalVerdict(readIf(join(projectDir, PLAN_FILE)), readIf(join(projectDir, PLAN_APPROVAL_FILE)))

/** الاعتمادُ شرطٌ حين تكون الخطّةُ شرطاً (كما sprintPlanReady)؛ بلا شرطٍ لا بوّابة. */
export const planApproved = (projectDir: string, required: boolean): boolean =>
  !required || planApprovalState(projectDir) === "approved"

/** يكتب سجلَّ الاعتماد مربوطاً ببصمة الخطّة الحاليّة. من يعتمد قرارٌ خارج هذه الوحدة (بوّابةُ الموافقة أو المستخدم مباشرة). */
export const approvePlan = (projectDir: string, by: string): { readonly ok: boolean; readonly text: string } => {
  const plan = readIf(join(projectDir, PLAN_FILE))
  if (plan === undefined) return { ok: false, text: `لا خطّة لاعتمادها: ${PLAN_FILE} غائب — اكتب الخطّة أوّلاً` }
  const digest = planDigest(plan)
  const path = join(projectDir, PLAN_APPROVAL_FILE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ digest, approvedAt: new Date().toISOString(), by }, null, 2)}\n`)
  return { ok: true, text: `اعتُمدت الخطّة ${PLAN_FILE} (بصمة ${digest.slice(0, 12)}) — فُتحت مرحلة التنفيذ؛ تعديلُ الخطّة يُسقط الاعتماد ويعيد التخطيط.` }
}
