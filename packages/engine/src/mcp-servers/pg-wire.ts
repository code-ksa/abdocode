/**
 * سلكُ بوستجرس — كتبناه، ولم نُنزّل سائقاً.
 *
 * أمرُ المالك: «لا تنزّل حزمة، أنشئه» و«خذ من كودهم بدون أبوابٍ خلفيّة».
 * فالبروتوكولُ منشورٌ (الإصدار 3.0) والتنفيذُ ملكنا: مقبسٌ، وثلاثُ رسائل
 * للمصادقة، ورسالةُ استعلامٍ بسيطة. لا `node_modules` لطرفٍ ثالثٍ على مسارٍ
 * يحمل كلمةَ مرور قاعدةٍ إنتاجيّة — وهذا وحده يبرّر الكتابة.
 *
 * **ما يُنفَّذ هنا:** بدءُ الجلسة، والمصادقةُ بثلاث (نصٌّ صريح، MD5،
 * SCRAM-SHA-256)، والاستعلامُ البسيط، وقراءةُ الصفوف والأخطاء.
 * **وما لا يُنفَّذ عمداً:** الاستعلامُ المُعَدّ (لا نحتاجه للقراءة)، والنسخُ
 * (`COPY`)، والإشعاراتُ (`LISTEN`). ما لا يُنفَّذ لا يُدّعى.
 *
 * ═══ ثلاثةُ حرّاسٍ في السلك نفسِه ═══
 *
 * ١) **لا كلمةَ مرورٍ على سلكٍ عارٍ إلى مضيفٍ بعيد.** ‏`SCRAM` لا يرسل الكلمة
 *    لكنّ `MD5` والنصَّ الصريح يرسلان ما يكفي لانتحالك. فالمصادقةُ الضعيفة
 *    **تُرفض** إلا إلى مضيفٍ محلّيّ. والبعيدُ يُوصَل عبر نفقٍ — وهو ما تفعله
 *    بنيتُنا أصلاً.
 * ٢) **توقيعُ الخادم يُتحقَّق منه** في SCRAM (`v=`). تخطّيه يُلغي المصادقةَ
 *    المتبادلة، فيصير وسيطٌ في المنتصف مقبولاً بصمت.
 * ٣) **سقفٌ على الرسالة الواردة.** طولٌ يعلنه الطرفُ الآخر ويُصدَّق بلا سقفٍ
 *    هو تخصيصُ ذاكرةٍ بأمر الغريب — وهو الفخُّ نفسُه الذي أوقعنا في إطارات
 *    القشرة (إطارٌ بطول 2 غيغابايت).
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto"

/** سقفُ الرسالة الواردة — طولٌ يُعلنه الغريبُ لا يُصدَّق بلا حدّ. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/**
 * أوضاعُ التشفير — بدلالة libpq نفسِها كي لا نخترع مفرداتٍ لمن يعرفها:
 *   `disable`      لا تفاوضَ أصلاً.
 *   `prefer`       جرّب، واقبل الرفضَ ومُرّ عارياً.
 *   `require`      لا بدّ من التشفير، **ولا يُتحقَّق من الشهادة** (دلالةُ libpq).
 *   `verify-full`  تشفيرٌ وشهادةٌ موثوقةٌ يطابق اسمُها المضيف.
 */
export type PgSslMode = "disable" | "prefer" | "require" | "verify-full"

export const PG_SSL_MODES: readonly PgSslMode[] = Object.freeze(["disable", "prefer", "require", "verify-full"])

export interface PgConnectionInfo {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly password: string
  readonly database: string
  readonly sslMode: PgSslMode
}

/** رسالةُ طلب التشفير: طولٌ ثمانيةٌ ورمزٌ ثابت. بلا وسمٍ — تسبق كلَّ شيء. */
export const sslRequestMessage = (): Uint8Array => concat([int32(8), int32(80_877_103)])

/** مضيفٌ محلّيٌّ: السلكُ لا يغادر الجهاز، فالمصادقةُ الضعيفة مقبولةٌ عليه. */
export const isLocalHost = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"

/**
 * يقرأ رابطَ الاتصال. **لا يُقبل من argv أبداً** — سطرُ أمرِ أيّ عمليّةٍ مقروءٌ
 * لكلّ عمليّةٍ على الجهاز، والقاعدةُ نفسُها التي تحكم الخزنة تحكم هنا.
 */
