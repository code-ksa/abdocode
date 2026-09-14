/**
 * A harness in the reasoning-first convention, written here.
 *
 * The convention imitated is the one where the model is expected to think at
 * length before acting and the harness makes room for that: a short system
 * instruction, an explicit recovery scope, and permissive schemas so a
 * partially-formed call is repaired rather than rejected. Ours words; `origin`
 * records it and the S126 licensing test bounds the claim.
 */
export const document = {
  id: "deepseek-style",
  version: 1,
  origin: "written-here",
  rationale:
    "For reasoning-first models: little instruction, room to think, and a declared recovery scope so a failed call is retried deliberately instead of repeated. Permissive schemas cost a repair pass now and then, which the native harness avoids by declaring closed schemas.",
  naming: {
    assistant: "the assistant",
    toolNameCase: "snake",
  },
  instructions: [
    {
      scope: "system",
      text: "You are {assistant}. Think the problem through before acting, then act. State the conclusion, not the deliberation.",
    },
    {
      scope: "builder",
      text: "You are {assistant}. Decide the shape of the change before writing any of it. Then write it once.",
    },
    {
      scope: "verifier",
      text: "You are {assistant}. Look for the case the author did not consider. Report it, or report that you looked and found none.",
    },
    {
      scope: "recovery",
      text: "You are {assistant}, and the last attempt failed. Say what you now believe went wrong before you try again. Do not repeat the identical call.",
    },
  ],
  tools: {
    shape: "json-schema",
    strict: false,
    descriptionMaxChars: 2048,
  },
  stop: [],
} as const
