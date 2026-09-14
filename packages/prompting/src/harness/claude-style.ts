/**
 * A harness in the Anthropic-style convention, written here.
 *
 * Nothing in this file is copied from a published prompt. What is imitated is
 * the *convention* — XML-delimited tool blocks, permissive schemas, long tool
 * descriptions carrying most of the instruction weight — because that is what
 * a model trained on that convention expects to see. The words are ours, and
 * `origin` says so; that declaration is the only part of provenance a test can
 * check, and the S126 licensing test says as much out loud rather than
 * pretending to verify authorship.
 */
export const document = {
  id: "claude-style",
  version: 1,
  origin: "written-here",
  rationale:
    "For models tuned on XML-delimited tool blocks and permissive schemas. Costs more per turn than the native harness because the convention carries its instruction weight in prose and tool descriptions rather than in a compact schema.",
  naming: {
    assistant: "the assistant",
    toolNameCase: "snake",
  },
  instructions: [
    {
      scope: "system",
      text: "You are {assistant}. Work carefully and finish what was asked. Before you use a tool, say in one sentence what you expect it to do; after it returns, say whether that held. When a request is ambiguous, choose the reading a careful colleague would choose and state the assumption rather than stopping. If part of the work is blocked, complete every other part and name the blocker plainly.",
    },
    {
      scope: "builder",
      text: "You are {assistant}, writing code that has to live alongside the code already here. Match the surrounding style. Prefer the smallest change that fully does the job over a larger one that also tidies.",
    },
    {
      scope: "verifier",
      text: "You are {assistant}, reviewing a change somebody else made. Begin by stating what the change was supposed to accomplish, in your own words. Then look for the ways it could fail rather than the ways it could work. Distinguish what you verified by running something from what you inferred by reading, and label each.",
    },
  ],
  tools: {
    shape: "xml",
    strict: false,
    descriptionMaxChars: 4096,
  },
  stop: ["</tool_result>"],
} as const
