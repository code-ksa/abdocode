/**
 * الفجوة #10 (2026-09-27) — الصوت: قراءةُ الجواب بأصوات ويندوز، والإملاءُ حيث يوجد مُعرِّفُ الكلام وحده.
 * نافذةٌ مزيّفة تثبت السلوك، وقراءةُ الصفحة تثبت أنّ زرَّ الميكروفون مخفيٌّ ما لم تُكشف الواجهة.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
// @ts-expect-error — the shell's plain ES module
import { createDictation, createReader, pickVoice, speakable, speechLang } from "../../desktop/ui/voice.js"

test("the text chooses the voice language, and only what is worth hearing is read", () => {
  expect(speechLang("مرحباً بك في عبدو كود", "en")).toBe("ar-SA")
  expect(speechLang("Build finished with 3 warnings", "ar")).toBe("en-US")
  expect(speechLang("123 456", "en")).toBe("en-US")
  expect(pickVoice([{ lang: "en-US", name: "a" }, { lang: "ar-EG", name: "b" }], "ar-SA")).toMatchObject({ name: "b" })
  expect(pickVoice([{ lang: "ar-SA", name: "c" }, { lang: "ar-EG", name: "b" }], "ar-SA")).toMatchObject({ name: "c" })
  expect(pickVoice([{ lang: "fr-FR" }], "ar-SA")).toBeUndefined()
  const text = "Done **now**.\n```ts\nconst secret = 1\n```\nSee [the docs](https://x).\n— المقيس: دخل 9 توكيناً"
  expect(speakable(text)).toBe("Done now . See the docs.")
})

test("read aloud: one control that speaks with the right language and voice, and stops when pressed again", () => {
  const spoken: { text: string; lang: string; voice?: unknown }[] = []
  let cancelled = 0
  class Utterance { text: string; lang = ""; voice?: unknown; onend?: () => void; onerror?: () => void; constructor(t: string) { this.text = t } }
  const synth = { getVoices: () => [{ lang: "ar-SA", name: "Hoda" }], speak: (u: Utterance) => { spoken.push({ text: u.text, lang: u.lang, voice: u.voice }) }, cancel: () => { cancelled += 1 } }
  const reader = createReader({ speechSynthesis: synth, SpeechSynthesisUtterance: Utterance })
  expect(reader.supported).toBe(true)
  const states: boolean[] = []
  expect(reader.toggle("تمّ إنشاءُ الملفّ", "en", (on: boolean) => states.push(on))).toBe(true)
  expect(spoken[0]).toMatchObject({ text: "تمّ إنشاءُ الملفّ", lang: "ar-SA", voice: { name: "Hoda" } })
  expect(reader.toggle("ignored", "en", () => undefined)).toBe(false)
  expect(states).toEqual([true, false])
  expect(cancelled).toBeGreaterThanOrEqual(2)
  // بلا واجهة قراءة: لا زرّ ولا نداء.
  expect(createReader({}).supported).toBe(false)
  expect(createReader({}).toggle("x", "en", () => undefined)).toBe(false)
})

test("dictation exists only where a recognizer does, and its words land in the composer", () => {
  expect(createDictation({}, () => "ar-SA", () => undefined, () => undefined)).toBeUndefined()
  let instance: any
  class Recognizer { lang = ""; onresult?: (e: unknown) => void; onend?: () => void; onerror?: (e: unknown) => void; started = false; constructor() { instance = this } start() { this.started = true } stop() { this.onend?.() } }
  const said: string[] = [], states: boolean[] = []
  const dictation = createDictation({ webkitSpeechRecognition: Recognizer }, () => "ar-SA", (t: string) => said.push(t), (on: boolean) => states.push(on))!
  dictation.toggle()
  expect(instance.started).toBe(true)
  expect(instance.lang).toBe("ar-SA")
  instance.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: "افتح ملف الإعدادات" }], { isFinal: true })] })
  expect(said).toEqual(["افتح ملف الإعدادات"])
  dictation.toggle()
  expect(states).toEqual([true, false])
})

test("the shell wires both behind their detection: the microphone ships hidden, the speaker needs a finished answer", () => {
  const html = readFileSync(join(import.meta.dir, "../../desktop/ui/index.html"), "utf8")
  expect(html).toContain('import { createDictation, createReader } from "./voice.js";')
  expect(html).toContain('<button class="chip" id="micchip" hidden ')
  expect(html).toContain('if (dictation !== undefined) { el("micchip").hidden = false; el("micchip").onclick = () => dictation.toggle(); }')
  expect(html).toContain('if (ending === "done" && reader.supported && this.bodyEl.textContent.trim().length > 0 && this.node.querySelector(".speak") === null) {')
})
