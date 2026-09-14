import { describe, expect, test } from "bun:test"
import { runTextAgentLoop } from "@abdo/engine-host"

// أمر المالك 2026-09-02 (هارنس رفيع، نافذة 128k): الدفتر يرى المخبوء ويحسبه
// بخصم، وأثر القراءة يُضغط بلا كسر البادئة — وكلٌّ خلف مفتاح إعدادات افتراضه
// مفعَّل وإطفاؤه هو القديم حرفياً (قاعدة المالك 6). الوحدات مختبَرة في
// token-budget.test وengine-host؛ هذا الملف يثبت أن cli.ts يصل بها فعلاً —
// المسح 2026-09-02 وجد الوحدتين مبنيتَين وغير موصولتَين بالمسار الحي.
const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

describe("token economy wiring in the live cli path", () => {
  test("both ledger writers forward decoded usage through chargeableUsage behind plugins.cacheAccounting", () => {
    // IDEA 10 (turnBudget): the chargeableUsage result is bound once per site, written to the ledger,
    // and charged into the per-turn meter — one unit, one arithmetic per site.
    // إعادة تثبيت (سجلّ الإضافات): القراءة صارت تمرّ بالمحلّل نفسه — الجرد إن
    // كان في دور، وإلا حلٌّ مباشر — بدل `!== false` التي كانت تقرأ أيّ قيمةٍ
    // مشوَّهة مفعَّلةً. الموضع والحساب لم يتغيّرا.
    expect(source).toContain("const charged = chargeableUsage(decoded.usage, estimated, requestOutputCap, pluginOnNow(\"cacheAccounting\"))")
    expect(source).toContain("recordCloudUsage({ provider: prov.id, model: selected.model, ...charged })")
    // IDEA 4 (routerGate): the gate call is the SECOND and only other ledger writer — same chargeableUsage
    // spread with the gate's own output cap, tagged note: "router.gate" so ledgerSummary consumers can split
    // gate vs loop later without a schema change. Raised honestly from 1 → 2 (spec risk item).
    expect(source).toContain("const charged = chargeableUsage(decoded.usage, estimated, GATE_OUTPUT_TOKENS, pluginOnNow(\"cacheAccounting\"))")
    expect(source).toContain('recordCloudUsage({ provider: prov.id, model: selected.model, note: "router.gate", ...charged })')
    // Third writer (2026-09-05): semantic memory ranking (memoryRankAsk) spends on the selected
    // provider too, tagged note:'memory.semantic' so the ledger can split it. Raised honestly 2 -> 3.
    expect(source).toContain("const charged=chargeableUsage(decoded.usage,estimated,outputCap,pluginOnNow('cacheAccounting'))")
    expect(source).toContain("recordCloudUsage({provider:prov.id,model:selected.model,note:'memory.semantic',...charged})")
    // Fourth writer (2026-09-06, د3): semantic inference (inferAsk) spends one bounded side call on the
    // selected provider, tagged note:"semantic.infer" so the ledger can split it. Raised honestly 3 -> 4.
    expect(source).toContain('recordCloudUsage({ provider: prov.id, model: selected.model, note: "semantic.infer", ...charged })')
    expect(source.match(/chargeableUsage\(decoded\.usage/gu)).toHaveLength(4)
    expect(source.match(/recordCloudUsage\(\{/gu)).toHaveLength(4)
    expect(source.match(/note: "router\.gate"/gu)).toHaveLength(1)
    expect(source.match(/note:'memory\.semantic'/gu)).toHaveLength(1)
    // No hand-built entry survives that could drop cachedInputTokens again.
    expect(source).not.toContain("conservativeTokens(decoded.usage")
    expect(source).toMatch(/import \{[^}]*\bchargeableUsage\b[^}]*\} from "\.\/token-budget"/u)
  })

  test("the gate call is a cloud call like any other: global cap first, turn meter second with the same estimate, ledger + meter from one charged result", () => {
    const gateAsk = source.indexOf("const gateAsk = async (")
    const askFn = source.indexOf("const ask = async (")
    expect(gateAsk).toBeGreaterThan(0)
    expect(askFn).toBeGreaterThan(gateAsk)
    const body = source.slice(gateAsk, askFn)
    const cloudGate = body.indexOf("cloudBudgetVerdict(estimated + GATE_OUTPUT_TOKENS)")
    const turnGate = body.indexOf("hooks.turnMeter?.verdict(estimated + GATE_OUTPUT_TOKENS)")
    const transport = body.indexOf("REACH.model({ provider: prov.id, url: request.url, body: request.body, timeoutMs }, hooks.signal)")
    const decode = body.indexOf("const decoded = Providers.decodeResponse(prov, await response.json())")
    const ledger = body.indexOf('note: "router.gate"')
    const meter = body.indexOf("hooks.turnMeter?.charge(charged)")
    const interpret = body.indexOf("interpretGateTurn(decoded, corpus)")
    expect(cloudGate).toBeGreaterThan(0)
    expect(turnGate).toBeGreaterThan(cloudGate)
    expect(transport).toBeGreaterThan(turnGate)
    expect(decode).toBeGreaterThan(transport)
    expect(ledger).toBeGreaterThan(decode)
    expect(meter).toBeGreaterThan(ledger)
    // tokens were spent: recorded and charged BEFORE the decision is interpreted (same rule as ask()).
    expect(interpret).toBeGreaterThan(meter)
    // a budget refusal skips the gate (reason "budget") and never throws into the turn.
    expect(body).toContain('if (!budget.allowed) return { kind: "escalated", reason: "budget", detail: "cloud" }')
    expect(body).toContain('if (turnBudget !== undefined && !turnBudget.allowed) return { kind: "escalated", reason: "budget", detail: "turn" }')
    // the gate charges only cloud providers, exactly like ask(): local calls stay outside the ledger.
    expect(body.match(/if \(rustOwnedProvider\) \{/gu)!.length).toBeGreaterThanOrEqual(3)
  })

  test("the cache-aware ledger line has a live consumer and never renders an unknown or empty ledger", () => {
    // cloudLedger لا ledger: في نطاق الدور نفسه يعيش دفتر أحكام الأدوات (§8) باسم ledger — دفتران مستقلّان.
    expect(source).toContain("const cloudLedger = readLedgerSummary()")
    expect(source).toContain('if (cloudLedger !== "unknown" && cloudLedger.calls > 0) await emitEvent(turn.id, renderLedgerLine(cloudLedger))')
  })

  test("read compaction is wired into runTextAgentLoop behind plugins.readCompaction; OFF is the legacy option-absent loop", () => {
    // إعادة تثبيت: القراءة صارت من جرد الدور بموضع «حقبة» (توقيتها لم يتغيّر —
    // مرةً لكل حقبة داخل حلقة الحقب)، والطيّ المشروط نفسه: المعطَّل = غياب الخيار.
    expect(source).toContain('...(plugins.read("readCompaction", "epoch", epoch) ? { readCompaction: READ_COMPACTION } : {}),')
    expect(source).toContain("ضغط القراءة=${loop.readCompactions}")
    expect(source.match(/runTextAgentLoop\(\{/gu)).toHaveLength(1)
  })

  test("the shipped compaction budget is a valid, rare trigger for READ_BUDGET-sized reads in a 128k window", async () => {
    const match = source.match(/const READ_COMPACTION = \{ keepRecent: (\d+), overChars: ([\d_]+) \} as const/u)
    expect(match).not.toBeNull()
    const keepRecent = Number(match![1])
    const overChars = Number(match![2]!.replace(/_/gu, ""))
    const readBudget = Number(source.match(/const READ_BUDGET = (\d+)/u)![1])
    expect(keepRecent).toBeGreaterThanOrEqual(2)
    // At least several full reads must age out before one pass rewrites the prefix.
    expect(overChars).toBeGreaterThanOrEqual(readBudget * 5)
    // ~4 chars/token: the budget stays a fraction of the 128k window.
    expect(overChars / 4).toBeLessThan(128_000 / 4)
    // The loop accepts the shipped numbers (it rejects malformed budgets).
    const result = await runTextAgentLoop({
      input: "x", history: [], ask: async () => "تم", dispatch: async () => "", isCallable: () => false,
      readCompaction: { keepRecent, overChars },
    })
    expect(result.readCompactions).toBe(0)
  })

  // S13.0-b — the exec-class trail compaction rides a SEPARATE spread behind its own
  // toggle; the readCompaction spread above stays byte-identical (owner rule 6).
  test("trail compaction is wired into runTextAgentLoop behind plugins.trailCompaction with its own spread; the read spread is untouched", () => {
    expect(source).toContain('...(plugins.read("trailCompaction", "epoch", epoch) ? { trailCompaction: TRAIL_COMPACTION } : {}),')
    expect(source).toContain('...(plugins.read("readCompaction", "epoch", epoch) ? { readCompaction: READ_COMPACTION } : {}),')
    expect(source.match(/trailCompaction: TRAIL_COMPACTION/gu)).toHaveLength(1)
    expect(source.match(/runTextAgentLoop\(\{/gu)).toHaveLength(1)
    // The checkpoint line keeps the pinned read field and appends the exec pass count and the final epoch trail size after it.
    expect(source).toContain("ضغط القراءة=${loop.readCompactions} · ضغط التنفيذ=${loop.execCompactions} · أثر الحقبة=${loop.trailChars}")
  })

  test("the shipped trail budget is valid, rare, and its per-call knob is bounded like AGENT_CONTEXT_TOKENS", async () => {
    const match = source.match(/const TRAIL_COMPACTION = \{ keepRecent: (\d+), overChars: ([\d_]+), trailChars: EPOCH_TRAIL_CHARS \} as const/u)
    expect(match).not.toBeNull()
    const keepRecent = Number(match![1])
    const overChars = Number(match![2]!.replace(/_/gu, ""))
    expect(keepRecent).toBeGreaterThanOrEqual(1)
    // At least two full 14_000-char trail slices (one run receipt each) must age out before a pass rewrites the prefix.
    expect(overChars).toBeGreaterThanOrEqual(2 * 14_000)
    const knob = source.match(/const EPOCH_TRAIL_CHARS = \(\(\) => \{\r?\n\s*const configured = Number\(process\.env\.ABDO_EPOCH_TRAIL_CHARS\)\r?\n\s*if \(Number\.isSafeInteger\(configured\) && configured >= ([\d_]+) && configured <= ([\d_]+)\) return configured\r?\n\s*return ([\d_]+)\r?\n\}\)\(\)/u)
    expect(knob).not.toBeNull()
    const [lower, upper, fallback] = [knob![1], knob![2], knob![3]].map((n) => Number(n!.replace(/_/gu, "")))
    expect(lower).toBe(20_000)
    expect(upper).toBe(400_000)
    expect(fallback).toBe(100_000)
    expect(source.match(/process\.env\.ABDO_EPOCH_TRAIL_CHARS/gu)).toHaveLength(1)
    // The loop accepts the shipped numbers; an empty run compacts nothing.
    const result = await runTextAgentLoop({
      input: "x", history: [], ask: async () => "تم", dispatch: async () => "", isCallable: () => false,
      readCompaction: { keepRecent: 4, overChars: 60_000 },
      trailCompaction: { keepRecent, overChars, trailChars: fallback },
    })
    expect(result.execCompactions).toBe(0)
    expect(result.readCompactions).toBe(0)
    expect(result.trailChars).toBe(1)
  })
})

// IDEA 10 — per-turn effective-token cap (plugins.turnBudget + ABDO_TURN_TOKEN_CAP). Each pin FAILS
// if the feature is unwired; the unit semantics live in turn-budget.test.
describe("turn budget wiring in the live cli path", () => {
  test("the meter is built once per turn, only when the toggle is on AND a cap is set; otherwise the hooks literal is byte-identical", () => {
    expect(source).toContain('const turnBudgetOn = plugins.read("turnBudget", "turn")')
    // 2026-09-13: السقفُ من الإعدادات (turnTokenCap؛ 0 = بلا سقف) ثمّ متغيّرِ البيئة ثمّ الافتراض 400k — كان 150k متغيّرَ بيئةٍ على جهاز المطوّر وحده.
    expect(source).toContain('const turnCap = turnBudgetOn ? (typeof turnCapSetting === "number" ? (turnCapSetting === 0 ? undefined : turnCapSetting) : (turnTokenCap() ?? DEFAULT_TURN_TOKEN_CAP)) : undefined')
    expect(source).toContain("const turnMeter = turnCap === undefined ? undefined : new TurnSpendMeter(turnCap)")
    expect(source).toContain("...(turnMeter === undefined ? {} : { turnMeter }),")
    expect(source.match(/new TurnSpendMeter\(/gu)).toHaveLength(1)
    expect(source).toContain("readonly turnMeter?: TurnSpendMeter")
    expect(source).toMatch(/import \{ DEFAULT_TURN_TOKEN_CAP, TURN_CAP_ENV, TurnSpendMeter, closeToDone, renderCap, renderTurnBudgetLine, turnTokenCap \} from "\.\/turn-budget"/u)
  })

  test("the global cloud cap is consulted first; the turn meter second, with the same estimate, and never raises it", () => {
    expect(source).toMatch(/cloudBudgetVerdict\(estimated \+ requestOutputCap\)[\s\S]{0,400}?hooks\.turnMeter\?\.verdict\(estimated \+ requestOutputCap\)/u)
    // Four cloud call sites (ask + gateAsk + memoryRankAsk + inferAsk), each with exactly one global-cap check followed by one turn-meter check.
    expect(source.match(/cloudBudgetVerdict\(/gu)).toHaveLength(4)
    expect(source.match(/hooks\.turnMeter\?\.verdict\(/gu)).toHaveLength(4)
    // The memory ranker refuses before transport when either cap says no, with the same estimate on both.
    expect(source).toContain("if (!prov.local && (!cloudBudgetVerdict(estimated+outputCap).allowed || hooks.turnMeter?.verdict(estimated+outputCap).allowed===false)) throw Error('memory-budget')")
    expect(source).toMatch(/cloudBudgetVerdict\(estimated \+ GATE_OUTPUT_TOKENS\)[\s\S]{0,400}?hooks\.turnMeter\?\.verdict\(estimated \+ GATE_OUTPUT_TOKENS\)/u)
    // Chat reports a refusal; Code retains its checkpoint-return semantics.
    // Both paths stop before transport and use the same already-computed cap.
    expect(source).toContain('if (turnBudget !== undefined && !turnBudget.allowed) {if(hooks.conversationMode===\'chat\')throw Error(turnBudget.message??\'Turn budget does not allow this request.\');return turnBudget.message ?? "سقف الدور رفض النداء"}')
  })

  test("the meter is charged from the same chargeableUsage result, outside the ledger try so a disk failure never hides spend", () => {
    // one charge per ledger writer (ask + gateAsk + memoryRankAsk + inferAsk) — never a charge without a ledger write or vice versa.
    expect(source.match(/hooks\.turnMeter\?\.charge\(charged\)/gu)).toHaveLength(4)
    expect(source).toContain("try{recordCloudUsage({provider:prov.id,model:selected.model,note:'memory.semantic',...charged})}catch{}")
    expect(source).toMatch(/note:'memory\.semantic',\.\.\.charged\}\)\}catch\{\}\r?\n\s+hooks\.turnMeter\?\.charge\(charged\)/u)
    expect(source).toMatch(/\} catch \(error\) \{\r?\n\s+ledgerNote = [^\r\n]*\r?\n\s+\}\r?\n(?:\s+\/\/[^\r\n]*\r?\n)*\s+hooks\.turnMeter\?\.charge\(charged\)/u)
    expect(source).toMatch(/note: "router\.gate", \.\.\.charged \}\)\r?\n\s+\} catch \{\r?\n(?:\s+\/\/[^\r\n]*\r?\n)*\s+\}\r?\n\s+hooks\.turnMeter\?\.charge\(charged\)/u)
  })

  test("the boundary gate runs before the epoch is counted and grants one host-evidenced grace via closeToDone + openSprintCount", () => {
    const gate = source.indexOf('turnMeter.gate(epoch) === "exhausted"')
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(source.search(/\bepochs = epoch\b/u))
    // TB-R2-03: the cli-level once-only guard is pinned literally — removing or reordering `!s.graceUsed` turns this red.
    expect(source).toContain("const graceDue = !s.graceUsed && closeToDone({ probePending, openSprints: openSprintCount(PROJECT_DIR), receipts: allReceipts.length })")
    expect(source).toContain("const granted = graceDue ? turnMeter.grantGrace(epoch) : 0")
    // TB-1 / TB-2 / TB-R2-01: a grace is announced only when it is non-zero AND actually reopens the gate for one
    // more call of the peak request; a zero grant (invalid cap) or a grace too small to admit a call is an honest stop.
    expect(source).toContain('if (granted > 0 && turnMeter.gate(epoch) === "open") {')
    expect(source.match(/turnMeter\.gate\(epoch\)/gu)).toHaveLength(2)
    expect(source.indexOf("🕰 سماحة سقف الدور (مرة واحدة")).toBeGreaterThan(source.indexOf('if (granted > 0 && turnMeter.gate(epoch) === "open") {'))
    expect(source.match(/🕰 سماحة سقف الدور/gu)).toHaveLength(1)
    // The boundary stop names the predictor in the pre-check unit and never prints a raw cap.
    expect(source).toContain("فعّال=${stop.spent}/${renderCap(stop.cap)} · أكبر طلب مقدَّر=${stop.peakRequest} · أكبر نداء=${stop.peakCall}${graceNote}")
    expect(source).toMatch(/import \{[^}]*\bopenSprintCount\b[^}]*\} from "\.\/project-sprint-plan-guard"/u)
  })

  test("TB-R2-02: every trail/answer line renders the cap through renderCap — the English literal 'invalid' never reaches Arabic text", () => {
    expect(source.match(/renderCap\(/gu)!.length).toBeGreaterThanOrEqual(4)
    expect(source).not.toMatch(/فعّال=\$\{[\w.]+\}\/\$\{[\w.]+\.cap\}/u)
    expect(source).toContain("فعّال=${s.spent}/${renderCap(s.cap)}")
    expect(source).toContain("فعّال=${turnSpend.spent}/${renderCap(turnSpend.cap)}")
    // The mid-epoch trip names the variable when the cap is malformed (the refusal string itself never enters the trail).
    expect(source).toContain('${s.cap === "invalid" ? ` — ${TURN_CAP_ENV} غير صالح؛ صحّح القيمة أو أزلها بقرار المالك` : ""}')
  })

  test("TB-3: a turn-cap refusal of the semantic-verifier ask hands back turn_budget with its own ⏱ line instead of blaming the model", () => {
    const verifierAsk = source.indexOf("const reply = await ask(buildVerifierPrompt(effectiveGoal, loop.answer, allReceipts), hooks, [], selectedModel)")
    const trip = source.indexOf("if (turnMeter !== undefined && turnMeter.snapshot().tripped) {")
    const unjudged = source.indexOf("⚠ غير محكّم دلالياً: النموذج لم ينتج حكماً صالحاً")
    expect(verifierAsk).toBeGreaterThan(0)
    expect(trip).toBeGreaterThan(verifierAsk)
    expect(trip).toBeLessThan(unjudged)
    // Abort still wins over the trip (an interrupted verifier is a checkpoint, not a budget stop).
    expect(trip).toBeGreaterThan(source.indexOf('if (hooks.signal?.aborted === true) {\r\n              lastStop = "acceptance-pending"'))
    expect(source).toContain("⏱ رُفض نداء المحكّم الدلالي بسقف الدور (${s.refusals}×): فعّال=${s.spent}/${renderCap(s.cap)}")
    expect(source.slice(trip, unjudged)).toContain('lastStop = "turn_budget"')
    expect(source.slice(trip, unjudged)).toMatch(/\bbreak\b/u)
  })

  test("the ⏱ line follows the 💳 line and the mid-epoch trip is handled before the prose warning and the stuck block", () => {
    const ledgerLine = source.indexOf("renderLedgerLine(cloudLedger)")
    const turnLine = source.indexOf("renderTurnBudgetLine(s, epoch)")
    const trip = source.indexOf("if (s.tripped) {")
    expect(turnLine).toBeGreaterThan(ledgerLine)
    expect(trip).toBeGreaterThan(turnLine)
    expect(trip).toBeLessThan(source.indexOf('if (stuckWall !== undefined && loop.stopReason === "complete")'))
    expect(trip).toBeLessThan(source.indexOf("⚠ رد النموذج بلا أداة"))
    // The 💳 consumer line itself is untouched.
    expect(source).toContain('if (cloudLedger !== "unknown" && cloudLedger.calls > 0) await emitEvent(turn.id, renderLedgerLine(cloudLedger))')
  })

  test("the stop vocabulary is turn_budget (reused from contracts RUN_STOP_REASONS), set at all five hand-back sites (boundary, mid-epoch, Super Abdo review, adversarial refute, verifier), with an honest final branch and a fact", async () => {
    // هـ٣ (2026-09-07): موضعٌ خامس — التفنيدُ العدائيّ ينفق ثلاثةَ نداءاتٍ فيُسلِّم الدورَ عند موضعه إن ترِبت الميزانية، وإلّا أنفق بعد القطع.
    expect(source.match(/lastStop = "turn_budget"/gu)).toHaveLength(5)
    expect(source).toMatch(/let lastStop: "complete" \| [^\n]*\| "stuck" \| "turn_budget" = "complete"/u)
    expect(source).toContain('lastStop === "turn_budget" && turnMeter !== undefined')
    expect(source.match(/key: `turn-budget:\$\{turn\.id\}`/gu)).toHaveLength(3)
    const contracts = await Bun.file(new URL("../../contracts/src/session.ts", import.meta.url)).text()
    expect(contracts).toMatch(/RUN_STOP_REASONS = \[[\s\S]*?"turn_budget",[\s\S]*?\] as const/u)
  })

  test("a refusal string returned by ask is prose to the loop (complete, zero commands) — which is why cli.ts consults tripped first", async () => {
    const result = await runTextAgentLoop({
      input: "x", history: [],
      ask: async () => "سقف الدور استُنفد: منفَق 9 + مقدَّر 9 > سقف الدور 9 — النداء مرفوض",
      dispatch: async () => "", isCallable: () => false,
    })
    expect(result.stopReason).toBe("complete")
    expect(result.commands).toEqual([])
  })
})
