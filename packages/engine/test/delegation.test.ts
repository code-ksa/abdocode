/**
 * S13.5 — الحلقةُ المتداخلة: ما يملكه الطفل وما يشاركه الأب.
 *
 * كلُّ برهانٍ هنا يمرّ من **الحلقة النصّيّة الحقيقيّة** (`runTextAgentLoop`)
 * لا من محاكٍ لها: نموذجٌ مكتوبٌ بيدٍ (`ask` مبرمَجة) ومُوزِّعٌ يعدّ نداءاته.
 * لم يُشغَّل نموذجٌ حيّ في أيٍّ منها.
 */
import { describe, expect, test } from "bun:test"
import { runTextAgentLoop, type NativeAgentCall, type TextAgentMessage } from "@abdo/engine-host"
import { BUILTIN_AGENT_FILES, buildAgentCatalogue, findAgent, type AgentDefinition } from "../src/agent-definitions"
import {
  CHILD_MAX_EPOCHS,
  DELEGATE_TOOL,
  MAX_DELEGATION_DEPTH,
  childToolRefusal,
  parseDelegateCommand,
  renderDelegateReport,
  runDelegatedAgent,
  REPORT_MAX_CHARS,
  type DelegateReport,
} from "../src/delegation"
import { TurnSpendMeter } from "../src/turn-budget"

const CATALOGUE = buildAgentCatalogue([...BUILTIN_AGENT_FILES])
const reviewer = findAgent(CATALOGUE, "reviewer")!
const builder = findAgent(CATALOGUE, "builder")!

interface Harness {
  readonly dispatched: string[]
  readonly prompts: string[]
  readonly allowlists: (readonly string[])[]
  run(agent: AgentDefinition, replies: readonly string[], extra?: Partial<Parameters<typeof runDelegatedAgent>[0]>): Promise<DelegateReport>
}

const harness = (): Harness => {
  const dispatched: string[] = []
  const prompts: string[] = []
  const allowlists: (readonly string[])[] = []
  return {
    dispatched,
    prompts,
    allowlists,
    run: (agent, replies, extra = {}) => {
      const queue = [...replies]
      return runDelegatedAgent({
        agent,
        task: "افحص src/a.ts",
        depth: 1,
        ask: async (prompt, _history: readonly TextAgentMessage[], allowlist) => {
          prompts.push(prompt)
          allowlists.push(allowlist)
          return queue.shift() ?? "تم"
        },
        dispatch: async (command: string, _native?: NativeAgentCall) => {
          dispatched.push(command)
          return `⚙ ${command}\nنتيجة`
        },
        runLoop: runTextAgentLoop,
        maxRounds: 4,
        ...extra,
      })
    },
  }
}

describe("delegation — سقفُ الوكيل بالبناء", () => {
  test("restriction proof: a tool outside the ceiling is refused BY NAME and NOTHING is dispatched", async () => {
    const h = harness()
    // reviewer سقفُه قراءة؛ `run` خارجَه.
    const report = await h.run(reviewer, ["نفّذ: run npm test", "نفّذ: read src/a.ts", "تم"])
    expect(h.dispatched).toEqual(["read src/a.ts"])
    expect(h.dispatched).not.toContain("run npm test")
    expect(report.commands).toEqual(["read src/a.ts"])
    // الحلقةُ ترفض الاسم قبل التوزيع (`isCallable`)، فلا نداءَ يخرج أصلاً.
    expect(report.refusals).toEqual([])
    // وحارسُ التوزيع نفسُه يرفض بالاسم لو وصلته الكلمة من طريقٍ آخر.
    const guard = childToolRefusal(reviewer, "run", 1)
    expect(guard).toContain("«run»")
    expect(guard).toContain("«reviewer»")
  })

  test("the guard names the tool and the agent for every effectful class", () => {
    for (const word of ["run", "write", "edit", "patch", "fetch", "packages"]) {
      expect(childToolRefusal(reviewer, word, 1)).toContain(`«${word}»`)
    }
    for (const word of reviewer.tools) expect(childToolRefusal(reviewer, word, 1)).toBeUndefined()
  })

  test("depth cap: a child may not delegate further — refused by name, at depth 1", () => {
    expect(MAX_DELEGATION_DEPTH).toBe(1)
    const refusal = childToolRefusal(builder, DELEGATE_TOOL, 1)
    expect(refusal).toContain(`«${DELEGATE_TOOL}»`)
    expect(refusal).toContain("لا يفوّض")
  })

  test("depth cap holds even if an agent file DECLARED delegate in its ceiling", async () => {
    const rogue: AgentDefinition = { ...builder, tools: [...builder.tools, DELEGATE_TOOL], callable: new Set([...builder.callable, DELEGATE_TOOL]) }
    expect(childToolRefusal(rogue, DELEGATE_TOOL, 1)).toContain("لا يفوّض")
    const h = harness()
    const report = await h.run(rogue, ["نفّذ: delegate planner :: خطّط", "تم"])
    expect(h.dispatched).toEqual([])
    expect(report.commands).toEqual([])
  })

  test("the advertised ceiling handed to the model equals the declared one", async () => {
    const h = harness()
    await h.run(reviewer, ["تم"])
    expect(h.allowlists.length).toBeGreaterThan(0)
    for (const list of h.allowlists) expect(list).toEqual(reviewer.tools)
    // ومدخلُ الحقبة الأولى يقول السقف نصّاً أيضاً — للنموذج، لا بدلاً من الحارس.
    expect(h.prompts[0]).toContain(reviewer.tools.join("، "))
    expect(h.prompts[0]).toContain("سقفُك قراءةٌ فقط")
    expect(h.prompts[0]).toContain("لا تفوّض إلى وكيلٍ آخر")
  })
})

