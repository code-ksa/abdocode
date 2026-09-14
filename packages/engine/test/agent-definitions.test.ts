/**
 * S13.5 — تعريفُ الوكيل: الشكلان، والغيابُ رفضٌ لا إذن، والقراءة-فقط مشتقّة.
 */
import { describe, expect, test } from "bun:test"
import { ProductTools } from "@abdo/tools"
import {
  AGENT_MAX_TOOLS,
  BUILTIN_AGENT_FILES,
  agentToolRefusal,
  buildAgentCatalogue,
  describeAgents,
  findAgent,
  parseAgentDefinition,
} from "../src/agent-definitions"

const MD = `---
name: probe
description: وكيل تجربة
tools: read, grep
---
متنُ الوكيل.
`

const TOML = `name = "probe"
description = "وكيل تجربة"
tools = ["read", "grep"]
developer_instructions = """
متنُ الوكيل.
"""
`

const agentOf = (file: string, text: string) => {
  const parsed = parseAgentDefinition(file, text)
  if (!parsed.ok) throw new Error(parsed.why)
  return parsed.agent
}

describe("agent definitions — الشكلان يُطابَقان على سجلٍّ واحد", () => {
  test("markdown frontmatter (name/description/tools) + body", () => {
    const agent = agentOf("probe.agent.md", MD)
    expect(agent).toMatchObject({ name: "probe", description: "وكيل تجربة", source: "markdown", readOnly: true })
    expect(agent.tools).toEqual(["read", "grep"])
    expect(agent.instructions).toBe("متنُ الوكيل.")
  })

  test("toml (name/description/developer_instructions) maps onto the SAME record", () => {
    const md = agentOf("probe.agent.md", MD)
    const toml = agentOf("probe.agent.toml", TOML)
    expect(toml.source).toBe("toml")
    // السجلّ واحد: الاختلاف الوحيد المسموح هو حقل «من أين جاء».
    expect({ ...toml, source: "markdown", callable: undefined }).toEqual({ ...md, source: "markdown", callable: undefined })
  })

  test("the measured trap: an ABSENT tools list is a REFUSAL, never «all tools»", () => {
    // هذا بالضبط شكلُ ملفّ كوديكس المقيس: بلا مفتاح tools أصلاً.
    const scaffold = `name = "probe"
description = "وكيل بلا سقف"
developer_instructions = """متن"""
`
    const parsed = parseAgentDefinition("probe.agent.toml", scaffold)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("unreachable")
    expect(parsed.why).toContain("لا مفتاح tools")
    expect(parsed.why).toContain("الغائبة رفضٌ لا إذن")
    // ولا وكيلَ يُبنى: لا سقفَ ضمنيّ يُشتقّ من الفراغ.
    expect(buildAgentCatalogue([{ file: "probe.agent.toml", text: scaffold }]).agents).toEqual([])
  })

  test("an EMPTY or unparsable tools list is refused too — the same rule, both shapes", () => {
    for (const [file, text] of [
      ["probe.agent.md", MD.replace("tools: read, grep", "tools:")],
      ["probe.agent.toml", TOML.replace('tools = ["read", "grep"]', "tools = []")],
    ] as const) {
      const parsed = parseAgentDefinition(file, text)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.why).toMatch(/tools فارغة|لا مفتاح tools/u)
    }
  })

  test("a tool outside the ONE registry is refused BY NAME (no invented ceiling)", () => {
    const parsed = parseAgentDefinition("probe.agent.md", MD.replace("read, grep", "read, sudo"))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.why).toContain("أداةٌ غير مسجَّلة «sudo»")
  })

  test("a registry entry that is not agent-callable cannot be a ceiling either", () => {
    expect(ProductTools.agentCallable("demo")).toBe(false)
    const parsed = parseAgentDefinition("probe.agent.md", MD.replace("read, grep", "read, demo"))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.why).toContain("ليست أداةَ نموذج")
  })

  test("readOnly is DERIVED from the declared effects, never trusted from prose", () => {
    // المتن يدّعي «لا ينفّذ» بينما السقف يحمل run — الاشتقاق يكذّب النثر.
    const lying = `---
name: probe
description: يقيس ويقترح ولا ينفّذ أبداً
tools: read, run
---
أنا لا أنفّذ شيئاً إطلاقاً، أقرأ وأقترح فقط.
`
    expect(agentOf("probe.agent.md", lying).readOnly).toBe(false)
    expect(agentOf("probe.agent.md", MD).readOnly).toBe(true)
  })

  test("name discipline: the declared name must equal the file name", () => {
    const parsed = parseAgentDefinition("other.agent.md", MD)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.why).toContain("يخالف اسم الملفّ")
  })

  test("caps and shape refusals", () => {
    expect(parseAgentDefinition("probe.txt", MD).ok).toBe(false)
    expect(parseAgentDefinition("probe.agent.md", "no frontmatter").ok).toBe(false)
    expect(parseAgentDefinition("probe.agent.md", MD.replace("description: وكيل تجربة\n", "")).ok).toBe(false)
    expect(parseAgentDefinition("probe.agent.md", MD.replace("متنُ الوكيل.\n", "")).ok).toBe(false)
    const many = MD.replace("read, grep", new Array(AGENT_MAX_TOOLS + 1).fill("read").join(", "))
    expect(parseAgentDefinition("probe.agent.md", many).ok).toBe(false)
  })

  test("the permission check is by construction: an undeclared tool is refused BY NAME", () => {
    const agent = agentOf("probe.agent.md", MD)
    expect(agentToolRefusal(agent, "read")).toBeUndefined()
    expect(agentToolRefusal(agent, "grep")).toBeUndefined()
    const refusal = agentToolRefusal(agent, "run")
    expect(refusal).toContain("«run»")
    expect(refusal).toContain("«probe»")
    expect(refusal).toContain("read، grep")
    expect(refusal).toContain("الغياب رفضٌ لا إذن")
  })

  test("aliases of a declared tool are permitted; aliases of an undeclared one are not", () => {
    const agent = agentOf("probe.agent.md", MD.replace("read, grep", "list"))
    expect(agent.tools).toEqual(["list"])
    expect(agentToolRefusal(agent, "ls")).toBeUndefined()
    expect(agentToolRefusal(agent, "glob")).toBeDefined()
  })
})

