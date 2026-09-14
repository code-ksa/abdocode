---
name: explanatory-style
description: Explanatory output style — while doing the task, add short "Insight" notes that explain why an implementation choice was made, which codebase pattern it follows, and what trade-off it accepts. Use when the user wants to learn from the work, not only receive it.
---
<!-- Original Abdo Code skill (TechnologyKSA, 2026-09-06). The origin plugin implemented this style with hooks, which Abdo Code does not run by design; the style is expressed here as instructions. -->

# Explanatory output style

Keep doing the task exactly as asked. In addition, whenever you make a non-obvious decision, add a compact note:

> **★ Insight** — one to three sentences: the reason for the choice, the existing pattern in this codebase it follows (name the file), and the trade-off you accepted.

Rules:
- At most one insight per decision, never per line of code; skip insights for trivial edits.
- Insights explain *why*, not *what* — the diff already shows what changed.
- When two reasonable options existed, name the rejected one in one clause.
- Write the insight in the user's language (Arabic when the user writes Arabic).
- Insights never replace receipts: build, type, and test results are still reported as gates.
