import { describe, expect, test } from "bun:test"
import { approvalDecidedLine } from "../src/approval-ledger"
import { Approval } from "../src/shells/approval"

const ask = (turnId = "t1") => ({ kind: "approval", turnId, request: "write app/page.tsx", class: "write", mode: "read-only" })
const decided = (turnId: string, request: string, decision: "approved" | "denied" | "interrupted") =>
  ({ kind: "event", turnId, seq: 3, payload: approvalDecidedLine({ request, decision }) })

describe("shell approval reducer — the seat is the composer, the ledger is the truth", () => {
  test("an approval frame takes the seat with the request, its class and the mode", () => {
    const folded = Approval.fold(Approval.empty(), ask())
    expect(folded.refused).toBeUndefined()
    expect(folded.store.state).toMatchObject({
      kind: "asked", turnId: "t1", request: "write app/page.tsx", cls: "write", mode: "read-only", diffSeen: false,
    })
    expect(Approval.pendingTurn(folded.store)).toBe("t1")
  })

  test("a diff seen before the ask marks the preview available for that turn only", () => {
    let store = Approval.fold(Approval.empty(), { kind: "diff", turnId: "t1", path: "app/page.tsx", diff: "+x" }).store
    expect(Approval.fold(store, ask("t1")).store.state).toMatchObject({ diffSeen: true })
    expect(Approval.fold(store, ask("t2")).store.state).toMatchObject({ diffSeen: false })
    // ومعاينةٌ تصل **بعد** السؤال ترفع الراية أيضاً — والمعاينة لدورٍ آخر لا.
    store = Approval.fold(Approval.empty(), ask("t1")).store
    expect(Approval.fold(store, { kind: "diff", turnId: "t9", diff: "+y" }).store.state).toMatchObject({ diffSeen: false })
    expect(Approval.fold(store, { kind: "diff", turnId: "t1", diff: "+y" }).store.state).toMatchObject({ diffSeen: true })
  })

  test("THE CLICK IS NOT THE TRUTH: choose() only arms 'deciding'; only the journal line returns the seat to idle", () => {
    const asked = Approval.fold(Approval.empty(), ask()).store
    const deciding = Approval.choose(asked, "approve")
    expect(deciding.refused).toBeUndefined()
    expect(deciding.store.state).toMatchObject({ kind: "deciding", choice: "approve", turnId: "t1" })
    expect(deciding.settled).toBeUndefined()
    // سطرُ قرارٍ لدورٍ آخر لا يحرّر المقعد.
    const other = Approval.fold(deciding.store, decided("t2", "write app/page.tsx", "approved"))
    expect(other.store.state.kind).toBe("deciding")
    expect(other.settled).toBeUndefined()
    // وسطرُ حدثٍ عاديّ للدور نفسه لا يحرّره كذلك.
    const noise = Approval.fold(deciding.store, { kind: "event", turnId: "t1", seq: 4, payload: "📐 أحكام الأدوات ح1: —" })
    expect(noise.store.state.kind).toBe("deciding")
    // القرار وحده.
    const settled = Approval.fold(deciding.store, decided("t1", "write app/page.tsx", "approved"))
    expect(settled.settled).toBe("approved")
    expect(settled.store.state).toEqual({ kind: "idle" })
  })

  test("a denial and an interruption are named decisions, not silence", () => {
    const asked = Approval.fold(Approval.empty(), ask()).store
    expect(Approval.fold(asked, decided("t1", "write app/page.tsx", "denied")).settled).toBe("denied")
    expect(Approval.fold(asked, decided("t1", "write app/page.tsx", "interrupted")).settled).toBe("interrupted")
  })

  test("a turn that ends without any decision closes the seat as «أُغلق» — never as consent", () => {
    for (const kind of ["done", "interrupted", "unresolved"]) {
      const asked = Approval.fold(Approval.empty(), ask()).store
      const folded = Approval.fold(asked, { kind, turnId: "t1" })
      expect(folded.settled).toBe("closed")
      expect(folded.store.state).toEqual({ kind: "idle" })
    }
    // ونفسُ الشيء من حالة «يُقرَّر»: انقطاعٌ لا يصير سماحاً أبداً.
    const deciding = Approval.choose(Approval.fold(Approval.empty(), ask()).store, "approve").store
    expect(Approval.fold(deciding, { kind: "done", turnId: "t1" }).settled).toBe("closed")
    // وبادئةُ قرارٍ بصيغةٍ مجهولة تُغلق ولا تُخمَّن سماحاً.
    const unknown = Approval.fold(deciding, { kind: "event", turnId: "t1", seq: 5, payload: "🔐 قرار الموافقة: شيءٌ آخر" })
    expect(unknown.settled).toBe("closed")
  })

  test("Escape in the asked state IS a denial; elsewhere it does nothing", () => {
    const asked = Approval.fold(Approval.empty(), ask()).store
    expect(Approval.escape(asked).store.state).toMatchObject({ kind: "deciding", choice: "deny" })
    const idle = Approval.empty()
    expect(Approval.escape(idle).store).toBe(idle)
    expect(Approval.escape(idle).refused).toBeUndefined()
    const deciding = Approval.choose(asked, "approve").store
    expect(Approval.escape(deciding).store).toBe(deciding)
  })

  // العطل المقيس: المحرّك يحسم الموافقة **بلا** سطر قرار (كتابةُ الدفتر
  // تُبتلع عمداً عند SQLITE_BUSY، أو المفتاح مُطفأ عنده والقشرة مستولية)،
  // فيبقى المقعد في «يُقرَّر» ويُرفض السؤال الثاني للدور نفسه: المشغّل أمام
  // طلبٍ ميّتٍ بأزرارٍ مقفلة، والمؤلِّف مغلقٌ حتى المقاطعة. الدور نفسه دليلُ
  // تجاوزٍ لا خلل، فيستولي الجديد على المقعد.
  test("ask → click → ask AGAIN for the same turn with no decided line: the new request takes the seat, it is not refused", () => {
    const asked = Approval.fold(Approval.empty(), ask("t1")).store
    const deciding = Approval.choose(asked, "approve").store
    expect(deciding.state).toMatchObject({ kind: "deciding", request: "write app/page.tsx" })
    const second = Approval.fold(deciding, { kind: "approval", turnId: "t1", request: "run rm -rf /data", class: "shell", mode: "read-only" })
    expect(second.refused).toBeUndefined()
    expect(second.store.state).toMatchObject({ kind: "asked", turnId: "t1", request: "run rm -rf /data", cls: "shell" })
    // ومن حالة «سُئل» كذلك — لا يُهجر المشغّل أمام طلبٍ تجاوزه المحرّك.
    const fromAsked = Approval.fold(asked, { kind: "approval", turnId: "t1", request: "run npm test", class: "shell", mode: "auto" })
    expect(fromAsked.refused).toBeUndefined()
    expect(fromAsked.store.state).toMatchObject({ kind: "asked", request: "run npm test", mode: "auto" })
    // والمقعدُ المشغولُ بدورٍ آخر يبقى محميّاً برفضه المسمّى.
    expect(Approval.fold(deciding, ask("t2")).refused).toBe("موافقة معلّقة أخرى — المقعد واحد")
    expect(Approval.fold(deciding, ask("t2")).store).toBe(deciding)
    // وطلبٌ بلا دور فوق مقعدٍ مشغول يُسمّى بعيبه هو، ولا يستولي.
    const nameless = Approval.fold(deciding, { kind: "approval", request: "x", class: "write", mode: "auto" })
    expect(nameless.refused).toBe("طلب موافقة بلا دور — لا يُعرض")
    expect(nameless.store).toBe(deciding)
  })

  test("a second concurrent approval is refused BY NAME and leaves the seat untouched", () => {
    const asked = Approval.fold(Approval.empty(), ask("t1")).store
    const second = Approval.fold(asked, ask("t2"))
    expect(second.refused).toBe("موافقة معلّقة أخرى — المقعد واحد")
    expect(second.store).toBe(asked)
    expect(second.store.state).toMatchObject({ turnId: "t1" })
    // وطلبٌ بلا دور يُرفض باسمه ولا يفتح مقعداً أعمى.
    const nameless = Approval.fold(Approval.empty(), { kind: "approval", request: "x", class: "write", mode: "auto" })
    expect(nameless.refused).toBe("طلب موافقة بلا دور — لا يُعرض")
    expect(nameless.store.state).toEqual({ kind: "idle" })
  })

  test("choose() outside the asked state is refused, not silently applied", () => {
    expect(Approval.choose(Approval.empty(), "approve").refused).toBe("لا موافقة معلّقة تُقرَّر")
    const deciding = Approval.choose(Approval.fold(Approval.empty(), ask()).store, "deny").store
    expect(Approval.choose(deciding, "approve").refused).toBe("لا موافقة معلّقة تُقرَّر")
    expect(Approval.choose(deciding, "approve").store).toBe(deciding)
  })

  test("frames for other kinds pass through untouched", () => {
    const asked = Approval.fold(Approval.empty(), ask()).store
    for (const frame of [{ kind: "tool", turnId: "t1", cmd: "read a" }, { kind: "delta", turnId: "t1", text: "x" }]) {
      expect(Approval.fold(asked, frame).store).toBe(asked)
    }
  })
})
