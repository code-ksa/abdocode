/**
 * مسبارُ مفتاح المزوّد — «المفتاحُ لا يُحفظ بل يُقاس».
 *
 * البندُ 13 من جرد هيرمس/أوبن‑كلاو (الفكرةُ من openclaw `ui/src/pages/model-providers/probe-results.ts`،
 * لا الشيفرة). العطلُ الذي يعالجه قيس في بلاغ المالك على 4.0.68 (2026-09-27): «حُفظ المفتاح» كان يعني
 * أنّ الخزنةَ كُتبت، لا أنّ المزوّدَ يقبله — فالمفتاحُ الخطأ أو الخطّةُ الخطأ (مفتاحُ Token Plan على مضيفٍ
 * آخر يُرفض بنصٍّ يشبه «منتهٍ») لا تُعرف إلا في أوّل دورٍ يسقط.
 *
 * المسبارُ نداءٌ واحدٌ صغير عبر المسار نفسِه الذي يسلكه الدور (عاملُ Rust يقرأ المفتاح؛ لا يصل هنا أبداً)،
 * وحكمُه سببٌ مسمّى من تصنيف البوّابة نفسِه — لا نصُّ المزوّد ولا جسدُه. وهو **أثرٌ يُنفق توكنات**: يُطلق
 * بضغطة المشغّل، أو تلقائيّاً بعد الحفظ حين يُفعَّل `plugins.providerProbe` (مطفأٌ افتراضاً).
 */
import { classifyModelFailure, type ModelFailureKind } from "@abdo/model-gateway"

export type ProbeKind = "ok" | "no-key" | "local" | "unknown-provider" | "no-model" | ModelFailureKind

export interface ProbeResult {
  readonly provider: string
  readonly model: string
  readonly ok: boolean
  /** اسمُ الحكم (لا `kind`: ذاك مميّزُ الإطار نفسِه على السلك). */
  readonly verdict: ProbeKind
  /** رمزُ HTTP حين رُدّ به — آمنٌ ويُغني عن التخمين. */
  readonly status?: number
  readonly ms: number
}

export interface ProbeProvider {
  readonly id: string
  readonly local: boolean
  readonly models: readonly string[]
  readonly vaultKey?: string
}

export interface ProbeDeps {
  readonly provider: (id: string) => ProbeProvider | undefined
  readonly hasKey: (id: string) => Promise<boolean>
  /** نداءٌ واحدٌ صغيرٌ بأقلّ إخراج — يعيد رمزَ الحالة، أو يرمي عند فشل النقل. */
  readonly send: (provider: ProbeProvider, model: string) => Promise<{ readonly status: number }>
  readonly now: () => number
}

/** أقلُّ إخراجٍ يقبله كلُّ مزوّدٍ مُجمَّع — «1» يرفضه بعضُ نماذج التفكير بطلبٍ غير صالح لا بمفتاحٍ خاطئ. */
export const PROBE_OUTPUT_TOKENS = 16

export async function probeProvider(id: string, deps: ProbeDeps, wantedModel?: string): Promise<ProbeResult> {
  const started = deps.now()
  const provider = deps.provider(id)
  const result = (kind: ProbeKind, model = "", status?: number): ProbeResult =>
    Object.freeze({ provider: id, model, ok: kind === "ok", verdict: kind, ...(status === undefined ? {} : { status }), ms: Math.max(0, deps.now() - started) })
  if (provider === undefined) return result("unknown-provider")
  // المحلّيُّ لا مفتاحَ له، وحالتُه من «تشغيل النماذج المحلية» لا من هنا.
  if (provider.local || provider.vaultKey === undefined) return result("local")
  const model = wantedModel !== undefined && provider.models.includes(wantedModel) ? wantedModel : provider.models[0]
  if (model === undefined) return result("no-model")
  // لا نداءَ بلا مقبض: الغيابُ يُقال غياباً لا «رُفض المفتاح».
  if (!(await deps.hasKey(provider.id))) return result("no-key", model)
  try {
    const response = await deps.send(provider, model)
    if (response.status >= 200 && response.status < 300) return result("ok", model, response.status)
    return result(classifyModelFailure({ status: response.status }).kind, model, response.status)
  } catch (error) {
    return result(classifyModelFailure({ error }).kind, model)
  }
}
