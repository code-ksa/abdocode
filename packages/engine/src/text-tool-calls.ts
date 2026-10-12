/**
 * 10-10 (مقيس في مهمّة n8n على deepseek-v4-pro، بروتوكولٌ أصليّ): النموذجُ أنهى ردَّه بنداءاتٍ مكتوبةٍ نصّاً بصيغة DeepSeek —
 * `<tool_calls><invoke name="list"><parameter name="path" string="true">.abdo/reference</parameter></invoke>…</tool_calls>` — فظهرت
 * للمستخدم نصّاً خامّاً ولم يُنفَّذ شيء (حارسُ «<tool_call>» المفرد لا يطابق الجمع). النداءُ نيّةٌ صريحةٌ بأسماءٍ ووسائط محدّدة، فيُحوَّل
 * إلى نداءٍ منظّم يمرّ بفحص nativeToolReply نفسِه (الاسمُ المعلَن، الوسائطُ، حزمةُ القراءة) — لا بابَ ثانياً حوله.
 */
import type { ModelToolCall } from "@abdo/model-gateway"

const DSML = "(?:｜DSML｜|\\|DSML\\|)?"
const BLOCK = new RegExp(`<${DSML}(?:tool_calls|function_calls)>([\\s\\S]*?)</${DSML}(?:tool_calls|function_calls)>`, "u")
const INVOKE = new RegExp(`<${DSML}invoke\\s+name="([A-Za-z0-9_.-]{1,64})"\\s*>([\\s\\S]*?)</${DSML}invoke>`, "gu")
// 10-10 (مقيس بعد 4.0.129): الصيغةُ نفسُها بلا غلاف <tool_calls> — «<invoke name="read"><parameter name="file">ABDO-SPRINTS.md</parameter>…</invoke>».
const BARE = new RegExp(`<${DSML}invoke\\s+name="[A-Za-z0-9_.-]{1,64}"\\s*>[\\s\\S]*</${DSML}invoke>`, "u")
const PARAM = new RegExp(`<${DSML}parameter\\s+name="([A-Za-z0-9_]{1,40})"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${DSML}parameter>`, "gu")
const INTENT_MAX = 160

/** Pure. Text tool calls in DeepSeek's markup → structured calls and the remaining text; undefined when there are none. */
export function salvageTextToolCalls(text: string, intentField = false): { text: string; calls: ModelToolCall[] } | undefined {
  const wrapped = BLOCK.exec(String(text ?? ""))
  const bare = wrapped === null ? BARE.exec(String(text ?? "")) : null
  const block = wrapped ?? bare
  if (block === null) return undefined
  const inner = wrapped !== null ? wrapped[1]! : block[0]
  const rest = (text.slice(0, block.index) + text.slice(block.index + block[0].length)).trim()
  const calls: ModelToolCall[] = []
  for (const invoke of inner.matchAll(INVOKE)) {
    const input: Record<string, unknown> = {}
    for (const param of invoke[2]!.matchAll(PARAM)) {
      const raw = param[3]!.replace(/^\r?\n/u, "").replace(/\r?\n$/u, "")
      if (param[2] === "false") { try { input[param[1]!] = JSON.parse(raw) } catch { input[param[1]!] = raw } }
      else input[param[1]!] = raw
    }
    if (intentField && typeof input.intent !== "string") {
      const line = rest.split(/\r?\n/u).map((l) => l.trim()).find((l) => l.length > 0) ?? ""
      input.intent = (line.length > 0 ? line : `نداءٌ كتبه النموذجُ نصّاً: ${invoke[1]}`).slice(0, INTENT_MAX)
    }
    calls.push({ id: `text-call-${calls.length + 1}`, name: invoke[1]!, input })
  }
  return calls.length === 0 ? undefined : { text: rest, calls }
}
