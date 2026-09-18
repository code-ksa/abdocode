import { createHash } from "node:crypto"

export interface EvidenceReceipt { readonly action: string; readonly resultDigest: string; readonly verified: true; readonly previousDigest?: string; readonly digest: string }
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

export function createEvidenceReceipt(input: { action: string; result: string; verified: boolean; previousDigest?: string }): EvidenceReceipt {
  if (!input.action.trim()) throw new Error("evidence_action_required")
  if (!input.verified) throw new Error("unverified_result_refused")
  const resultDigest = digest(input.result)
  const body = JSON.stringify({ action: input.action, resultDigest, verified: true, previousDigest: input.previousDigest })
  return Object.freeze({ action: input.action, resultDigest, verified: true, previousDigest: input.previousDigest, digest: digest(body) })
}

export function verifyEvidenceChain(receipts: readonly EvidenceReceipt[]): boolean {
  return receipts.every((receipt, index) => {
    const expectedPrevious = index === 0 ? receipt.previousDigest : receipts[index - 1]!.digest
    const body = JSON.stringify({ action: receipt.action, resultDigest: receipt.resultDigest, verified: true, previousDigest: expectedPrevious })
    return receipt.previousDigest === expectedPrevious && receipt.digest === digest(body)
  })
}
