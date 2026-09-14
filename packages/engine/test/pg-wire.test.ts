/**
 * سلكُ بوستجرس — يُقاس بمتّجهٍ منشورٍ لا بنفسه.
 *
 * حسابُ SCRAM يُقاس **بمتّجه RFC 7677 §3**: حسابٌ يختبره كاتبُه بقيمٍ من عنده
 * يثبت اتّساقَه مع نفسه لا صحّتَه، والخطأُ فيه يظهر «كلمةُ مرورٍ خاطئة» ولا
 * يُفهم سببُه أبداً. وبقيّةُ الملفّ تقيس الحدود: قسمةُ الرسائل على حدودٍ
 * مقطوعة، وسقفُ الطول، وشكلُ الرابط.
 */
import { describe, expect, test } from "bun:test"
import {
  concat, cstring, dataRow, describeError, errorFields, isLocalHost, MAX_MESSAGE_BYTES,
  md5Response, parseConnectionUrl, readMessages, rowDescription, scramProof,
  serverSignatureMatches, sslRequestMessage, startupMessage, tagged,
} from "../src/mcp-servers/pg-wire"

describe("SCRAM-SHA-256 — متّجه RFC 7677 §3", () => {
  test("البرهانُ والتوقيعُ يطابقان القيمَ المنشورة حرفاً بحرف", () => {
    const clientNonce = "rOprNGfwEbeRWgbNEkqO"
    const serverFirst = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096"
    const proof = scramProof("pencil", clientNonce, serverFirst, "user")
    expect("refusal" in proof).toBe(false)
    if ("refusal" in proof) return
    // البرهانُ المنشور في المواصفة.
    expect(proof.clientFinal).toBe(
      "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=",
    )
    // وتوقيعُ الخادم المنشور — به تصحّ المصادقةُ المتبادلة.
    expect(serverSignatureMatches("v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=", proof.expectedServerSignature)).toBe(true)
    // وتوقيعٌ مختلفٌ بحرفٍ يُرفض — وإلّا كانت المقارنةُ زينة.
    expect(serverSignatureMatches("v=7rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=", proof.expectedServerSignature)).toBe(false)
    expect(serverSignatureMatches("no-signature-here", proof.expectedServerSignature)).toBe(false)
  })

  test("ردُّ خادمٍ لا يمتدّ نونسَنا يُرفض — وهو أوّلُ علامةِ وسيطٍ في المنتصف", () => {
    const bad = scramProof("pencil", "myNonce", "r=someoneElseNonce,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096")
    expect("refusal" in bad).toBe(true)
    if ("refusal" in bad) expect(bad.refusal).toContain("نونس")
    // وردٌّ ناقصُ الحقول يُرفض ولا يُكمَّل بافتراض.
    expect("refusal" in scramProof("pencil", "n", "r=n,i=4096")).toBe(true)
    // وعددُ جولاتٍ خياليّ يُرفض قبل أن يشغّل المعالجَ دهراً.
    expect("refusal" in scramProof("pencil", "n", "r=nx,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=99999999")).toBe(true)
  })

  test("استجابةُ MD5 بالشكل الذي يعرّفه البروتوكول", () => {
    // md5(md5(pass+user)+salt) — قيمةٌ محسوبةٌ من التعريف نفسِه.
    const answer = md5Response("u", "p", new Uint8Array([1, 2, 3, 4]))
    expect(answer.startsWith("md5")).toBe(true)
    expect(answer).toHaveLength(35)
    // ملحٌ مختلفٌ ⇒ استجابةٌ مختلفة (وإلّا كان الملحُ زينة).
    expect(md5Response("u", "p", new Uint8Array([9, 9, 9, 9]))).not.toBe(answer)
  })
})