describe("delegation — ما يشاركه الطفل الأبَ", () => {
  test("budget proof: the child CANNOT spend past the parent turn cap (measured)", async () => {
    // عدّادُ الأب نفسه، بسقفٍ صغير: كلُّ نداءٍ يقدَّر ويُشحن 400.
    const CAP = 1000
    const CALL = 400
    const meter = new TurnSpendMeter(CAP, 0, String(CAP))
    let refusedCalls = 0
    let n = 0
    const h = harness()
    // نداءٌ يحاكي `ask` الحقيقيّة: يسأل العدّاد قبل النداء ثمّ يشحنه بعده.
    const ask = async (): Promise<string> => {
      if (!meter.verdict(CALL).allowed) { refusedCalls += 1; return "توقفتُ: سقف الدور" }
      meter.charge({ inputTokens: CALL, outputTokens: 0 })
      n += 1
      return `نفّذ: read src/a${n}.ts`
    }
    const report = await runDelegatedAgent({
      agent: reviewer,
      task: "افحص",
      depth: 1,
      ask,
      dispatch: async (command) => { h.dispatched.push(command); return `⚙ ${command}` },
      runLoop: runTextAgentLoop,
      meter,
      maxRounds: 1,
      maxEpochs: 8,
    })
    const snapshot = meter.snapshot()
    // المقيس: أُنفق 800 من سقف 1000، ولم يُرفض نداءٌ لأن بوّابة الحقبة أوقفته
    // قبل أن يحاول — العدّاد لم يُخرَق ولم يُوسَّع.
    expect(snapshot.spent).toBe(800)
    expect(snapshot.spent).toBeLessThanOrEqual(CAP)
    expect(snapshot.calls).toBe(2)
    expect(snapshot.tripped).toBe(false)
    expect(refusedCalls).toBe(0)
    // ولا سماحةَ أنفقها الفرع: السماحةُ واحدةٌ لكلّ دور وهي قرارُ الأب.
    expect(snapshot.graceUsed).toBe(false)
    // ولولا العدّاد لدارت ثماني حِقب: هو الذي أوقفها، لا سقفُ الحِقب.
    expect(report.stop).toBe("budget")
    expect(report.epochs).toBeLessThan(8)
  })

  test("a child with no meter behaves exactly as before: the epoch cap alone stops it", async () => {
    const h = harness()
    const report = await h.run(reviewer, ["نفّذ: read a.ts", "نفّذ: read b.ts", "نفّذ: read c.ts", "نفّذ: read d.ts"], { maxRounds: 1, maxEpochs: 2 })
    expect(report.stop).toBe("epoch-limit")
    expect(report.epochs).toBe(2)
  })

  test("approval and mode are the PARENT's: the child re-uses the one dispatcher and cannot widen either", async () => {
    // بوّابةٌ مشتركةٌ يملكها الأب — الطفل يمرّ بها ولا يملك مفتاحها.
    const shared = { mode: "read-only" as string, approvals: 0 }
    const h = harness()
    const report = await runDelegatedAgent({
      agent: builder,
      task: "اكتب",
      depth: 1,
      ask: async () => "نفّذ: run npm test",
      dispatch: async (command) => {
        shared.approvals += 1
        return {
          output: `رُفض ${command} — نمط ${shared.mode} يحتاج موافقةً لم تُمنح.`,
          verdict: { ok: false as const, reason: "policy_denied" as const, denied: true, detail: "denied" },
        }
      },
      runLoop: runTextAgentLoop,
      maxRounds: 1,
      maxEpochs: 1,
    })
    expect(shared.approvals).toBe(1)
    // النمط لم يتغيّر: لا سبيل في هذه الوحدة إلى كتابته أصلاً.
    expect(shared.mode).toBe("read-only")
    expect(report.commands).toEqual(["run npm test"])
  })

  test("a child that keeps repeating one call stops as «duplicate», not as «done»", async () => {
    const h = harness()
    // الأولى تُنفَّذ، والثانية تُعاد من ذاكرة القراءة مرّةً واحدة، والثالثة توقّف.
    const report = await h.run(reviewer, ["نفّذ: read a.ts", "نفّذ: read a.ts", "نفّذ: read a.ts"])
    // طيُّ الدوران إلى «أنهى» يقلب فشلاً إلى نجاحٍ في التقرير الذي يبني عليه الأب.
    expect(report.stop).toBe("duplicate")
    expect(h.dispatched).toEqual(["read a.ts"])
  })

  test("no second policy exists here: the module names no gate, mode or price", async () => {
    const source = await Bun.file(new URL("../src/delegation.ts", import.meta.url)).text()
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "")
    for (const word of ["currentMode", "approvalAskedLine", "recordCloudUsage", "cloudBudgetVerdict", "Shell.decide", "railProfile"]) {
      expect(code).not.toContain(word)
    }
    // ولا شحنَ للعدّاد من هنا: الطفل يسأل ولا يحاسب.
    expect(code).not.toContain(".charge(")
    expect(code).not.toContain("grantGrace")
  })
})

