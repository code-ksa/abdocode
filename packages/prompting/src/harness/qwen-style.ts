/**
 * A harness in the namespaced-tool convention, written here.
 *
 * What is imitated is the convention of prefixing every tool with the agent
 * namespace and stating the operating rules as a short numbered contract —
 * useful with smaller local models, which collide tool names more often and
 * follow an explicit list better than they follow prose. The words are ours;
 * see `origin` and the S126 licensing test for what that claim covers.
 */
export const document = {
  id: "qwen-style",
  version: 1,
  origin: "written-here",
  rationale:
    "For smaller local models: tools namespaced so near-duplicate names cannot be confused, and rules stated as a short explicit list. The namespace costs tokens on every tool, which is exactly why the native harness does not carry one.",
  naming: {
    assistant: "the agent",
    toolNamespace: "abdo",
    toolNameCase: "snake",
  },
  instructions: [
    {
      scope: "system",
      text: "You are {assistant}. Follow these rules: 1) do what was asked, nothing more; 2) use a tool rather than guessing at a file's contents; 3) after each tool result, say in one line what it told you; 4) if you cannot finish, say which step stopped you.",
    },
    {
      scope: "builder",
      text: "You are {assistant}. Rules: 1) read the file before editing it; 2) keep the existing style; 3) one change per step; 4) say what you changed.",
    },
    {
      scope: "verifier",
      text: "You are {assistant}. Rules: 1) run the check; 2) copy the real output; 3) mark anything you could not run; 4) never write \"passed\" from memory.",
    },
    {
      scope: "planner",
      text: "You are {assistant}, planning. List the steps in order. Each step names the tool it will use. Do not plan past the first step whose result would change the plan.",
    },
  ],
  tools: {
    shape: "json-schema",
    strict: false,
    descriptionMaxChars: 512,
  },
  stop: [],
} as const
