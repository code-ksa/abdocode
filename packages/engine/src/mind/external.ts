/**
 * T12 — بروتوكول الأدوات الخارجية.
 *
 * الفكرة من MCP، **والكود ملكنا**: عمليةٌ خارجية تُعلن أدواتها JSON على
 * stdio، فتنضمّ إلى سجلّ T01 بأصنافها وتُنفَّذ ببوابة النمط نفسها. وقاعدةٌ
 * حاكمةٌ من دستور الجلسة: **توصيلُ كلّ مزوّدٍ خارجيّ قرارُ مالكٍ صريح** —
 * لا تعميم، ولا اشتقاقُ ثقةٍ من توصيلٍ سابق.
 *
 * المصافحة (سطرٌ واحدٌ في كل اتجاه):
 *   ←  {"kind":"hello"}
 *   →  {"kind":"tools","tools":[{"name","effect","usage","summary"}]}
 *   ←  {"kind":"call","id","name","args"}
 *   →  {"kind":"result","id","output"}   أو   {"kind":"error","id","why"}
 *
 * ثلاثة قيود صريحة: الأداة الخارجية **لا تُصنَّف read تلقائياً** (المجهول
 * يُعامَل `command` فيقف على البوابة)، والأسماء تُنَسَّب بالبادئة `<مزوّد>.`
 * فلا تُظلَّل أداةٌ أصليّة، والخرج محدود.
 */

import { stripChildEnv } from "@abdo/tools/env-strip"

export interface ExternalTool {
  readonly name: string
  readonly effect: "read" | "edit" | "command" | "network"
  readonly usage: string
  readonly summary: string
}

export interface ExternalProvider {
  readonly id: string
  readonly command: readonly string[]
  /**
   * سلكُ المزوّد. `native` لغتُنا (المصافحة أعلاه)، و`mcp` بروتوكول MCP
   * القياسيّ (`mind/mcp.ts`). **القدرةُ واحدةٌ والسلكان اثنان**: ما بعد الجلسة
   * — التنسيبُ وتشديدُ الصنف والبوّابةُ والكتالوج — واحدٌ لا يُكرَّر.
   * الغيابُ = `native`، فالموصولُ قبل اليوم لا يتغيّر سلوكُه.
   */
  readonly protocol?: "native" | "mcp"
}

/**
 * السطحُ الذي يملؤه كلُّ سلك. تعريفُه هنا لا في المُنادي: مُنادٍ يعرف الصنفَ
 * الملموس يربط نفسَه بسلكٍ بعينه، فيصير السلكُ الثاني نسخةً من المسار كلِّه.
 */
export interface ToolProviderSession {
  readonly id: string
  handshake(timeoutMs?: number): Promise<readonly ExternalTool[]>
  tools(): readonly ExternalTool[]
  call(name: string, args: string, timeoutMs?: number): Promise<{ ok: boolean; text: string }>
  close(): void
}

const SAFE_EFFECTS = new Set(["read", "edit", "command", "network"])

/**
 * الصيغةُ تُنسب حيث يُنسب الاسم — عيبُ صحّةٍ مقيس (2026-09-03).
 *
 * الاسمُ كان يُنسب (`<مزوّد>.<أداة>`) والصيغةُ تُنقل كما كتبها المزوّد بمفرداته
 * العارية (`issue <رقم>`). ما دامت الأدواتُ الخارجيّة لا تدخل كتالوج النموذج
 * لم يظهر شيء؛ فلمّا أُعلنت (S13.5) صار `@abdo/harness` يرمي عليها:
 * «tool <اسم> usage must start with its legal name». والرميةُ داخل `ask` بلا
 * التقاط، فمزوّدٌ واحدٌ يكتب صيغته بلهجته كان **يُسقط كلّ نداءات النموذج في
 * الدور** ما دام موصولاً. النصُّ الذي تكتبه عمليةٌ غريبة يُقصّ عند حدّه، لا
 * يُوثق به: الكلمةُ الأولى تُبدَّل بالاسم المنسوب ويبقى ما بعدها كما هو.
 */
export const namespacedUsage = (name: string, usage: string): string => {
  const declared = usage.trim()
  if (declared === name || declared.startsWith(`${name} `)) return declared
  const bare = declared.split(" ", 1)[0] ?? ""
  const suffix = bare.length > 0 ? declared.slice(bare.length) : ""
  const rebuilt = `${name}${suffix}`.trimEnd()
  return rebuilt.length === 0 ? name : rebuilt
}

