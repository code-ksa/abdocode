/**
 * أثرُ الشِّلّ تحت سلطة النواة — إدخالٌ ثمّ دفتر.
 *
 * كان أمرُ `run` (مقدّمةً وخلفيّةً) خارج سلطة أثر النواة كلِّها: النواةُ تُدخِل محوّلاتِها
 * الخمسةَ ولا شِلَّ بينها. صار للشِّلّ محوّلٌ سادسٌ بصنفه الصادق — `Irreversible`: سطرُ أمرٍ
 * قد يحذف أو ينشر أو يدفع، ولا عمليّةَ تعويضٍ تُسمّى، دليلٌ على ما جرى فقط.
 *
 * **والحكمُ مقيسٌ لا متوقَّع (2026-09-27):** توقّعتُ أن ترفضه النواةُ على مضيفٍ بلا عزلِ
 * نظام، فقاعدتُها ترفض ما لا رجعةَ فيه حين يكون الإنفاذُ `Unavailable`. والقياس: الحدُّ
 * المصرَّف يعطي `Partial` بثغرةٍ مسمّاة («application-controls-only-no-os-sandbox»)،
 * و`Partial` ليس `Unavailable` — فالنواةُ **تُدخِله وتسجّل الثغرة**. فلا تجاوزَ لرفضٍ هنا،
 * بل إدخالٌ حقيقيٌّ بتقريره كما هو.
 *
 * والترتيبُ جزءٌ من الميزة: **الإدخالُ قبل سؤال المشغّل** (لا يُسأل عن أثرٍ لن يُدخَل)،
 * و**بدءُ الدفتر قبل الإقلاع** (أثرٌ بدأ قبل تسجيله أثرٌ لا يستردّه الاسترداد).
 *
 * وغيابُ العامل أو رفضُه **رفضٌ للتشغيل** لا تشغيلٌ بلا نواة — «الغياب رفضٌ لا إذن»، وهي
 * القاعدةُ نفسُها التي تحكم الكتابة (محوّلُ `write` يفشل مغلقاً بلا عامل).
 */
import { AdapterEffectLedger, ToolAdmissionWorker } from "@abdo/tool-worker"
import { createHash, randomUUID } from "node:crypto"

export interface ShellAdmission {
  readonly admitted: true
  /** «Full» أو «Partial» كما قاله العامل — يُروى ولا يُجمَّل. */
  readonly enforcement: string
  /** نصُّ الثغرة المسجَّلة في التقرير (مثل «application-controls-only-no-os-sandbox»). */
  readonly limitations: string
}

export interface ShellRefusal {
  readonly admitted: false
  readonly why: string
}

/** يقرأ ملصقاً مخزَّناً في بصمةِ ٣٢ بايتاً (بادئةٌ نصّيّة ثمّ أصفار ثمّ ١ في الأخير). */
const labelOf = (digest: unknown): string => {
  if (digest === null || typeof digest !== "object") return ""
  const bytes = Uint8Array.from(Object.values(digest as Record<string, number>).slice(0, 31))
  return new TextDecoder().decode(bytes).replace(/\u0000+$/u, "")
}

export const admitShell = async (workerExecutable: string): Promise<ShellAdmission | ShellRefusal> => {
  try {
    const admission = await new ToolAdmissionWorker(workerExecutable).admit("shell")
    const report = admission.report as unknown as Record<string, unknown>
    const enforcement = typeof report.enforcement === "string" ? report.enforcement : "Unknown"
    return { admitted: true, enforcement, limitations: labelOf(report.limitations_digest) }
  } catch (error) {
    return { admitted: false, why: error instanceof Error ? error.message : String(error) }
  }
}

/** بصمةٌ سداسيّةٌ بطول ٦٤ — الشكلُ الوحيدُ الذي يقبله دفترُ المحوّلات. */
const hex64 = (value: string): string => createHash("sha256").update(value).digest("hex")

export interface ShellEffectRecord {
  readonly effectId: string
  readonly operationDigest: string
}

/**
 * بدءُ الأثر في دفتر النواة **قبل** الإقلاع. العائدُ يحمل ما يلزم لتسويته.
 * لا يُنقل نصُّ الأمر إلى الدفتر — بصمتُه وحدها، كما يفعل المحوّلُ مع حمولته.
 */
export const beginShellEffect = async (
  ledger: AdapterEffectLedger,
  command: string,
  cwd: string,
  background: boolean,
): Promise<ShellEffectRecord> => {
  const effectId = randomUUID().replaceAll("-", "")
  const operationDigest = hex64(JSON.stringify({ version: 1, adapter: "shell", command, cwd, background }))
  await ledger.begin(effectId, operationDigest)
  return { effectId, operationDigest }
}

/** تسويةٌ بخروجٍ معلوم — رمزُ الخروج وبصمةُ الخرج، لا الخرجُ نفسُه. */
export const settleShellEffect = async (
  ledger: AdapterEffectLedger,
  record: ShellEffectRecord,
  outcome: { readonly exitCode: number | null; readonly stopped?: boolean; readonly output?: string },
): Promise<void> => {
  await ledger.settle(record.effectId, record.operationDigest, hex64(JSON.stringify({
    exitCode: outcome.exitCode,
    stopped: outcome.stopped === true,
    output: hex64(outcome.output ?? ""),
  })))
}

/** أثرٌ لا يُعرف مآلُه (فشلُ إقلاعٍ بعد البدء) — يُقال «مجهول» ولا يُسوّى كأنّه نجح. */
export const unknownShellEffect = async (ledger: AdapterEffectLedger, record: ShellEffectRecord, why: string): Promise<void> => {
  await ledger.unknown(record.effectId, record.operationDigest, hex64(why))
}
