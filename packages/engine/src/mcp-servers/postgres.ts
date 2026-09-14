/**
 * خادمُ MCP لبوستجرس — **قراءةً فقط**، بسلكٍ كتبناه ولا حزمةَ تُنزَّل.
 *
 * مشاريعُ المالك على Prisma وPostgres، فهذا هو الخادمُ الذي يخدم فعلاً — وأخوه
 * `sqlite.ts` يخدم قواعدَ التطوير الصغيرة. والحَكَمُ المشترك (`read-only-sql`)
 * واحدٌ للاثنين، فلا نسخةَ ثانية.
 *
 * ═══ الاعتمادُ من البيئة، لا من سطر الأمر ═══
 *
 * رابطُ الاتصال يحمل كلمةَ المرور، **وسطرُ أمرِ أيّ عمليّةٍ مقروءٌ لكلّ عمليّةٍ
 * على الجهاز** — القاعدةُ نفسُها التي تحكم الخزنة. فالرابطُ يُقرأ من
 * `ABDO_PG_URL` في بيئة العمليّة، وهي تصلها عبر **منح الاعتماد** الذي بُني
 * اليوم: قيمةٌ في الخزنة، ومقبضٌ في الإعدادات، وحقنٌ في البيئة عند التوصيل.
 * فلا سرَّ في إعدادٍ ولا في سطرِ أمرٍ ولا في سجلّ.
 *
 * ═══ ثلاثُ طبقاتٍ للقراءة، لا واحدة ═══
 *
 * ١) **الجلسةُ تُضبط للقراءة** بـ`default_transaction_read_only = on` فور
 *    الاتّصال: المحرّكُ نفسُه يرفض الكتابة بعدها.
 * ٢) **وكلُّ استعلامٍ يُلفّ في معاملةٍ للقراءة** (`BEGIN READ ONLY`) — حزامٌ
 *    فوق الحمّالة، لأنّ إعداد الجلسة يمكن أن يُغيَّر بجملةٍ لو أفلتت.
 * ٣) **والحَكَمُ الشكليّ** يقول سبباً مفهوماً ويسدّ ما لا يسدّه المحرّك:
 *    `COPY … TO PROGRAM` و`pg_read_file` و`dblink` و`pg_ls_dir` — قراءاتٌ
 *    تخرج من القاعدة إلى قرصِ الخادم وشبكتِه.
 *
 * والدورُ الذي تتّصل به مسؤوليّةُ المشغّل: أنظفُ إعدادٍ دورٌ لا يملك إلا
 * `SELECT`. والطبقاتُ الثلاث لمن لم يفعل.
 */

import { judgeReadOnly, type SqlVerdict } from "./read-only-sql"
import {
  concat, cstring, describeError, dataRow, isLocalHost, md5Response, newClientNonce, parseConnectionUrl,
  readMessages, rowDescription, scramProof, serverSignatureMatches, sslRequestMessage, startupMessage, tagged,
  type PgConnectionInfo, type PgMessage,
} from "./pg-wire"

export const PG_MCP_PROTOCOL = "2025-11-25"
export const MAX_ROWS = 200
export const MAX_TEXT = 8_000
export const PG_URL_ENV = "ABDO_PG_URL"

/**
 * ما يُرفض أينما وقع: قراءاتٌ تخرج من القاعدة إلى القرص أو الشبكة، وكتابةٌ
 * متنكّرةٌ في ثوب قراءة.
 */
export const PG_FORBIDDEN: readonly string[] = Object.freeze([
  "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_stat_file",
  "lo_import", "lo_export", "dblink", "postgres_fdw", "copy ", "pg_terminate", "pg_cancel",
  "set session", "set local", "reset ",
])

export const judgeStatement = (raw: string): SqlVerdict => judgeReadOnly(raw, PG_FORBIDDEN)

export interface QueryResult {
  readonly columns: readonly string[]
  readonly rows: readonly (readonly (string | null)[])[]
  readonly notice?: string
}

