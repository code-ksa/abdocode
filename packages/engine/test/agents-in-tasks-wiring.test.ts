import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// المسامير تثبت أنّ السلسلة موصولة من طرفها إلى طرفها: المحرّك يبثّ إطار `agent` من delegate وteam بحالةٍ من حكم
// التقرير، ووضعَ العمل على `admission`؛ والقشرة تجمعهما على صفّ المهمّة؛ والورقة ترسم النقطة والمربّع.
const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8")

test("engine emits one agent frame per delegated or team member, closed by the report's stop", () => {
  const cli = read("../src/cli.ts")
  expect(cli).toContain('emit({ kind: "agent", turnId, id: agentFrameId, name: agent.name, task: parsed.task.slice(0, 240), agentKind: "delegate"')
  expect(cli).toContain('emit({ kind: "agent", turnId, id: agentId, name: agent.name, task: task.slice(0, 240), agentKind: "team", index: index + 1, total: jobs.length, mode: work.label, state, ...extra })')
  // الحالةُ حكمُ التقرير لا الزمن: `report.stop` يغلق الإطار، و`failed` عند الرمية — في المسارين.
  expect(cli.match(/agentFrame\(report\.stop, \{ epoch: report\.epochs/gu)).toHaveLength(2)
  expect(cli.match(/agentFrame\("failed", \{ detail: String/gu)).toHaveLength(2)
  // فريق: التقدّم بالحقبة يمرّ من onEpoch الذي كان غائباً عن team.
  expect(cli).toContain('onEpoch: (childEpoch) => agentFrame("running", { epoch: childEpoch }),')
  // وضعُ العمل يركب القبول فيعرفه اللوحُ لكلّ دور، لا للجاري وحده.
  expect(cli).toContain('emit({ kind: "admission", ...admission, mode: workProfile(loadSettings().workMode).label })')
})

test("shell folds agent frames and admission mode onto the task rows; sheet draws the blue dot and the square", () => {
  const shell = read("../../desktop/ui/index.html")
  expect(shell).toContain('if (f.kind === "agent" && typeof f.turnId === "string" && typeof f.id === "string") {')
  expect(shell).toContain('if (f.kind === "admission" && typeof f.turnId === "string" && typeof f.mode === "string") modeByTurn.set(f.turnId, f.mode);')
  expect(shell).toContain("...(agentsByTurn.has(turnId) ? { agents: Array.from(agentsByTurn.get(turnId).values()) } : {}),")
  expect(shell).toContain('const WORK_MODE_LABEL = Object.freeze({ basic: "أساسيّ", strong: "أقوى", stronger: "أقوى+", max: "أقصى" });')
  const sheet = read("../../desktop/ui/native-transcript.css")
  expect(sheet).toContain(".task-agent[data-state=running] .task-agent-dot{background:var(--ns-blue);border-radius:50%;animation:task-agent-pulse")
  expect(sheet).toContain(".task-agent-wrap[open]>.task-agent-detail{display:block}")
  // السهمُ في المهامّ صار رسماً بسماكة الأيقونات (1.65) لا حرفاً.
  expect(sheet).toContain(".task-head:after{content:'';width:7px;height:7px;border-right:1.65px solid currentColor")
  expect(sheet).not.toContain("content:'⌄'")
})

test("dark mode: buttons and the terminal read light; settings is sliders, conversation options is a filter", () => {
  const css = read("../../desktop/ui/native-shell.css")
  expect(css).toContain("--ns-muted:#c4c7cc")
  expect(css).not.toContain("color:#636562")
  expect(css).toContain("border-radius:6px;color:var(--ns-fg);gap:7px}")
  const termCss = read("../../desktop/src/native-terminal.css")
  expect(termCss).toContain("color:var(--nt-foreground,var(--ns-fg,#242424))")
  const termJs = read("../../desktop/src/native-terminal.js")
  expect(termJs).toContain("root.style.setProperty('--nt-foreground', dark ? '#eeeeee' : '#242424');")
  const shellJs = read("../../desktop/ui/native-shell.js")
  expect(shellJs).toContain("settings:'M4 6h8m4 0h4M4 12h4m4 0h8M4 18h10m4 0h2M12 4v4M8 10v4M14 16v4'")
  expect(shellJs).toContain("filter:'M4 6h16M7 12h10m-7 6h4'")
  expect(shellJs).toContain("]]),'filter')")
  expect(shellJs).toContain("gear=button('',()=>native.settings(),'settings')")
  expect(shellJs).not.toContain("name==='settings'?'<circle")
})

// مقيس على 4.0.52 (09-17): وضعُ العمل «أقصى» ومفتاحُ التفويض معطَّل ⇦ النموذج: «أداة team غير موجودة». الوضعُ الموازي يعني التفويض.
test("a parallel work mode implies delegation: team and delegate are advertised and allowed without the plugin switch", () => {
  const cli = read("../src/cli.ts")
  expect(cli).toContain('const delegationEnabled = (): boolean => pluginOnNow("delegation") || workProfile(loadSettings().workMode).parallelAgents >= 2')
  // كلُّ بوّابات التفويض تمرّ من الدالّة الواحدة — لا موضعَ يسأل المفتاحَ وحده.
  expect(cli.match(/pluginOnNow\("delegation"\)/gu)).toHaveLength(1)
  expect(cli).toContain("const delegationOn = delegationEnabled()")
  expect(cli).toContain("if (!delegationEnabled()) return denied(\"رُفض team:")
  expect(cli).toContain("const delegationOnNow = delegationEnabled()")
})
