import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SqliteFactStore } from "@abdo/memory"
import {
  buildImportReview, importTitle, itemsFromMarkdown, itemsFromPaste, readExport, readLocalSources, readPasted,
  redactImportText, saveImportedItems, scanLocalAgentFiles, unwrapChatGptContext,
} from "../src/memory-import"
import { USER_MEMORY_PROJECT, userOwnerNotes } from "../src/owner-memory"
import { factsForAutomaticRecall } from "../src/turn-memory"
import { SemanticMemory } from "../src/semantic-memory"

// استيرادُ الذاكرة والتخصيصات (10-10): القرّاءُ حتميّون على ملفّاتٍ مثبّتة، والحجبُ يعضّ وتوأمُه لا يمسّ النصَّ العاديّ،
// والحفظُ يكتب في المالك القائم (ملاحظات المالك) وحده، والبندُ المستورد يبلغ موضعَ الحقن نفسَه ([PROJECT_MEMORY]).

const FAKE_KEY = "sk-live-ZZTESTKEY9911223344556677"
const base = mkdtempSync(join(tmpdir(), "abdo-memimport-"))
afterAll(() => { for (let i = 0; i < 10; i += 1) { try { rmSync(base, { recursive: true, force: true }); break } catch { Bun.sleepSync(100) } } })
const write = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text) }

/** zip «مخزَّن» (بلا ضغط) يكفي لقارئ الدليل المركزيّ — CRC صفرٌ لا يفحصه القارئ. */
const storedZip = (files: Record<string, string>): Uint8Array => {
  const enc = new TextEncoder(), locals: Uint8Array[] = [], centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const n = enc.encode(name), data = enc.encode(text)
    const local = new Uint8Array(30 + n.length + data.length), lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, n.length, true)
    local.set(n, 30); local.set(data, 30 + n.length)
    const central = new Uint8Array(46 + n.length), cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, n.length, true); cv.setUint32(42, offset, true)
    central.set(n, 46)
    locals.push(local); centrals.push(central); offset += local.length
  }
  const centralSize = centrals.reduce((s, c) => s + c.length, 0)
  const end = new Uint8Array(22), ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, centrals.length, true); ev.setUint16(10, centrals.length, true); ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + centralSize + 22)
  let at = 0
  for (const part of [...locals, ...centrals, end]) { out.set(part, at); at += part.length }
  return out
}

const chatgptConversations = JSON.stringify([
  { title: "a", mapping: {
    n1: { message: { author: { role: "system" }, create_time: 1700000000, content: { content_type: "user_editable_context",
      user_profile: "The user provided the following information about themselves. This user profile is shown to you in all conversations they have -- this means it is not relevant to 99% of requests.\nUser profile:\n```Old profile text that was replaced```",
      user_instructions: "The user provided the additional info about how they would like you to respond:\n```- Answer in Arabic\n- Keep answers short```" } } },
    n2: { message: { author: { role: "assistant" }, recipient: "bio", create_time: 1700000100, content: { content_type: "text", parts: ["User is building a Saudi e-commerce app with Next.js."] } } },
    n3: { message: { author: { role: "tool", name: "bio" }, content: { content_type: "text", parts: ["Model set context updated."] } } },
  } },
  { title: "b", mapping: {
    m1: { message: { author: { role: "system" }, create_time: 1720000000, content: { content_type: "user_editable_context",
      user_profile: "The user provided the following information about themselves.\nUser profile:\n```I am a full-stack developer in Riyadh.\nI prefer PostgreSQL over MySQL.```" } } },
    m2: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["hello"] } } },
  } },
])

