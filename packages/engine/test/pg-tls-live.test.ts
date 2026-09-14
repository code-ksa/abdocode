/**
 * تفاوضُ TLS مع بوستجرس — والتحقّقُ من الشهادة يُقاس **بفشله عند وجوبه**.
 *
 * حارسُ التحقّق أسهلُ الحرّاس ادّعاءً وأصعبُها إثباتاً: شهادةٌ صحيحةٌ تمرّ سواءٌ
 * تحقّقتَ أم لا. فالقياسُ الحاكم هنا معكوس: عنقودٌ بشهادةٍ **موقَّعةٍ ذاتيّاً**،
 * ثمّ:
 *
 *   • `sslmode=require`      ⇒ يتّصل (تشفيرٌ بلا تحقّق — دلالةُ libpq).
 *   • `sslmode=verify-full`  ⇒ **يُرفض**، لأنّ الموقِّعَ غيرُ موثوق.
 *   • `sslmode=disable`      ⇒ يتّصل عارياً على المحلّيّ.
 *
 * لو مرّ `verify-full` لكان التحقّقُ زينةً. وهذا الفحصُ هو ما يمنع ذلك.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PgSession } from "../src/mcp-servers/postgres"
import { parseConnectionUrl } from "../src/mcp-servers/pg-wire"

const onPath = Bun.which("pg_ctl")
const PG_BIN = process.env.ABDO_PG_BIN ?? (onPath === null ? "" : dirname(onPath))
const OPENSSL = Bun.which("openssl")
const HAVE = PG_BIN.length > 0 && existsSync(join(PG_BIN, "pg_ctl.exe")) && OPENSSL !== null
const PORT = 55_439
const USER = "abdotls"
const PASSWORD = "abdotls"
const base = `${USER}:${PASSWORD}@127.0.0.1:${PORT}/postgres`

const run = async (exe: string, args: readonly string[]): Promise<number> => {
  const child = Bun.spawn([exe, ...args], { env: process.env, stdout: "pipe", stderr: "pipe" })
  await new Response(child.stdout).text()
  await new Response(child.stderr).text()
  return child.exited
}

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

const connect = async (query: string): Promise<{ ok: boolean; why: string }> => {
  const info = parseConnectionUrl(`postgresql://${base}${query}`)
  if ("refusal" in info) return { ok: false, why: info.refusal }
  const opened = await PgSession.open(info)
  if ("refusal" in opened) return { ok: false, why: opened.refusal }
  opened.close()
  return { ok: true, why: "" }
}

if (HAVE) describe("تفاوضُ TLS — التحقّقُ يُثبَت بفشله", () => {
  test("require يمرّ على شهادةٍ ذاتيّة، وverify-full يُرفض، وdisable يمرّ عارياً", async () => {
    const home = mkdtempSync(join(tmpdir(), "abdo-pgtls-"))
    const data = join(home, "pgdata")
    const passFile = join(home, "pw.txt")
    writeFileSync(passFile, PASSWORD)
    try {
      expect(`initdb=${await run(join(PG_BIN, "initdb.exe"), ["-D", data, "-U", USER, "--auth-host=scram-sha-256", `--pwfile=${passFile}`, "-E", "UTF8"])}`).toBe("initdb=0")

      // شهادةٌ موقَّعةٌ ذاتيّاً: صالحةٌ للتشفير، **غيرُ موثوقةٍ** للتحقّق.
      const key = join(data, "server.key")
      const cert = join(data, "server.crt")
      expect(`openssl=${await run(OPENSSL!, [
        "req", "-new", "-x509", "-days", "2", "-nodes", "-text",
        "-out", cert, "-keyout", key, "-subj", "/CN=127.0.0.1",
      ])}`).toBe("openssl=0")
      // بوستجرس يرفض مفتاحاً واسعَ الصلاحيّات — وعلى ويندوز يكفي وجودُه.
      writeFileSync(join(data, "postgresql.auto.conf"), [
        "ssl = on",
        `ssl_cert_file = '${cert.split("\\").join("/")}'`,
        `ssl_key_file = '${key.split("\\").join("/")}'`,
        "",
      ].join("\n"))

      expect(`started=${await startCluster(data, join(home, "pg.log"))}`).toBe("started=true")
      try {
        // (١) تشفيرٌ بلا تحقّق: يمرّ.
        const required = await connect("?sslmode=require")
        expect(`require: ${required.ok} ${required.why}`).toBe("require: true ")

        // (٢) ⚠ الحاكم: التحقّقُ يرفض الموقِّعَ غيرَ الموثوق. لو مرّ لكان زينةً.
        const verified = await connect("?sslmode=verify-full")
        expect(verified.ok).toBe(false)
        expect(`${verified.why.includes("TLS")} :: ${verified.why.slice(0, 60)}`).toContain("true")

        // (٣) والعاري يمرّ على المحلّيّ حين يُطلب صراحةً.
        const plain = await connect("?sslmode=disable")
        expect(`disable: ${plain.ok} ${plain.why}`).toBe("disable: true ")
      } finally {
        await run(join(PG_BIN, "pg_ctl.exe"), ["-D", data, "-m", "immediate", "stop"])
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }, 180_000)
})

if (!HAVE) describe("تفاوضُ TLS — متعذّر", () => {
  test("تخطٍّ مسمّى: يلزم بوستجرس وopenssl على هذا الجهاز", () => {
    // فحصٌ يُتخطّى بصمتٍ يُقرأ نجاحاً في تقرير أخضر — فيُقال سببُه.
    expect(HAVE).toBe(false)
  })
})
