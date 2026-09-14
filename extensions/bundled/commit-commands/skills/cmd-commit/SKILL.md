---
name: cmd-commit
description: Create a git commit
---
<!-- Modified by TechnologyKSA for Abdo Code — origin: anthropics/claude-plugins-official@85cce0381e78 commands/commit.md (Apache-2.0). Names, paths and tool references adapted; see NOTICE.md. -->
## Context

- Current git status: !`git status`
- Current git diff (staged and unstaged changes): !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Your task

Based on the above changes, create a single git commit.

You have the capability to call multiple tools in a single response. Stage and create the commit using a single message. Do not use any other tools or do anything else. Do not send any other text or messages besides these tool calls.
