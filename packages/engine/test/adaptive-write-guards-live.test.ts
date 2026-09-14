/**
 * م11 حيّاً على المحرّك الحقيقيّ (stdio مؤطَّر، بلا نموذج — كلماتُ المشغّل): ملفٌّ ٥٫٥ك حرفاً ثمّ `write` بسطرٍ واحد ⇦ يُرفض
 * ويبقى الملفُّ كما كان (القرصُ حَكَم)؛ `write --shrink` بالسطر نفسِه ⇦ يمرّ ويصير الملفُّ سطراً. والتحريرُ بنصٍّ خاطئ مرّتين ⇦
 * الرفضُ الثاني يحمل «أعد كتابته كاملاً» (المزوّدُ المحلّيّ الافتراضيّ أولاما ⇦ قضبانٌ غيرُ رفيعة).
 * أسلاكُ المصدر مثبَّتة أيضاً: الحارسُ بعد خطّ الأساس وقبل معاينة الفرق، وقبل البوّابة.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const REPO = resolve(import.meta.dir, "../../..")
const source = await Bun.file(new URL("../src/cli.ts", import.meta.url)).text()

describe("adaptive write guards — wiring pins", () => {
  test("shrink guard sits after the baseline read and before the diff preview; edit refusals carry the escalation tail", () => {
    const baseline = source.indexOf('const baseline = word === "write" ? diskBefore : before')
    const shrink = source.indexOf("const shrink = shrinkViolation(diskBefore, after, railTier, shrinkIntended)", baseline)
    const diff = source.indexOf("const diff = unifiedDiff(baseline ?? before, after, target)", baseline)
    expect(baseline).toBeGreaterThan(0); expect(shrink).toBeGreaterThan(baseline); expect(diff).toBeGreaterThan(shrink)
    expect(source.match(/editRefusals\.refused\(turnId, checked0\.abs, railTier, before\.length\)/gu) ?? []).toHaveLength(3)
    expect(source).toContain("const railTier = railsFor(`${ASK_PROVIDER}/${ASK_MODEL}`).tier")
    expect(source).toContain("if (target.startsWith(`${SHRINK_FLAG} `)) { shrinkIntended = true; target = target.slice(SHRINK_FLAG.length).trim() }")
  })
})

describe("adaptive write guards — live engine", () => {
  test.skipIf(process.platform !== "win32")("a wiping write is refused and the disk is untouched; --shrink passes; repeated bad edits escalate", async () => {
    const state = mkdtempSync(join(tmpdir(), "abdo-shrink-live-"))
    const project = join(state, "proj"); mkdirSync(project)
    const big = "import bpy\n".repeat(500)
    writeFileSync(join(project, "build_scene.py"), big)
    // قضبانٌ صارمة صراحةً (نموذجٌ ضعيف): التصعيدُ من الرفض الأوّل، والحارسُ عند ٢٥٪
    writeFileSync(join(state, "settings.json"), JSON.stringify({ railPolicy: "strict" }))
    const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
      cwd: REPO,
      env: { ...process.env, ABDO_SHELL_TOKEN: "shrink-token", ABDO_FRAMED_STDIO: "1", ABDO_CODE_STATE_DIR: state, ABDO_CODE_SETTINGS: join(state, "settings.json"), ABDO_VAULT_HOME: state, USERPROFILE: state, HOME: state, ABDO_TEST_NATIVE_BINARY_DIR: process.env.ABDO_TEST_NATIVE_BINARY_DIR ?? resolve(REPO, "packages/desktop/src-tauri/payload/bin") },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    })
    const decoder = new LocalJsonFrameDecoder()
    const reader = child.stdout.getReader()
    const seen: Record<string, unknown>[] = []
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
    const until = async (probe: () => boolean, why: string): Promise<void> => {
      const deadline = Date.now() + 60_000
      while (!probe()) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${why}; frames=${JSON.stringify(seen.map((f) => ({ kind: f.kind, turnId: f.turnId, payload: String(f.payload ?? "").slice(0, 120) }))).slice(0, 3000)}`)
        pending ??= reader.read()
        const got = await Promise.race([pending, Bun.sleep(120).then(() => undefined)])
        if (got === undefined) continue
        pending = undefined
        if (got.done) return
        for (const frame of decoder.push(got.value)) seen.push(frame as Record<string, unknown>)
      }
    }
    const send = async (frame: Readonly<Record<string, unknown>>): Promise<void> => { child.stdin.write(encodeLocalJsonFrame(frame)); await child.stdin.flush() }
    const turn = async (id: string, body: string): Promise<string> => {
      await send({ kind: "submit", turn: { id, body } })
      await until(() => seen.some((f) => (f.kind === "done" || f.kind === "unresolved" || f.kind === "refused") && f.turnId === id), `${id} to finish`)
      return seen.filter((f) => f.kind === "event" && f.turnId === id).map((f) => String(f.payload)).join("\n")
    }
    try {
      await send({ kind: "hello", shell: "desktop", token: "shrink-token" })
      await until(() => seen.some((f) => f.kind === "ready"), "ready")
      await send({ kind: "project-set", path: project })
      await until(() => seen.some((f) => f.kind === "trust-request"), "trust request")
      await send({ kind: "trust-grant", path: project })
      await until(() => seen.some((f) => f.kind === "project"), "project")
      await send({ kind: "mode-set", mode: "full-access" })
      await until(() => seen.some((f) => f.kind === "mode"), "mode")

      const wipe = await turn("t1", 'write build_scene.py <<< print("Scene built successfully")')
      expect(wipe).toContain("رُفضت الكتابة: تُسقط")
      expect(wipe).toContain("--shrink")
      expect(readFileSync(join(project, "build_scene.py"), "utf8")).toBe(big) // القرصُ لم يُمسّ

      const e1 = await turn("t2", 'edit build_scene.py :: print("nope") => print("yes")')
      expect(e1).toContain("غير موجود حرفياً")
      // قضبانٌ صارمة: النصيحةُ بإعادة الكتابة من الرفض الأوّل، بعدّاد الدور والملفّ
      expect(e1).toContain("هذا الرفض رقم 1")
      expect(e1).toContain("أعد كتابته كاملاً")

      const intended = await turn("t4", 'write --shrink build_scene.py <<< print("Scene built successfully")')
      expect(intended).not.toContain("رُفضت الكتابة: تُسقط")
      expect(readFileSync(join(project, "build_scene.py"), "utf8").trim()).toBe('print("Scene built successfully")')
    } finally {
      child.kill(); await child.exited
      for (let i = 0; i < 20; i += 1) { try { rmSync(state, { recursive: true, force: true }); break } catch { await Bun.sleep(250) } }
    }
  }, 120_000)
})
