# Code modernization — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `code-modernize` · **النوع**: developer · **الإصدار**: 1.0.0
- **الأصل**: anthropics/claude-plugins-official / `plugins/code-modernization` @ `85cce0381e78` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill code-modernize/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (0)

- (لا مهاراتٍ مستقلّة في الأصل)

## الأوامرُ المنقولة مهاراتٍ (10)

- /modernize-assess ⇦ `/skill code-modernize/cmd-modernize-assess` — Full discovery & portfolio analysis of a legacy system — inventory, complexity, debt, relative scale
- /modernize-brief ⇦ `/skill code-modernize/cmd-modernize-brief` — Generate a phased Modernization Brief — the approved plan that transformation agents will execute against
- /modernize-extract-rules ⇦ `/skill code-modernize/cmd-modernize-extract-rules` — Mine business logic from legacy code into testable, human-readable rule specifications
- /modernize-harden ⇦ `/skill code-modernize/cmd-modernize-harden` — Security vulnerability scan with a reviewable remediation patch — OWASP, CWE, CVE, secrets, injection
- /modernize-map ⇦ `/skill code-modernize/cmd-modernize-map` — Dependency & topology mapping — call graphs, data lineage, batch flows, rendered as navigable diagrams
- /modernize-preflight ⇦ `/skill code-modernize/cmd-modernize-preflight` — Environment readiness check — analysis tools, build toolchain, source completeness, telemetry access
- /modernize-reimagine ⇦ `/skill code-modernize/cmd-modernize-reimagine` — Multi-agent greenfield rebuild — extract specs from legacy, design AI-native, scaffold & validate with HITL
- /modernize-status ⇦ `/skill code-modernize/cmd-modernize-status` — Where am I in the modernization workflow — artifact inventory, staleness, secrets hygiene, next step
- /modernize-transform ⇦ `/skill code-modernize/cmd-modernize-transform` — Transform one legacy module to the target stack — idiomatic rewrite with behavior-equivalence tests
- /modernize-uplift ⇦ `/skill code-modernize/cmd-modernize-uplift` — Same-stack version uplift (e.g. .NET Framework 4.8 → .NET 8) — preserve the code, fix the version deltas, prove equivalence by running one test suite on both runtimes

## الوكلاء (8)

- `architecture-critic` (أدوات: read, glob, grep, run) — نصُّه الكامل `/skill code-modernize/agent-architecture-critic`، وملفُّه `agents/architecture-critic.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate architecture-critic :: <المهمّة>`
- `business-rules-extractor` (أدوات: read, glob, grep, run) — نصُّه الكامل `/skill code-modernize/agent-business-rules-extractor`، وملفُّه `agents/business-rules-extractor.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate business-rules-extractor :: <المهمّة>`
- `legacy-analyst` (أدوات: read, glob, grep, run) — نصُّه الكامل `/skill code-modernize/agent-legacy-analyst`، وملفُّه `agents/legacy-analyst.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate legacy-analyst :: <المهمّة>`
- `scaffolder` (أدوات: read, glob, grep, write, edit, run) — نصُّه الكامل `/skill code-modernize/agent-scaffolder`، وملفُّه `agents/scaffolder.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate scaffolder :: <المهمّة>`
- `security-auditor` (أدوات: read, glob, grep, run) — نصُّه الكامل `/skill code-modernize/agent-security-auditor`، وملفُّه `agents/security-auditor.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate security-auditor :: <المهمّة>`
- `test-engineer` (أدوات: read, write, edit, glob, grep, run) — نصُّه الكامل `/skill code-modernize/agent-test-engineer`، وملفُّه `agents/test-engineer.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate test-engineer :: <المهمّة>`
- `uplift-migrator` (أدوات: read, glob, grep, write, edit, run) — نصُّه الكامل `/skill code-modernize/agent-uplift-migrator`، وملفُّه `agents/uplift-migrator.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate uplift-migrator :: <المهمّة>`
- `version-delta-analyst` (أدوات: read, glob, grep, run) — نصُّه الكامل `/skill code-modernize/agent-version-delta-analyst`، وملفُّه `agents/version-delta-analyst.agent.md` يُنسخ إلى دليل الوكلاء ليعمل بـ`delegate version-delta-analyst :: <المهمّة>`

## الموصّلات التي يطلبها الأصل (0)

- (لا موصّلات)

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
