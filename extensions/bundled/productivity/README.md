<!-- Modified by TechnologyKSA for Abdo Code — origin: anthropics/knowledge-work-plugins@1f517b9de47e README.md (Apache-2.0). Names, paths and tool references adapted; see NOTICE.md. -->
# Productivity Plugin

A productivity plugin primarily designed for [Cowork](https://claude.com/product/cowork), Abdo Code's agentic desktop application — though it also works in Abdo Code. Task management, workplace memory, and a visual dashboard — Abdo Code learns your people, projects, and terminology so it can act like a colleague, not a chatbot.

## Installation

```
claude plugins add knowledge-work-plugins/productivity
```

## What It Does

This plugin gives Abdo Code a persistent understanding of your work:

- **Task management** — A markdown task list (`TASKS.md`) that Abdo Code reads, writes, and executes against. Add tasks naturally, and Abdo Code tracks status, triages stale items, and syncs with external tools.
- **Workplace memory** — A two-tier memory system that teaches Abdo Code your shorthand, people, projects, and terminology. Say "ask todd to do the PSR for oracle" and Abdo Code knows exactly who, what, and which deal.
- **Visual dashboard** — A local HTML file that gives you a board view of your tasks and a live view of what Abdo Code knows about your workplace. Edit from the board or the file — they stay in sync.

## Commands

| Command | What it does |
|---------|--------------|
| `/start` | Initialize tasks + memory, open the dashboard |
| `/update` | Triage stale items, check memory for gaps, sync from external tools if applicable |
| `/update --comprehensive` | Deep scan email, calendar, chat — flag missed todos and suggest new memories |

## Skills

| Skill | Description |
|-------|-------------|
| `memory-management` | Two-tier memory system — ABDO.md for working memory, memory/ directory for deep storage |
| `task-management` | Markdown-based task tracking using a shared TASKS.md file |

## Example Workflows

### Getting Started

```
You: /start

Abdo Code: [Creates TASKS.md, ABDO.md, memory/ directory, and dashboard.html]
        [Opens the dashboard in your browser]
        [Asks about your role, team, and current priorities to seed memory]
```

### Adding Tasks Naturally

```
You: I need to review the budget proposal for Sarah by Friday,
     draft the Q2 roadmap after syncing with Greg, and follow up
     on the API spec from the Platform team

Abdo Code: [Adds all three tasks to TASKS.md with context]
        [Dashboard updates automatically]
```

### Morning Sync

```
You: /update --comprehensive

Abdo Code: [Scans email, calendar, and chat for new action items]
        [Flags: "Budget proposal review is due tomorrow — still open"]
        [Suggests: "New person mentioned in 3 threads: Jamie Park,
         Design Lead — add to memory?"]
        [Updates stale tasks and fills memory gaps]
```

### Workplace Shorthand

Once memory is populated, Abdo Code decodes your shorthand instantly:

```
You: ask todd to do the PSR for oracle

Abdo Code: "Ask Todd Martinez (Finance lead) to prepare the Pipeline
         Status Report for the Oracle Systems deal ($2.3M, closing Q2)"
```

No clarifying questions. No round trips.

## Data Sources

> If you see unfamiliar placeholders or need to check which tools are connected, see [CONNECTORS.md](CONNECTORS.md).

Connect your communication and project management tools for the best experience. Without them, manage tasks and memory manually.

**Included MCP connections:**
- Chat (Slack) for team context and message scanning
- Email and calendar (Microsoft 365) for action item discovery
- Knowledge base (Notion) for reference documents
- Project tracker (Asana, Linear, Atlassian, monday.com, ClickUp) for task syncing
- Office suite (Microsoft 365) for documents

**Additional options:**
- See [CONNECTORS.md](CONNECTORS.md) for alternative tools in each category
