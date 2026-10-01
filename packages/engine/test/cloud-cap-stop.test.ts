/**
 * 10-01 — مقيس (الدوران 40–41): سقفُ السحابة العامّ رفض النداء فعاد نصّاً، فعومل «ردّاً بلا أداة» وأطلق شرطَ السبرنت مرّتين ومراجعةً على نصّ الرفض.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8")

describe("the global cloud cap stops the turn by name, before any acceptance gate", () => {
  test("a code-mode refusal is counted where it is returned", () => {
    const refusal = cli.indexOf("if (!budget.allowed) {if(hooks.conversationMode==='chat')throw Error(budget.message??'Cloud usage budget does not allow this request.');")
    expect(refusal).toBeGreaterThan(0)
    expect(cli.slice(refusal, refusal + 260)).toContain("cloudCapRefusals += 1")
  })

  test("the epoch breaks on it before the turn meter, the no-tool warning and the acceptance chain", () => {
    const stop = cli.indexOf("if (cloudCapRefusals > cloudCapRefusalsAtTurnStart) {")
    const meter = cli.indexOf("if (turnMeter !== undefined) {", stop)
    const sprintGate = cli.indexOf("if (isResumeIntent(turn.body) && sprintOpenAtStart !== undefined")
    expect(stop).toBeGreaterThan(0)
    expect(meter).toBeGreaterThan(stop)
    expect(sprintGate).toBeGreaterThan(stop)
    const branch = cli.slice(stop, meter)
    expect(branch).toContain('lastStop = "turn_budget"')
    expect(branch).toContain("break")
    expect(cli).toContain("const cloudCapRefusalsAtTurnStart = cloudCapRefusals")
  })
})
