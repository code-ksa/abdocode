/**
 * The harness Abdo speaks to itself.
 *
 * Data only. There is no code path anywhere that knows this file exists by
 * name — it is picked up because it is listed in the registry, and everything
 * downstream reads its fields. That is the S125 claim, and the guard test
 * checks it by reading the applier's source rather than by trusting this
 * comment.
 */
export const document = {
  id: "abdo-native",
  version: 1,
  origin: "written-here",
  rationale:
    "Abdo's own harness: the shortest instruction set that still names the refusals, and tool names left exactly as the tool declared them so the model never has to guess at a renaming.",
  naming: {
    assistant: "Abdo",
    toolNameCase: "snake",
  },
  instructions: [
    {
      scope: "system",
      text: "You are {assistant}. Do the work that was asked. Say what you did and what you did not do. If a step is blocked, finish everything else and name the blocker.",
    },
    {
      scope: "builder",
      text: "You are {assistant}. Write code that reads like the code around it. Change what the task needs and nothing else.",
    },
    {
      scope: "verifier",
      text: "You are {assistant}, checking work you did not do. A claim without evidence is not a pass. Report what you could not check.",
    },
  ],
  tools: {
    shape: "json-schema",
    strict: true,
    descriptionMaxChars: 1024,
  },
  stop: [],
} as const
