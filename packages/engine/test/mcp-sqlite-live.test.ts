/**
 * الحلقةُ كاملةً بخادمٍ كتبناه — لا حزمةَ نُزِّلت.
 *
 * أمرُ المالك: «لا تنزّل حزمة، أنشئه» و«خذ من كودهم بدون أبوابٍ خلفيّة». فهذا
 * الفحصُ يصل الطرفين: خادمُ MCP خاصّتنا (أمرٌ فرعيٌّ في ثنائيّنا نفسِه) يُوصَل
 * بعميلِ MCP خاصّتنا، وأدواتُه تدخل الكتالوجَ منسوبةً، ونداءٌ يقف على بوّابة
 * الموافقة ثمّ ينفَّذ ويعود بصفٍّ من قاعدةٍ حقيقيّة.
 *
 * وهو أيضاً القياسُ الذي لا يستطيعه فحصُ وحدة: أنّ الأدواتَ تصل **بصنف
 * `command`** ولو كان الخادمُ خادمَنا — إقرارُ خادمٍ عن نفسه ليس دليلاً، ولا
 * تُشتقّ ثقةٌ من كوننا كتبناه.
 */
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

const REPO = resolve(import.meta.dir, "../../..")
const forward = (path: string): string => path.split("\\").join("/")

describe("خادمُ SQLite خاصّتنا — عبر عميل MCP والمحرّك الحيّ", () => {
  test("يُوصَل، وتدخل أدواتُه الكتالوجَ بصنف command، ونداءٌ يمرّ بالبوّابة ويعود بصفّ", async () => {
    const state = mkdtempSync(join(tmpdir(), "abdo-sqlite-live-"))
    const dbPath = join(state, "dev.db")
    const seed = new Database(dbPath, { create: true })
    seed.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)")
    seed.run("INSERT INTO users (name) VALUES ('نورة'), ('عمر'), ('سارة')")
    seed.close()

    const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], {
      cwd: REPO,
      env: {
        ...process.env,
        ABDO_SHELL_TOKEN: "sqlite-live-token",
        ABDO_FRAMED_STDIO: "1",
        ABDO_CODE_STATE_DIR: state,
        ABDO_CODE_SETTINGS: join(state, "settings.json"),
        ABDO_VAULT_HOME: state,
        ABDO_PLUGIN_MCP_CLIENT: "1",
        USERPROFILE: state,
        HOME: state,
      },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    })
    try {
      const decoder = new LocalJsonFrameDecoder()
      const reader = child.stdout.getReader()
      const seen: Record<string, unknown>[] = []
      let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
      const until = async (test: () => boolean, why: string): Promise<void> => {
        const deadline = Date.now() + 60_000
        while (!test()) {
          if (Date.now() >= deadline) throw new Error(`timed out waiting for ${why}; frames=${JSON.stringify(seen).slice(0, 1200)}`)
          pending ??= reader.read()
          const got = await Promise.race([pending, Bun.sleep(150).then(() => undefined)])
          if (got === undefined) continue
          pending = undefined
          if (got.done) return
          for (const frame of decoder.push(got.value)) seen.push(frame as Record<string, unknown>)
        }
      }
      const send = async (frame: Readonly<Record<string, unknown>>): Promise<void> => {
        child.stdin.write(encodeLocalJsonFrame(frame))
        await child.stdin.flush()
      }

      await send({ kind: "hello", shell: "desktop", token: "sqlite-live-token" })
      await until(() => seen.some((f) => f.kind === "ready"), "ready")

      // خادمُنا يُشغَّل كأيّ خادمٍ خارجيّ: أمرٌ فرعيٌّ في ثنائيّنا، لا حزمة.
      await send({
        kind: "external-connect",
        id: "db",
        protocol: "mcp",
        command: [process.execPath, join(REPO, "packages/engine/src/cli.ts"), "mcp-sqlite", forward(dbPath)],
      })
      await until(() => seen.some((f) => f.kind === "external" || f.kind === "refused"), "the connect verdict")
      const refusal = seen.find((f) => f.kind === "refused")
      expect(refusal === undefined ? "" : String(refusal.why)).toBe("")

      const announced = seen.find((f) => f.kind === "external")!
      const tools = announced.tools as { name: string; effect: string; usage: string }[]
      expect(tools.map((t) => t.name).sort()).toEqual(["db.query", "db.schema", "db.tables"])
      // ⚠ خادمُنا نحن — والصنفُ `command` مع ذلك. لا ثقةَ تُشتقّ من الملكيّة.
      expect([...new Set(tools.map((t) => t.effect))]).toEqual(["command"])
      // والصيغةُ منسوبةٌ ومبنيّةٌ من المخطّط.
      expect(tools.find((t) => t.name === "db.query")!.usage).toBe("db.query <sql>")
      expect(tools.find((t) => t.name === "db.schema")!.usage).toBe("db.schema <table>")

      // نداءٌ حقيقيّ: يقف على البوّابة (صنف command في «قراءة فقط»).
      await send({ kind: "submit", turn: { id: "q1", body: 'db.query {"sql":"SELECT COUNT(*) AS n FROM users"}' } })
      await until(() => seen.some((f) => f.kind === "approval"), "the approval")
      expect(seen.find((f) => f.kind === "approval")!.target).toBe("db.query")

      await send({ kind: "approve", turnId: "q1" })
      // جوابُ الدور يصل أسطراً في إطارات `event` — لا `tool-result`: المسارُ
      // المباشر (الكلمةُ الأولى أداة) يوزّع رأساً بلا حلقةِ نموذج.
      await until(() => seen.some((f) => f.kind === "done" && f.turnId === "q1"), "the first turn to finish")
      const answered = seen
        .filter((f) => f.kind === "event" && f.turnId === "q1")
        .map((f) => String(f.payload ?? "")).join(" ⏎ ")
      // ثلاثةُ صفوفٍ زُرعت — والعددُ يعود من قاعدةٍ حقيقيّةٍ عبر أنبوبٍ حقيقيّ.
      expect(answered).toContain("n")
      expect(answered).toContain("3")

      // ومحاولةُ كتابةٍ عبر السلسلة كلِّها: تُرفض ولا تصل القرص.
      await send({ kind: "submit", turn: { id: "q2", body: 'db.query {"sql":"DELETE FROM users"}' } })
      await until(() => seen.filter((f) => f.kind === "approval").length >= 2, "the second approval")
      await send({ kind: "approve", turnId: "q2" })
      await until(() => seen.some((f) => f.kind === "done" && f.turnId === "q2"), "the second turn to finish")
      const refusedAnswer = seen
        .filter((f) => f.kind === "event" && f.turnId === "q2")
        .map((f) => String(f.payload ?? "")).join(" ⏎ ")
      expect(refusedAnswer).toContain("ليست قراءة")

      // والقاعدةُ كما كانت — القرصُ يشهد بعد رحلةٍ كاملةٍ عبر المنتَج.
      const after = new Database(dbPath, { readonly: true, create: false })
      expect((after.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(3)
      after.close()
    } finally {
      child.kill()
      await child.exited
      rmSync(state, { recursive: true, force: true })
    }
  }, 150_000)
})
