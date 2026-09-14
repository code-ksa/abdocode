/**
 * S14 — البرهان الذي يهمّ فعلاً: **نسأل القرص، لا الدالّة**.
 *
 * الدعوى: اعتمادٌ يصل في نصّ دورٍ لا يُكتب في الدفتر ولا في الذاكرة الدائمة
 * ولا في تاريخ المحادثة ولا يُرسل إلى نموذج. الاختبار لا يستدعي المصنّف ولا
 * يسأله ماذا أعاد: يُشغّل المحرّك حقيقةً، يُرسل الدور، ثم **يفتح ملفّات
 * الحالة على القرص بايتاً بايت** ويبحث عن القيمة. وجودُها في بايتٍ واحد =
 * سقوط.
 *
 * ولا نداءَ نموذجٍ حيّ في هذا الملفّ: الدور يُقطع بعد أن يظهر سطرُ التحذير،
 * وسطرُ التحذير يُبثّ قبل أيّ نداء (الحلقة تبدأ بعده).
 */
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { REDACTED } from "../src/secret-command-guard"

const ROOT = resolve(import.meta.dir, "../../..")
const EDITOR_STUB = resolve(import.meta.dir, "fixtures", "intake-editor-stub.ts")

/** السرّ الذي «يكتبه المستخدم في المحادثة» — يجب ألّا يظهر على القرص. */
const CHAT_PASSWORD = "Passw0rdBurned2026"
const CHAT_BODY = `الحساب adminuser والباسورد ${CHAT_PASSWORD} دخلهم في لوحة التحكم`

/** كلُّ ملفّات الشجرة، بايتاتها الخام — لا استعلامَ يختار ما نريد رؤيته. */
const everyFile = (directory: string): { path: string; bytes: Buffer }[] => {
  const found: { path: string; bytes: Buffer }[] = []
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) walk(path)
      else found.push({ path, bytes: readFileSync(path) })
    }
  }
  walk(directory)
  return found
}

/** بحثٌ عن النصّ بترميزَيه: UTF-8 وUTF-16LE (سجلّاتٌ قد تُكتب بأيّهما). */
const holdsPlaintext = (bytes: Buffer, needle: string): boolean =>
  bytes.includes(Buffer.from(needle, "utf8")) || bytes.includes(Buffer.from(needle, "utf16le"))

interface Session {
  readonly send: (frame: Readonly<Record<string, unknown>>) => Promise<void>
  readonly awaitFrame: (match: (frame: Record<string, unknown>) => boolean, what: string) => Promise<Record<string, unknown>>
  readonly stop: () => Promise<void>
  readonly frames: Record<string, unknown>[]
}

