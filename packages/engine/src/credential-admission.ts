/**
 * S11 (2026-09-18) — بوّابةُ الاعتماد عند قبول الدور، قبل أوّل نداء نموذج.
 *
 * مقيس على دفاتر المثبّتات: ستّة أدوارٍ ماتت قبل أوّل أداة بـ«اعتماد المزوّد غير متاح» لأنّ
 * نموذجَ الدور أو درجةً في سلّم المالك أو نموذجَ الرؤية يشير إلى مزوّدٍ مقبضُه غائبٌ في خزنة
 * ذلك التطبيق. الحكمُ هنا حتميّ: المزوّدُ المحلّيّ ومن لا مقبضَ له يمرّان بلا فحص؛ وغيرُهما
 * يُسأل عنه حضورُ المقبض (`has`) — فشلُ السؤال غياب («الغياب رفضٌ لا إذن»). ما غاب مقبضُه
 * يُخطّى بإشعارٍ واحد (سطر ⚠)، والدورُ يمضي على أوّل ما بقي؛ وإن لم يبقَ شيءٌ فرفضٌ يسمّي
 * المقابضَ الغائبة كلَّها. الوحدة خالصةٌ من الأثر: الخزنةُ والكتالوجُ يصلان منافذَ.
 */

export interface AdmissionProvider { readonly id: string; readonly local: boolean; readonly vaultKey?: string }

export interface AdmissionDeps {
  readonly parseRef: (ref: string) => { readonly provider: string } | undefined
  readonly providerOf: (id: string) => AdmissionProvider | undefined
  /** حضورُ المقبض لا قيمتُه — فعلُ `has`؛ الرميُ يُعدّ غياباً. */
  readonly hasCredential: (provider: string) => Promise<boolean>
}

export interface AdmissionInput {
  /** نموذجُ الدور المختار (مرجع «مزوّد/نموذج»). */
  readonly selected: string
  /** سلّمُ المالك بترتيبه. */
  readonly ladder: readonly string[]
  /** نموذجُ الرؤية المضبوط إن وُجد. */
  readonly vision?: string
}

export interface MissingHandle { readonly ref: string; readonly provider: string; readonly handle: string }

export interface AdmissionResult {
  /** النموذجُ الذي يمضي عليه الدور — `undefined` حين لا يبقى شيء (انظر `failure`). */
  readonly selected: string | undefined
  /** السلّمُ بعد إسقاط ما غاب مقبضُه، بترتيبه. */
  readonly ladder: readonly string[]
  /** نموذجُ الرؤية إن قُبل؛ `undefined` = لا رؤيةَ مضبوطة أو مقبضُها غائب. */
  readonly vision: string | undefined
  readonly missing: readonly MissingHandle[]
  /** سطرٌ واحد للدفتر حين خُطّي شيءٌ والدورُ ماضٍ؛ بلا غيابٍ لا سطر. */
  readonly notice: string | undefined
  /** سببٌ مسمّى حين لا يبقى نموذج — الدورُ يُرفض به. */
  readonly failure: string | undefined
}

const UNRESOLVED = "مرجعٌ لا يُحلّ"

export async function admitCredentials(input: AdmissionInput, deps: AdmissionDeps): Promise<AdmissionResult> {
  const probes = new Map<string, Promise<boolean>>()
  const present = (provider: string): Promise<boolean> => {
    let probe = probes.get(provider)
    if (probe === undefined) {
      probe = deps.hasCredential(provider).then((has) => has === true, () => false)
      probes.set(provider, probe)
    }
    return probe
  }
  const missing: MissingHandle[] = []
  const seenMissing = new Set<string>()
  /** `undefined` = مقبول؛ وإلا المقبضُ الغائب. */
  const gap = async (ref: string): Promise<MissingHandle | undefined> => {
    const parsed = deps.parseRef(ref)
    const provider = parsed === undefined ? undefined : deps.providerOf(parsed.provider)
    if (parsed === undefined || provider === undefined) return { ref, provider: parsed?.provider ?? ref, handle: UNRESOLVED }
    if (provider.local || provider.vaultKey === undefined) return undefined
    return (await present(provider.id)) ? undefined : { ref, provider: provider.id, handle: provider.vaultKey }
  }
  const admit = async (ref: string): Promise<boolean> => {
    const g = await gap(ref)
    if (g === undefined) return true
    if (!seenMissing.has(g.ref)) { seenMissing.add(g.ref); missing.push(g) }
    return false
  }

  const selectedOk = await admit(input.selected)
  const ladder: string[] = []
  for (const ref of input.ladder) if (await admit(ref)) ladder.push(ref)
  const vision = input.vision === undefined ? undefined : (await admit(input.vision)) ? input.vision : undefined
  // النموذجُ الماضي: المختارُ إن قُبل، وإلا أوّلُ درجةٍ قُبلت من السلّم — لا اختراعَ بديلٍ خارجهما.
  const selected = selectedOk ? input.selected : ladder[0]

  if (missing.length === 0) return Object.freeze({ selected, ladder: Object.freeze(ladder), vision, missing: Object.freeze([]), notice: undefined, failure: undefined })
  const handles = [...new Map(missing.map((m) => [`${m.provider}: ${m.handle}`, m])).keys()].join("، ")
  if (selected === undefined) {
    return Object.freeze({
      selected: undefined, ladder: Object.freeze(ladder), vision, missing: Object.freeze(missing), notice: undefined,
      failure: `لا نموذجَ له اعتمادٌ في الخزنة — المقابضُ الغائبة: ${handles}. أضف المفتاح من الإعدادات ← المزوّدون ثمّ أعد الإطلاق.`,
    })
  }
  const skipped = missing.map((m) => m.ref).join("، ")
  const visionNote = input.vision !== undefined && vision === undefined ? "؛ والرؤيةُ على نموذج الدور" : ""
  const switched = selectedOk ? "" : `؛ يمضي الدور على ${selected}`
  const notice = `اعتمادُ الخزنة غائب — المقابض: ${handles}؛ تُخطّى: ${skipped}${switched}${visionNote}.`
  return Object.freeze({ selected, ladder: Object.freeze(ladder), vision, missing: Object.freeze(missing), notice, failure: undefined })
}