describe("local agent files", () => {
  const home = join(base, "home"), roots = join(base, "projects"), app = join(roots, "shop")
  write(join(home, ".claude", "CLAUDE.md"), "# Global\n- Never add Co-Authored-By lines to commits\n")
  write(join(home, ".claude", "projects", "C--shop", "memory", "MEMORY.md"), "# Memory Index\n- [Commit style](commit-style.md) — short messages\n")
  write(join(home, ".claude", "projects", "C--shop", "memory", "commit-style.md"), "---\nname: commit-style\ndescription: Commit messages are short and in Arabic\ntype: feedback\n---\n\nThe owner wants one-line commit messages.\n\n**Why:** long messages were noise.\n")
  write(join(home, ".codex", "AGENTS.md"), "## Style\n- Prefer tabs over spaces in Go files\n\n```bash\nrm -rf /\n```\n| Rule | Value |\n|---|---|\n| language | Arabic |\n")
  write(join(app, "AGENTS.md"), "# Shop\nUse Bun for every script in this repo.\n")
  write(join(app, ".cursorrules"), "Always use server components first.\n")
  write(join(app, ".github", "copilot-instructions.md"), "- Write tests with bun:test\n")
  write(join(app, ".clinerules", "style.md"), "- Use logical CSS properties for RTL\n")
  write(join(roots, "node_modules", "AGENTS.md"), "- must never be scanned\n")

  test("the scan lists every agent's files by path and size, from home and project roots, without node_modules", () => {
    const sources = scanLocalAgentFiles({ home, projectRoots: [roots] })
    const agents = (agent: string) => sources.filter((s) => s.agent === agent).map((s) => s.path.replaceAll("\\", "/"))
    expect(agents("claude-code").some((p) => p.endsWith(".claude/CLAUDE.md"))).toBe(true)
    expect(agents("claude-code").some((p) => p.endsWith("memory/MEMORY.md"))).toBe(true)
    expect(agents("claude-code").some((p) => p.endsWith("memory/commit-style.md"))).toBe(true)
    expect(agents("codex").some((p) => p.endsWith(".codex/AGENTS.md"))).toBe(true)
    expect(agents("codex").some((p) => p.endsWith("shop/AGENTS.md"))).toBe(true)
    expect(agents("cursor")).toHaveLength(1)
    expect(agents("copilot")).toHaveLength(1)
    expect(agents("cline")).toHaveLength(1)
    expect(sources.every((s) => s.bytes > 0)).toBe(true)
    expect(sources.some((s) => s.path.includes("node_modules"))).toBe(false)
  })

  test("Claude Code memory and AGENTS.md become items; code fences are skipped; a path outside the scan is refused", () => {
    const scan = scanLocalAgentFiles({ home, projectRoots: [roots] })
    const pick = scan.filter((s) => /commit-style|\.codex/u.test(s.path)).map((s) => s.path)
    const outside = join(base, "secret.txt"); writeFileSync(outside, "- my private diary line\n")
    const { raw, found } = readLocalSources([...pick, outside], scan, home)
    const texts = raw.map((r) => r.text)
    expect(texts).toContain("Commit messages are short and in Arabic")
    expect(texts).toContain("The owner wants one-line commit messages.")
    expect(texts).toContain("Style: Prefer tabs over spaces in Go files")
    expect(texts).toContain("Style: language — Arabic")
    expect(texts.join("\n")).not.toContain("rm -rf")
    expect(texts.join("\n")).not.toContain("private diary")
    expect(found.some((line) => line.includes("ليس من نتيجة الفحص"))).toBe(true)
    expect(raw.find((r) => r.text.startsWith("Commit messages"))!.origin).toBe("~/.claude/projects/C--shop/memory/commit-style.md")
  })
})