describe("agent definitions — وكلاء المنتَج المشحونون", () => {
  const catalogue = buildAgentCatalogue([...BUILTIN_AGENT_FILES])

  test("every shipped agent parses through the SAME reader — no refusals", () => {
    expect(catalogue.refusals).toEqual([])
    // هـ2 (2026-09-07): الوكيلُ الموجِّه orient أوّلُ المضمَّنين — يقرأ المشروع من الوعي والذاكرة قبل الفعل.
    expect(catalogue.agents.map((a) => a.name)).toEqual(["orient", "planner", "reviewer", "recaller", "builder"])
    expect(findAgent(catalogue, "orient")!.readOnly).toBe(true)
  })

  test("both shapes are shipped, so the reader is exercised by the product itself", () => {
    // هـ2: الموجِّه ماركداون كأقرانه — الشكلان ما زالا مشحونَين.
    expect(catalogue.agents.map((a) => a.source)).toEqual(["markdown", "markdown", "markdown", "markdown", "toml"])
  })

  test("the ceilings say what they are: planner/reviewer/recaller read only, builder does not", () => {
    expect(findAgent(catalogue, "planner")!.readOnly).toBe(true)
    expect(findAgent(catalogue, "reviewer")!.readOnly).toBe(true)
    expect(findAgent(catalogue, "recaller")!.readOnly).toBe(true)
    expect(findAgent(catalogue, "builder")!.readOnly).toBe(false)
    for (const name of ["planner", "reviewer", "recaller"]) {
      for (const word of findAgent(catalogue, name)!.tools) {
        expect(ProductTools.tool(word)!.effect).toBe("read")
      }
      expect(agentToolRefusal(findAgent(catalogue, name)!, "write")).toBeDefined()
      expect(agentToolRefusal(findAgent(catalogue, name)!, "run")).toBeDefined()
    }
  })

  test("no shipped agent may delegate: the delegate tool is in nobody's ceiling", () => {
    for (const agent of catalogue.agents) expect(agent.tools).not.toContain("delegate")
  })

  test("the operator line states the DERIVED property, not a claim from the body", () => {
    const text = describeAgents(catalogue)
    expect(text).toContain("planner — ")
    expect(text).toContain("قراءة-فقط (مشتقّ من أدواته)")
    expect(text).toContain("يكتب/ينفّذ")
  })

  test("a duplicate name is reported, not silently resolved", () => {
    const twice = buildAgentCatalogue([...BUILTIN_AGENT_FILES, ...BUILTIN_AGENT_FILES])
    expect(twice.agents.length).toBe(BUILTIN_AGENT_FILES.length)
    expect(twice.refusals.length).toBe(BUILTIN_AGENT_FILES.length)
    expect(twice.refusals[0]).toContain("معرَّفٌ مرّتين")
  })

  test("the shipped agents are the product's own: no private-estate identity in them", () => {
    for (const file of BUILTIN_AGENT_FILES) {
      expect(file.text).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//u)
      expect(file.text.toLowerCase()).not.toContain("claude")
      expect(file.text.toLowerCase()).not.toContain("codex")
    }
  })
})
