/**
 * A harness in the code-assistant convention, written here.
 *
 * The convention this imitates is the terse one: strict closed schemas, short
 * tool descriptions, and an instruction set that assumes the model already
 * knows how to program and only needs to be told the rules of this workspace.
 * The words are ours; `origin` records that, and the S126 licensing test states
 * plainly what that declaration can and cannot prove.
 */
export const document = {
  id: "codex-style",
  version: 1,
  origin: "written-here",
  rationale:
    "For models tuned on strict closed function schemas and terse operating rules. Cheaper than the prose-heavy conventions and still more expensive than the native harness, which does not repeat the workspace rules the runtime already enforces.",
  naming: {
    assistant: "the coding assistant",
    toolNameCase: "snake",
  },
  instructions: [
    {
      scope: "system",
      text: "You are {assistant}. Read before you write. Change only what the task requires. Run the tests you can run and report the output you actually saw, including failures.",
    },
    {
      scope: "builder",
      text: "You are {assistant}. Write code that matches the file it lands in. Do not add dependencies without saying why.",
    },
    {
      scope: "verifier",
      text: "You are {assistant}. Re-run the build and the tests. Paste what failed. Do not report a pass you did not observe.",
    },
  ],
  tools: {
    shape: "json-schema",
    strict: true,
    descriptionMaxChars: 1024,
  },
  stop: [],
} as const
