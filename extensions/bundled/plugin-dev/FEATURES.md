# Plugin dev — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `plugin-dev` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/plugin-dev` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill plugin-dev/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (7)

- `/skill plugin-dev/agent-development` — This skill should be used when the user asks to "create an agent", "add an agent", "write a subagent", "agent frontmatter", "when to use description", "agent examples", "agent tools", "agent colors",
- `/skill plugin-dev/command-development` — This skill should be used when the user asks to "create a slash command", "add a command", "write a custom command", "define command arguments", "use command frontmatter", "organize commands", "create
- `/skill plugin-dev/hook-development` — This skill should be used when the user asks to "create a hook", "add a PreToolUse/PostToolUse/Stop hook", "validate tool use", "implement prompt-based hooks", "use ${CLAUDE_PLUGIN_ROOT}", "set up eve
- `/skill plugin-dev/mcp-integration` — This skill should be used when the user asks to "add MCP server", "integrate MCP", "configure MCP in plugin", "use .mcp.json", "set up Model Context Protocol", "connect external service", mentions "${
- `/skill plugin-dev/plugin-settings` — This skill should be used when the user asks about "plugin settings", "store plugin configuration", "user-configurable plugin", ".local.md files", "plugin state files", "read YAML frontmatter", "per-p
- `/skill plugin-dev/plugin-structure` — This skill should be used when the user asks to "create a plugin", "scaffold a plugin", "understand plugin structure", "organize plugin components", "set up plugin.json", "use ${CLAUDE_PLUGIN_ROOT}",
- `/skill plugin-dev/skill-development` — This skill should be used when the user wants to "create a skill", "add a skill to plugin", "write a new skill", "improve skill description", "organize skill content", or needs guidance on skill struc

## الأوامرُ المنقولة مهاراتٍ (1)

- /create-plugin ⇦ `/skill plugin-dev/cmd-create-plugin` — Guided end-to-end plugin creation workflow with component design, implementation, and validation

## الوكلاء (3)

- `agent-creator` (أدوات: write, read) — نصُّه الكامل `/skill plugin-dev/agent-agent-creator`، وملفُّه `agents/agent-creator.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate agent-creator :: <المهمّة>`
- `plugin-validator` (أدوات: read, grep, glob, run) — نصُّه الكامل `/skill plugin-dev/agent-plugin-validator`، وملفُّه `agents/plugin-validator.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate plugin-validator :: <المهمّة>`
- `skill-reviewer` (أدوات: read, grep, glob) — نصُّه الكامل `/skill plugin-dev/agent-skill-reviewer`، وملفُّه `agents/skill-reviewer.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate skill-reviewer :: <المهمّة>`

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
