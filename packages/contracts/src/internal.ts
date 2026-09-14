/**
 * Internal helpers for @abdo/contracts.
 *
 * Vendored on purpose: contracts must stay dependency-pure — and since the
 * severance, that means **no runtime dependency at all**. The id generator
 * below needs only `crypto` and `BigInt`.
 *
 * ⚠️ حُذف من هذا الملفّ `statics` و`optional`: مساعدان لا معنى لهما إلّا مع
 * النواة القديمة. بقاؤهما بعد إزالتها يُبقي بابها موارباً.
 * These are small, self-contained utilities — no coupling to the forked
 * @abdo/* packages, so contracts can be reasoned about and tested in
 * isolation. See docs/adr/0001-contracts-are-pure.md.
 */

/** Monotonic, lexicographically-sortable id suffix (ULID-like, 26 chars). */
const length = 26
const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastTimestamp = 0
let counter = 0

function create(descending: boolean, timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = descending ? ~current : current
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const bytes = crypto.getRandomValues(new Uint8Array(length - 12))
  return time + Array.from(bytes, (byte) => chars[byte % 62]).join("")
}

/** Ascending id — earlier events sort first. Use for the event log. */
export const ascending = () => create(false)
/** Descending id — newest sorts first. Use for sessions/messages listings. */
export const descending = () => create(true)