/** صفوفٌ ← نصٌّ مقروء، بسقفَين، والقطعُ يُعلَن. */
export const renderResult = (result: QueryResult): string => {
  if (result.columns.length === 0) return "(بلا أعمدة)"
  if (result.rows.length === 0) return `${result.columns.join(" | ")}\n(لا صفوف)`
  const shown = result.rows.slice(0, MAX_ROWS)
  const lines = [result.columns.join(" | "), result.columns.map(() => "---").join(" | ")]
  for (const row of shown) lines.push(row.map((value) => value ?? "NULL").join(" | "))
  if (result.rows.length > shown.length) lines.push(`… وقُطع ${result.rows.length - shown.length} صفّاً عند سقف ${MAX_ROWS}`)
  const text = lines.join("\n")
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… وقُطع النصُّ عند سقف ${MAX_TEXT} محرفاً` : text
}

/** اتّصالٌ حيّ: يرسل استعلاماً بسيطاً ويقرأ حتى `ReadyForQuery`. */
export class PgSession {
  /** ليس `readonly`: الترقيةُ إلى TLS تستبدل المقبسَ بآخر. */
  #socket: import("bun").Socket<undefined>
  /** `ssl` = ننتظر بايتَ الجواب الواحد؛ `messages` = بروتوكولُ الرسائل. */
  #phase: "ssl" | "messages" = "messages"
  #sslAnswer: ((answer: string) => void) | undefined
  /** هل السلكُ مشفَّرٌ فعلاً؟ يُقرأ في حارس المصادقة الضعيفة. */
  #encrypted = false
  // ‏`ArrayBufferLike`: ما يعود من `slice` على مخزّنٍ وارد ليس بالضرورة
  // `ArrayBuffer` الضيّق، والتضييقُ هنا يكذب على النوع لا على الواقع.
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  #waiting: ((messages: PgMessage[]) => void) | undefined
  #queue: PgMessage[] = []
  #closed = false

  private constructor(socket: import("bun").Socket<undefined>) { this.#socket = socket }

  /** يفتح جلسةً مصادَقةً جاهزةً للقراءة، أو يعيد رفضاً مسمّى. */
  static async open(info: PgConnectionInfo): Promise<PgSession | { readonly refusal: string }> {
    let session: PgSession | undefined
    // ⚠ الإغلاقُ يُحسب **من المقبس الجاري وحده**. الترقيةُ إلى TLS تُغلق المقبسَ
    // الخام، فيُعلن خطّافُه موتَ الجلسة بينما المقبسُ المشفَّر حيٌّ يعمل —
    // وهو ما قِيس: المصافحةُ تنجح ثمّ «أُغلق الاتصالُ أثناء المصادقة».
    const current = (socket: unknown): boolean => session !== undefined && socket === session.#socket
    const handlers = {
      // ⚠ والبياناتُ كذلك: المقبسُ الخامُّ يبقى موصولاً بعد الترقية ويستقبل
      // **نصَّ التشفير**. حقنُه في مُقسِّم الرسائل يفسده — قِيس: 1337 بايتاً من
      // المصافحة تدخل المُقسِّمَ قبل أوّل رسالةٍ حقيقيّة.
      data(socket: unknown, data: Uint8Array) { if (current(socket)) session!.push(data) },
      close(socket: unknown) { if (current(socket)) session!.#closed = true },
      error(socket: unknown) { if (current(socket)) session!.#closed = true },
    }
    const socket = await Bun.connect({
      hostname: info.host,
      port: info.port,
      socket: handlers as never,
    }).catch((cause: unknown) => ({ failure: cause instanceof Error ? cause.message : String(cause) }))
    if ("failure" in (socket as { failure?: string })) {
      return { refusal: `تعذّر الاتصال بـ${info.host}:${info.port} — ${(socket as { failure: string }).failure}` }
    }
    session = new PgSession(socket as import("bun").Socket<undefined>)

    // ── التفاوضُ على التشفير، قبل أيّ رسالةِ بروتوكول ──────────────────────
    if (info.sslMode !== "disable") {
      const answer = await session.#negotiateTls()
      if (answer === "S") {
        // ⚠ المصافحةُ **لا تكتمل عند العودة**: `upgradeTLS` تُرجع فوراً
        // والمصافحةُ تجري بعدها. الكتابةُ قبل تمامها تضيع، فيصمت الخادمُ ثمّ
        // يُغلق — وهو ما قِيس بالضبط: «أُغلق الاتصالُ أثناء المصادقة» في
        // الوضعين المشفَّرين بينما العاري يمرّ. فالانتظارُ لخطّاف `handshake`،
        // وهو نفسُه من يعطي **سببَ رفض الشهادة** فلا نخترعه.
        const settled = await new Promise<{ ok: boolean; why?: string }>((resolve) => {
          const timer = setTimeout(() => resolve({ ok: false, why: "انتهت مهلةُ المصافحة" }), 15_000)
          timer.unref?.()
          try {
            const [, upgraded] = (session!.#socket as unknown as {
              upgradeTLS: (options: unknown) => [unknown, import("bun").Socket<undefined>]
            }).upgradeTLS({
              data: undefined,
              // ‏`require` لا يتحقّق من الشهادة — وهي دلالةُ libpq نفسُها لا
              // تساهلٌ من عندنا. و`verify-full` تتحقّق من السلسلة ومن الاسم.
              tls: { serverName: info.host, rejectUnauthorized: info.sslMode === "verify-full" },
              socket: {
                ...handlers,
                handshake(_socket: unknown, success: boolean, authorizationError: unknown) {
                  clearTimeout(timer)
                  const why = String((authorizationError as { message?: string } | undefined)?.message ?? authorizationError ?? "")
                  if (!success) { resolve({ ok: false, why: why.length > 0 ? why : "فشلت المصافحة" }); return }
                  // ⚠ مقيس (2026-09-04): `upgradeTLS` في Bun 1.3.14 يُبلّغ
                  // `success = true` **ولو كانت الشهادةُ غيرَ موثوقة** ورغم
                  // `rejectUnauthorized: true` — ويضع السببَ في
                  // `authorizationError`. فالتحقّقُ يُنفَّذ هنا صراحةً: رايةٌ
                  // نثق بها ولا تعمل أسوأُ من غيابها، لأنّها تُطمئن كذباً.
                  if (info.sslMode === "verify-full" && why.length > 0) {
                    resolve({ ok: false, why: `الشهادةُ غيرُ موثوقة (${why})` })
                    return
                  }
                  resolve({ ok: true })
                },
              },
            })
            session!.#socket = upgraded
          } catch (cause) {
            clearTimeout(timer)
            resolve({ ok: false, why: cause instanceof Error ? cause.message : String(cause) })
          }
        })
        if (!settled.ok) {
          session.close()
          return { refusal: `فشلت مصافحةُ TLS (sslmode=${info.sslMode}): ${settled.why}` }
        }
        session.#encrypted = true
      } else if (info.sslMode === "require" || info.sslMode === "verify-full") {
        session.close()
        return { refusal: `الخادمُ لا يقبل التشفير (${answer === "N" ? "ردّ N" : "لا ردّ"}) وsslmode=${info.sslMode} — مرفوض بلا سلكٍ مشفَّر` }
      }
    }

    const authenticated = await session.#authenticate(info)
    if (authenticated !== undefined) { session.close(); return { refusal: authenticated } }
    // الطبقةُ الأولى: الجلسةُ نفسُها للقراءة.
    const readOnly = await session.#simpleQuery("SET default_transaction_read_only = on")
    if ("refusal" in readOnly) { session.close(); return { refusal: `تعذّر ضبطُ الجلسة للقراءة: ${readOnly.refusal}` } }
    return session
  }

  push(data: Uint8Array): void {
    // بايتُ جواب التشفير يسبق البروتوكول ولا يتبع شكلَه — فلا يمرّ بالمُقسِّم.
    if (this.#phase === "ssl") {
      const answer = this.#sslAnswer
      this.#phase = "messages"
      this.#sslAnswer = undefined
      if (answer !== undefined) answer(String.fromCharCode(data[0] ?? 0))
      if (data.length <= 1) return
      data = data.slice(1)
    }
    const merged = new Uint8Array(this.#buffer.length + data.length)
    merged.set(this.#buffer)
    merged.set(data, this.#buffer.length)
    this.#buffer = merged
    const { messages, rest } = readMessages(this.#buffer)
    this.#buffer = rest
    if (messages.length === 0) return
    this.#queue.push(...messages)
    const waiting = this.#waiting
    if (waiting !== undefined) { this.#waiting = undefined; waiting(this.#queue.splice(0)) }
  }

  /** يرسل طلبَ التشفير وينتظر بايتاً واحداً: `S` أو `N`. */
  async #negotiateTls(timeoutMs = 10_000): Promise<string> {
    this.#phase = "ssl"
    const answered = new Promise<string>((resolve) => {
      this.#sslAnswer = resolve
      const timer = setTimeout(() => {
        if (this.#sslAnswer === resolve) { this.#sslAnswer = undefined; this.#phase = "messages"; resolve("") }
      }, timeoutMs)
      timer.unref?.()
    })
    this.#socket.write(sslRequestMessage())
    return answered
  }

  async #next(timeoutMs = 15_000): Promise<PgMessage[]> {
    if (this.#queue.length > 0) return this.#queue.splice(0)
    if (this.#closed) return []
    return new Promise<PgMessage[]>((resolve) => {
      this.#waiting = resolve
      const timer = setTimeout(() => { if (this.#waiting === resolve) { this.#waiting = undefined; resolve([]) } }, timeoutMs)
      timer.unref?.()
    })
  }

  #send(bytes: Uint8Array): void { this.#socket.write(bytes) }

  async #authenticate(info: PgConnectionInfo): Promise<string | undefined> {
    this.#send(startupMessage(info.user, info.database))
    let clientNonce: string | undefined
    let expected: Buffer | undefined
    const deadline = Date.now() + 20_000
    for (;;) {
      if (Date.now() > deadline) return "انتهت مهلةُ المصادقة"
      const messages = await this.#next()
      if (messages.length === 0) return this.#closed ? "أُغلق الاتصالُ أثناء المصادقة" : "لا ردَّ من الخادم"
      for (const message of messages) {
        if (message.tag === "E") return describeError(message.body)
        if (message.tag === "Z") return undefined // جاهزٌ = المصادقةُ تمّت
        if (message.tag !== "R") continue
        const kind = new DataView(message.body.buffer, message.body.byteOffset).getUint32(0, false)
        if (kind === 0) continue // AuthenticationOk — ننتظر Z
        // ⚠ الحارس: كلمةُ المرور (أو ما يكفي لانتحالها) لا تغادر الجهاز عارية.
        // والشرطُ **حالُ السلك** لا حالُ المضيف: سلكٌ مشفَّرٌ إلى بعيدٍ مقبول،
        // وسلكٌ عارٍ إلى بعيدٍ مرفوض. ربطُه بالمضيف وحده كان يمنع الصحيحَ
        // ويسمح بالخطأ لو تغيّر أحدُهما.
        if ((kind === 3 || kind === 5) && !isLocalHost(info.host) && !this.#encrypted) {
          return `الخادمُ يطلب مصادقةً ضعيفة (${kind === 3 ? "نصّ صريح" : "MD5"}) على سلكٍ غير مشفَّر إلى مضيفٍ بعيد — مرفوض. استعمل sslmode=verify-full أو نفقاً إلى localhost.`
        }
        if (kind === 3) { this.#send(tagged("p", new TextEncoder().encode(`${info.password}\0`))); continue }
        if (kind === 5) {
          const salt = message.body.slice(4, 8)
          this.#send(tagged("p", new TextEncoder().encode(`${md5Response(info.user, info.password, salt)}\0`)))
          continue
        }
        if (kind === 10) { // SASL
          const mechanisms = new TextDecoder().decode(message.body.slice(4))
          if (!mechanisms.includes("SCRAM-SHA-256")) return `آليّةُ SASL غيرُ مدعومة: ${mechanisms.slice(0, 60)}`
          clientNonce = newClientNonce()
          // ‏SASLInitialResponse: اسمُ الآليّة منتهياً بصفر، ثمّ طولُ الردّ،
          // ثمّ الردّ. و`n,,` بادئةُ ربطِ القناة «لا أدعمها» — صريحةٌ لا فارغة.
          const first = `n,,n=,r=${clientNonce}`
          this.#send(tagged("p", concat([cstring("SCRAM-SHA-256"), lengthPrefixed(first)])))
          continue
        }
        if (kind === 11) { // SASLContinue
          if (clientNonce === undefined) return "ردُّ SCRAM قبل بدئه"
          const serverFirst = new TextDecoder().decode(message.body.slice(4))
          const proof = scramProof(info.password, clientNonce, serverFirst)
          if ("refusal" in proof) return proof.refusal
          expected = proof.expectedServerSignature
          this.#send(tagged("p", new TextEncoder().encode(proof.clientFinal)))
          continue
        }
        if (kind === 12) { // SASLFinal — التوقيعُ يُتحقَّق منه
          if (expected === undefined) return "توقيعُ خادمٍ بلا حساب"
          const serverFinal = new TextDecoder().decode(message.body.slice(4))
          if (!serverSignatureMatches(serverFinal, expected)) return "توقيعُ الخادم لا يطابق — لا مصادقةَ متبادلة"
          continue
        }
        return `آليّةُ مصادقةٍ غيرُ مدعومة: ${kind}`
      }
    }
  }

  async #simpleQuery(sql: string): Promise<QueryResult | { readonly refusal: string }> {
    this.#send(tagged("Q", new TextEncoder().encode(`${sql}\0`)))
    let columns: string[] = []
    const rows: (string | null)[][] = []
    let failure: string | undefined
    const deadline = Date.now() + 30_000
    for (;;) {
      if (Date.now() > deadline) return { refusal: "انتهت مهلةُ الاستعلام" }
      const messages = await this.#next()
      if (messages.length === 0) return { refusal: this.#closed ? "أُغلق الاتصال" : "لا ردَّ من الخادم" }
      for (const message of messages) {
        if (message.tag === "T") { columns = rowDescription(message.body); continue }
        if (message.tag === "D") { rows.push(dataRow(message.body)); continue }
        if (message.tag === "E") { failure = describeError(message.body); continue }
        if (message.tag === "Z") {
          if (failure !== undefined) return { refusal: failure }
          return { columns, rows }
        }
      }
    }
  }

  /** استعلامُ قراءةٍ داخل معاملةٍ للقراءة — الطبقةُ الثانية. */
  async read(sql: string): Promise<QueryResult | { readonly refusal: string }> {
    const begun = await this.#simpleQuery("BEGIN READ ONLY")
    if ("refusal" in begun) return begun
    const result = await this.#simpleQuery(sql)
    await this.#simpleQuery("ROLLBACK")
    return result
  }

  close(): void {
    this.#closed = true
    try { this.#socket.end() } catch { /* مقبسٌ مغلقٌ أصلاً */ }
  }
}

/** سلسلةٌ ببادئة طولٍ ‎int32‎ — شكلُ `SASLInitialResponse`. */
const lengthPrefixed = (value: string): Uint8Array => {
  const bytes = new TextEncoder().encode(value)
  const out = new Uint8Array(4 + bytes.length)
  new DataView(out.buffer).setUint32(0, bytes.length, false)
  out.set(bytes, 4)
  return out
}

const TOOLS = Object.freeze([
  Object.freeze({
    name: "tables",
    description: "جداولُ ومَشاهدُ القاعدة الموصولة بمخطّطاتها.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }),
  Object.freeze({
    name: "columns",
    description: "أعمدةُ جدولٍ بأنواعها وقابليّتها للفراغ.",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string", description: "اسمُ الجدول" } },
      required: ["table"],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: "query",
    description: "جملةُ قراءةٍ واحدة داخل معاملةٍ للقراءة. الكتابةُ يرفضها المحرّك نفسُه.",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string", description: "جملةُ SQL للقراءة" } },
      required: ["sql"],
      additionalProperties: false,
    },
  }),
])

type RpcId = string | number | null
const write = (value: object): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
const ok = (id: RpcId, result: unknown): void => write({ jsonrpc: "2.0", id, result })
const fail = (id: RpcId, code: number, message: string): void => write({ jsonrpc: "2.0", id, error: { code, message } })

/** يُنفَّذ باسمٍ ومعطيات، ويعيد نصّاً وحكماً. مفصولٌ ليُقاس بلا أنبوب. */
export const runPgTool = async (
  session: PgSession,
  name: string,
  args: Record<string, unknown>,
): Promise<{ readonly ok: boolean; readonly text: string }> => {
  if (name === "tables") {
    const result = await session.read(
      "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2",
    )
    return "refusal" in result ? { ok: false, text: result.refusal } : { ok: true, text: renderResult(result) }
  }
  if (name === "columns") {
    const table = args.table
    if (typeof table !== "string" || table.length === 0) return { ok: false, text: "columns يحتاج اسمَ جدول" }
    // اسمٌ من النموذج لا يُلصق: يُقتبس بمضاعفة العلامة المفردة، وهو أضيقُ من
    // مُعامَلٍ مربوط لكنّ الاستعلامَ البسيط لا يحمل مُعامَلات. والقيمةُ تُحصر
    // في مقارنةِ نصٍّ واحدة، والحَكَمُ يمنع الجملةَ الثانية أصلاً.
    const quoted = table.replace(/'/gu, "''")
    const result = await session.read(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${quoted}' ORDER BY ordinal_position`,
    )
    if ("refusal" in result) return { ok: false, text: result.refusal }
    if (result.rows.length === 0) return { ok: false, text: `لا جدولَ باسم «${table.slice(0, 64)}»` }
    return { ok: true, text: renderResult(result) }
  }
  if (name === "query") {
    const sql = args.sql
    if (typeof sql !== "string") return { ok: false, text: "query يحتاج نصَّ sql" }
    const verdict = judgeStatement(sql)
    if (!verdict.ok) return { ok: false, text: `رُفضت الجملة: ${verdict.why}` }
    const result = await session.read(sql)
    return "refusal" in result ? { ok: false, text: `رفضها المحرّك: ${result.refusal}` } : { ok: true, text: renderResult(result) }
  }
  return { ok: false, text: `أداةٌ مجهولة: ${name.slice(0, 48)}` }
}