describe("بناءُ الرسائل وقراءتها", () => {
  test("رسالةُ البدء تحمل طولَها وإصدارَ البروتوكول واسمَي المستخدم والقاعدة", () => {
    const bytes = startupMessage("abdo", "app")
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    expect(view.getUint32(0, false)).toBe(bytes.length) // الطولُ يشمل نفسَه
    expect(view.getUint32(4, false)).toBe(196_608) // 3.0
    const text = new TextDecoder().decode(bytes)
    expect(text).toContain("abdo")
    expect(text).toContain("app")
    expect(bytes[bytes.length - 1]).toBe(0) // النهايةُ صفر
  })

  test("الرسالةُ الموسومة: حرفٌ ثمّ طولٌ يشمل نفسَه", () => {
    const message = tagged("Q", cstring("SELECT 1"))
    expect(String.fromCharCode(message[0]!)).toBe("Q")
    const length = new DataView(message.buffer, message.byteOffset).getUint32(1, false)
    expect(length).toBe(message.length - 1)
  })

  test("القسمةُ تصمد على حدودٍ مقطوعة — بايتاً بايتاً", () => {
    const stream = concat([tagged("A", cstring("one")), tagged("B", cstring("two"))])
    // تسليمٌ بايتاً بايتاً: أقسى ما يفعله الشبكةُ الحقيقيّة.
    let held = new Uint8Array(0)
    const seen: string[] = []
    for (const byte of stream) {
      const merged = new Uint8Array(held.length + 1)
      merged.set(held); merged[held.length] = byte
      const { messages, rest } = readMessages(merged)
      held = rest
      for (const message of messages) seen.push(message.tag)
    }
    expect(seen).toEqual(["A", "B"])
    expect(held.length).toBe(0)
  })

  test("طولٌ غيرُ معقولٍ يُرمى ولا يُحجز — الفخُّ الذي قتل إطارَ القشرة", () => {
    const evil = new Uint8Array(5)
    evil[0] = 68 // 'D'
    new DataView(evil.buffer).setUint32(1, MAX_MESSAGE_BYTES + 1, false)
    expect(() => readMessages(evil)).toThrow()
    // وطولٌ أقلُّ من الرأس نفسِه يُرمى أيضاً.
    const tiny = new Uint8Array(5)
    tiny[0] = 68
    new DataView(tiny.buffer).setUint32(1, 2, false)
    expect(() => readMessages(tiny)).toThrow()
  })

  test("الأخطاءُ تُقرأ بحقولها، والصفوفُ تفرّق NULL عن الفراغ", () => {
    const body = concat([
      cstring("SERROR"), cstring("C25006"), cstring("Mcannot execute"), new Uint8Array([0]),
    ])
    expect(errorFields(body).C).toBe("25006")
    expect(describeError(body)).toContain("25006")
    expect(describeError(body)).toContain("cannot execute")

    // صفٌّ بقيمتين: نصٌّ فارغ (طول 0) وNULL (طول ‎-1‎) — والفرقُ يجب أن يبقى.
    const row = new Uint8Array(2 + 4 + 0 + 4)
    const view = new DataView(row.buffer)
    view.setUint16(0, 2, false)
    view.setInt32(2, 0, false)
    view.setInt32(6, -1, false)
    expect(dataRow(row)).toEqual(["", null])
  })

  test("وصفُ الأعمدة يقرأ الأسماءَ بترتيبها", () => {
    // اسمٌ ثمّ ثمانيةَ عشرَ بايتاً ثابتة لكلّ عمود.
    const column = (name: string): Uint8Array => concat([cstring(name), new Uint8Array(18)])
    const body = concat([new Uint8Array([0, 2]), column("id"), column("name")])
    expect(rowDescription(body)).toEqual(["id", "name"])
  })
})

describe("رابطُ الاتصال والمضيف", () => {
  test("الرابطُ السليمُ يُقرأ، والناقصُ يُرفض بسببٍ مسمّى", () => {
    const good = parseConnectionUrl("postgresql://u:p%40ss@db.local:6433/app")
    expect("refusal" in good).toBe(false)
    if (!("refusal" in good)) {
      expect(good.host).toBe("db.local")
      expect(good.port).toBe(6433)
      expect(good.user).toBe("u")
      // الترميزُ يُفكّ: كلمةٌ فيها `@` تصل صحيحةً لا مقطوعة.
      expect(good.password).toBe("p@ss")
      expect(good.database).toBe("app")
    }
    // والمنفذُ الافتراضيّ حين يغيب.
    const bare = parseConnectionUrl("postgres://u:p@localhost/app")
    expect("refusal" in bare ? -1 : bare.port).toBe(5432)

    for (const bad of ["mysql://u:p@h/db", "postgres://u:p@h/", "postgres://h/db", "ليس رابطاً"]) {
      expect(`${bad}: ${"refusal" in parseConnectionUrl(bad)}`).toBe(`${bad}: true`)
    }
  })

  test("المضيفُ المحلّيُّ يُعرف بأشكاله، والبعيدُ لا يُخلط به", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) expect(`${host}:${isLocalHost(host)}`).toBe(`${host}:true`)
    // ⚠ أسماءٌ تبدأ بـlocalhost ليست محلّيّة — وهي حيلةُ تصيّدٍ معروفة.
    for (const host of ["db.example.com", "localhost.evil.com", "127.0.0.1.evil.com", "0.0.0.0"]) {
      expect(`${host}:${isLocalHost(host)}`).toBe(`${host}:false`)
    }
  })
})

describe("وضعُ التشفير — الافتراضُ مقلوبٌ عن libpq عمداً", () => {
  test("المضيفُ البعيدُ يبدأ عند verify-full، والمحلّيُّ عند prefer", () => {
    const remote = parseConnectionUrl("postgres://u:p@db.example.com/app")
    expect("refusal" in remote ? "" : remote.sslMode).toBe("verify-full")
    for (const host of ["localhost", "127.0.0.1"]) {
      const local = parseConnectionUrl(`postgres://u:p@${host}/app`)
      expect(`${host}: ${"refusal" in local ? "" : local.sslMode}`).toBe(`${host}: prefer`)
    }
    // غيابُ الإعداد ليس إذناً بسلكٍ عارٍ عبر الشبكة — «الغياب رفضٌ لا إذن».
  })

  test("الوضعُ المطلوبُ يُحترم، والمجهولُ يُرفض مسمّى", () => {
    for (const mode of ["disable", "prefer", "require", "verify-full"]) {
      const asked = parseConnectionUrl(`postgres://u:p@db.example.com/app?sslmode=${mode}`)
      expect(`${mode}: ${"refusal" in asked ? "رفض" : asked.sslMode}`).toBe(`${mode}: ${mode}`)
    }
    const bad = parseConnectionUrl("postgres://u:p@h/app?sslmode=allow")
    expect("refusal" in bad).toBe(true)
    if ("refusal" in bad) expect(bad.refusal).toContain("sslmode")
  })

  test("رسالةُ طلب التشفير: ثمانيةُ بايتاتٍ بلا وسم", () => {
    const request = sslRequestMessage()
    expect(request.length).toBe(8)
    const view = new DataView(request.buffer, request.byteOffset)
    expect(view.getUint32(0, false)).toBe(8)
    expect(view.getUint32(4, false)).toBe(80_877_103)
  })
})
