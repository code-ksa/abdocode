// خوادمُ التطوير (S2): قارئُ `.claude/launch.json` مغلقُ الفشل، والدمجُ بالقياس دالّةٌ صافية.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LAUNCH_CONFIG_CAP, LAUNCH_CONFIG_PATH, LAUNCH_RUNTIMES, mergeDevServerRows, readLaunchConfig, type LaunchConfig } from "../src/dev-servers"

const project = (body: string | object): string => {
  const dir = mkdtempSync(join(tmpdir(), "abdo-launch-"))
  mkdirSync(join(dir, ".claude"), { recursive: true })
  writeFileSync(join(dir, LAUNCH_CONFIG_PATH), typeof body === "string" ? body : JSON.stringify(body))
  return dir
}
const entry = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ name: "web-app", runtimeExecutable: "npm", runtimeArgs: ["run", "dev"], port: 3210, ...over })
const file = (...configurations: unknown[]) => ({ version: "0.0.1", configurations })

describe("readLaunchConfig — الفشلُ مغلقٌ والرفضُ مسمّى", () => {
  test("الغيابُ لا إعدادات بلا مشكلة؛ والتشويهُ لا إعدادات بمشكلةٍ مسمّاة", () => {
    const empty = mkdtempSync(join(tmpdir(), "abdo-launch-none-"))
    expect(readLaunchConfig(empty)).toEqual({ configs: [], problems: [] })
    const broken = readLaunchConfig(project("{ \"configurations\": [ oops"))
    expect(broken.configs).toEqual([])
    expect(broken.problems).toHaveLength(1)
    expect(broken.problems[0]).toContain("JSON")
    // جذرٌ بلا قائمة: ليس «صفرَ إعدادات» بل ملفٌّ لا يُفهم.
    expect(readLaunchConfig(project({ version: "0.0.1" })).problems[0]).toContain("configurations")
    expect(readLaunchConfig(project([1, 2])).problems[0]).toContain("configurations")
  })

  test("الإعدادُ الصحيح يُقرأ بصيغة تطبيق كلود: الاسم والمنفذ والإطلاق والرابطُ الافتراضيّ", () => {
    const reading = readLaunchConfig(project(file(entry())))
    expect(reading.problems).toEqual([])
    expect(reading.configs).toEqual([{ name: "web-app", port: 3210, url: "http://127.0.0.1:3210", launch: ["npm", "run", "dev"] }])
    // runtimeArgs اختياريّة، والمُشغّل يُطبَّع إلى الصغيرة.
    const bare = readLaunchConfig(project(file({ name: "api", runtimeExecutable: "Node", port: 8080 })))
    expect(bare.configs[0]?.launch).toEqual(["node"])
  })

  test("المُشغّل من قائمة سماحٍ مغلقة — الملفُّ في مستودع العميل ويُنفَّذ بضغطة زرّ", () => {
    for (const runtime of ["cmd", "bash", "sh", "curl", "C:/x/npm.cmd", "", 7]) {
      const reading = readLaunchConfig(project(file(entry({ runtimeExecutable: runtime }))))
      expect(reading.configs).toEqual([])
      expect(reading.problems[0]).toContain("runtimeExecutable")
    }
    for (const runtime of LAUNCH_RUNTIMES) {
      expect(readLaunchConfig(project(file(entry({ runtimeExecutable: runtime })))).configs).toHaveLength(1)
    }
    // وسيطٌ يحمل محرفَ تحكّم يُرفض — لا يُنظَّف صامتاً.
    expect(readLaunchConfig(project(file(entry({ runtimeArgs: ["run", "dev\n&& rm"] })))).problems[0]).toContain("runtimeArgs")
    expect(readLaunchConfig(project(file(entry({ runtimeArgs: "run dev" })))).problems[0]).toContain("runtimeArgs")
  })

  test("المنفذُ 1024–65535 عدداً صحيحاً، والاسمُ معرّفٌ قصيرٌ بلا فراغ ولا تكرار", () => {
    for (const port of [80, 1023, 65_536, 70_000, "3210", 3210.5, undefined]) {
      expect(readLaunchConfig(project(file(entry({ port })))).problems[0]).toContain("المنفذ")
    }
    expect(readLaunchConfig(project(file(entry({ port: 1024 })))).configs).toHaveLength(1)
    expect(readLaunchConfig(project(file(entry({ port: 65_535 })))).configs).toHaveLength(1)
    for (const name of ["web app", "-web", "a".repeat(41), "", 5, "ويب"]) {
      expect(readLaunchConfig(project(file(entry({ name })))).problems[0]).toContain("الاسم")
    }
    expect(readLaunchConfig(project(file(entry({ name: "a".repeat(40) })))).configs).toHaveLength(1)
    const dup = readLaunchConfig(project(file(entry(), entry({ port: 4000 }))))
    expect(dup.configs).toHaveLength(1)
    expect(dup.problems[0]).toContain("مكرّر")
  })

  test("url: المحلّيُّ أصلُ الخادم على منفذه لا غير؛ والبعيدُ يُقبل كما هو؛ وغيرُ http يُرفض", () => {
    expect(readLaunchConfig(project(file(entry({ url: "http://localhost:3210" })))).configs[0]?.url).toBe("http://localhost:3210/")
    expect(readLaunchConfig(project(file(entry({ url: "http://localhost:3000" })))).problems[0]).toContain("يخالف")
    expect(readLaunchConfig(project(file(entry({ url: "http://127.0.0.1:3210/admin" })))).problems[0]).toContain("مسار")
    expect(readLaunchConfig(project(file(entry({ url: "https://staging.example.test/app" })))).configs[0]?.url).toBe("https://staging.example.test/app")
    expect(readLaunchConfig(project(file(entry({ url: "file:///C:/x" })))).problems[0]).toContain("url")
    expect(readLaunchConfig(project(file(entry({ url: 12 })))).problems[0]).toContain("url")
  })

  test("السقفُ ستّةَ عشر: ما بعده يُترك ويُقال", () => {
    const many = Array.from({ length: LAUNCH_CONFIG_CAP + 3 }, (_, i) => entry({ name: `svc-${i}`, port: 4000 + i }))
    const reading = readLaunchConfig(project(file(...many)))
    expect(reading.configs).toHaveLength(LAUNCH_CONFIG_CAP)
    expect(reading.problems).toHaveLength(1)
    expect(reading.problems[0]).toContain(String(LAUNCH_CONFIG_CAP))
  })

  test("إعدادٌ فاسدٌ بين صحيحين يسقط وحده بسببه، ولا يُسقط الملفَّ كلَّه", () => {
    const reading = readLaunchConfig(project(file(entry({ name: "a", port: 3001 }), "nope", entry({ name: "c", port: 3003 }))))
    expect(reading.configs.map((c) => c.name)).toEqual(["a", "c"])
    expect(reading.problems).toEqual([`${LAUNCH_CONFIG_PATH}: الإعداد #2: ليس كائناً`])
  })
})

