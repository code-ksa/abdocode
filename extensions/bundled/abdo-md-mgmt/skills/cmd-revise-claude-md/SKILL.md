---
name: cmd-revise-claude-md
description: Update ABDO.md with learnings from this session
---
<!-- Modified by example for Abdo Code — origin: anthropics/claude-plugins-official@85cce0381e78 commands/revise-claude-md.md (Apache-2.0). Names, paths and tool references adapted; see NOTICE.md. -->
Review this session for learnings about working with Abdo Code in this codebase. Update ABDO.md with context that would help future Abdo Code sessions be more effective.

## Step 1: Reflect

What context was missing that would have helped Abdo Code work more effectively?
- Bash commands that were used or discovered
- Code style patterns followed
- Testing approaches that worked
- Environment/configuration quirks
- Warnings or gotchas encountered

## Step 2: Find ABDO.md Files

```bash
find . -name "ABDO.md" -o -name ".claude.local.md" 2>/dev/null | head -20
```

Decide where each addition belongs:
- `ABDO.md` - Team-shared (checked into git)
- `.claude.local.md` - Personal/local only (gitignored)

## Step 3: Draft Additions

**Keep it concise** - one line per concept. ABDO.md is part of the prompt, so brevity matters.

Format: `<command or pattern>` - `<brief description>`

Avoid:
- Verbose explanations
- Obvious information
- One-off fixes unlikely to recur

## Step 4: Show Proposed Changes

For each addition:

```
### Update: ./ABDO.md

**Why:** [one-line reason]

\`\`\`diff
+ [the addition - keep it brief]
\`\`\`
```

## Step 5: Apply with Approval

Ask if the user wants to apply the changes. Only edit files they approve.
