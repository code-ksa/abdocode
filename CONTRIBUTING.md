# Contributing to AbdoCode

AbdoCode is proprietary software with published source (see `LICENSE` and `COMMERCIAL.md`). Contributions are welcome under those terms, and they follow one rule: **idea first, execution after review**.

## 1. Propose the idea

Open an issue or a draft pull request that states, in this order:

1. **The measurement** — what a real model did on a real machine, with the receipt lines (tool calls and their results). "The model guessed the window title three times" is a measurement; "the model should be smarter" is not.
2. **The rule you propose** — what the harness should do so the next model does not have to learn it by trial (a refusal that names the next call, a tool that removes the need to guess, a guard that reads receipts).
3. **How it will be proven** — the unit test and, where the change touches a browser, a window or a shell, the live board that reads the truth back from the target (a file the window writes, a pixel of a known colour, `/health`).

Maintainers answer with one of: go ahead, needs a smaller scope, or already covered (with the pointer).

## 2. Execute

- Keep the change inside one line of work (`docs/MIND.md` §8 lists them) and one package where possible.
- Every guard needs its **positive twin**: a test that proves the thing is produced at all, not only that the bad case is refused.
- Receipts are Arabic today; new receipts should carry the exact next call the model can make. English receipts are a line of work (`docs/MIND.md`), not a reason to block a change.
- Run `bun test` in the package you touched. Keep machine paths, personal accounts and credentials out of the tree — they are rejected in review.
- Do not add secrets, fixtures that look like real tokens, or anything from a customer's project.

## 3. Ship a lesson with the fix

If your fix came from a measured model failure, add one entry to `packages/engine/release-lessons.json`:

```json
{ "cls": "env_trap", "text": "…the rule, in one sentence the model can act on…" }
```

Classes are closed: `playbook`, `package_pattern`, `env_trap`. The engine promotes shipped lessons into every installed copy's shared awareness once per version, through the same promotion rule as any lesson (class check, secret sweep, no project identity). Lessons that name a project, a path or a person are refused by the rule, not by the reviewer.

## 4. What a good pull request looks like

- Title: the measured defect and the rule (`desk focus: strip quotes around the title — model quoted it three times`).
- Body: the receipt lines, the test names, and what you did **not** do.
- No force pushes to shared branches; no history rewrites.

## 5. Communication

- Issues and pull requests on GitHub.
- Email: technoksaweb@gmail.com (TechnologyKSA).
