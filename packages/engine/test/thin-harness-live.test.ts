import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { encodeLocalJsonFrame, LocalJsonFrameDecoder } from "@abdo/transport-contracts"

// و«صارم» يرسلان النصَّ نفسه (نظام 9823 حرفاً + دور 2106). هنا يُقاس ما يصل النموذجَ فعلاً في الحقبة الأولى عبر المحرّك الحقيقيّ
// بالإضافات الافتراضية: الرفيعُ بلا مواعظ ولا نثر ولا طلب خلاصة، والصارمُ بها كلِّها (التوأمُ الإيجابيّ)، وعقدُ الأدوات في كليهما.

const ROOT = resolve(import.meta.dir, "../../..")

async function firstRequest(railPolicy: string): Promise<{ system: string; user: string; tier: string | undefined }> {
  const base = mkdtempSync(join(tmpdir(), "abdo-thin-")), state = join(base, "state"), project = join(base, "proj")
  mkdirSync(join(project, "src", "app"), { recursive: true }); mkdirSync(join(state, "trust"), { recursive: true })
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0", scripts: { dev: "next dev", build: "next build" }, dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" } }))
  writeFileSync(join(project, "README.md"), "# محامي جدة\n")
  writeFileSync(join(project, "src", "app", "page.tsx"), "export default function Page() { return <main>مرحبا</main> }\n")
  const requests: { system: string; user: string }[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { stream?: boolean; messages?: { role: string; content: unknown }[] }
    const msgs = body.messages ?? []
    const text = (m: { content: unknown } | undefined) => m === undefined ? "" : typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    requests.push({ system: msgs.filter((m) => m.role === "system").map(text).join("\n"), user: text([...msgs].reverse().find((m) => m.role === "user")) })
    const content = "Done."
    if (body.stream === false) return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  } })
  const settings = join(state, "settings.json")
  writeFileSync(settings, JSON.stringify({ language: "ar", agentModel: "tool-fixture/model", chatModel: "tool-fixture/model", modelRole: "agent", mode: "full-access", project, routerGate: "off", railPolicy, customProviders: [{ id: "tool-fixture", label: "fixture", baseUrl: `http://127.0.0.1:${server.port}/v1`, vaultKey: "", local: true, models: ["model"] }] }))
  const { createHash } = await import("node:crypto")
  writeFileSync(join(state, "trust", createHash("sha256").update(resolve(project).toLowerCase()).digest("hex") + ".json"), JSON.stringify({ project, trustedAt: new Date().toISOString(), by: "test" }))
  const child = Bun.spawn([process.execPath, "packages/engine/src/cli.ts", "serve"], { cwd: ROOT, env: { ...process.env, ABDO_SHELL_TOKEN: "tool-test", ABDO_FRAMED_STDIO: "1", ABDO_CODE_SETTINGS: settings, ABDO_CODE_STATE_DIR: state, ABDO_CODE_TRUST_DIR: join(state, "trust"), USERPROFILE: base, HOME: base, ABDO_VAULT_HOME: base, ABDO_REQUIRE_SPRINT_PLAN: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const errors = new Response(child.stderr).text(), frames: any[] = []
  const decoder = new LocalJsonFrameDecoder()
  void (async () => { for await (const bytes of child.stdout) frames.push(...decoder.push(bytes)) })()
  const send = (frame: object) => { child.stdin.write(encodeLocalJsonFrame(frame)); void child.stdin.flush() }
  const wait = async (predicate: () => boolean) => { const deadline = Date.now() + 90_000; while (!predicate()) { if (Date.now() > deadline) throw Error("timed out " + JSON.stringify(frames).slice(-2000)); await Bun.sleep(15) } }
  try {
    send({ kind: "hello", shell: "desktop", token: "tool-test" }); await wait(() => frames.some((f) => f.kind === "ready"))
    send({ kind: "submit", mode: "full-access", turn: { id: "t-1", body: "أضف صفحة «من نحن» للموقع مع رابط في القائمة العلوية" } })
    await wait(() => frames.some((f) => f.turnId === "t-1" && ["done", "refused", "unresolved"].includes(f.kind)))
    const rails = frames.find((f) => f.kind === "rails")
    return { system: requests[0]?.system ?? "", user: requests[0]?.user ?? "", tier: rails?.tier }
  } finally { child.kill(); await child.exited; server.stop(true); await errors; rmSync(base, { recursive: true, force: true }) }
}

const COACHING = ["عند إنشاء موقع Next.js صغير", "لا تختلق أرقام خبرة", "قبل كتابة توقعٍ عدديّ في اختبار", "حافظ على الهدف الأصلي، وافحص حالة المشروع بعد كل حقبة", "إذا بقي عمل فاقترح الأداة التالية", "حين يسمّي المستخدم مشروعاً ليستكمله", "For a new Next.js scaffold, first write a minimal manifest"]
const CONTRACT = ["عند الحاجة إلى أداة أخرج «نفّذ: <الأمر>» فقط", "- lsp diag <ملف>", "- plan set <<<", "Active project root:", "اقرأ الملفات الكبيرة بمقطع", "لا تقل تم قبل تشغيل البناء", "أجب باللغة التي يطلبها المستخدم صراحة", "Windows PowerShell"]

test.skipIf(process.platform !== "win32")("thin rails send a thin harness; strict rails keep the coaching, prose and summary ask (positive twin); the tool contract reaches both", async () => {
  const thin = await firstRequest("thin")
  const strict = await firstRequest("strict")
  expect(thin.tier).toBe("thin"); expect(strict.tier).toBe("strict")
  // الصارم: كلُّ المواعظ والنثر وطلبُ الخلاصة موجودة — التوأمُ الإيجابيّ الذي يثبت أنّ الأسطر تُنتَج أصلاً
  for (const line of COACHING) expect(strict.system).toContain(line)
  expect(strict.user).toContain("Observed now from bounded root metadata, not recalled completion claims")
  expect(strict.user).toContain("\"interpretation\":")
  expect(strict.user).toContain("— خلاصة الحقبة:")
  // الرفيع: بلا مواعظ في النظام، وبلا نثرٍ ولا تفسيرٍ في الرصد، وبلا طلب خلاصة
  for (const line of COACHING) expect(thin.system).not.toContain(line)
  expect(thin.user).not.toContain("not recalled completion claims")
  expect(thin.user).not.toContain("\"interpretation\":")
  expect(thin.user).not.toContain("— خلاصة الحقبة:")
  // ما يبقى للقويّ: عقدُ الأدوات وكتالوجُها والجذرُ والصدفةُ واقتصادُ القراءة — في كليهما
  for (const line of CONTRACT) { expect(thin.system).toContain(line); expect(strict.system).toContain(line) }
  // ورصدُ المشروع (JSON الحقائق) والخريطةُ الباردة والطلبُ نفسه في كليهما
  for (const part of ["[CURRENT_PROJECT_OBSERVATIONS]", "\"frameworks\":[\"next\",\"react\"]", "خريطة المشروع", "أضف صفحة «من نحن»"]) { expect(thin.user).toContain(part); expect(strict.user).toContain(part) }
  // والفرقُ مقيس لا مدَّعى (2026-09-07: نظامٌ −1964 حرفاً، دورٌ −1.1k): الرفيعُ أقصر بما لا يقلّ عن ١٥٠٠ حرفٍ نظاماً وثمانمئةٍ دوراً
  expect(strict.system.length - thin.system.length).toBeGreaterThanOrEqual(1500)
  expect(strict.user.length - thin.user.length).toBeGreaterThanOrEqual(800)
}, 240_000)
