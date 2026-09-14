import { describe, expect, test } from "bun:test"
import { GoogleSearch } from "../src/mind/google-search"
import { encodeGoogleSearchWorkerRequest } from "@abdo/tool-worker"

/**
 * ر2 — صورٌ من بحث الويب على المالك الواحد (`search`)، لا خادمَ صورٍ ثانياً.
 * الفكرةُ الممتصّة من خوادم MCP للصور: نتيجةُ صورةٍ ببياناتها (الصفحةُ الحاضنة،
 * المصغَّرة، الأبعادُ، النوع) كي يختار نموذجُ الرؤية بعدها. النداءُ الحيّ إلى PSE
 * يبقى غيرَ مثبتٍ حتى حضور مفتاحي `abdocode-google-pse-*` في الخزنة (§٩ في البرنامج).
 */
describe("google search — image mode", () => {
  test("`--images` selects the image kind; plain search stays web, and the browser URL follows", () => {
    const images = GoogleSearch.parseCommand("شعار جامعة الملك سعود --images --count 3")
    expect(images).toMatchObject({ query: "شعار جامعة الملك سعود", count: 3, kind: "image" })
    expect(GoogleSearch.parseCommand("شعار جامعة الملك سعود").kind).toBe("web")
    expect(GoogleSearch.browserUrl("x", "image")).toContain("&tbm=isch")
    expect(GoogleSearch.browserUrl("x")).not.toContain("tbm=isch")
  })

  test("image results carry context, thumbnail, dimensions and mime; hostile fields are dropped, web results stay byte-identical in shape", () => {
    const body = JSON.stringify({
      searchInformation: { totalResults: "2", searchTime: 0.2 },
      items: [
        { title: "KSU logo", link: "https://cdn.example/ksu.png", displayLink: "cdn.example", snippet: "logo", mime: "image/png",
          image: { contextLink: "https://ksu.example/about", thumbnailLink: "https://t.example/ksu.jpg", width: 800, height: 600 } },
        { title: "bad", link: "https://cdn.example/bad.svg", displayLink: "cdn.example", snippet: "", mime: "text/html<script>",
          image: { contextLink: "javascript:alert(1)", thumbnailLink: "https://t.example/bad.jpg", width: -1, height: "600" } },
      ],
    })
    const request = GoogleSearch.normaliseRequest({ query: "ksu logo", kind: "image", count: 5 })
    const result = GoogleSearch.decodeWorkerResponse(request, 200, body)
    expect(result.items[0].image).toEqual({ contextUrl: "https://ksu.example/about", thumbnailUrl: "https://t.example/ksu.jpg", width: 800, height: 600, mime: "image/png" })
    // الحقولُ العدائيّة تسقط لا تمرّ: لا مخطّط javascript، لا عرضَ سالباً، لا نوعاً غيرَ صورة
    expect(result.items[1].image).toEqual({ contextUrl: "", thumbnailUrl: "https://t.example/bad.jpg" })
    expect(result.browserUrl).toContain("tbm=isch")
    const text = GoogleSearch.format(result)
    expect(text).toContain("800×600 · image/png · الصفحة: https://ksu.example/about")
    // الوضعُ الويب لا يلتقط حقولَ الصور حتى لو أرسلها الخادم
    const web = GoogleSearch.decodeWorkerResponse(GoogleSearch.normaliseRequest({ query: "ksu logo" }), 200, body)
    expect(web.items[0]).not.toHaveProperty("image")
    expect(GoogleSearch.format(web)).toContain("   logo")
  })

  test("the worker frame carries the kind byte under the bumped magic, so an old worker refuses instead of misreading", () => {
    const frame = encodeGoogleSearchWorkerRequest({ query: "q", count: 5, language: "ar", country: "sa", safe: "active", kind: "image", timeoutMs: 15_000 })
    expect(new TextDecoder().decode(frame.slice(0, 5))).toBe("ABGS2")
    expect(frame[frame.length - 5]).toBe(1)
  })
})