export const parseConnectionUrl = (raw: string): PgConnectionInfo | { readonly refusal: string } => {
  let url: URL
  try { url = new URL(raw) } catch { return { refusal: "رابطُ الاتصال غيرُ صالح" } }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return { refusal: `مخطَّطٌ غيرُ مدعوم «${url.protocol.replace(":", "").slice(0, 16)}» — المتاح: postgres` }
  }
  const database = url.pathname.replace(/^\//u, "")
  if (database.length === 0) return { refusal: "الرابطُ بلا اسم قاعدة" }
  if (url.username.length === 0) return { refusal: "الرابطُ بلا مستخدم" }
  const host = url.hostname
  const asked = url.searchParams.get("sslmode")
  if (asked !== null && !PG_SSL_MODES.includes(asked as PgSslMode)) {
    return { refusal: `sslmode غيرُ معروف «${asked.slice(0, 24)}» — المتاح: ${PG_SSL_MODES.join("، ")}` }
  }
  return {
    host,
    port: url.port.length > 0 ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    // ⚠ الافتراضُ **مقلوبٌ عن libpq عمداً**: المضيفُ البعيد يبدأ عند
    // `verify-full` لا عند `prefer`. غيابُ الإعداد ليس إذناً بسلكٍ عارٍ عبر
    // الشبكة — «الغياب رفضٌ لا إذن». والمحلّيُّ يبقى `prefer` فلا يُعطَّل
    // تطويرٌ على الجهاز نفسه.
    sslMode: (asked as PgSslMode | null) ?? (isLocalHost(host) ? "prefer" : "verify-full"),
  }
}

// ── بناءُ الرسائل ────────────────────────────────────────────────────────────

/** نصٌّ منتهٍ بصفر — شكلُ كلّ اسمٍ في البروتوكول. */
export const cstring = (value: string): Uint8Array => {
  const bytes = new TextEncoder().encode(value)
  const out = new Uint8Array(bytes.length + 1)
  out.set(bytes)
  return out
}

/** ضمُّ قطعٍ في مصفوفةٍ واحدة. */
export const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

const int32 = (value: number): Uint8Array => {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, false)
  return out
}

/** رسالةٌ موسومة: حرفٌ ثمّ طولٌ يشمل نفسَه ثمّ الجسم. */
export const tagged = (tag: string, body: Uint8Array): Uint8Array =>
  concat([new TextEncoder().encode(tag), int32(body.length + 4), body])

/** رسالةُ البدء — بلا وسمٍ، وطولُها يشمل نفسَه. */
export const startupMessage = (user: string, database: string): Uint8Array => {
  const body = concat([
    int32(196_608), // 3.0
    cstring("user"), cstring(user),
    cstring("database"), cstring(database),
    cstring("application_name"), cstring("abdocode-mcp"),
    new Uint8Array([0]),
  ])
  return concat([int32(body.length + 4), body])
}

// ── SCRAM-SHA-256 ───────────────────────────────────────────────────────────

const xor = (a: Buffer, b: Buffer): Buffer => {
  const out = Buffer.alloc(a.length)
  for (let i = 0; i < a.length; i += 1) out[i] = a[i]! ^ b[i]!
  return out
}

export interface ScramProof {
  readonly clientFinal: string
  /** توقيعُ الخادم المتوقَّع — يُقارَن بما يرسله، وإلا فلا مصادقةَ متبادلة. */
  readonly expectedServerSignature: Buffer
}

/**
 * يحسب برهانَ العميل وتوقيعَ الخادم المتوقَّع (RFC 5802 / 7677).
 *
 * مفصولٌ عن المقبس كي يُقاس بمتّجهات RFC بلا خادمٍ حيّ — والحسابُ الخاطئ هنا
 * يظهر «كلمةُ مرورٍ خاطئة» ولا يُفهم سببُه أبداً.
 */
export const scramProof = (
  password: string,
  clientNonce: string,
  serverFirst: string,
  /**
   * اسمُ المستخدم في طبقة SCRAM. **بوستجرس يتركه فارغاً** لأنّ الاسمَ في رسالة
   * البدء. وهو مُعامَلٌ لا ثابتٌ كي يُقاس الحسابُ بمتّجه RFC 7677 المنشور —
   * وحسابٌ لا يُقاس بمتّجهٍ خارجيّ يثبت اتّساقَ كاتبه مع نفسه لا صحّتَه.
   */
  username = "",
): ScramProof | { readonly refusal: string } => {
  const fields = new Map(serverFirst.split(",").map((part) => [part.slice(0, 1), part.slice(2)] as const))
  const nonce = fields.get("r"), salt = fields.get("s"), iterations = fields.get("i")
  if (nonce === undefined || salt === undefined || iterations === undefined) return { refusal: "ردُّ SCRAM ناقص" }
  // النونسُ يجب أن يبدأ بنونس العميل — وإلّا فالخادمُ لا يردّ على طلبنا.
  if (!nonce.startsWith(clientNonce)) return { refusal: "نونسُ الخادم لا يمتدّ نونسَنا" }
  const rounds = Number(iterations)
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 1_000_000) return { refusal: "عددُ الجولات غيرُ معقول" }

  const saltedPassword = pbkdf2Sync(password, Buffer.from(salt, "base64"), rounds, 32, "sha256")
  const clientKey = createHmac("sha256", saltedPassword).update("Client Key").digest()
  const storedKey = createHash("sha256").update(clientKey).digest()
  const clientFinalWithoutProof = `c=biws,r=${nonce}`
  const authMessage = `n=${username},r=${clientNonce},${serverFirst},${clientFinalWithoutProof}`
  const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest()
  const proof = xor(clientKey, clientSignature)
  const serverKey = createHmac("sha256", saltedPassword).update("Server Key").digest()
  const expectedServerSignature = createHmac("sha256", serverKey).update(authMessage).digest()
  return { clientFinal: `${clientFinalWithoutProof},p=${proof.toString("base64")}`, expectedServerSignature }
}

