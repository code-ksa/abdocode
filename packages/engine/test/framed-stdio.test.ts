import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"
import { PLUGINS } from "../src/plugin-registry"

describe("desktop framed stdio carrier", () => {
  test("authenticates and exchanges bounded binary frames end to end", async () => {
    const root = resolve(import.meta.dir, "../../..")
    const sandbox = mkdtempSync(resolve(tmpdir(), "abdo-framed-carrier-"))
    // A freshly installed desktop profile has no state directory yet. The
    // engine must create its selected nested root before opening its journal.
    const state = resolve(sandbox, "new-profile", "engine-state")
    expect(existsSync(state)).toBe(false)
    const token = "framed-carrier-test-token"
    const executable = process.env.ABDO_TEST_ENGINE
    const command = executable === undefined
      ? [process.execPath, "packages/engine/src/cli.ts", "serve"]
      : [executable, "serve"]
    const child = Bun.spawn(command, {
      cwd: root,
      env: {
        ...process.env,
        ABDO_SHELL_TOKEN: token,
        ABDO_FRAMED_STDIO: "1",
        ABDO_CODE_STATE_DIR: state,
        ABDO_CODE_SETTINGS: resolve(sandbox, "new-profile", "engine-settings.json"),
        USERPROFILE: sandbox,
        HOME: sandbox,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const decoder = new LocalJsonFrameDecoder()
    const reader = child.stdout.getReader()
    const stderrText = new Response(child.stderr).text()
    const waiting: Record<string, unknown>[] = []
    let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
    const send = async (frame: Readonly<Record<string, unknown>>): Promise<void> => {
      child.stdin.write(encodeLocalJsonFrame(frame))
      await child.stdin.flush()
    }
    const readKind = async (kind: string): Promise<Record<string, unknown>> => {
      // A release-wide forced run concurrently compiles the Rust isolation
      // helpers and kernel. Give the compiled engine a bounded but realistic
      // startup window under that measured contention.
      const deadline = Date.now() + 30_000
      for (;;) {
        const buffered = waiting.findIndex((frame) => frame.kind === kind)
        if (buffered >= 0) return waiting.splice(buffered, 1)[0]!
        if (Date.now() >= deadline) {
          child.kill()
          await child.exited
          throw new Error(`timed out waiting for ${kind}; stderr=${(await stderrText).slice(0, 2_000)}`)
        }
        // Never abandon a pending stream read when the timer wins: that read
        // would consume the eventual ready frame and discard it, creating a
        // false startup timeout. Reuse exactly one in-flight read.
        pendingRead ??= reader.read()
        const result = await Promise.race([
          pendingRead,
          Bun.sleep(250).then(() => undefined),
        ])
        if (result === undefined) continue
        pendingRead = undefined
        if (result.done) throw new Error(`engine ended before ${kind}; stderr=${(await stderrText).slice(0, 2_000)}`)
        for (const value of decoder.push(result.value)) waiting.push(value as Record<string, unknown>)
      }
    }

    try {
      await send({ kind: "hello", shell: "desktop", token })
      const ready = await readKind("ready")
      expect(ready).toMatchObject({ kind: "ready", name: "عبدو كود" })
      expect(existsSync(resolve(state, "abdocode-events.sqlite"))).toBe(true)
      // سجلّ الإضافات يركب إطار الجاهزية: الأوصاف والقيم النافذة ورقم المراجعة.
      const readyRegistry = ready.pluginRegistry as { descriptors: { name: string }[]; effective: Record<string, boolean>; pins: Record<string, unknown>; revision: number }
      expect(readyRegistry.descriptors.map((d) => d.name)).toEqual(PLUGINS.map((d) => d.name))
      expect(readyRegistry.revision).toBe(0)
      expect(readyRegistry.pins).toEqual({})
      expect(readyRegistry.effective.walls).toBe(true)
      expect(readyRegistry.effective.verifier).toBe(false)
      expect(Array.isArray(ready.pluginCatalog)).toBe(true)
      expect((ready.pluginCatalog as { name: string }[]).map((r) => r.name)).toEqual(PLUGINS.map((d) => d.name))
      await send({ kind: "settings-get" })
      expect(await readKind("settings")).toMatchObject({ kind: "settings" })
      await send({
        kind: "settings-set",
        settings: {
          chatModel: "ollama/qwen9b-gpu-32k:latest",
          agentModel: "ollama/empero-qwen3.8-9b-gpu:latest",
          modelRole: "auto",
          mode: "read-only",
        },
      })
      expect(await readKind("settings")).toMatchObject({
        settings: {
          chatModel: "ollama/qwen9b-gpu-32k:latest",
          agentModel: "ollama/empero-qwen3.8-9b-gpu:latest",
          modelRole: "auto",
        },
      })
      await send({ kind: "settings-set", settings: { hiddenControl: true } })
      expect(await readKind("refused")).toMatchObject({ kind: "refused", why: "حقل إعدادات غير معروف: hiddenControl" })
      // ── ذ2ب: سلّمُ التصعيد يُضبط من الواجهة، ويُرفض بالاسم حين لا يُحلّ ──
      await send({ kind: "settings-set", settings: { modelLadder: ["ollama/qwen9b-gpu-32k:latest", "ollama/empero-qwen3.8-9b-gpu:latest"] } })
      expect(await readKind("settings")).toMatchObject({ settings: { modelLadder: ["ollama/qwen9b-gpu-32k:latest", "ollama/empero-qwen3.8-9b-gpu:latest"] } })
      await send({ kind: "settings-set", settings: { modelLadder: ["nope/x"] } })
      expect(await readKind("refused")).toMatchObject({ kind: "refused", why: "modelLadder: المرجع «nope/x» لا يُحلّ" })
      await send({ kind: "settings-set", settings: { modelLadder: Array.from({ length: 9 }, () => "ollama/qwen9b-gpu-32k:latest") } })
      expect(String((await readKind("refused")).why)).toStartWith("modelLadder: حتى ٨")
      // ── ذ1: نموذجُ الرؤية يُضبط من اللوحة بالتحقّق نفسه، والفراغُ يلغيه لا يُرفض ──
      await send({ kind: "settings-set", settings: { visionModel: "ollama/qwen9b-gpu-32k:latest" } })
      expect(await readKind("settings")).toMatchObject({ settings: { visionModel: "ollama/qwen9b-gpu-32k:latest" } })
      await send({ kind: "settings-set", settings: { visionModel: "nope/x" } })
      expect(await readKind("refused")).toMatchObject({ kind: "refused", why: "visionModel يحتاج مرجع مزوّد/نموذج صالحاً" })
      await send({ kind: "settings-set", settings: { visionModel: "" } })
      expect((await readKind("settings")).settings.visionModel).toBeUndefined()


      // ── سجلّ الإضافات: باب مُغلق، سياج مراجعة، شرطٌ يُحفظ ويُصدى، وجردٌ يُطفأ ──
      // (١) اسمٌ غير مسجَّل يُرفض بالاسم وبقائمة المعروف.
      await send({ kind: "settings-set", settings: { plugins: { nope: true } } })
      const unknownPlugin = await readKind("refused")
      expect(String(unknownPlugin.why)).toStartWith("plugins: إضافة غير معروفة: nope — المعروف:")
      // (٢) قيمة ليست منطقيّة تُرفض — كانت تُحفظ وتُقرأ مفعَّلةً (فشلٌ مفتوح).
      await send({ kind: "settings-set", settings: { plugins: { walls: "on" } } })
      expect(await readKind("refused")).toMatchObject({ why: "plugins.walls يحتاج true أو false" })
      // (٣) شرطٌ على مفتاحٍ حاكم مرفوض.
      await send({ kind: "settings-set", settings: { plugins: { rules: { when: "os == windows" } } } })
      expect(await readKind("refused")).toMatchObject({ why: "plugins.rules: المفاتيح الحاكمة تقبل نعم/لا فقط" })
      // (٤) كتابةٌ مسيَّجة بالمراجعة الصحيحة تمرّ وترفع الرقم.
      await send({ kind: "settings-set", settings: { plugins: { walls: false } }, expectedPluginsRevision: 0 })
      const afterWrite = await readKind("settings")
      expect(afterWrite).toMatchObject({ settings: { plugins: { walls: false }, pluginsRevision: 1 } })
      expect((afterWrite.pluginRegistry as { revision: number; effective: Record<string, boolean> }).revision).toBe(1)
      expect((afterWrite.pluginRegistry as { revision: number; effective: Record<string, boolean> }).effective.walls).toBe(false)
      // (٥) المراجعة المتأخّرة تُرفض بالاسم ويُعاد إليها المحفوظ — والقرص لم يُمَس.
      await send({ kind: "settings-set", settings: { plugins: { walls: true } }, expectedPluginsRevision: 0 })
      expect(String((await readKind("refused")).why)).toStartWith("تعارض إعدادات الإضافات: قرأتَ المراجعة 0 والمحفوظة 1")
      const resynced = await readKind("settings")
      expect(resynced).toMatchObject({ settings: { plugins: { walls: false }, pluginsRevision: 1 } })
      expect((resynced.pluginRegistry as { revision: number }).revision).toBe(1)
      // (٦) غياب السياج = كتابةٌ غير مشروطة كما كانت.
      await send({ kind: "settings-set", settings: { plugins: { walls: true } } })
      expect(await readKind("settings")).toMatchObject({ settings: { plugins: { walls: true }, pluginsRevision: 2 } })
      // (٧) شرطٌ صالح يُحفظ كما هو ويعود في الكتالوج صالحاً.
      await send({ kind: "settings-set", settings: { plugins: { verifier: { when: "rail == thin" }, walls: true } }, expectedPluginsRevision: 2 })
      const withRule = await readKind("settings")
      expect(withRule).toMatchObject({ settings: { plugins: { verifier: { when: "rail == thin" } }, pluginsRevision: 3 } })
      expect((withRule.pluginCatalog as { name: string; configured: string; valid: boolean; rule?: string }[]).find((r) => r.name === "verifier"))
        .toMatchObject({ configured: "rule", valid: true, rule: "rail == thin" })
      // (٨) شرطٌ والقواعد مطفأة في الرقعة نفسها يُرفض بالاسم.
      await send({ kind: "settings-set", settings: { plugins: { rules: false, verifier: { when: "rail == thin" } } } })
      expect(await readKind("refused")).toMatchObject({ why: "plugins.verifier: قواعد الشرط معطَّلة — فعّل plugins.rules أولاً" })
      // (٩) إطفاء الجرد = **غياب** الكتالوج لا قائمةً فارغة؛ والوصف يبقى (اللوحة تُولَّد منه).
      await send({ kind: "settings-set", settings: { plugins: { inventory: false } } })
      const inventoryOff = await readKind("settings")
      expect(inventoryOff.pluginCatalog).toBeUndefined()
      expect("pluginCatalog" in inventoryOff).toBe(false)
      expect((inventoryOff.pluginRegistry as { descriptors: unknown[] }).descriptors).toHaveLength(PLUGINS.length)
      await send({ kind: "settings-get" })
      const reread = await readKind("settings")
      expect("pluginCatalog" in reread).toBe(false)
      // (١٠) رقم المراجعة يكتبه المحرّك وحده — رقعةٌ تحمله تُرفض «حقل غير معروف».
      await send({ kind: "settings-set", settings: { pluginsRevision: 9 } })
      expect(await readKind("refused")).toMatchObject({ why: "حقل إعدادات غير معروف: pluginsRevision" })
      // إعادة الجرد لئلا يتسرّب الإطفاء إلى بقيّة الحالات.
      await send({ kind: "settings-set", settings: { plugins: { inventory: true } } })
      expect(await readKind("settings")).toMatchObject({ settings: { plugins: { inventory: true } } })

      // Explicit owner memory is a real durable surface, with project/session
      // scope and a reversible forget action. It must round-trip through the
      // same framed carrier used by the desktop settings page.
      await send({ kind: "memory-note", title: "release rule", text: "Keep preview installs isolated", scope: "project", sensitive: false })
      const savedMemory = await readKind("memory-saved")
      expect(savedMemory).toMatchObject({ kind: "memory-saved", title: "release rule", scope: "project" })
      const savedMemoryList = await readKind("memory-notes")
      expect(savedMemoryList).toMatchObject({
        kind: "memory-notes",
        facts: [{ key: "release rule", value: { note: "Keep preview installs isolated", sensitive: false }, scope: "project" }],
      })
      await send({ kind: "memory-forget", id: savedMemory.id })
      expect(await readKind("memory-forgotten")).toMatchObject({ kind: "memory-forgotten", id: savedMemory.id })
      expect(await readKind("memory-notes")).toMatchObject({ kind: "memory-notes", facts: [] })

      const project = resolve(state, "empty-customer-project")
      mkdirSync(project, { recursive: true })
      await send({ kind: "project-set", path: project })
      expect(await readKind("trust-request")).toMatchObject({ kind: "trust-request", path: project })
      await send({ kind: "trust-grant", path: project })
      expect(await readKind("project")).toMatchObject({ kind: "project", path: project, trusted: true })
      expect(existsSync(resolve(project, ".abdocode"))).toBe(false)
      const trustDirectory = resolve(state, "trusted-projects")
      expect(existsSync(trustDirectory)).toBe(true)
      expect(readdirSync(trustDirectory).filter((name) => name.endsWith(".json"))).toHaveLength(1)
    } finally {
      child.kill()
      await child.exited
      rmSync(sandbox, { recursive: true, force: true })
    }
  }, 40_000)

  // القياس الذي أوجب هذا الاختبار: سطرُ رفضٍ واحد على stdout في وضع الأُطر
  // يُقرأ رأسَ طولٍ (u32) — «[plu» = 1534094453 > السقف — فيرفضه المفكِّك
  // وقارئُ Rust معاً، فتُعلن القشرة «المحرّك مات» قبل أن يصل إطار ready.
  // متغيّرٌ واحد مشوَّه كان يكفي. التحذير على stderr، والقناة تبقى نظيفة.
  test("a malformed env pin never touches the frame carrier: it names itself on stderr and ready still decodes", async () => {
    const root = resolve(import.meta.dir, "../../..")
    const state = mkdtempSync(resolve(tmpdir(), "abdo-framed-pin-"))
    const token = "framed-pin-test-token"
    const executable = process.env.ABDO_TEST_ENGINE
    const command = executable === undefined
      ? [process.execPath, "packages/engine/src/cli.ts", "serve"]
      : [executable, "serve"]
    const child = Bun.spawn(command, {
      cwd: root,
      env: {
        ...process.env,
        ABDO_SHELL_TOKEN: token,
        ABDO_FRAMED_STDIO: "1",
        ABDO_CODE_STATE_DIR: state,
        USERPROFILE: state,
        HOME: state,
        // (أ) القيمة الطبيعية التي يكتبها مشغّل: مرفوضة (0/1 فقط).
        ABDO_PLUGIN_MINER: "true",
        // (ب) تثبيتٌ على مفتاحٍ حاكم: مرفوضٌ بالاسم — قارئه `metaOn` لا يرى
        //     التثبيتات أصلاً، فقبولُه كان يُظهر القواعد مطفأةً وهي تُقيَّم.
        ABDO_PLUGIN_RULES: "0",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderrText = new Response(child.stderr).text()
    try {
      const decoder = new LocalJsonFrameDecoder()
      const reader = child.stdout.getReader()
      child.stdin.write(encodeLocalJsonFrame({ kind: "hello", shell: "desktop", token }))
      await child.stdin.flush()
      const waiting: Record<string, unknown>[] = []
      let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
      const deadline = Date.now() + 30_000
      let ready: Record<string, unknown> | undefined
      for (;;) {
        const found = waiting.findIndex((frame) => frame.kind === "ready")
        if (found >= 0) { ready = waiting[found]!; break }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ready; stderr=${(await stderrText).slice(0, 2_000)}`)
        pendingRead ??= reader.read()
        const result = await Promise.race([pendingRead, Bun.sleep(250).then(() => undefined)])
        if (result === undefined) continue
        pendingRead = undefined
        if (result.done) throw new Error("engine ended before ready")
        // لو تسرّب بايتٌ واحد غير إطار إلى stdout لرمى هذا السطر هنا.
        for (const value of decoder.push(result.value)) waiting.push(value as Record<string, unknown>)
      }
      expect(ready).toMatchObject({ kind: "ready", name: "عبدو كود" })
      const registry = ready!.pluginRegistry as {
        effective: Record<string, boolean>
        pins: Record<string, unknown>
        rules: boolean
        context: { os: string }
      }
      // لا تثبيت طُبِّق: لا للقيمة المشوَّهة ولا للمفتاح الحاكم.
      expect(registry.pins).toEqual({})
      expect(registry.effective.miner).toBe(true)
      // والقيمة المعروضة للمفتاح الحاكم هي عينها التي تعمل بها الحلقة.
      expect(registry.effective.rules).toBe(true)
      expect(registry.rules).toBe(true)
      // والسياق مُعلَن بمنصّة العملية لا بـ«other» مفترضة.
      expect(registry.context.os).toBe(
        process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : process.platform === "darwin" ? "macos" : "other",
      )
      child.kill()
      await child.exited
      const stderr = await stderrText
      expect(stderr).toContain("[plugins] ABDO_PLUGIN_MINER=«true» ليس 0/1 — لم يُطبَّق")
      expect(stderr).toContain("[plugins] ABDO_PLUGIN_RULES لا يُثبَّت من البيئة")
    } finally {
      child.kill()
      await child.exited
      rmSync(state, { recursive: true, force: true })
    }
  }, 40_000)

  // ⚠ عطلٌ مقيس على جهاز المالك (2026-09-04): أوّلُ إقلاعٍ بعد إعادة التثبيت
  // يجد قفلاً يتيماً من النسخة السابقة، فكان المحرّك يكتب إعلانَ الاستيلاء
  // بـ`console.log` — **كتابةٌ خام** — بينما القشرةُ تقرأ إطاراتٍ مؤطَّرة.
  // فيقرأ القارئُ الرست البايتاتِ الأربعةَ الأولى طولاً فيرى `{"ki` =
  // ‎2,065,853,289‎ بايت، ويستسلم ويُعلن «engine-died» — **والمحرّكُ حيّ**.
  // ثمّ يردّ الإحياءُ «يعمل بالفعل» لأنّ `try_wait` يقيس العمليةَ لا المجرى:
  // مصدرا حقيقةٍ يقيسان شيئين مختلفين وكلاهما صادق.
  //
  // ولأنّ `pluginRegistry` يأتي في الإطارات، كان غيابُها يُخفي أزرارَ
  // التيرمينال والخوادم والمهامّ ويترك المتصفّحَ بلا محرّك: سببٌ واحد
  // وأربعةُ أعراض بدت أربعةَ أعطال.
  //
  // الفحصُ يسأل **القرصَ لا الدالّة**: يقرأ أوّلَ بايتٍ يخرج فعلاً من العملية.
  test("a reclaimed stale lock is announced as a frame, not a raw line", async () => {
    const root = resolve(import.meta.dir, "../../..")
    const state = mkdtempSync(resolve(tmpdir(), "abdo-framed-stale-lock-"))
    // قفلٌ لصاحبٍ ميت — عينُ ما يجده أوّلُ إقلاعٍ بعد إعادة التثبيت.
    writeFileSync(resolve(state, "serve.lock"), "999999")
    const executable = process.env.ABDO_TEST_ENGINE
    const command = executable === undefined
      ? [process.execPath, "packages/engine/src/cli.ts", "serve"]
      : [executable, "serve"]
    const child = Bun.spawn(command, {
      cwd: root,
      env: {
        ...process.env,
        ABDO_SHELL_TOKEN: "stale-lock-token",
        ABDO_FRAMED_STDIO: "1",
        ABDO_CODE_STATE_DIR: state,
        USERPROFILE: state,
        HOME: state,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const reader = child.stdout.getReader()
      const decoder = new LocalJsonFrameDecoder()
      const frames: Record<string, unknown>[] = []
      let raw = new Uint8Array(0)
      // لا تُرسَل `hello`: الإعلانُ يسبق المصافحة، وهو أوّلُ ما يراه القارئ.
      const deadline = Date.now() + 30_000
      // مقيس 2026-09-14: قراءةٌ جديدة في كلّ دورة كانت تُضيّع القطعةَ التي وصلت إلى القراءة السابقة (الخاسرة في السباق)
      // — فمحرّكٌ يُقلع في أكثر من ٥٠٠ms يبدو صامتاً وهو قد كتب الإعلان. وعدٌ واحدٌ معلَّق يُعاد استعماله حتى يصل.
      let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
      while (frames.length === 0 && Date.now() < deadline) {
        pendingRead ??= reader.read()
        const chunk = await Promise.race([pendingRead, Bun.sleep(500).then(() => undefined)])
        if (chunk === undefined) continue
        pendingRead = undefined
        if (chunk.done) break
        const merged = new Uint8Array(raw.byteLength + chunk.value.byteLength)
        merged.set(raw)
        merged.set(chunk.value, raw.byteLength)
        raw = merged
        for (const frame of decoder.push(chunk.value)) frames.push(frame as Record<string, unknown>)
      }
      // الحكمُ الأوّل على البايتات نفسِها: طولٌ معقول لا نصٌّ يُقرأ طولاً.
      expect(raw.byteLength).toBeGreaterThanOrEqual(4)
      const declared = new DataView(raw.buffer, raw.byteOffset, 4).getUint32(0, false)
      expect(declared).toBeLessThan(1_000_000)
      // والتوأمُ الإيجابي — الأخضرُ هنا لا يعني «لم يخرج شيء»: الإعلانُ وصل.
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ kind: "event", turnId: "serve" })
      expect(String(frames[0]!.payload)).toContain("قفلٌ يتيم")
    } finally {
      child.kill()
      await child.exited
      rmSync(state, { recursive: true, force: true })
    }
  }, 40_000)

  // ⚠ عطلٌ مقيس (2026-09-04): `panelDocks` كان له مُتحقِّقٌ كاملٌ في المحرّك
  // ولم يكن في `SETTINGS_KEYS`. فكلُّ نقلِ لوحٍ يمرّ بالتحقّق ثمّ يُرفض
  // بـ«حقل إعدادات غير معروف» — واللوحُ يتحرّك في الشاشة ولا ينجو من إعادة
  // التشغيل. حارسٌ يُفحص **بعائده** كان يمرّ: الرقعةُ صالحةٌ فعلاً؛ الساقطُ
  // هو الكتابة. فالحكمُ هنا **من القرص**: نقرأ ملفَّ الإعدادات بعد الرقعة.
  test("a panel dock survives to disk — including the anchor above the chat", async () => {
    const root = resolve(import.meta.dir, "../../..")
    const state = mkdtempSync(resolve(tmpdir(), "abdo-panel-docks-"))
    const token = "panel-docks-test-token"
    const settingsFile = resolve(state, "settings.json")
    const executable = process.env.ABDO_TEST_ENGINE
    const command = executable === undefined
      ? [process.execPath, "packages/engine/src/cli.ts", "serve"]
      : [executable, "serve"]
    const child = Bun.spawn(command, {
      cwd: root,
      env: {
        ...process.env,
        ABDO_SHELL_TOKEN: token,
        ABDO_FRAMED_STDIO: "1",
        ABDO_CODE_STATE_DIR: state,
        ABDO_CODE_SETTINGS: settingsFile,
        USERPROFILE: state,
        HOME: state,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const decoder = new LocalJsonFrameDecoder()
      const reader = child.stdout.getReader()
      const seen: Record<string, unknown>[] = []
      let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
      const pump = async (): Promise<void> => {
        pending ??= reader.read()
        const result = await Promise.race([pending, Bun.sleep(250).then(() => undefined)])
        if (result === undefined) return
        pending = undefined
        if (result.done) return
        for (const frame of decoder.push(result.value)) seen.push(frame as Record<string, unknown>)
      }
      const until = async (test: () => boolean, why: string): Promise<void> => {
        const deadline = Date.now() + 30_000
        while (!test()) {
          if (Date.now() >= deadline) throw new Error(`timed out waiting for ${why}; frames=${JSON.stringify(seen).slice(0, 800)}`)
          await pump()
        }
      }
      const send = async (frame: Readonly<Record<string, unknown>>): Promise<void> => {
        child.stdin.write(encodeLocalJsonFrame(frame))
        await child.stdin.flush()
      }

      await send({ kind: "hello", shell: "desktop", token })
      await until(() => seen.some((f) => f.kind === "ready"), "ready")

      // المِرساةُ الرابعة — فوق المحادثة — تدخل مع الثلاث القديمة في رقعةٍ واحدة.
      await send({ kind: "settings-set", settings: { panelDocks: {
        "panel:terminal": "block-start",
        "panel:tasks": "inline-start",
      } } })
      await until(() => seen.some((f) => f.kind === "settings" || f.kind === "refused"), "the settings verdict")

      // (أ) لا رفضَ — والرفضُ هو ما كان يقع، فالفحصُ السلبيُّ هنا له معنى.
      const refusal = seen.find((f) => f.kind === "refused")
      expect(refusal === undefined ? "" : String(refusal.why)).toBe("")

      // (ب) والتوأمُ الإيجابيُّ الحاكم: **القرص**، لا عائدُ الدالّة.
      await until(() => existsSync(settingsFile), "the settings file on disk")
      const onDisk = JSON.parse(readFileSync(settingsFile, "utf-8")) as { panelDocks?: Record<string, string> }
      expect(onDisk.panelDocks).toEqual({ "panel:terminal": "block-start", "panel:tasks": "inline-start" })

      // (ج) ومِرساةٌ لا وجودَ لها تبقى مرفوضةً — القبولُ ليس فتحَ الباب لكلّ اسم.
      await send({ kind: "settings-set", settings: { panelDocks: { "panel:terminal": "block-middle" } } })
      await until(() => seen.some((f) => f.kind === "refused"), "the refusal of an unknown dock")
      expect(String(seen.find((f) => f.kind === "refused")!.why)).toContain("مِرساةٌ غير معروفة")
      // ولم تُفسد المحاولةُ المرفوضةُ ما على القرص.
      const after = JSON.parse(readFileSync(settingsFile, "utf-8")) as { panelDocks?: Record<string, string> }
      expect(after.panelDocks!["panel:terminal"]).toBe("block-start")
    } finally {
      child.kill()
      await child.exited
      rmSync(state, { recursive: true, force: true })
    }
  }, 60_000)
})
