---
name: import-memory
description: Import memory from another AI assistant — the user pastes an exported memory or "what you know about me" text (from ChatGPT, Claude, Gemini or notes); turn it into clean, categorised Abdo Code memory notes (profile, topics, areas, people) and save only what the user confirms.
---
<!-- Original Abdo Code skill (TechnologyKSA, 2026-09-06). -->

# Import memory from another assistant

The user will paste text exported from another assistant. Convert it into Abdo Code memory without inventing or embellishing.

1. **Parse** the text into atomic facts (one sentence each). Drop greetings, duplicates and anything that is a preference of the *other* assistant rather than a fact about the user.
2. **Categorise** each fact:
   - `profile` — who the user is (role, languages, tools, working style)
   - `topic` — recurring subjects and projects
   - `area` — responsibilities or domains
   - `person` — people and their relation to the user
3. **Flag sensitive items** (health, finances, religion, politics, identifiers) and keep them out unless the user explicitly asks to include them.
4. **Show the table** (category · fact · source line) and ask the user to confirm or edit.
5. **Save** the confirmed facts through the memory notes surface (Settings → Memory → Import, or the `memory-note` frame with its category) — one note per fact, tagged with the source assistant and today's date.

Never save before confirmation. Report the count saved and the count skipped, with reasons.
