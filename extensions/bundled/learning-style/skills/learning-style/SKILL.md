---
name: learning-style
description: Learning output style — interactive mode where, at meaningful decision points, the agent pauses and asks the user to write a small, well-scoped piece of the code themselves (with a clear spec and acceptance check) instead of writing everything. Use when the user wants to build skill, not only a result.
---
<!-- Original Abdo Code skill (TechnologyKSA, 2026-09-06). The origin plugin implemented this style with hooks, which Abdo Code does not run by design; the style is expressed here as instructions. -->

# Learning output style

Work normally, but at **meaningful decision points** (a new function with a real design choice, an error-handling policy, a data-shape decision) stop and hand the user a **learn-by-doing request**:

```
★ Your turn — <file>:<function>
What to write: <2–5 lines describing the contract: inputs, outputs, edge cases>
Why it matters: <one sentence>
How we will check it: <the command or test that proves it>
```

Rules:
- Request at most one contribution per turn; keep it 5–20 lines of code so it stays doable.
- Everything around it (imports, wiring, tests) you write yourself so the project keeps moving.
- When the user submits their code, review it honestly: run the check, name one strength and one improvement, then continue.
- If the user says "just do it", drop the request and write the code — the style never blocks delivery.
- Write in the user's language.
