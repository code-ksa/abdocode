/**
 * التقاطُ الذهب من الكود **قبل** S1 — لا من المُركِّب نفسه.
 *
 * يقرأ `cli.ts` من الإيداع المثبَّت (آخر إيداعٍ قبل المُركِّب) عبر git، يقتطع
 * تعبيرَ `baseSystem` حرفيّاً، ويقيّمه بمدخلاتٍ صريحة، ثمّ يكتب الناتجَ ذهباً
 * في `legacy-golden.json`. الاختبارُ يقارن `legacyBaseSystem` بهذا الذهب بايتاً.
 *
 * التشغيل (من جذر المستودع): `bun packages/engine/test/fixtures/prompt-composer/capture-legacy.ts`
 */
import { ProductTools as Tools } from "@abdo/tools"
import { intentInstruction } from "../../../src/intent-field"
import { nativeAgentSystem } from "../../../src/native-agent-tools"
import { legacyBaseSystem, type ComposeInput } from "../../../src/prompt-composer"
import { browserBridgeHint, policyLine, terminalDialectLine, toolVocabulary } from "../../../src/tool-vocabulary"
import type { RequestKind } from "../../../src/shells/shell"

/** آخرُ إيداعٍ قبل أيّ لمسةٍ لـ`cli.ts` في S1. */
const PRE_CHANGE_COMMIT = "e7181a7c36"
const cliPath = new URL("../../../src/cli.ts", import.meta.url)
const proc = Bun.spawnSync(["git", "show", `${PRE_CHANGE_COMMIT}:packages/engine/src/cli.ts`], { cwd: new URL("../../../../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1") })
if (proc.exitCode !== 0) throw new Error(`git show failed: ${proc.stderr.toString()}`)
const preChange = proc.stdout.toString().replace(/\r\n/gu, "\n")

const HEAD_MARK = "const baseSystem = hooks.conversationMode==='chat' ? CHAT_SYSTEM : "
const TAIL_MARK = "\"{{tool-catalogue}}\""
const start = preChange.indexOf(HEAD_MARK)
if (start < 0) throw new Error("baseSystem head not found in pre-change cli.ts")
const exprStart = start + HEAD_MARK.length
const exprEnd = preChange.indexOf(TAIL_MARK, exprStart) + TAIL_MARK.length
const expression = preChange.slice(exprStart, exprEnd)
if (!expression.startsWith("nativeTools ? nativeAgentSystem(")) throw new Error("unexpected expression head: " + expression.slice(0, 60))

// التعبيرُ القديم كما هو، بأسمائه الحرّة مربوطةً وسائط — لا نسخةٌ منقولة باليد.
const evaluate = new Function(
  "nativeTools", "nativeAgentSystem", "planningPhase", "process", "hooks", "policy", "rails",
  "sprintPlanReady", "planApproved", "PROJECT_DIR", "terminalDialectLine", "advertisedNames", "intentInstruction", "toolVocabulary",
  `return (${expression})`,
) as (...args: unknown[]) => string

const effectOf = (name: string): RequestKind | undefined => Tools.TOOLS.find((tool) => tool.name === name)?.effect
const FULL = Tools.TOOLS.filter((tool) => tool.agentCallable && tool.cloudOnly !== true).map((tool) => tool.name)
const READERS = FULL.filter((name) => effectOf(name) === "read")

interface Fixture { readonly name: string; readonly input: ComposeInput; readonly golden: string }

const policyFor = (mode: "read-only" | "auto" | "full-access", advertised: readonly string[]): string =>
  policyLine(mode, advertised, effectOf) + browserBridgeHint([], advertised)

const inputs: readonly { readonly name: string; readonly input: ComposeInput }[] = [
  { name: "text-coaching-on", input: { mode: "text", planningPhase: false, coaching: true, intentField: false, advertised: FULL, policy: policyFor("full-access", FULL), sprintPlan: { required: false, ready: false, approved: false } } },
  { name: "text-coaching-off", input: { mode: "text", planningPhase: false, coaching: false, intentField: false, advertised: FULL, policy: policyFor("auto", FULL), sprintPlan: { required: false, ready: false, approved: false } } },
  { name: "text-planning-sprint-required", input: { mode: "text", planningPhase: true, coaching: true, intentField: true, advertised: READERS, policy: policyFor("read-only", READERS), sprintPlan: { required: true, ready: false, approved: false } } },
  { name: "text-plan-written-unapproved", input: { mode: "text", planningPhase: true, coaching: true, intentField: false, advertised: READERS, policy: policyFor("read-only", READERS), sprintPlan: { required: true, ready: true, approved: false } } },
  { name: "text-plan-approved-execution", input: { mode: "text", planningPhase: false, coaching: true, intentField: false, advertised: FULL, policy: policyFor("full-access", FULL), sprintPlan: { required: true, ready: true, approved: true } } },
  { name: "native-execution", input: { mode: "native", planningPhase: false, coaching: true, intentField: true, advertised: FULL, policy: policyFor("full-access", FULL), sprintPlan: { required: false, ready: false, approved: false } } },
  { name: "native-planning-sprint-required", input: { mode: "native", planningPhase: true, coaching: false, intentField: false, advertised: READERS, policy: policyFor("read-only", READERS), sprintPlan: { required: true, ready: false, approved: false } } },
]

const fixtures: Fixture[] = inputs.map(({ name, input }) => {
  const env = { ABDO_REQUIRE_SPRINT_PLAN: input.sprintPlan.required ? "1" : undefined }
  const golden = evaluate(
    input.mode === "native", nativeAgentSystem, input.planningPhase, { env }, { intentField: input.intentField ? true : undefined }, input.policy, { coaching: input.coaching },
    (_dir: string, _strict: boolean) => input.sprintPlan.ready, (_dir: string, _strict: boolean) => input.sprintPlan.approved, "C:\\projects\\demo",
    terminalDialectLine, input.advertised, intentInstruction, toolVocabulary,
  )
  const mine = legacyBaseSystem(input)
  if (mine !== golden) {
    const at = [...golden].findIndex((ch, i) => mine[i] !== ch)
    throw new Error(`legacyBaseSystem drifts from pre-change cli.ts in «${name}» at char ${at}: …${golden.slice(Math.max(0, at - 40), at + 40)}…`)
  }
  return { name, input, golden }
})

const out = new URL("./legacy-golden.json", import.meta.url)
await Bun.write(out, JSON.stringify({ capturedFrom: `${PRE_CHANGE_COMMIT}:packages/engine/src/cli.ts`, fixtures }, null, 2) + "\n")
console.log(`captured ${fixtures.length} fixtures from ${PRE_CHANGE_COMMIT} → ${out.pathname}`)
for (const fixture of fixtures) console.log(`  ${fixture.name}: ${Buffer.byteLength(fixture.golden, "utf8")} bytes`)
void cliPath
