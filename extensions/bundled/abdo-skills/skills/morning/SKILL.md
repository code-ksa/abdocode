---
name: morning
description: Morning briefing — start the working day by reading the project's plan and memory, listing what changed since the last session, the gates that are red, and the three next actions, then ask which one to start. Use at the beginning of a session or when the user says "صباح الخير" / "ابدأ يومي".
---
<!-- Original Abdo Code skill (TechnologyKSA, 2026-09-06). -->

# Morning briefing

Produce a short, honest start-of-day brief for the current project. Read before writing; never invent.

1. **Where we are** — read `ABDO-SPRINTS.md` (or the project plan) and the last `ABDO-HANDOFF.md`; quote the current sprint and its acceptance gate.
2. **What changed** — run `git log --since="1 day ago" --oneline` and `git status --short`; summarise in three lines at most.
3. **What is red** — name every gate that failed or was not run in the last session (build, types, tests).
4. **Memory** — recall project facts with the `recall` tool and list any that affect today's work (deadlines, owner decisions, conventions).
5. **Next three actions** — ordered by risk, each one sentence with the file it touches.
6. End with one question: which action to start.

Keep it under 150 words in the user's language. No greetings longer than one line.
