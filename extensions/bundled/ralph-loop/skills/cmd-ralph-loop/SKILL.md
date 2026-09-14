---
name: cmd-ralph-loop
description: Start Ralph Loop in current session
---
<!-- Modified by TechnologyKSA for Abdo Code — origin: anthropics/claude-plugins-official@85cce0381e78 commands/ralph-loop.md (Apache-2.0). Names, paths and tool references adapted; see NOTICE.md. -->
# Ralph Loop Command

Execute the setup script to initialize the Ralph loop:

```!
"${extension}/scripts/setup-ralph-loop.sh" (the user's request)
```

Please work on the task. When you try to exit, the Ralph loop will feed the SAME PROMPT back to you for the next iteration. You'll see your previous work in files and git history, allowing you to iterate and improve.

CRITICAL RULE: If a completion promise is set, you may ONLY output it when the statement is completely and unequivocally TRUE. Do not output false promises to escape the loop, even if you think you're stuck or should exit for other reasons. The loop is designed to continue until genuine completion.