/** أداةٌ خارجية تُقبل فقط بصنفٍ معروف؛ والمجهول يُشدَّد إلى command. */
export const normalise = (providerId: string, raw: unknown): ExternalTool | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.name !== "string" || r.name.length === 0 || r.name.includes(" ")) return undefined
  const effect = typeof r.effect === "string" && SAFE_EFFECTS.has(r.effect) ? (r.effect as ExternalTool["effect"]) : "command"
  const name = `${providerId}.${r.name}`
  return {
    name,
    effect,
    usage: typeof r.usage === "string" ? namespacedUsage(name, r.usage) : `${name} <معطيات>`,
    summary: typeof r.summary === "string" ? r.summary.slice(0, 160) : "أداةٌ خارجية بلا وصف",
  }
}

/** جلسةُ مزوّدٍ خارجيّ حيّة. */
export class ExternalSession implements ToolProviderSession {
  readonly id: string
  #child: import("bun").Subprocess<"pipe", "pipe", "ignore"> | undefined
  #tools: ExternalTool[] = []
  #pending = new Map<string, (r: { ok: boolean; text: string }) => void>()
  #seq = 0
  #buffer = ""

  constructor(provider: ExternalProvider) {
    this.id = provider.id
    // ⚠ كان يرث `process.env` كاملاً — ومنه `ABDO_SHELL_TOKEN` الذي تُصادق
    // به القشرةُ المحرّك، ومقابضُ الخزنة. مزوّدٌ من طرفٍ ثالث كان يملك مفتاحَ
    // انتحال القشرة. (مقيس 2026-09-04.)
    this.#child = Bun.spawn(provider.command as string[], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore",
      env: stripChildEnv(process.env).env,
    }) as never
    void this.#pump()
  }

  async #pump(): Promise<void> {
    const stdout = this.#child?.stdout as ReadableStream<Uint8Array> | undefined
    if (!stdout) return
    const reader = stdout.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      this.#buffer += dec.decode(value, { stream: true })
      let cut
      while ((cut = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, cut)
        this.#buffer = this.#buffer.slice(cut + 1)
        if (line.trim().length === 0) continue
        let frame: Record<string, unknown>
        try { frame = JSON.parse(line) } catch { continue }
        if (frame.kind === "tools" && Array.isArray(frame.tools)) {
          this.#tools = frame.tools.map((t) => normalise(this.id, t)).filter((t): t is ExternalTool => t !== undefined)
        } else if ((frame.kind === "result" || frame.kind === "error") && typeof frame.id === "string") {
          const resolve = this.#pending.get(frame.id)
          if (resolve) {
            this.#pending.delete(frame.id)
            resolve({ ok: frame.kind === "result", text: String(frame.output ?? frame.why ?? "").slice(0, 4000) })
          }
        }
      }
    }
    // موتُ المزوّد يُفرغ أدواته: قائمةٌ لمزوّدٍ ميتٍ كذبةٌ صامتة
    this.#tools = []
    for (const [, resolve] of this.#pending) resolve({ ok: false, text: "المزوّد الخارجيّ انقطع" })
    this.#pending.clear()
  }

  #send(frame: object): void {
    this.#child?.stdin.write(JSON.stringify(frame) + "\n")
  }

  async handshake(timeoutMs = 5000): Promise<readonly ExternalTool[]> {
    this.#send({ kind: "hello" })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && this.#tools.length === 0) await Bun.sleep(50)
    return this.#tools
  }

  tools(): readonly ExternalTool[] {
    return this.#tools
  }

  call(name: string, args: string, timeoutMs = 60_000): Promise<{ ok: boolean; text: string }> {
    const bare = name.startsWith(`${this.id}.`) ? name.slice(this.id.length + 1) : name
    this.#seq += 1
    const id = `c${this.#seq}`
    const done = new Promise<{ ok: boolean; text: string }>((resolve) => {
      this.#pending.set(id, resolve)
      // `unref` ضروريّ: مؤقّت مهلةٍ حيٌّ يمنع العملية من الخروج ولو أُجيب
      // الطلب — أثبته التشغيل بـexit=124 بينما الحلقة سليمة تماماً.
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) resolve({ ok: false, text: "المزوّد الخارجيّ لم يُجب داخل المهلة" })
      }, timeoutMs)
      timer.unref?.()
    })
    this.#send({ kind: "call", id, name: bare, args })
    return done
  }

  close(): void {
    this.#child?.kill()
    this.#child = undefined
    this.#tools = []
  }
}

export * as External from "./external"