describe("mergeDevServerRows — الحالةُ ثلاثيّةٌ ومالكُها مسمّى", () => {
  const web: LaunchConfig = { name: "web", port: 3000, url: "http://127.0.0.1:3000", launch: ["npm", "run", "dev"] }
  const api: LaunchConfig = { name: "api", port: 4000, url: "http://127.0.0.1:4000", launch: ["bun", "run", "start"] }
  const docs: LaunchConfig = { name: "docs", port: 5000, url: "http://127.0.0.1:5000", launch: ["npx", "vitepress", "dev"] }
  const ext: LaunchConfig = { name: "ext", port: 6000, url: "http://127.0.0.1:6000", launch: ["node", "server.js"] }

  test("المُدارُ يأخذ قياسَه بسببه؛ والمطلوبُ «يُقاس»؛ والخارجيُّ «يعمل بيدٍ أخرى» غيرَ مُدار؛ والباقي «متوقّف»", () => {
    const rows = mergeDevServerRows([web, api, docs, ext], {
      managed: [{ name: "npm run dev", port: 3000, state: "up", pid: 7 }, { name: "bun run start", port: 4000, state: "down", why: "خرجت برمز 1" }],
      leased: new Map(),
      starting: new Set(["docs"]),
      external: new Set([6000]),
    })
    expect(rows).toEqual([
      { name: "web", port: 3000, url: "http://127.0.0.1:3000", state: "up", managed: true },
      { name: "api", port: 4000, url: "http://127.0.0.1:4000", state: "down", managed: true, why: "خرجت برمز 1" },
      { name: "docs", port: 5000, url: "http://127.0.0.1:5000", state: "measuring", managed: true },
      { name: "ext", port: 6000, url: "http://127.0.0.1:6000", state: "up", managed: false, why: "يعمل بيدٍ أخرى" },
    ])
  })

  test("منفذٌ مؤجَّر يبدّل منفذَ الصفّ ورابطَه — اللوحةُ تفتح حيث يُنصت الخادمُ فعلاً", () => {
    const rows = mergeDevServerRows([web], {
      managed: [{ name: "npm run dev -- -p 3001", port: 3001, state: "up" }],
      leased: new Map([["web", 3001]]),
      starting: new Set(),
      external: new Set(),
    })
    expect(rows[0]).toEqual({ name: "web", port: 3001, url: "http://127.0.0.1:3001", state: "up", managed: true })
  })

  test("بلا إعدادات لا صفوف — والدالّةُ لا تلمس شيئاً", () => {
    expect(mergeDevServerRows([], { managed: [], leased: new Map(), starting: new Set(), external: new Set() })).toEqual([])
  })
})
