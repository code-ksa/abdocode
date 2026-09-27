/**
 * Voice — gap #10 in the 2026-09-27 table (ChatGPT speaks and listens).
 *
 * Two capabilities with two different realities inside WebView2:
 *  · Reading an answer aloud (speechSynthesis) uses the Windows voices installed on the machine, offline.
 *  · Dictation (SpeechRecognition) is not guaranteed in WebView2. Its button exists only where the API does — a
 *    microphone that silently does nothing is worse than no microphone.
 * Pure helpers here; the shell wires them. Nothing is sent anywhere by this module.
 */

const ARABIC = /[؀-ۿ]/u

/** The language to read in: the text decides (Arabic letters or not), the interface breaks ties. */
export function speechLang(text, uiLanguage) {
  const arabic = (text.match(/[؀-ۿ]/gu) ?? []).length
  const latin = (text.match(/[A-Za-z]/gu) ?? []).length
  if (arabic === 0 && latin === 0) return uiLanguage === "en" ? "en-US" : "ar-SA"
  return arabic >= latin ? "ar-SA" : "en-US"
}

/** An installed voice for the language: exact tag first, then the same language, else none (the browser default). */
export function pickVoice(voices, lang) {
  const list = Array.from(voices ?? [])
  const primary = lang.split("-")[0].toLowerCase()
  return list.find((v) => (v.lang ?? "").toLowerCase() === lang.toLowerCase())
    ?? list.find((v) => (v.lang ?? "").toLowerCase().split(/[-_]/u)[0] === primary)
}

/** What is worth hearing: no code blocks, no engine meta lines, no markdown punctuation — and a bounded length. */
export function speakable(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, " ")
    .split("\n")
    .filter((line) => !/^\s*— (?:المقيس|Measured|حقب التنفيذ|Epochs)/u.test(line))
    .join("\n")
    .replace(/[`*_#>|]/gu, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 4000)
}

export const recognitionCtor = (win) => win?.SpeechRecognition ?? win?.webkitSpeechRecognition

/** Read-aloud with one control: pressing it again stops. `onChange(true|false)` follows the actual speaking state. */
export function createReader(win) {
  const synth = win?.speechSynthesis
  const Utterance = win?.SpeechSynthesisUtterance
  const supported = synth !== undefined && typeof Utterance === "function"
  let current
  return {
    supported,
    toggle(text, uiLanguage, onChange) {
      if (!supported) return false
      if (current !== undefined) { const was = current; current = undefined; synth.cancel(); was.onChange?.(false); return false }
      const words = speakable(text)
      if (words.length === 0) return false
      const utterance = new Utterance(words)
      utterance.lang = speechLang(words, uiLanguage)
      const voice = pickVoice(synth.getVoices?.() ?? [], utterance.lang)
      if (voice !== undefined) utterance.voice = voice
      const entry = { onChange }
      current = entry
      utterance.onend = utterance.onerror = () => { if (current === entry) current = undefined; onChange?.(false) }
      synth.cancel()
      synth.speak(utterance)
      onChange?.(true)
      return true
    },
  }
}

/** Dictation into the composer, or undefined where the platform has no recognizer. */
export function createDictation(win, lang, onText, onState) {
  const Ctor = recognitionCtor(win)
  if (typeof Ctor !== "function") return undefined
  let active
  return {
    toggle() {
      if (active !== undefined) { active.stop(); return }
      const rec = new Ctor()
      rec.lang = lang()
      rec.interimResults = false
      rec.continuous = false
      rec.onresult = (event) => {
        const parts = []
        for (let i = event.resultIndex ?? 0; i < event.results.length; i += 1) if (event.results[i].isFinal !== false) parts.push(event.results[i][0].transcript)
        const said = parts.join(" ").trim()
        if (said.length > 0) onText(said)
      }
      rec.onend = () => { active = undefined; onState(false) }
      rec.onerror = (e) => { active = undefined; onState(false, e?.error ?? "error") }
      active = rec
      rec.start()
      onState(true)
    },
  }
}

export const isArabicText = (text) => ARABIC.test(text)
