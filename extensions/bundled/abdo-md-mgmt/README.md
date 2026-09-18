<!-- Modified by example for Abdo Code — origin: anthropics/claude-plugins-official@85cce0381e78 README.md (Apache-2.0). Names, paths and tool references adapted; see NOTICE.md. -->
# ABDO.md Management Plugin

Tools to maintain and improve ABDO.md files - audit quality, capture session learnings, and keep project memory current.

## What It Does

Two complementary tools for different purposes:

| | claude-md-improver (skill) | /revise-claude-md (command) |
|---|---|---|
| **Purpose** | Keep ABDO.md aligned with codebase | Capture session learnings |
| **Triggered by** | Codebase changes | End of session |
| **Use when** | Periodic maintenance | Session revealed missing context |

## Usage

### Skill: claude-md-improver

Audits ABDO.md files against current codebase state:

```
"audit my ABDO.md files"
"check if my ABDO.md is up to date"
```

<img src="claude-md-improver-example.png" alt="ABDO.md improver showing quality scores and recommended updates" width="600">

### Command: /revise-claude-md

Captures learnings from the current session:

```
/revise-claude-md
```

<img src="revise-claude-md-example.png" alt="Revise command capturing session learnings into ABDO.md" width="600">

## Author

Isabella He (isabella@anthropic.com)
