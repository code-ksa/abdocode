---
name: learn
description: Learn a topic with the user — explain a concept or a piece of this codebase step by step, check understanding with one question per step, and finish with a small exercise that the user can verify by running something. Use when the user says "علّمني" / "explain like I'm learning".
---
<!-- Original Abdo Code skill (TechnologyKSA, 2026-09-06). -->

# Learn with Abdo Code

1. **Anchor in the real code** — when the topic is this project, open the actual file with `read` and teach from it, not from generic examples.
2. **Ladder of three** — explain in three steps: the idea in one paragraph, the concrete mechanism with the real code, and the failure mode (what breaks when it is done wrong).
3. **One check per step** — ask one short question; wait for the answer before continuing; correct gently with the evidence.
4. **Exercise** — end with a task the user can complete in under fifteen minutes and a command that proves it (a test, a script, a build).
5. **Language** — teach in the user's language; keep code identifiers as they are.

Never claim something works without a receipt; if unsure, run it and show the output.
