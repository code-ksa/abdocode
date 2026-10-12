/**
 * 10-11 (مقيس على CRM الخامس) — النموذجُ يختم حمولةَ write بسطرٍ وحده «<<<» (علامةُ الفتح نفسُها مستعملةً للإغلاق)، فرُفضت ثلاثُ كتاباتٍ كاملة
 * (79 و199 و310 سطراً) «سطرٌ فيه علامات < وحدها» وأُعيدت كلٌّ بنداءٍ طويل. السطرُ الأخير يُنزع من ملفّات الشيفرة؛ وفي وسط الحمولة يبقى رفضاً.
 */
import { expect, test } from "bun:test"
import { runTextAgentLoop } from "../src"

async function run(reply: string): Promise<{ seen: string[]; prompts: string[] }> {
  const seen: string[] = []
  const prompts: string[] = []
  const answers = [reply, "تمّ."]
  await runTextAgentLoop({
    input: "اكتب الملفّ",
    history: [],
    ask: async (prompt) => { prompts.push(prompt); return answers.length > 1 ? answers.shift()! : answers[0]! },
    dispatch: async (command: string) => { seen.push(command); return "✍ كُتب" },
    isCallable: () => true,
    maxRounds: 3,
  })
  return { seen, prompts }
}

const TS = "export function board(stages: string[]) {\n  return stages.map((s) => s.toUpperCase())\n}"

test("a lone closing «<<<» after a code payload is dropped before the write", async () => {
  const { seen } = await run(`نفّذ: write src/board.ts <<<\n${TS}\n<<<`)
  expect(seen).toEqual([`write src/board.ts <<<\n${TS}\n`])
  const two = await run(`نفّذ: write src/board.ts <<<\n${TS}\n<<\n`)
  expect(two.seen).toEqual([`write src/board.ts <<<\n${TS}\n`])
})

test("the twins: «<<<» in the middle of the payload is still refused (nothing written), and a Markdown file keeps its bytes", async () => {
  const mid = await run(`نفّذ: write src/board.ts <<<\n${TS}\n<<<\nexport const more = 1`)
  expect(mid.seen).toEqual([])
  expect(mid.prompts.some((p) => p.includes("علامات < وحدها"))).toBe(true)
  const md = await run("نفّذ: write NOTES.md <<<\n# notes\nsome text\n<<<")
  expect(md.seen).toEqual([])
})
