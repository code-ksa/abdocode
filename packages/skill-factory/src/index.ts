export interface VerifiedSkillStep { readonly tool: string; readonly arguments: Readonly<Record<string, unknown>>; readonly verified: true }
export interface GeneratedSkill { readonly version: 1; readonly name: string; readonly steps: readonly VerifiedSkillStep[] }
const SECRET = /(authorization|api[-_]?key|password|secret|token)/i

export function generateSkill(name: string, steps: readonly VerifiedSkillStep[]): GeneratedSkill {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error("skill_name_invalid")
  if (steps.length === 0) throw new Error("skill_steps_required")
  for (const step of steps) {
    if (step.verified !== true) throw new Error("unverified_skill_step")
    if (Object.keys(step.arguments).some((key) => SECRET.test(key))) throw new Error("secret_bearing_skill_step")
  }
  return Object.freeze({ version: 1, name, steps: Object.freeze(steps.map((step) => Object.freeze({ ...step, arguments: Object.freeze({ ...step.arguments }) }))) })
}