describe("export files", () => {
  test("ChatGPT export: the newest custom instructions and the bio memories are read, user.json is not imported — folder and zip alike", () => {
    const dir = join(base, "chatgpt-export")
    write(join(dir, "conversations.json"), chatgptConversations)
    write(join(dir, "user.json"), JSON.stringify({ email: "me@example.com", phone_number: "+966500000000" }))
    const zip = join(base, "chatgpt-export.zip")
    writeFileSync(zip, storedZip({ "conversations.json": chatgptConversations, "user.json": "{}" }))
    for (const path of [dir, zip]) {
      const { raw, found } = readExport(path, "chatgpt")
      const texts = raw.map((r) => r.text)
      expect(texts).toContain("I am a full-stack developer in Riyadh. I prefer PostgreSQL over MySQL.")
      expect(texts.join("\n")).not.toContain("Old profile text")
      expect(texts).toContain("Answer in Arabic")
      expect(texts).toContain("Keep answers short")
      expect(texts).toContain("User is building a Saudi e-commerce app with Next.js.")
      expect(texts.join("\n")).not.toContain("Model set context updated")
      expect(texts.join("\n")).not.toContain("+966500000000")
      expect(found.some((line) => line.includes("user.json") && line.includes("لم يُستورد"))).toBe(true)
      expect(found.some((line) => line.includes("نسخ، أُخذت الأحدث"))).toBe(true)
    }
    expect(unwrapChatGptContext("prefix\n```inner text```")).toBe("inner text")
  })

  test("ChatGPT export without custom instructions says so instead of inventing them", () => {
    const dir = join(base, "chatgpt-empty")
    write(join(dir, "conversations.json"), JSON.stringify([{ mapping: {} }]))
    const { raw, found } = readExport(dir, "chatgpt")
    expect(raw).toHaveLength(0)
    expect(found.some((line) => line.includes("user_profile") && line.includes("غير موجود"))).toBe(true)
  })

  test("Claude export: project instructions and memories; Gemini Takeout: only 'remember' prompts, and missing Saved info is named", () => {
    const claude = join(base, "claude-export")
    write(join(claude, "projects.json"), JSON.stringify([{ uuid: "p1", name: "Shop", prompt_template: "- Reply in Arabic\n- Use Tailwind 4" }, { uuid: "p2", name: "Empty", prompt_template: "" }]))
    write(join(claude, "memories.json"), JSON.stringify([{ conversations_memory: "- Works as a solo founder\n- Prefers concise code reviews", project_memories: { p1: "- The shop sells perfume" } }]))
    const c = readExport(claude, "claude")
    expect(c.raw.map((r) => r.text)).toEqual(expect.arrayContaining(["[Shop] Reply in Arabic", "[Shop] Use Tailwind 4", "Works as a solo founder", "Prefers concise code reviews", "[Shop] The shop sells perfume"]))
    const gemini = join(base, "Takeout", "My Activity", "Gemini Apps")
    write(join(gemini, "MyActivity.json"), JSON.stringify([{ header: "Gemini Apps", title: "Prompted Remember that I prefer dark mode in every app" }, { header: "Gemini Apps", title: "Prompted what is the weather" }, { header: "Gemini Apps", title: "Prompted تذكر أنني أعمل في الرياض" }]))
    const g = readExport(join(base, "Takeout"), "gemini")
    expect(g.raw.map((r) => r.text)).toEqual(["I prefer dark mode in every app", "أنني أعمل في الرياض"])
    expect(g.found.some((line) => line.includes("Saved info") && line.includes("غير موجودة"))).toBe(true)
  })
})

describe("paste, redaction and review", () => {
  test("a pasted assistant answer becomes one item per line, intros dropped and label lines kept as context", () => {
    const items = itemsFromPaste("Sure! Here's what I remember about you:\n\n**Work:**\n- Full-stack developer\n- Uses Bun\n\nبالتأكيد، إليك ما أتذكّره\n• يفضّل الردود القصيرة\n")
    expect(items).toEqual(["Work: Full-stack developer", "Work: Uses Bun", "Work: يفضّل الردود القصيرة"])
    expect(readPasted("- one fact here", "claude").raw[0]).toEqual({ text: "one fact here", agent: "claude", origin: "لصق من Claude" })
  })

  test("a fake key is masked — and the twin: ordinary text passes byte-for-byte", () => {
    const masked = redactImportText(`My OpenAI key is ${FAKE_KEY} and password=hunter2hunter2`, false)
    expect(masked.text).not.toContain(FAKE_KEY)
    expect(masked.text).not.toContain("hunter2hunter2")
    expect(masked.redactions).toBeGreaterThan(0)
    expect(masked.blocked).toBe(false)
    const plain = "أفضّل الردود القصيرة بالعربية، وأعمل بـ Next.js وPostgreSQL على ويندوز 11."
    expect(redactImportText(plain, true)).toEqual({ text: plain, redactions: 0, blocked: false })
    expect(redactImportText("mail me at owner@example.com", true).text).toBe("mail me at [email]")
    expect(redactImportText("mail me at owner@example.com", false).text).toBe("mail me at owner@example.com")
  })

  test("the review masks, dedupes, drops short lines and hints sensitive items without writing anything", () => {
    const review = buildImportReview([
      { text: `- token ${FAKE_KEY}`, agent: "chatgpt", origin: "x" },
      { text: "I prefer Arabic answers", agent: "chatgpt", origin: "x" },
      { text: "i prefer   arabic answers!", agent: "claude", origin: "y" },
      { text: "ok", agent: "chatgpt", origin: "x" },
      { text: "My salary is 18000 SAR", agent: "chatgpt", origin: "x" },
    ], ["found"], { maskEmails: true })
    expect(review.items).toHaveLength(3)
    expect(JSON.stringify(review)).not.toContain(FAKE_KEY)
    expect(review.dropped).toEqual({ duplicates: 1, tooShort: 1, secrets: 0 })
    expect(review.items.find((i) => i.text.includes("salary"))!.sensitive).toBe(true)
    expect(review.items.find((i) => i.text.includes("Arabic"))!.sensitive).toBe(false)
  })

  test("markdown: headings give context, tables become rows, horizontal rules vanish", () => {
    expect(itemsFromMarkdown("# A\n---\n- x is fine\n\n## B\npara one\npara two\n")).toEqual(["A: x is fine", "B: para one para two"])
  })
})

