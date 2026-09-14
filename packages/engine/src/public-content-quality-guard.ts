export interface PublicContentWrite {
  readonly normalizedTarget: string
  readonly after: string
}

/** Catch runaway metadata prose before a syntactically valid file reaches disk. */
export const excessiveMetadataDescription = (write: PublicContentWrite): number | undefined => {
  if (!/\.(?:tsx?|jsx?)$/iu.test(write.normalizedTarget)) return undefined
  const descriptions = [...write.after.matchAll(/\bdescription\s*:\s*(["'`])([\s\S]*?)\1/gu)]
  const excessive = descriptions.map((match) => match[2]?.length ?? 0).find((length) => length > 500)
  return excessive
}
