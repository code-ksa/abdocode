/**
 * 10-08 (مقيس في بروفة النشر): `server add` كان يولّد المفتاحَ بـssh-keygen، وفي PowerShell 5.1 تسقط الوسيطةُ الفارغة (`-N ""`)
 * فينتظر ssh-keygen عبارةَ مرورٍ من الطرفيّة حتى المهلة (رمز 124، بلا خرج) — والنموذجُ نفسُه دار خمسَ مرّاتٍ على «option requires an
 * argument -- N». المفتاحُ يُولَّد هنا داخل العمليّة (ed25519 من node:crypto) ويُكتب بصيغة OpenSSH الأصليّة (openssh-key-v1)
 * التي يقرؤها ssh وssh-keygen — بلا برنامجٍ خارجيّ ولا وسائطَ تُقتبس.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto"

const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b }
const sshString = (data: Buffer | string): Buffer => { const b = typeof data === "string" ? Buffer.from(data, "utf8") : data; return Buffer.concat([u32(b.length), b]) }
const fromB64Url = (s: string): Buffer => Buffer.from(s.replace(/-/gu, "+").replace(/_/gu, "/"), "base64")

export function generateOpenSshEd25519(comment: string): { readonly privateKey: string; readonly publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519")
  const jwk = privateKey.export({ format: "jwk" }) as { d?: string; x?: string }
  if (jwk.d === undefined || jwk.x === undefined) throw new Error("ed25519 key export failed")
  const seed = fromB64Url(jwk.d), pub = fromB64Url(jwk.x)
  if (seed.length !== 32 || pub.length !== 32) throw new Error("ed25519 key has an unexpected size")
  const keyType = "ssh-ed25519"
  const publicBlob = Buffer.concat([sshString(keyType), sshString(pub)])
  const check = randomBytes(4)
  let privateBlock = Buffer.concat([check, check, sshString(keyType), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)])
  // الحشوُ 1، 2، 3… حتى مضاعفِ حجمِ الكتلة (8 لـ«none»).
  const pad: number[] = []
  for (let i = 1; (privateBlock.length + pad.length) % 8 !== 0; i += 1) pad.push(i)
  privateBlock = Buffer.concat([privateBlock, Buffer.from(pad)])
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString("none"), sshString("none"), sshString(""),
    u32(1), sshString(publicBlob), sshString(privateBlock),
  ])
  const b64 = body.toString("base64").replace(/.{1,70}/gu, "$&\n")
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `${keyType} ${publicBlob.toString("base64")} ${comment}`,
  }
}

/**
 * 10-08 (مقيس على abdo-router): «server test» ردّ «Permission denied (publickey) … أضف المفتاح العامّ» بلا المفتاح، فثبّت النموذجُ مفتاحاً
 * آخرَ ولّده بنفسه ودار ربعَ ساعة. المفتاحُ العامّ مكتوبٌ صريحاً في رأس صيغة openssh-key-v1 (غيرَ مشفّرٍ ولو كان الخاصُّ محميّاً)،
 * فيُستخرج هنا بلا برنامجٍ خارجيّ. `undefined` = ليس بهذه الصيغة.
 */
export function publicKeyFromOpenSsh(pem: string, comment = ""): string | undefined {
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/u.exec(pem)
  if (m === null) return undefined
  const buf = Buffer.from(m[1]!.replace(/\s+/gu, ""), "base64")
  const magic = "openssh-key-v1\0"
  if (buf.subarray(0, magic.length).toString("binary") !== magic) return undefined
  let at = magic.length
  const readString = (): Buffer | undefined => {
    if (at + 4 > buf.length) return undefined
    const len = buf.readUInt32BE(at); at += 4
    if (at + len > buf.length) return undefined
    const out = buf.subarray(at, at + len); at += len
    return out
  }
  if (readString() === undefined || readString() === undefined || readString() === undefined) return undefined // cipher, kdf, kdf options
  if (at + 4 > buf.length || buf.readUInt32BE(at) < 1) return undefined
  at += 4
  const blob = readString()
  if (blob === undefined || blob.length < 4) return undefined
  const typeLen = blob.readUInt32BE(0)
  const type = blob.subarray(4, 4 + typeLen).toString("utf8")
  if (!/^(?:ssh-|ecdsa-|sk-)/u.test(type)) return undefined
  return `${type} ${blob.toString("base64")}${comment ? ` ${comment}` : ""}`
}
