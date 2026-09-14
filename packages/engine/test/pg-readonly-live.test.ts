/**
 * الطبقاتُ الثلاثُ للقراءة — على بوستجرس حقيقيّ، وبمحاولةِ تهريبٍ تعبر الحَكَم.
 *
 * القياسُ الذي أوجب هذا الملفّ (2026-09-04): جملةٌ تبدأ بـ`WITH` تمرّ من الحَكَم
 * الشكليّ وهي **تكتب فعلاً** في بوستجرس:
 *
 *     WITH x AS (INSERT INTO probe … RETURNING id) SELECT * FROM x
 *
 * فلو كان الحَكَمُ الشكليُّ هو الحارسَ لكُتب الصفّ. والذي منعه معاملةُ القراءة:
 * `ERROR 25006 cannot execute SELECT in a read-only transaction`.
 *
 * **والتوأمُ الإيجابيُّ شرطُ المعنى**: الدورُ الذي نتّصل به **يستطيع الكتابة**
 * فعلاً — يُثبَت بإدراجٍ ناجحٍ من خارج خادمنا. بدونه كان «لم يُكتب» يعني
 * «الصلاحيّاتُ تمنع» لا «طبقاتُنا تمنع».
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PgSession } from "../src/mcp-servers/postgres"
import { parseConnectionUrl } from "../src/mcp-servers/pg-wire"

/**
 * مجلّدُ ثنائيّات بوستجرس — **من البيئة أو من المسار**، ولا مسارَ مساحةِ عملٍ
 * مكتوبٌ في مصدرٍ قد يُنشر يوماً. (أمسكها حارسُ الحدّ العامّ في المستودع.)
 */
const onPath = Bun.which("pg_ctl")
const PG_BIN = process.env.ABDO_PG_BIN ?? (onPath === null ? "" : dirname(onPath))
const HAVE_PG = PG_BIN.length > 0 && existsSync(join(PG_BIN, "pg_ctl.exe")) && existsSync(join(PG_BIN, "initdb.exe"))
const PORT = 55_437
const USER = "abdoprobe"
const PASSWORD = "abdoprobe"
const URL = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/postgres`

const run = async (exe: string, args: readonly string[]): Promise<{ code: number; text: string }> => {
  const child = Bun.spawn([join(PG_BIN, exe), ...args], { env: process.env, stdout: "pipe", stderr: "pipe" })
  const text = `${await new Response(child.stdout).text()}\n${await new Response(child.stderr).text()}`
  return { code: await child.exited, text }
}

/**
 * ⚠ أنابيبُ `pg_ctl start` لا تُقرأ أبداً: الخادمُ الوليدُ يرث المقابض فيبقى
 * الأنبوبُ مفتوحاً ما دام يعمل، فقراءتُه تعلّق الفحصَ إلى الأبد (قِيس: 180
 * ثانيةً بلا نتيجة). فالإخراجُ يُهمَل، والجهوزيّةُ تُقاس بالاستجواب لا بالانتظار.
 */
const startCluster = async (data: string, log: string): Promise<boolean> => {
  const child = Bun.spawn(
    [join(PG_BIN, "pg_ctl.exe"), "-D", data, "-o", `-p ${PORT} -c listen_addresses=127.0.0.1`, "-l", log, "start"],
    { env: process.env, stdout: "ignore", stderr: "ignore" },
  )
  if (await child.exited !== 0) return false
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const ready = Bun.spawn([join(PG_BIN, "pg_isready.exe"), "-h", "127.0.0.1", "-p", String(PORT)], { stdout: "ignore", stderr: "ignore" })
    if (await ready.exited === 0) return true
    await Bun.sleep(400)
  }
  return false
}

if (HAVE_PG) describe("بوستجرس حيّ — الطبقاتُ تمنع، لا الصلاحيّات", () => {
  test("جملةٌ تعبر الحَكَمَ الشكليَّ وتكتب: يرفضها المحرّك، والدورُ يكتب من خارجنا", async () => {
    const home = mkdtempSync(join(tmpdir(), "abdo-pg-live-"))
    const data = join(home, "pgdata")
    const passFile = join(home, "pw.txt")
    writeFileSync(passFile, PASSWORD)
    try {
      const init = await run("initdb.exe", ["-D", data, "-U", USER, "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", `--pwfile=${passFile}`, "-E", "UTF8"])
      expect(`initdb=${init.code}`).toBe("initdb=0")
      expect(`started=${await startCluster(data, join(home, "pg.log"))}`).toBe("started=true")
      try {
        const seed = await run("psql.exe", [URL, "-c", "CREATE TABLE probe (id serial primary key, name text); INSERT INTO probe (name) VALUES ('a'),('b'),('c');"])
        expect(`seed=${seed.code}`).toBe("seed=0")

        const info = parseConnectionUrl(URL)
        expect("refusal" in info).toBe(false)
        if ("refusal" in info) return
        // ⚠ ومصادقةُ SCRAM هنا حقيقيّة: العنقودُ أُنشئ بـscram-sha-256 حصراً.
        const opened = await PgSession.open(info)
        expect("refusal" in opened ? (opened as { refusal: string }).refusal : "").toBe("")
        if ("refusal" in opened) return
        const session = opened
        try {
          // القراءةُ تعمل — وإلّا كان كلُّ ما بعده بلا معنى.
          const counted = await session.read("SELECT count(*) AS n FROM probe")
          expect("refusal" in counted ? "" : counted.rows[0]![0]).toBe("3")

          // التهريبُ: يبدأ بـWITH فيعبر الشكل، ويكتب فعلاً في بوستجرس.
          const smuggled = await session.read(
            "WITH x AS (INSERT INTO probe (name) VALUES ('مهرّب') RETURNING id) SELECT * FROM x",
          )
          expect("refusal" in smuggled).toBe(true)
          if ("refusal" in smuggled) expect(smuggled.refusal).toContain("read-only transaction")

          // ولم يُكتب شيء.
          const after = await session.read("SELECT count(*) AS n FROM probe")
          expect("refusal" in after ? "" : after.rows[0]![0]).toBe("3")
        } finally {
          session.close()
        }

        // **التوأمُ الإيجابيّ**: الدورُ نفسُه يكتب من خارج خادمنا — فالمنعُ
        // أعلاه من طبقاتنا لا من صلاحيّةٍ ناقصة.
        const wrote = await run("psql.exe", [URL, "-c", "INSERT INTO probe (name) VALUES ('من الخارج');"])
        expect(`write=${wrote.code}`).toBe("write=0")
        const now = await run("psql.exe", [URL, "-tAc", "SELECT count(*) FROM probe;"])
        expect(now.text.trim().split("\n")[0]!.trim()).toBe("4")
      } finally {
        await run("pg_ctl.exe", ["-D", data, "-m", "immediate", "stop"])
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 180_000)
})

if (!HAVE_PG) describe("بوستجرس حيّ — متعذّر", () => {
  test("لا ثنائيّاتِ بوستجرس على هذا الجهاز، فالفحصُ الحيُّ لا يُدّعى", () => {
    // تخطٍّ **مسمّى**: فحصٌ يُتخطّى بصمتٍ يُقرأ نجاحاً في تقرير أخضر. لتشغيله
    // اضبط `ABDO_PG_BIN` على مجلّد ثنائيّات بوستجرس، أو ضعها في المسار.
    expect(HAVE_PG).toBe(false)
  })
})