/** يشغّل الخادم على stdio. الرابطُ من البيئة — لا من سطر الأمر أبداً. */
export const servePostgresMcp = async (env: Readonly<Record<string, string | undefined>>): Promise<number> => {
  const raw = env[PG_URL_ENV]
  if (typeof raw !== "string" || raw.length === 0) {
    process.stderr.write(`${PG_URL_ENV} غيرُ مضبوط — امنح الاعتمادَ للخادم من «الاتصالات» ولا تضع الرابطَ في سطر الأمر.\n`)
    return 2
  }
  const info = parseConnectionUrl(raw)
  if ("refusal" in info) { process.stderr.write(`${info.refusal}\n`); return 2 }
  const opened = await PgSession.open(info)
  if ("refusal" in opened) { process.stderr.write(`${opened.refusal}\n`); return 3 }
  const session = opened

  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true })
    let cut: number
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 1)
      if (line.trim().length === 0) continue
      let request: { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown> }
      try { request = JSON.parse(line) } catch { continue }
      if (request.jsonrpc !== "2.0" || typeof request.method !== "string") continue
      if (request.id === undefined || request.id === null) continue
      const id = request.id
      if (request.method === "initialize") {
        const asked = (request.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        ok(id, {
          protocolVersion: typeof asked === "string" ? asked : PG_MCP_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "abdocode-postgres", version: "1" },
        })
        continue
      }
      if (request.method === "ping") { ok(id, {}); continue }
      if (request.method === "tools/list") { ok(id, { tools: TOOLS }); continue }
      if (request.method !== "tools/call") { fail(id, -32601, "Method not found"); continue }
      const name = (request.params as { name?: unknown } | undefined)?.name
      const args = (request.params as { arguments?: unknown } | undefined)?.arguments
      if (typeof name !== "string") { fail(id, -32602, "tools/call يحتاج name"); continue }
      const outcome = await runPgTool(session, name, (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>)
      ok(id, outcome.ok ? { content: [{ type: "text", text: outcome.text }] } : { isError: true, content: [{ type: "text", text: outcome.text }] })
    }
  }
  session.close()
  return 0
}

export * as PostgresMcp from "./postgres"
