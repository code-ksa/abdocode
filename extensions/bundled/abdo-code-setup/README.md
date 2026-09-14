<!-- Modified by TechnologyKSA for Abdo Code — origin: anthropics/claude-plugins-official@85cce0381e78 README.md (Apache-2.0). Names, paths and tool references adapted; see NOTICE.md. -->
# Abdo Code Setup Plugin

Analyze codebases and recommend tailored Abdo Code automations - hooks, skills, MCP servers, and more.

## What It Does

Abdo Code uses this skill to scan your codebase and recommend the top 1-2 automations in each category:

- **MCP Servers** - External integrations (context7 for docs, Playwright for frontend)
- **Skills** - Packaged expertise (Plan agent, frontend-design)
- **Hooks** - Automatic actions (auto-format, auto-lint, block sensitive files)
- **Subagents** - Specialized reviewers (security, performance, accessibility)
- **Slash Commands** - Quick workflows (/test, /pr-review, /explain)

This skill is **read-only** - it analyzes but doesn't modify files.

## Usage

```
"recommend automations for this project"
"help me set up Abdo Code"
"what hooks should I use?"
```

<img src="automation-recommender-example.png" alt="Automation recommender analyzing a codebase and providing tailored recommendations" width="600">

## Author

Isabella He (isabella@anthropic.com)
