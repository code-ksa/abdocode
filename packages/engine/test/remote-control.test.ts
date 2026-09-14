// م5 — عبدو ريموت كونترول: اقترانٌ برمز، بثٌّ للعملاء، أُطرٌ واردة محصورة، وطابورُ الدمج مع stdin.
import { describe, expect, test } from "bun:test"
import { FrameQueue, REMOTE_INBOUND_KINDS, createRemoteControl, inboundFromRemote, mergeFrames, outboundForRemote } from "../src/remote-control"

const openSocket = (url: string): Promise<WebSocket> => new Promise((resolve, reject) => {
  const ws = new WebSocket(url)
  ws.onopen = () => resolve(ws)
  ws.onerror = () => reject(new Error("ws error"))
  ws.onclose = (e) => reject(new Error(`closed ${e.code}`))
})
const nextMessage = (ws: WebSocket): Promise<Record<string, unknown>> => new Promise((resolve) => { ws.onmessage = (e) => resolve(JSON.parse(String(e.data))) })

describe("remote control — pairing and transport", () => {
  test("pairs by code, rotates the code after 5 failures and on success, streams frames and refuses foreign kinds", async () => {
    const received: Record<string, unknown>[] = []
    const remote = createRemoteControl({ hostname: "127.0.0.1", port: 0, onFrame: (f) => received.push(f), snapshot: () => ({ project: "demo", model: "m", mode: "auto", running: false }) })
    expect(remote.status().status).toBe("off")
    const started = await remote.start()
    expect(started.status).toBe("on")
    const base = `http://127.0.0.1:${started.port}`
    const first = started.code!
    expect(first).toMatch(/^\d{6}$/u)
    expect(started.urls).toEqual([`${base}/`])

    // الصفحةُ تُقدَّم بلا رمز؛ /ws بلا رمزٍ صالح مرفوض
    const page = await fetch(`${base}/`)
    expect(page.headers.get("content-type")).toContain("text/html")
    const pageHtml = await page.text()
    expect(pageHtml).toContain("عبدو ريموت كونترول")
    // مقيس 09-14 على 4.0.9: قسمُ الاقتران بقي ظاهراً بعد الاقتران لأنّ display:flex يغلب سمةَ hidden — القاعدةُ صريحة.
    expect(pageHtml).toContain("[hidden]{display:none!important}")
    expect((await fetch(`${base}/ws?token=${"0".repeat(48)}`)).status).toBe(403)

    // خمسُ محاولاتٍ خاطئة تُدوّر الرمز
    for (let i = 0; i < 5; i += 1) {
      const wrong = await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ code: "000000" === first ? "111111" : "000000" }) })
      expect(wrong.status).toBe(403)
    }
    const rotated = remote.status().code!
    expect(rotated).not.toBe(first)

    // الاقترانُ الصحيح يعطي رمزاً ويستهلك رمزَ الاقتران
    const ok = await fetch(`${base}/pair`, { method: "POST", body: JSON.stringify({ code: rotated, label: "test-phone" }) })
    expect(ok.status).toBe(200)
    const { token } = await ok.json() as { token: string }
    expect(token).toMatch(/^[0-9a-f]{48}$/u)
    expect(remote.status().code).not.toBe(rotated)
    expect(remote.status().devices).toBe(1)

    const ws = await openSocket(`ws://127.0.0.1:${started.port}/ws?token=${token}`)
    const hello = await nextMessage(ws)
    expect(hello.kind).toBe("remote-hello"); expect(hello.project).toBe("demo")
    expect(remote.status().clients).toBe(1)

    // إطارٌ مسموح يصل المحرّك (بلا مرفقات)، وإطارٌ ممنوع يُرفض عند العميل ولا يصل
    const refusal = nextMessage(ws)
    ws.send(JSON.stringify({ kind: "settings-set", settings: { model: "x" } }))
    expect(String((await refusal).why)).toContain("settings-set")
    ws.send(JSON.stringify({ kind: "submit", turn: { id: "r-1", body: "اكمل" }, attachments: ["a"] }))
    for (let i = 0; i < 50 && received.length === 0; i += 1) await Bun.sleep(10)
    expect(received).toEqual([{ kind: "submit", turn: { id: "r-1", body: "اكمل" } }])

    // البثُّ يصل، والمحجوبُ لا يصل (bridge-pairing يحمل رمز الجسر)
    const delta = nextMessage(ws)
    remote.broadcast({ kind: "bridge-pairing", status: "available", token: "secret" })
    remote.broadcast({ kind: "delta", turnId: "r-1", text: "مرحباً" })
    expect(await delta).toEqual({ kind: "delta", turnId: "r-1", text: "مرحباً" })

    // الإيقافُ يقطع العملاء ويُلغي الرموز
    const closed = new Promise<number>((resolve) => { ws.onclose = (e) => resolve(e.code) })
    remote.stop()
    expect([1000, 1001]).toContain(await closed) // Bun يبلّغ 1000 عند إيقاف الخادم القسريّ وإن طُلب 1001 — كلاهما «الخادم أغلق»
    expect(remote.status().status).toBe("off")
  })

  test("inbound guard and outbound shaping (positive twins included)", () => {
    expect(inboundFromRemote("nope").ok).toBe(false)
    expect(inboundFromRemote(JSON.stringify({ kind: "project-set", path: "C:/" })).ok).toBe(false)
    expect(inboundFromRemote(JSON.stringify({ kind: "external-connect", id: "x" })).ok).toBe(false)
    expect(inboundFromRemote("x".repeat(400 * 1024)).ok).toBe(false)
    for (const kind of REMOTE_INBOUND_KINDS) expect(inboundFromRemote(JSON.stringify({ kind, turnId: "t" })).ok).toBe(true)
    expect(outboundForRemote({ kind: "ready", settings: {} })).toBeUndefined()
    expect(outboundForRemote({ kind: "browser-shot", data: "…" })).toBeUndefined()
    expect(outboundForRemote({ kind: "done", turnId: "t" })).toBe('{"kind":"done","turnId":"t"}')
    const big = JSON.parse(outboundForRemote({ kind: "tool-result", turnId: "t", output: "y".repeat(20_000) })!) as { output: string }
    expect(big.output.length).toBeLessThan(9_000); expect(big.output).toContain("محذوفة للهاتف")
    const huge = JSON.parse(outboundForRemote({ kind: "event", turnId: "t", payload: "z".repeat(300_000) })!) as { truncated: boolean }
    expect(huge.truncated).toBe(true)
  })
})

describe("frame queue merge", () => {
  test("remote frames interleave with stdin frames and the merge ends when stdin ends", async () => {
    const queue = new FrameQueue<string>()
    async function* stdin() { yield "s1"; await Bun.sleep(20); yield "s2"; await Bun.sleep(20) }
    const seen: string[] = []
    setTimeout(() => queue.push("r1"), 5)
    setTimeout(() => queue.push("r2"), 30)
    for await (const frame of mergeFrames(stdin(), queue)) seen.push(frame)
    expect(seen.sort()).toEqual(["r1", "r2", "s1", "s2"])
    expect(seen.indexOf("r1")).toBeLessThan(seen.indexOf("s2"))
  })
  test("a closed queue stops feeding but does not end the merge", async () => {
    const queue = new FrameQueue<string>()
    queue.push("early"); queue.close(); queue.push("late-ignored")
    async function* stdin() { await Bun.sleep(10); yield "s" }
    const seen: string[] = []
    for await (const frame of mergeFrames(stdin(), queue)) seen.push(frame)
    expect(seen).toEqual(["early", "s"])
  })
})