const startEngine = (state: string, extra: Record<string, string>): Session => {
  const token = "secret-persistence-token"
  const executable = process.env.ABDO_TEST_ENGINE
  const command = executable === undefined ? [process.execPath, "packages/engine/src/cli.ts", "serve"] : [executable, "serve"]
  const child = Bun.spawn(command, {
    cwd: ROOT,
    env: {
      ...process.env,
      ABDO_SHELL_TOKEN: token,
      ABDO_FRAMED_STDIO: "1",
      ABDO_CODE_STATE_DIR: state,
      USERPROFILE: state,
      HOME: state,
      ...extra,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const decoder = new LocalJsonFrameDecoder()
  const reader = child.stdout.getReader()
  const stderrText = new Response(child.stderr).text()
  const frames: Record<string, unknown>[] = []
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  const send = async (frame: Readonly<Record<string, unknown>>): Promise<void> => {
    child.stdin.write(encodeLocalJsonFrame(frame))
    await child.stdin.flush()
  }
  const awaitFrame = async (match: (frame: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 60_000
    for (;;) {
      const found = frames.find(match)
      if (found !== undefined) return found
      if (Date.now() >= deadline) {
        child.kill()
        await child.exited
        const recent = frames.filter((frame) => frame.kind !== "ready").slice(-20)
        throw new Error(`timed out waiting for ${what}; frames=${JSON.stringify(recent).slice(0, 8_000)}; stderr=${(await stderrText).slice(0, 2_000)}`)
      }
      pendingRead ??= reader.read()
      const result = await Promise.race([pendingRead, Bun.sleep(200).then(() => undefined)])
      if (result === undefined) continue
      pendingRead = undefined
      if (result.done) throw new Error(`engine ended before ${what}`)
      for (const value of decoder.push(result.value)) frames.push(value as Record<string, unknown>)
    }
  }
  const stop = async (): Promise<void> => { child.kill(); await child.exited }
  return { send, awaitFrame, stop, frames, token } as Session & { token: string }
}

const eventText = (frame: Record<string, unknown>): string => String(frame.payload ?? "")
const isEvent = (needle: string) => (frame: Record<string, unknown>): boolean =>
  frame.kind === "event" && eventText(frame).includes(needle)

describe("S14 — القيمة لا تصل القرص (نسأل القرص لا الدالّة)", () => {
  test("المفتاح مطفأ: الحجب ومنعُ التخزين يقعان، ولا محرّر يُفتح ولا خزنة تُكتب", async () => {
    const state = mkdtempSync(join(tmpdir(), "abdo-secret-off-"))
    const vaultHome = mkdtempSync(join(tmpdir(), "abdo-secret-off-vault-"))
    const engine = startEngine(state, {
      ABDO_VAULT_HOME: vaultHome,
      // ⛔ المفتاح مطفأ: أرضيّةُ الأمان يجب أن تقع على كلّ حال.
      ABDO_PLUGIN_SECRET_INTAKE: "0",
      // ولو حاول أحدٌ فتح محرّرٍ لَكان هذا هو، فغيابُ أثره دليلٌ لا ادّعاء.
      ABDO_INTAKE_EDITOR: process.execPath,
      ABDO_INTAKE_EDITOR_ARG: EDITOR_STUB,
      ABDO_TEST_INTAKE_VALUE: "must-never-be-written",
    })
    try {
      await engine.send({ kind: "hello", shell: "desktop", token: "secret-persistence-token" })
      await engine.awaitFrame((f) => f.kind === "ready", "ready")
      await engine.send({ kind: "submit", turn: { id: "t-off-1", body: CHAT_BODY }, mode: "read-only" })
      // سطرُ التحذير يُبثّ ولو كان المفتاح مطفأً — التحذير ليس اختيارياً.
      const warning = await engine.awaitFrame(isEvent("تحذير تدوير الأسرار"), "rotation warning")
      expect(eventText(warning)).toContain("كلمة مرور")
      expect(eventText(warning)).not.toContain(CHAT_PASSWORD)
      // وسطرٌ يقول صراحةً إن الطريق المُعان مطفأ — لا صمتَ يُفهم إذناً.
      const off = await engine.awaitFrame(isEvent("الإدخال المُعان معطَّل"), "toggle-off line")
      expect(eventText(off)).toContain("plugins.secretIntake")
      await engine.stop()

      // ── البرهان من القرص ────────────────────────────────────────────────
      const files = everyFile(state)
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        expect(`${file.path} ⇦ ${holdsPlaintext(file.bytes, CHAT_PASSWORD) ? "يحمل السرّ" : "نظيف"}`)
          .toBe(`${file.path} ⇦ نظيف`)
      }
      // والدفتر يحمل الجسد **محجوباً** لا ناقصاً: صفُّ القبول موجود بعلامته.
      const events = new Database(join(state, "abdocode-events.sqlite"), { readonly: true })
      const rows = events.query("SELECT type, data FROM events").all() as { type: string; data: string }[]
      events.close()
      const admissions = rows.filter((row) => row.data.includes("t-off-1") && row.data.includes("body"))
      expect(admissions.length).toBeGreaterThan(0)
      expect(admissions.some((row) => row.data.includes(REDACTED))).toBe(true)
      for (const row of rows) expect(row.data).not.toContain(CHAT_PASSWORD)
      // وحقيقةُ الدور الدائمة (هدفُ الدور) محجوبةٌ هي أيضاً.
      const memory = new Database(join(state, "abdocode-memory.sqlite"), { readonly: true })
      const facts = memory.query("SELECT * FROM facts").all() as Record<string, unknown>[]
      memory.close()
      const factText = JSON.stringify(facts)
      expect(factText).not.toContain(CHAT_PASSWORD)
      expect(factText).toContain(REDACTED)

      // ⛔ المطفأ لا يلمس سطح المكتب ولا الخزنة: لا مخزنَ أسرارٍ ولا قالب.
      //
      // ⚠ دُقِّق 2026-09-04 ولم يُضعَّف: صار المحرّك يُثبّت **سكربتَ الخزنة**
      // عند الإقلاع ليعرف عاملُ Rust مكانَها (بدونه كان كلُّ مزوّدٍ سحابيّ
      // يُقرأ «بلا مفتاح»). السكربتُ أداةٌ لا سرّ، فالحراسةُ تُصاغ على ما
      // تحرسه فعلاً: **لا مخزن، ولا شيء سوى السكربت، ولا سرَّ في بايتاته**.
      expect(existsSync(join(vaultHome, "vault"))).toBe(false)
      expect(readdirSync(vaultHome)).toEqual(["vault.ps1"])
      const shipped = readFileSync(join(vaultHome, "vault.ps1"))
      expect(holdsPlaintext(shipped, CHAT_PASSWORD)).toBe(false)
      expect(holdsPlaintext(shipped, "must-never-be-written")).toBe(false)
    } finally {
      rmSync(state, { recursive: true, force: true })
      rmSync(vaultHome, { recursive: true, force: true })
    }
  }, 120_000)

  test("المفتاح مفعَّل: التحذير، ثم محرّرٌ يُفتح تنفيذياً، ثم قيمةٌ جديدة في الخزنة والقالب محذوف", async () => {
    const state = mkdtempSync(join(tmpdir(), "abdo-secret-on-"))
    const vaultHome = mkdtempSync(join(tmpdir(), "abdo-secret-on-vault-"))
    const editorHome = mkdtempSync(join(tmpdir(), "abdo-secret-editor-"))
    const rotated = "sk-rotated-fresh-2026"
    // المحرّر ابنٌ منزوعُ البيئة قصداً، لذلك تحمل نسخة الاختبار قيمتها داخل
    // سكربت مؤقت لا عبر متغيّر بيئة قد يتحول إلى قناة أسرار في المنتج.
    const editorStub = join(editorHome, "intake-editor.ts")
    writeFileSync(editorStub, [
      'import { readFileSync, writeFileSync } from "node:fs"',
      'const path = process.argv.at(-1)!',
      'const kept = readFileSync(path, "utf8").split(/\\r\\n|\\n/u).filter((line) => line.startsWith("#"))',
      `writeFileSync(path, kept.join("\\r\\n") + "\\r\\n" + ${JSON.stringify(rotated)} + "\\r\\n", "utf8")`,
    ].join("\n"), "utf8")
    const engine = startEngine(state, {
      ABDO_VAULT_HOME: vaultHome,
      ABDO_INTAKE_EDITOR: process.execPath,
      ABDO_INTAKE_EDITOR_ARG: editorStub,
      ABDO_INTAKE_TIMEOUT_MS: "30000",
    })
    try {
      await engine.send({ kind: "hello", shell: "desktop", token: "secret-persistence-token" })
      await engine.awaitFrame((f) => f.kind === "ready", "ready")
      await engine.send({ kind: "submit", turn: { id: "t-on-1", body: CHAT_BODY }, mode: "read-only" })
      await engine.awaitFrame(isEvent("تحذير تدوير الأسرار"), "rotation warning")
      const stored = await engine.awaitFrame(isEvent("خُزّن السرّ في الخزنة"), "vault write")
      expect(eventText(stored)).toContain("chat-password")
      expect(eventText(stored)).not.toContain(rotated)
      expect(eventText(stored)).not.toContain(CHAT_PASSWORD)
      await engine.stop()

      // الخزنة كُتبت فعلاً — والملفّ ليس نصّاً صريحاً.
      const secFile = join(vaultHome, "vault", "chat-password.sec")
      expect(existsSync(secFile)).toBe(true)
      const secBytes = readFileSync(secFile)
      expect(holdsPlaintext(secBytes, rotated)).toBe(false)
      // ⛔ الطفرة (ج): لا قالبَ بقي بعد الدورة، لا فارغاً ولا ممتلئاً.
      expect(readdirSync(join(vaultHome, "vault")).filter((n) => n.endsWith(".intake.txt"))).toEqual([])
      // ولا سرَّ المحادثة ولا القيمة الجديدة في أيّ ملفّ حالة.
      for (const file of everyFile(state)) {
        expect(`${file.path} ⇦ ${holdsPlaintext(file.bytes, CHAT_PASSWORD) || holdsPlaintext(file.bytes, rotated) ? "يحمل سرّاً" : "نظيف"}`)
          .toBe(`${file.path} ⇦ نظيف`)
      }
    } finally {
      rmSync(state, { recursive: true, force: true })
      rmSync(vaultHome, { recursive: true, force: true })
      rmSync(editorHome, { recursive: true, force: true })
    }
  }, 120_000)
  /**
   * ⛔ الحالةُ التي وجدها الفريقُ الأحمر وهي أسوأ ما في التصميم: المحرّك
   * **يبثّ** «🔐 تحذير تدوير الأسرار … حُجب قبل أن يُكتب … ولم يُخزَّن»، وفي
   * الوقت نفسه يكتب القيمة في دفتر الأحداث وفي الذاكرة الدائمة. القيمةُ هنا
   * `ADMIN2026`: كلمةُ مرورٍ بحروفٍ كبيرةٍ وأرقام، كان يستثنيها استثناءُ «اسم
   * متغيّر بيئة» رغم أن الاسمَ الصريح «الباسورد» يسبقها بنقطتين. الدعوى الآن
   * تُقاس من القرص: صفرُ بايتٍ يحمل القيمة، وصفُّ القبول يحمل علامةَ الحجب.
   */
  test("⛔ التحذيرُ والقرص يقولان الشيءَ نفسه — لا دعوى أمنٍ بلا أثرٍ يطابقها", async () => {
    const state = mkdtempSync(join(tmpdir(), "abdo-secret-claim-"))
    const vaultHome = mkdtempSync(join(tmpdir(), "abdo-secret-claim-vault-"))
    const screaming = "ADMIN2026"
    const engine = startEngine(state, {
      ABDO_VAULT_HOME: vaultHome,
      ABDO_PLUGIN_SECRET_INTAKE: "0",
      ABDO_INTAKE_EDITOR: process.execPath,
      ABDO_INTAKE_EDITOR_ARG: EDITOR_STUB,
      ABDO_TEST_INTAKE_VALUE: "must-never-be-written",
    })
    try {
      await engine.send({ kind: "hello", shell: "desktop", token: "secret-persistence-token" })
      await engine.awaitFrame((f) => f.kind === "ready", "ready")
      await engine.send({ kind: "submit", turn: { id: "t-claim-1", body: `الباسورد: ${screaming} دخله في لوحة التحكم` }, mode: "read-only" })
      const warning = await engine.awaitFrame(isEvent("تحذير تدوير الأسرار"), "rotation warning")
      expect(eventText(warning)).toContain("كلمة مرور")
      expect(eventText(warning)).not.toContain(screaming)
      await engine.stop()

      for (const file of everyFile(state)) {
        expect(`${file.path} ⇦ ${holdsPlaintext(file.bytes, screaming) ? "يحمل السرّ" : "نظيف"}`)
          .toBe(`${file.path} ⇦ نظيف`)
      }
      const events = new Database(join(state, "abdocode-events.sqlite"), { readonly: true })
      const rows = events.query("SELECT type, data FROM events").all() as { type: string; data: string }[]
      events.close()
      const admissions = rows.filter((row) => row.data.includes("t-claim-1") && row.data.includes("body"))
      expect(admissions.length).toBeGreaterThan(0)
      expect(admissions.some((row) => row.data.includes(REDACTED))).toBe(true)
      for (const row of rows) expect(row.data).not.toContain(screaming)
      const memory = new Database(join(state, "abdocode-memory.sqlite"), { readonly: true })
      const facts = JSON.stringify(memory.query("SELECT * FROM facts").all())
      memory.close()
      expect(facts).not.toContain(screaming)
    } finally {
      rmSync(state, { recursive: true, force: true })
      rmSync(vaultHome, { recursive: true, force: true })
    }
  }, 120_000)
})