describe("delegation — المدخل والتقرير", () => {
  test("the command parse names its refusals", () => {
    expect(parseDelegateCommand("reviewer :: افحص a.ts")).toEqual({ agent: "reviewer", task: "افحص a.ts" })
    expect(parseDelegateCommand("")).toContain("الصيغة")
    expect(parseDelegateCommand("reviewer افحص")).toContain("الصيغة")
    expect(parseDelegateCommand(" :: افحص")).toContain("الصيغة")
    expect(parseDelegateCommand("reviewer ::   ")).toContain("مهمّةً")
  })

  test("the report is bounded and structured: the parent can act on it", async () => {
    const h = harness()
    const report = await h.run(reviewer, ["نفّذ: read src/a.ts", "لا عيب ظاهر"])
    expect(report).toMatchObject({ agent: "reviewer", readOnly: true, stop: "complete" })
    const text = renderDelegateReport(report)
    expect(text).toContain("🤝 تقرير الوكيل «reviewer»")
    expect(text).toContain("قراءة-فقط (مشتقٌّ من أدواته المعلَنة)")
    expect(text).toContain("read src/a.ts")
    // الجواب الخاتم كما ترفعه الحلقة (يحمل إيصاله معه) — يُنقل ولا يُعاد صوغه.
    expect(text).toContain("الخلاصة: ")
    expect(text).toContain("لا عيب ظاهر")
  })

  test("the answer is capped, so a chatty child cannot flood the parent window", async () => {
    const h = harness()
    const report = await h.run(reviewer, ["ب".repeat(REPORT_MAX_CHARS * 3)])
    expect(report.answer.length).toBe(REPORT_MAX_CHARS)
  })

  test("a refused tool shows up in the report as a named refusal, not as silence", async () => {
    const report = await runDelegatedAgent({
      agent: reviewer,
      task: "افحص",
      depth: 1,
      ask: async () => "نفّذ: read a.ts",
      // الحلقةُ لا تُخرِج «run» لأن `isCallable` ترفضه؛ نستدعي الحارس مباشرةً
      // لنثبت أن نصَّ الرفض هو نفسه الذي يركب التقرير.
      dispatch: async () => "ok",
      runLoop: async (options) => {
        const refusal = await options.dispatch("run npm test")
        expect(typeof refusal === "string" ? refusal : refusal.output).toContain("لا يعلنها في سقفه")
        return {
          answer: "انتهى",
          memory: [{ role: "user", content: "" }, { role: "assistant", content: "" }] as const,
          continuation: [],
          commands: [],
          stopReason: "complete" as const,
          readCompactions: 0,
          execCompactions: 0,
          writeCompactions: 0,
          trailChars: 0,
        }
      },
      maxEpochs: 1,
    })
    expect(report.refusals.length).toBe(1)
    expect(renderDelegateReport(report)).toContain("⛔")
  })

  test("the child's own epoch counter and awareness are its own", async () => {
    const seen: number[] = []
    const h = harness()
    const report = await h.run(reviewer, ["نفّذ: read a.ts", "نفّذ: read b.ts", "نفّذ: read c.ts"], {
      maxRounds: 1,
      onEpoch: (epoch) => seen.push(epoch),
    })
    // حقبةٌ لكلّ جولةِ أدواتٍ مستنفَدة — عدّادٌ يخصّ الطفل وحده، مقيسٌ من الخطّاف.
    expect(seen).toEqual([1, 2])
    expect(report.epochs).toBe(2)
    expect(CHILD_MAX_EPOCHS).toBe(3)
  })
})
