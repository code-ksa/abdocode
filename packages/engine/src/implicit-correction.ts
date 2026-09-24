/** Learning from what the user corrects without being asked to remember it.
 *
 * "لا، استخدم PostgreSQL بدل SQLite" / "actually use pnpm, not npm" carries a
 * standing decision the user will expect to hold next time. It is recorded
 * as an *inferred* memory: candidate status, a confidence from how explicit
 * the phrasing was, and a marker in recall saying it is unconfirmed until the
 * user confirms it (Memory panel) or overrides it with /remember. Only a
 * short, top-level, plain message qualifies — never quoted, fenced, attached
 * or credential-bearing text — so the model cannot be taught by a document. */
import { classifyInboundSecret } from "./secret-intake"
import { memoryTerms } from "./memory-terms"

export interface ImplicitCorrection {
  readonly topic: string
  readonly to: string
  readonly from?: string
  /** 0..1 — how explicit the correction was. */
  readonly confidence: number
  readonly pattern: string
}

const MAX_BODY = 240
const MAX_VALUE = 120

// Ordered from most to least explicit. Named groups: to (the decision), from (what it replaces).
const PATTERNS: readonly { name: string; re: RegExp; confidence: number }[] = [
  { name: "ar-negate-replace", confidence: 0.8, re: /^(?:لا|لأ|مش|ليس|غلط|خطأ|خطا)[،,.!]?\s*(?:استخدم|استعمل|خلّيها|خليها|اجعلها|اجعله|نستخدم|نبي|نبغى|أريد|اريد|بدنا|نريد|اعتمد)\s+(?<to>.+?)\s+(?:بدل|بدلاً من|بدلا من|مش|لا|وليس|مو|وليست)\s+(?<from>.+?)[.!]?$/iu },
  { name: "ar-instead", confidence: 0.75, re: /^(?:بدل|بدلاً من|بدلا من)\s+(?<from>.+?)\s+(?:استخدم|استعمل|خلّيها|خليها|اجعلها|اجعله|نستخدم|نبي|اعتمد)\s+(?<to>.+?)[.!]?$/iu },
  { name: "ar-use-not", confidence: 0.7, re: /^(?:استخدم|استعمل|خلّيها|خليها|اجعلها|اجعله|اعتمد)\s+(?<to>.+?)\s+(?:بدل|بدلاً من|بدلا من|مش|وليس|مو)\s+(?<from>.+?)[.!]?$/iu },
  { name: "ar-negate", confidence: 0.6, re: /^(?:لا|لأ|مش|ليس|غلط|خطأ|خطا)[،,.!]?\s*(?:استخدم|استعمل|خلّيها|خليها|اجعلها|اجعله|نستخدم|نبي|نبغى|أريد|اريد|بدنا|نريد|اعتمد)\s+(?<to>.+?)[.!]?$/iu },
  { name: "ar-always", confidence: 0.55, re: /^(?:دائماً|دائما|دايماً|دايما|من الآن|من الان|من هنا ورايح)[،,]?\s*(?:استخدم|استعمل|خلّيها|خليها|اجعلها|اجعله|نستخدم|اعتمد)\s+(?<to>.+?)[.!]?$/iu },
  { name: "en-negate-replace", confidence: 0.8, re: /^(?:no|nope|not that|wrong|actually|correction)[,.!:]?\s*(?:use|switch to|go with|make it|let'?s use|we use|i want|we want|prefer|stick with)\s+(?<to>.+?)\s+(?:instead of|not|rather than|over)\s+(?<from>.+?)[.!]?$/iu },
  { name: "en-instead", confidence: 0.75, re: /^(?:instead of|rather than)\s+(?<from>.+?)[,]?\s+(?:use|switch to|go with|make it|let'?s use|prefer)\s+(?<to>.+?)[.!]?$/iu },
  { name: "en-use-not", confidence: 0.7, re: /^(?:use|switch to|go with|make it|let'?s use|stick with|prefer)\s+(?<to>.+?)\s+(?:instead of|not|rather than|over)\s+(?<from>.+?)[.!]?$/iu },
  { name: "en-negate", confidence: 0.6, re: /^(?:no|nope|not that|wrong|actually|correction)[,.!:]?\s*(?:use|switch to|go with|make it|let'?s use|we use|i want|we want|prefer|stick with)\s+(?<to>.+?)[.!]?$/iu },
  { name: "en-always", confidence: 0.55, re: /^(?:always|from now on|going forward)[,]?\s*(?:use|go with|make it|prefer|stick with)\s+(?<to>.+?)[.!]?$/iu },
]

// Index-aligned with memory-terms concepts; the two engine families collapse to "database".
const CONCEPT_TOPIC = ["database", "database", "database", "billing", "auth", "permissions", "tests", "style", "deploy", "memory", "resume", "packages"]

const clean = (value: string) => value.replace(/[\s"'«»“”]+/gu, " ").replace(/[\x00-]/gu, "").trim()

/** Topic: the shared concept when the vocabulary knows it, else the first content word of the decision. */
export function correctionTopic(to: string, from?: string): string {
  const terms = memoryTerms(`${to} ${from ?? ""}`)
  const concept = [...terms.concepts][0]
  if (concept !== undefined && CONCEPT_TOPIC[concept]) return CONCEPT_TOPIC[concept]!
  const word = [...terms.tokens].find((token) => token.length >= 3)
  return (word ?? "preference").slice(0, 40)
}

export function detectImplicitCorrection(body: string): ImplicitCorrection | undefined {
  const text = body.trim()
  if (text.length === 0 || text.length > MAX_BODY) return undefined
  if (/[\r\n]/u.test(text) || /^[\/\\]/u.test(text) || /```|<<<|^>|\bنفّذ:|https?:\/\//u.test(text)) return undefined
  if (/[?؟]\s*$/u.test(text)) return undefined
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(text)
    if (!match?.groups?.to) continue
    const to = clean(match.groups.to), from = match.groups.from ? clean(match.groups.from) : undefined
    if (!to || to.length > MAX_VALUE || (from !== undefined && (from.length === 0 || from.length > MAX_VALUE))) return undefined
    if (from !== undefined && from.toLowerCase() === to.toLowerCase()) return undefined
    if (classifyInboundSecret(text).carriesSecret) return undefined
    return { topic: correctionTopic(to, from), to, ...(from !== undefined ? { from } : {}), confidence: pattern.confidence, pattern: pattern.name }
  }
  return undefined
}

/** The stored value shape for an inferred memory (`inferred:<topic>` keys). */
export interface InferredValue { readonly note: string; readonly to: string; readonly from?: string; readonly confidence: number; readonly inferred: true }

export function inferredValue(correction: ImplicitCorrection): InferredValue {
  return { note: correction.from ? `${correction.to} (not ${correction.from})` : correction.to, to: correction.to, ...(correction.from ? { from: correction.from } : {}), confidence: correction.confidence, inferred: true }
}