export const newClientNonce = (): string => randomBytes(18).toString("base64")

/** يقارن التوقيعين بزمنٍ ثابت — مقارنةُ نصٍّ تسرّب طولَ التطابق. */
export const serverSignatureMatches = (serverFinal: string, expected: Buffer): boolean => {
  const value = serverFinal.split(",").find((part) => part.startsWith("v="))?.slice(2)
  if (value === undefined) return false
  const got = Buffer.from(value, "base64")
  return got.length === expected.length && timingSafeEqual(got, expected)
}

/** استجابةُ MD5 كما يعرّفها البروتوكول: md5(md5(pass+user)+salt). */
export const md5Response = (user: string, password: string, salt: Uint8Array): string => {
  const inner = createHash("md5").update(password + user).digest("hex")
  return `md5${createHash("md5").update(Buffer.concat([Buffer.from(inner, "utf-8"), Buffer.from(salt)])).digest("hex")}`
}

// ── قراءةُ الرسائل ──────────────────────────────────────────────────────────

export interface PgMessage {
  readonly tag: string
  readonly body: Uint8Array
}

/**
 * يقسّم مخزّناً إلى رسائل. يعيد ما اكتمل وما بقي — ولا يخصّص بأمر الغريب:
 * طولٌ فوق السقف يُرمى بدل أن يُحجز.
 */
export const readMessages = (buffer: Uint8Array): { readonly messages: PgMessage[]; readonly rest: Uint8Array } => {
  const messages: PgMessage[] = []
  let at = 0
  while (buffer.length - at >= 5) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + at)
    const length = view.getUint32(1, false)
    if (length < 4 || length > MAX_MESSAGE_BYTES) {
      throw new Error(`رسالةٌ بطولٍ غير معقول من الخادم: ${length}`)
    }
    if (buffer.length - at < length + 1) break
    messages.push({
      tag: String.fromCharCode(buffer[at]!),
      body: buffer.slice(at + 5, at + 1 + length),
    })
    at += length + 1
  }
  return { messages, rest: buffer.slice(at) }
}

/** حقولُ رسالة خطأ/إشعار: وسمُ حرفٍ ثمّ نصٌّ منتهٍ بصفر. */
export const errorFields = (body: Uint8Array): Record<string, string> => {
  const out: Record<string, string> = {}
  const decoder = new TextDecoder()
  let at = 0
  while (at < body.length && body[at] !== 0) {
    const field = String.fromCharCode(body[at]!)
    let end = at + 1
    while (end < body.length && body[end] !== 0) end += 1
    out[field] = decoder.decode(body.slice(at + 1, end))
    at = end + 1
  }
  return out
}

/** نصُّ الخطأ كما يُعرض: الشدّةُ والرسالةُ ورمزُ الحالة، بلا حشو. */
export const describeError = (body: Uint8Array): string => {
  const fields = errorFields(body)
  return [fields.S ?? "ERROR", fields.C ?? "", fields.M ?? "خطأٌ بلا رسالة"].filter((part) => part.length > 0).join(" ")
}

/** أسماءُ الأعمدة من `RowDescription`. */
export const rowDescription = (body: Uint8Array): string[] => {
  const view = new DataView(body.buffer, body.byteOffset)
  const count = view.getUint16(0, false)
  const decoder = new TextDecoder()
  const names: string[] = []
  let at = 2
  for (let i = 0; i < count; i += 1) {
    let end = at
    while (end < body.length && body[end] !== 0) end += 1
    names.push(decoder.decode(body.slice(at, end)))
    at = end + 1 + 18 // الحقولُ الستّةُ الثابتة بعد الاسم
  }
  return names
}

/** قيمُ صفٍّ من `DataRow`. الطولُ ‎-1‎ يعني NULL — لا سلسلةً فارغة. */
export const dataRow = (body: Uint8Array): (string | null)[] => {
  const view = new DataView(body.buffer, body.byteOffset)
  const count = view.getUint16(0, false)
  const decoder = new TextDecoder()
  const values: (string | null)[] = []
  let at = 2
  for (let i = 0; i < count; i += 1) {
    const length = view.getInt32(at, false)
    at += 4
    if (length < 0) { values.push(null); continue }
    values.push(decoder.decode(body.slice(at, at + length)))
    at += length
  }
  return values
}

export * as PgWire from "./pg-wire"