describe("save into the existing owner and reach the prompt", () => {
  test("saved items are owner notes (user scope) with source and time, re-import updates instead of duplicating, sensitive needs the switch", () => {
    const store = new SqliteFactStore(join(base, "save.sqlite"))
    try {
      expect(userOwnerNotes(store)).toHaveLength(0)
      const items = [{ text: `I prefer short Arabic answers, key ${FAKE_KEY}`, agent: "chatgpt", origin: "ChatGPT › الذاكرة", category: "profile" }, { text: "My salary is 18000 SAR", agent: "chatgpt", origin: "x", sensitive: true }]
      const first = saveImportedItems(store, items, { projectId: USER_MEMORY_PROJECT, allowSensitive: false, maskEmails: true, now: 1_760_000_000_000 })
      expect(first.saved).toHaveLength(1)
      expect(first.skipped[0]!.why).toContain("حسّاس")
      const notes = userOwnerNotes(store)
      expect(notes).toHaveLength(1)
      const note = notes[0]!
      expect(note.key.startsWith("owner-note:ChatGPT: ")).toBe(true)
      expect(note.sourceEventIds[0]).toBe("owner-note:import:chatgpt:1760000000000")
      const value = note.value as { note: string; category: string; importedFrom: { agent: string; from: string; importedAt: string } }
      expect(value.note).not.toContain(FAKE_KEY)
      expect(value.category).toBe("profile")
      expect(value.importedFrom).toEqual({ agent: "chatgpt", from: "ChatGPT › الذاكرة", importedAt: "2025-10-09T08:53:20.000Z" })
      saveImportedItems(store, [items[0]], { projectId: USER_MEMORY_PROJECT, allowSensitive: false, maskEmails: true })
      expect(userOwnerNotes(store)).toHaveLength(1)
      expect(note.key).toBe(`owner-note:${importTitle("chatgpt", value.note)}`)
      expect(() => saveImportedItems(store, [], { projectId: USER_MEMORY_PROJECT, allowSensitive: false, maskEmails: true })).toThrow()
    } finally { store.close() }
  })

  test("an imported item reaches the injection point the existing notes use — even with history search off", async () => {
    const store = new SqliteFactStore(join(base, "inject.sqlite"))
    try {
      const project = join(base, "some-project")
      store.replaceVerified({ projectId: project, kind: "project_fact", key: "build:passing", value: "npm run build ينجح", sourceEventIds: ["t1"] })
      saveImportedItems(store, [{ text: "Always answer in Arabic with short sentences ZEBRA-PREF-71", agent: "gemini", origin: "paste" }], { projectId: USER_MEMORY_PROJECT, allowSensitive: false, maskEmails: true })
      // نفسُ التركيب في cli.ts (priorRecall وgateRecall): ملاحظاتُ «كلّ المشاريع» ثمّ حقائقُ المشروع ⇦ factsForAutomaticRecall ⇦ recall.
      const facts = factsForAutomaticRecall([...userOwnerNotes(store), ...store.query({ projectId: project, sessionId: "s-1", now: Date.now() }).facts], false, "s-1")
      const result = await new SemanticMemory().recall({ facts, query: "اكتب صفحة الدفع", scope: "x", route: "r", enabled: false, allowSensitive: false, rank: async () => "" })
      expect(result.brief.startsWith("[PROJECT_MEMORY]")).toBe(true)
      expect(result.brief).toContain("ZEBRA-PREF-71")
      expect(result.brief).toContain("source=owner-note:import:gemini:")
      // التوأم: حقيقةُ مشروعٍ بلا مصدرِ جلسة لا تمرّ والبحثُ مطفأ — فالمارُّ مرّ لأنه ملاحظةُ مالك، لا لأنّ المرشِّح لا يرشّح.
      expect(result.brief).not.toContain("npm run build")
    } finally { store.close() }
  })
})
