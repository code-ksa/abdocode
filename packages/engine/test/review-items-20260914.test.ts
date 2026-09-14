// بنودُ المراجعة العدائيّة المتبقّية (09-14): #12 حبسُ run المؤثّر أثناء مشروعٍ جديدٍ معلَّق، #17 إعادةُ قياس المجلّد الفارغ لحظةَ
// التبنّي، #19 تدويرُ سجلّ stderr، #25ج قواعدُ @media/@layer في page css (المملوك والإضافة)، وزرُّ الرجوع في القشرة من إطار done.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const at = (p: string) => readFileSync(resolve(import.meta.dir, p), "utf8")
const cli = at("../src/cli.ts")

describe("review items 09-14", () => {
  test("#12 — an effectful run while a new project is pending is denied before the gate; read-only commands pass the guard", () => {
    const guard = cli.indexOf("if (newProjectPending !== undefined && !/^(?:ls|dir|cat|type|head|tail|pwd|echo|node -v|npm -v|bun -v|git (?:status|log|diff|branch|remote)|where|which|Get-ChildItem|Get-Content|Get-Location|tree)\\b/iu.test(command.trim())) {")
    const gate = cli.indexOf('const ok = await gate(turnId, spec.effect, `تنفيذ${background ? " (خلفيّ)" : ""}: ${command}`)')
    expect(guard).toBeGreaterThan(0); expect(gate).toBeGreaterThan(guard); expect(gate - guard).toBeLessThan(700)
    expect(cli).toContain("رُفض التنفيذ في المشروع المختار: المستخدمُ طلب مشروعاً جديداً باسم «${newProjectPending}». أنشئه أوّلاً: نفّذ: project-create ${newProjectPending}")
    const re = /^(?:ls|dir|cat|type|head|tail|pwd|echo|node -v|npm -v|bun -v|git (?:status|log|diff|branch|remote)|where|which|Get-ChildItem|Get-Content|Get-Location|tree)\b/iu
    for (const ok of ["ls", "git status", "Get-ChildItem .", "node -v"]) expect(re.test(ok)).toBe(true)
    for (const bad of ["npm install", "npx create-vite app", "git init", "Remove-Item x", "rm -rf dist", "lsof"]) expect(re.test(bad)).toBe(false)
  })
  test("#17 — createProjectFolder re-measures emptiness at adoption time", () => {
    const bootstrap = at("../src/project-bootstrap.ts")
    const real = bootstrap.indexOf("const actual = realpathSync(path)")
    const recheck = bootstrap.indexOf('if (!isEmptyDirectory(actual)) throw new Error("The folder was filled by someone else between the check and the adoption', real)
    expect(real).toBeGreaterThan(0); expect(recheck).toBeGreaterThan(real)
  })
  test("#19 — the engine stderr log rotates once past 4 MiB before it is opened", () => {
    const main = at("../../desktop/src-tauri/src/main.rs")
    const rotate = main.indexOf('let _ = std::fs::rename(&log, dir.join("engine-stderr.1.log"));')
    const open = main.indexOf("match std::fs::File::create(&log) {", rotate)
    expect(rotate).toBeGreaterThan(0); expect(open).toBeGreaterThan(rotate)
    expect(main).toContain("m.len() > 4 * 1024 * 1024")
  })
  test("#25ج — grouped rules (@media/@supports/@layer/@container) are walked in both the owned browser and the extension", () => {
    const cdp = at("../../browser/src/cdp.ts")
    expect(cdp).toContain('const walk = (list, ctx, sheetName) => {')
    expect(cdp).toContain('r.type === 4 ? \\"@media \\" + r.media.mediaText')
    expect(cdp).toContain('\\"CSSLayerBlockRule\\"')
    const ext = at("../../browser-bridge/extension/background.js")
    expect(ext).toContain("const walk = (list, ctx) => {")
    expect(ext).toContain('name === "CSSLayerBlockRule" ? "@layer " + r.name')
    expect(ext).toContain('rules.push((ctx ? ctx : "") + String(r.cssText).slice(0, 400))')
  })
  test("done frame carries checkpointFiles and the shell offers a rollback button from it", () => {
    expect(cli).toContain('emit({ kind: "done", turnId: turn.id, rerun: false, ...(checkpoints.count(currentSession, turn.id) > 0 ? { checkpointFiles: checkpoints.count(currentSession, turn.id) } : {}), contextLeft: lastContextLeft })')
    // مقيس على 4.0.12: الدورُ العاديّ يخرج من مسار done الثاني (outcome) — بلا الحقل لم يظهر الزرُّ؛ كلُّ done يحمله
    expect(cli).toContain('outcome: completed ? "completed" : "checkpointed", ...(checkpoints.count(currentSession, turn.id) > 0 ? { checkpointFiles: checkpoints.count(currentSession, turn.id) } : {}), contextLeft: lastContextLeft })')
    expect((cli.match(/kind: "done", turnId: turn\.id/gu) ?? []).length).toBe((cli.match(/checkpointFiles: checkpoints\.count\(currentSession, turn\.id\)/gu) ?? []).length)
    const shell = at("../../desktop/ui/index.html")
    // 09-14 ظهراً: نهايةُ done تحمل سببَها (interrupted/done) — الوسمُ في القشرة من السبب لا من «ليست done».
    expect(shell).toContain('settle(f.turnId, interruptedTurns.has(f.turnId), interruptedTurns.has(f.turnId) ? "interrupted" : "done"); offerRollback(f); return; }')
    expect(shell).toContain('if (typeof f.checkpointFiles !== "number" || f.checkpointFiles <= 0) return;')
    expect(shell).toContain('operatorSubmit("rollback " + f.turnId)')
    expect(shell).toMatch(/if \(!confirm\(uiText\(/u)
  })
})
