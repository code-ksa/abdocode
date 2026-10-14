import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Providers } from "@abdo/providers"

// 10-14 — بلاغان: اختيارُ مجلّدٍ آخر في جلسةٍ جديدة كان يُبقي المحرّكَ على المشروع السابق، ومفتاحٌ كُتب تحت «anthropic» في نموذج
// المزوّد المخصّص لم يُحفظ؛ ونماذجُ أنثروبيك وأوبن إيه آي وجوجل (Gemini 4 Argon نزل 10-13) كلُّها حتى اليوم.

const ROOT = resolve(import.meta.dir, "..", "..")
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/gu, "\n")

describe("اختيارُ مجلّدٍ آخر يفتحه في المحرّك", () => {
  const shell = read("desktop", "ui", "native-shell.js")
  test("«إضافة مشروع» بمجلّدٍ موجود في القائمة يفتحه، والجديدُ يُفتح بعد حفظه — كان يُحفظ في القائمة فقط", () => {
    expect(shell).toContain("if(existing){await openProject(existing);projectDialog(existing);return;}")
    expect(shell).toContain("await safeSave();if(isNew)await openProject(next);else if(rootProject()===next.path)")
  })
  test("openProject هو ما يرسل project-set — البابُ نفسُه لكلّ فتح", () => {
    expect(shell).toContain("await bridge.send({kind:'project-set',path:p.path});")
  })
})

describe("نماذجُ المزوّدين حتى اليوم", () => {
  const find = (id: string) => Providers.PROVIDERS.find((p) => p.id === id)!
  test("أنثروبيك: عائلةُ Claude 5 (Opus 5.5، Sonnet 5، Fable 5.1) وHaiku 4.5، والقائمةُ الحيّة بالمفتاح", () => {
    const anthropic = find("anthropic")
    for (const model of ["claude-opus-5-5", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5"]) expect(anthropic.models).toContain(model)
    expect(anthropic.discoverModels).toBe(true)
    // مقيس حيّاً بمفتاحٍ حقيقيّ 10-14: القائمةُ الحيّة أعلنت 16 نموذجاً منها sonnet-5-5 وhaiku-5-5 — في البذرة كي تظهر بلا شبكة
    for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5"]) expect(anthropic.models).toContain(model)
  })
  test("القائمةُ الحيّة تنزع بادئةَ جوجل «models/» — الدردشةُ تريد «gemini-…»", () => {
    expect(read("engine", "src", "cli.ts")).toContain('.map((row) => (typeof row.id === "string" ? row.id.trim().replace(/^models\\//u, "") : ""))')
  })
  test("جوجل: Gemini 4 Argon ونماذجُ Flash الحاليّة، والقائمةُ الحيّة", () => {
    const google = find("google")
    for (const model of ["gemini-4-argon", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"]) expect(google.models).toContain(model)
    expect(google.discoverModels).toBe(true)
  })
  test("أوبن إيه آي: GPT-6.1 Sol أوّلاً، والقائمةُ الحيّة", () => {
    const openai = find("openai")
    expect(openai.models[0]).toBe("gpt-6.1-sol")
    expect(openai.discoverModels).toBe(true)
  })
  test("عاملُ رست يقرأ قائمةَ أنثروبيك بترويستها (x-api-key وanthropic-version) لا بـBearer", () => {
    const worker = read("kernel", "bins", "abdo-tool-worker", "src", "provider.rs")
    const runGet = worker.slice(worker.indexOf("fn run_get("))
    expect(runGet).toContain('CredentialKind::ApiKey => b"x-api-key: ".as_slice(),')
    expect(runGet).toContain('config.extend_from_slice(b"header = \\"anthropic-version: 2023-06-01\\"\\n");')
  })
})

describe("اسمُ مزوّدٍ مدمج في نموذج المزوّد المخصّص يحفظ مفتاحَه في المزوّد المدمج", () => {
  test("القشرة: «anthropic» تحت ⇦ مفتاحُ abdocode-anthropic في الخزنة وفحصُ الاتصال — لا مزوّدٌ مخصّص مكسور", () => {
    const shell = read("desktop", "ui", "native-shell.js")
    expect(shell).toContain("const builtin=(bridge.providers.PROVIDERS||[]).find(p=>p.id===id&&p.vaultKey);if(builtin){")
    expect(shell).toContain("await bridge.invoke('vault_set',{key:builtin.vaultKey,value:key});")
    expect(shell).toContain("bridge.send({kind:'provider-probe',provider:builtin.id,auto:true})")
    expect(Providers.PROVIDERS.find((p) => p.id === "anthropic")!.vaultKey).toBe("abdocode-anthropic")
  })
  test("المحرّك يرفض مزوّداً مخصّصاً باسم مزوّدٍ مدمج", () => {
    const cli = read("engine", "src", "cli.ts")
    expect(cli).toContain("if (Providers.PROVIDERS.some((p) => p.id === c.id)) return `customProviders: «${c.id}» مزوّدٌ مدمج")
  })
})
