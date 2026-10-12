/**
 * 10-11 (مقيس على m11 بالمثبَّت 4.0.139، DeepSeek) — الحمولةُ تُختم بوسمَي إغلاق بروتوكول النموذج «</｜｜DSML｜｜ parameter>» و«…invoke>»:
 * رُفضت بهما ثلاثُ كتاباتِ شيفرةٍ كاملة وأُعيدت، وكُتب .gitignore بهما فحجب المحكّمُ الاكتمال. الوسمُ يُنزع من الذيل في كلّ نوع ملفّ.
 */
import { expect, test } from "bun:test"
import { runTextAgentLoop } from "../src"

async function run(reply: string): Promise<string[]> {
  const seen: string[] = []
  const answers = [reply, "تمّ."]
  await runTextAgentLoop({
    input: "اكتب الملفّ",
    history: [],
    ask: async () => answers.length > 1 ? answers.shift()! : answers[0]!,
    dispatch: async (command: string) => { seen.push(command); return "✍ كُتب" },
    isCallable: () => true,
    maxRounds: 3,
  })
  return seen
}

const JS = "process.on('SIGTERM', shutdown);\nexport const port = 3000"
const TAIL = "\n</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>"

test("DSML closing tags after a code payload never reach the file", async () => {
  expect(await run(`نفّذ: write server/server.js <<<\n${JS}${TAIL}`)).toEqual([`write server/server.js <<<\n${JS}\n`])
  expect(await run(`نفّذ: write server/server.js <<<\n${JS}\n</｜DSML｜parameter>`)).toEqual([`write server/server.js <<<\n${JS}\n`])
})

test("a nameless DSML tag «</｜｜DSML｜｜>» (measured on 4.0.141) is stripped too, in code and non-code files", async () => {
  expect(await run(`نفّذ: write src/main.js <<<\n${JS}\n</｜｜DSML｜｜>`)).toEqual([`write src/main.js <<<\n${JS}\n`])
  expect(await run(`نفّذ: write notes.txt <<<\nhello\n</｜DSML｜>\n`)).toEqual([`write notes.txt <<<\nhello\n`])
})

test("nor after a non-code file like .gitignore", async () => {
  expect(await run(`نفّذ: write .gitignore <<<\nnode_modules/\n.env${TAIL}\n`)).toEqual([`write .gitignore <<<\nnode_modules/\n.env\n`])
})

test("a bare «</parameter>» tail is dropped from code files but kept in markup, where it may be a real element", async () => {
  expect(await run(`نفّذ: write tests/port.test.js <<<\n${JS}\n</parameter>`)).toEqual([`write tests/port.test.js <<<\n${JS}\n`])
  const xml = `write config.xml <<<\n<config>\n<parameter>`
  expect(await run(`نفّذ: ${xml}\n</parameter>`)).toEqual([`${xml}\n</parameter>`])
})

test("the twin: a payload without the tags is written byte-for-byte, and a DSML line mid-payload is left for the syntax check", async () => {
  expect(await run(`نفّذ: write .gitignore <<<\nnode_modules/\n.env`)).toEqual([`write .gitignore <<<\nnode_modules/\n.env`])
  const mid = `write notes.md <<<\nfirst\n</｜DSML｜parameter>\nlast`
  expect(await run(`نفّذ: ${mid}`)).toEqual([mid])
})
