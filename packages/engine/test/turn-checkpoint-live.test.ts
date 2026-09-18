/**
 * م9ط حيّاً — المحرّكُ الحقيقيّ عبر stdio المؤطَّر: دورٌ يكتب ملفّاً قائماً ودورٌ ينشئ ملفّاً، ثمّ «checkpoints» تسردهما،
 * و«rollback <دور>» يعيد القرصَ إلى ما قبل ذلك الدور وحده. الحكمُ من القرص لا من الجواب.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const REPO = resolve(import.meta.dir, "../../..")

describe("turn checkpoints — live engine", () => {
  test("write, create, list, rollback one turn, rollback the other — measured on disk", async () => {
    const state = mkdtempSync(join(tmpdir(), "abdo-ckpt-live-"))
    const project = join(state, "proj"); mkdirSync(project)
    writeFileSync(join(project, "a.txt"), "v1")
    const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
      cwd: REPO,
      env: {
        ...process.env,
        ABDO_SHELL_TOKEN: "ckpt-token", ABDO_FRAMED_STDIO: "1", ABDO_CODE_STATE_DIR: state,
        ABDO_CODE_SETTINGS: join(state, "settings.json"), ABDO_VAULT_HOME: state, USERPROFILE: state, HOME: state,
        ABDO_TEST_NATIVE_BINARY_DIR: process.env.ABDO_TEST_NATIVE_BINARY_DIR ?? resolve(REPO, "packages/desktop/src-tauri/payload/bin"),
      },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    })
    const decoder = new LocalJsonFrameDecoder()
    const reader = child.stdout.getReader()
    const seen: Record<string, unknown>[] = []
    let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
    const until = async (probe: () => boolean, why: string): Promise<void> => {
      const deadline = Date.now() + 60_000
      while (!probe()) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${why}; frames=${JSON.stringify(seen.map((f) => ({ kind: f.kind, turnId: f.turnId, why: f.why, payload: String(f.payload ?? "").slice(0, 120) }))).slice(0, 3000)}`)
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
      await until(() => seen.some((f) => (f.kind === "done" || f.kind === "unresolved") && f.turnId === id), `${id} to finish`)
      return seen.filter((f) => f.kind === "event" && f.turnId === id).map((f) => String(f.payload)).join("\n")
    }
    try {
      await send({ kind: "hello", shell: "desktop", token: "ckpt-token" })
      await until(() => seen.some((f) => f.kind === "ready"), "ready")
      await send({ kind: "project-set", path: project })
      await until(() => seen.some((f) => f.kind === "trust-request"), "trust request")
      await send({ kind: "trust-grant", path: project })
      await until(() => seen.some((f) => f.kind === "project"), "project")
      await send({ kind: "mode-set", mode: "full-access" })
      await until(() => seen.some((f) => f.kind === "mode"), "mode")

      const t1 = await turn("t1", "write a.txt <<< v2")
      expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("v2")
      // إطارُ done للدور الكاتب يحمل عددَ الملفّات المحفوظة (زرُّ الرجوع في القشرة يقوم عليه)
      expect(seen.find((f) => f.kind === "done" && f.turnId === "t1")).toMatchObject({ checkpointFiles: 1 })
      expect(t1).toContain("a.txt")
      await turn("t2", "write new.txt <<< n1")
      expect(readFileSync(join(project, "new.txt"), "utf8")).toBe("n1")

      const listed = await turn("t3", "checkpoints")
      expect(listed).toContain("t1"); expect(listed).toContain("t2")
      // نقطةٌ لدورٍ لم يكتب: لا شيء
      expect(existsSync(join(state, "checkpoints"))).toBe(true)

      const back2 = await turn("t4", "rollback t2")
      expect(back2).toContain("استُعيد ما قبل الدور t2")
      expect(existsSync(join(project, "new.txt"))).toBe(false)
      expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("v2") // دورٌ آخر لا يُمسّ

      const back1 = await turn("t5", "ارجع إلى ما قبل الدور t1")
      expect(back1).toContain("استُعيد ما قبل الدور t1")
      expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("v1")

      const missing = await turn("t6", "rollback t99")
      expect(missing).toContain("لا نقطةَ رجوعٍ")
      // الحدثُ مرّةٌ واحدة لكلّ رجوعٍ ناجح — لا تكرارَ للسطر في السجلّ
      expect(seen.filter((f) => f.kind === "event" && f.turnId === "t4" && String(f.payload).includes("استُعيد ما قبل الدور t2"))).toHaveLength(1)
    } finally {
      child.kill(); await child.exited
      rmSync(state, { recursive: true, force: true })
    }
  }, 120_000)
})
