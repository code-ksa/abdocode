# AbdoCode (عبدو كود) — from the terminal

A coding agent that runs on your own machine. It reads your project, plans, writes code, runs builds and tests, and
checks its own work — in Arabic or English.

```bash
npm install -g abdocode
abdocode
```

`abdocode` with no arguments opens the full terminal interface. `abdocode help` lists the commands.

**First run:** the package downloads the engine for its version from the
[GitHub release](https://github.com/code-ksa/abdocode/releases), checks its SHA-256, and unpacks it under
`%LOCALAPPDATA%\abdocode-cli`. Later runs start it directly. Set `ABDOCODE_CLI_HOME` to use another folder.

**Platforms:** Windows x64 today. The desktop app (with the same engine) is on the releases page.

**Models:** bring your own provider key (NVIDIA, OpenRouter, z.ai, Qwen and others) or a local model through Ollama;
keys live in the local vault, never in project files.

## عربي

```bash
npm install -g abdocode
abdocode
```

يفتح واجهة الطرفيّة الكاملة. أوّل تشغيلٍ ينزّل المحرّك من صفحة الإصدارات ويتحقّق من بصمته ثمّ يشغّله؛ وبعدها يعمل مباشرة.
