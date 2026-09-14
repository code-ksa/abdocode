# مواصفة المزوّدين وخطط التوكن — 2026-09-03

أمر المالك: «اضف باقي كل المزودين لكي نوفر للمستخدم جميع الخيارات و كل التوكين بلين
مثل اوبن كود ناخذ الافكار فقط». وُضعت هذه المواصفة قراءةً فقط — لا شيفرة من أوبن‑كود،
والأفكار أُعيد بناؤها خلف عقودنا.

## القيد الحاكم: سقفُ المصادقة مُصرَّفٌ في رست

عاملُ الأدوات يعبّر عن **شكلين فقط**: `Authorization: Bearer` و`x-api-key`
(ومعهما ترويسةُ نسخةٍ واحدة لأنثروبيك). فكلُّ مزوّدٍ خارجَ هذين الشكلين **غيرُ قابل
للتعبير** بلا توسيع الصنف المُصرَّف — ولذلك يُستبعد بالاسم لا يُضاف صفّاً كاذباً.
وعنوانُ العامل اشتقاقيّ (أصل + مسار الشكل)، فلا يقبل مُعاملَ استعلام أصلاً.

## الجداول

### يُشحن صفّاً أوّليّاً (27)

| المعرّف | الشكل | المصادقة | الدليل |
|---|---|---|---|
| `ollama` | native-ollama | none — local lane, plain fetch from the engine, never the Ru | MEASURED in our tree today (catalog.ts:24). The only wire that carries sampling knobs, num_ctx, num_predict, native tools and streaming. |
| `anthropic` | anthropic | x-api-key: <key> + compiled literal anthropic-version: 2023- | Endpoint MEASURED in our tree; model ids DOCUMENTATION-VERIFIED (platform.claude.com models overview, fetched 2026-09-03 by the docs lens). No live ca |
| `openai` | openai-compatible | Authorization: Bearer <key> | Endpoint MEASURED; model ids DOCUMENTATION-VERIFIED (developers.openai.com/api/docs/models). |
| `google` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (ai.google.dev/gemini-api/docs/openai). |
| `xai` | openai-compatible | Authorization: Bearer <key> | Endpoint MEASURED; model id DOCUMENTATION-VERIFIED (docs.x.ai/docs/api-reference). |
| `mistral` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (docs.mistral.ai models overview). |
| `groq` | openai-compatible | Authorization: Bearer <key> | Endpoint MEASURED; model ids DOCUMENTATION-VERIFIED (console.groq.com/docs/models). |
| `together` | openai-compatible | Authorization: Bearer <key> | Host DOCUMENTATION-VERIFIED (docs.together.ai OpenAI compatibility). The shipped .xyz host is legacy and unverified — treat the retarget as a correcti |
| `moonshot` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (platform.kimi.ai/docs/api/chat). LIVE DEFECT TODAY: an international user pasting a real key into our menu hits the CN host an |
| `dashscope` | openai-compatible | Authorization: Bearer <key> | MEASURED in our tree and corroborated by the models.dev snapshot vendored in OpenCode. This is the pay-per-token lane; the plan lanes are separate row |
| `openrouter` | openai-compatible | Authorization: Bearer <key>. The optional attribution header | Endpoint MEASURED and DOCUMENTATION-VERIFIED (openrouter.ai/docs/quickstart). |
| `nvidia` | openai-compatible | Authorization: Bearer <key> | MEASURED in our tree, corroborated by the models.dev snapshot. |
| `meta` | openai-compatible | Authorization: Bearer <key> | MEASURED in our tree, corroborated by the models.dev snapshot. |
| `deepseek` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (api-docs.deepseek.com). BLOCKER THAT IS NOT TECHNICAL: packages/egress/src/egress.ts BASE_POLICY.forbidden lists deepseek.com  |
| `zai` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (docs.z.ai/guides/develop/http/introduction). This is the pay-per-token host; the coding plan is a different host and therefore |
| `cerebras` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (inference-docs.cerebras.ai chat-completions). |
| `fireworks` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (docs.fireworks.ai OpenAI compatibility). |
| `deepinfra` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (docs.deepinfra.com/chat/overview). |
| `baseten` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (docs.baseten.co model-apis overview). |
| `nebius` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (docs.tokenfactory.nebius.com). |
| `cohere` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (docs.cohere.com compatibility API). |
| `vercel-gateway` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (vercel.com/docs/ai-gateway). A router: shipping it is a business choice like OpenRouter already is — our customers' code trans |
| `ollama-cloud` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED (docs.ollama.com/cloud). REMOTE — needs the full atomic set including a compiled binding; it is not free the way the local olla |
| `lmstudio` | openai-compatible | none (local: true → prepareChatRequest does not demand a cre | DOCUMENTATION-VERIFIED (lmstudio.ai OpenAI endpoints). TWO CHECKS BEFORE SHIPPING: (a) the engine's local lane has only ever been exercised with wire  |
| `llamacpp` | openai-compatible | none by default (server's --api-key is optional; we do not o | DOCUMENTATION-VERIFIED (llama.cpp tools/server README). Same two local-lane checks as lmstudio. |
| `vllm` | openai-compatible | none by default | DOCUMENTATION-VERIFIED (vLLM quickstart). Same two local-lane checks. |
| `qwen-token-plan` | anthropic | x-api-key + anthropic-version (CredentialKind::ApiKey, anthr | DOCUMENTATION-VERIFIED (alibabacloud.com/help/en/model-studio/claude-code) AND it is our own live precedent: this endpoint was used through ABDO_CUSTO |

### خلف مفتاح (7)

| المعرّف | الشكل | المصادقة | الدليل |
|---|---|---|---|
| `moonshot-cn` | openai-compatible | Authorization: Bearer <key> | DOCUMENTATION-VERIFIED as a distinct service. Ships hidden because it is a regional duplicate that would confuse the default menu. |
| `minimax` | openai-compatible | Authorization: Bearer <key> | CONTESTED: our shipped host api.minimax.chat appears in NO source we checked; vendor docs give api.minimax.io/v1 (OpenAI wire) and api.minimax.io/anth |
| `sambanova` | openai-compatible | Authorization: Bearer <key> | SEARCH-ONLY (no vendor page fetched). Hidden until a doc page or a live 200 exists. |
| `qwen-coding-plan` | anthropic | x-api-key + anthropic-version | DOCUMENTATION-VERIFIED (same Alibaba page). We hold no coding-plan key, so it ships hidden until one 200 is recorded. |
| `zai-coding-plan` | openai-compatible | Authorization: Bearer <plan key> | DOCUMENTATION-VERIFIED (docs.z.ai/devpack/quick-start). Hidden until a plan key returns 200 — a plan key 401s against the pay-per-token host and vice  |
| `minimax-coding-plan` | anthropic | x-api-key + anthropic-version; subscription keys carry an sk | DOCUMENTATION-VERIFIED for the surface (platform.minimax.io token-plan page); BLOCKED behind the parent minimax host/wire verdict above. |
| `kimi-code` | anthropic | x-api-key + anthropic-version | SEARCH-ONLY, plus a corroborating third-party issue stating a Kimi Code plan key works ONLY against api.kimi.com/coding and a platform key ONLY agains |

### بمسار المزوّد المخصّص (3)

| المعرّف | الشكل | المصادقة | الدليل |
|---|---|---|---|
| `zhipuai / tencent-coding-plan / tencent-` | openai-compatible | Authorization: Bearer <plan key> | SNAPSHOT-ONLY — these come from the models.dev catalogue vendored in OpenCode's test fixtures, i.e. a third party's assertion, with no vendor page and |
| `huggingface-router / github-models / chu` | openai-compatible | Authorization: Bearer <key> | SNAPSHOT-ONLY or SEARCH-ONLY. Sixteen rows we cannot stand behind is sixteen lies in a menu. They are all reachable today through ABDO_CUSTOM_PROVIDER |
| `cloudflare-ai-gateway` | openai-compatible | cf-aig-authorization: Bearer <token> — NOT expressible: our  | DOCUMENTATION-VERIFIED and structurally excluded twice over: account-templated host (ProviderBinding.url is a &'static str) and a custom auth header.  |

### يُستبعد بسببه (7)

| المعرّف | الشكل | المصادقة | الدليل |
|---|---|---|---|
| `azure-openai` | openai-compatible | api-key: <key> | DOCUMENTATION-VERIFIED as INEXPRESSIBLE on three counts: templated host, an api-key header we do not have, and a query string that prepareChatRequest  |
| `amazon-bedrock` | n/a | SigV4 request signing | DOCUMENTATION-VERIFIED as a credential subsystem, not a row: SigV4 is a signing implementation inside the Rust worker. Out of scope for this expansion |
| `google-vertex` | anthropic / openai | OAuth access token minted from a service account, refreshed | DOCUMENTATION-VERIFIED as out of scope: needs an expiring credential our CredentialKind enum cannot express. |
| `snowflake-cortex / databricks / sap-ai-c` | varies | PAT/JWT/OAuth/PRIVATE-TOKEN | Snapshot evidence only, and every one is templated-host plus a non-bearer credential. Skip. |
| `claude-pro-max / chatgpt-codex / github-` | anthropic / openai-respons | OAuth PKCE / device code, plus headers that ASSERT the calle | DOCUMENTATION-VERIFIED that these work by presenting as a first-party client, and that Anthropic cut OpenCode off for exactly this in January 2026 (Op |
| `perplexity / ai21 / anyscale` | n/a | n/a | Documentation checked and found NOT to support a coding-agent chat row. Dropping them is the finding. |
| `xai-oauth (SuperGrok)` | openai-compatible | expiring OAuth bearer with refresh — needs a CredentialKind  | SEARCH-ONLY, but notable as the ONE subscription flow published by the vendor rather than reverse-engineered. It is the right template if the owner ev |

## خطط التوكن

HOW A PLAN IS EXPRESSED IN OUR CONTRACTS — and why it is almost free.

THE MEASURED FACT THAT SETTLES THE DESIGN. For every vendor we checked, a subscription/plan is served from a DIFFERENT HOST (or a different path root) than the pay-per-token API, and the two keys are not interchangeable: an Alibaba Coding Plan key answers on coding-intl.dashscope.aliyuncs.com/apps/anthropic and 401s on dashscope-intl; a Z.ai plan key answers on /api/coding/paas/v4 and not on /api/paas/v4; a MiniMax subscription key carries its own sk-cp- prefix. OpenCode reached the same conclusion the same way: in the 159-provider catalogue vendored in its test fixtures, alibaba-token-plan, alibaba-coding-plan, zai-coding-plan, zhipuai-coding-plan, tencent-{coding,token}-plan, xiaomi-token-plan-* and minimax-coding-plan are all FIRST-CLASS PROVIDER ROWS beside their parents. Nothing in their code treats a plan as a mode — there is no plan flag anywhere in it.

THEREFORE: A PLAN IS A ROW, NOT A MODE. This is the whole mechanism for every API-key plan, and it costs us zero new Rust concepts.
- Storage: its own vault handle, abdocode-<planid> (e.g. abdocode-qwen-token-plan), never shared with the parent. Two secrets, two handles — which is also what the worker's namespace discipline already assumes.
- Worker: an ordinary compiled ProviderBinding. The plan endpoint is a constant, the auth is Bearer or x-api-key, so binding() matches it the same way it matches openai today. No CredentialKind change, no runtime URL building — which the compiled-identity design deliberately forbids.
- Catalogue: one new OPTIONAL, data-only field, safe to bundle to the renderer because it holds no secret:
    plan?: { kind: "subscription" | "prepaid-tokens"; parentId: string; requires: string; keyHint?: string }
  e.g. { kind: "prepaid-tokens", parentId: "dashscope", requires: "اشتراك خطة الرموز من Model Studio", keyHint: "المفتاح يبدأ عادةً بـsk-" }.
  keyHint and the vendor's conventional env-var name are DISPLAY ONLY — never a credential source. We never read a key from the environment.
- Parity gate: unchanged in shape; a plan row is checked exactly like any other row.

WHAT THE USER SEES. In الإعدادات ← المزوّدون, plan rows are grouped under their parent vendor with a badge (خطة/اشتراك) and one sentence of precondition: «يتطلب مفتاح خطة <المزوّد> — مفتاح الدفع بالاستهلاك لا يعمل هنا.» A plan row with no key is greyed and clickable straight to its own key box, exactly like every other keyless row today (index.html:1274). In the model picker the ref reads qwen-token-plan/qwen3.8-max, so the user can always see which wallet a turn is spending from. THE HONESTY RULE THE UI ENFORCES: a plan row we have never authenticated against renders as OFFERED-UNPROVEN — visible, greyed, with the plan named — never as a ready option. A row is either PROVEN (a dated probe recorded in .ai/awareness/) or visibly unproven. Never «we believe it works».

WHAT IS STORED. Only the plan key, in the vault (secrets.ps1, gpg+DPAPI), under abdocode-<planid>. The settings file stores no secret — for builtin plan rows it stores nothing at all; the row is compiled. The renderer never reads a key back: vault_has answers yes/no.

WHAT THE WORKER READS. ABDO_VAULT_SCRIPT get abdocode-<planid>, once per request, in Rust: the secret is written into a curl --config on stdin (never argv), zeroed on Drop, and redacted out of the response bytes before they return. Identical to every other provider — which is the point.

HOW THE PRODUCT TELLS THE TWO APART, in three places and no others:
  1. identity — different id, different vault handle. This is the only distinction the worker knows about, and it needs no more.
  2. display — the plan{} field drives the badge, the grouping and the precondition sentence.
  3. accounting — token-budget.ts must ledger usage under the PLAN's provider id, not the parent's. If qwen-token-plan spends against the dashscope bucket, a plan's allowance silently eats the pay-as-you-go allowance and the 10M cloud cap becomes meaningless. This is a real code change, small, and it is the one place a plan is genuinely different.

BUILD ON THE LIVE PRECEDENT, DO NOT INVENT BESIDE IT. The Qwen token-plan endpoint already ran here through ABDO_CUSTOM_PROVIDERS under the id «token-plan» (model-gateway carries the dated comment «measured on token-plan 2026-09-02», and the cache/reasoning token fields it decodes were measured on that run). Sprint work promotes exactly that endpoint to a compiled row, and the custom path stays what it was designed to be: the owner's escape hatch for an endpoint we do not ship — capped at 8 entries, https-only, OpenAI-dialect-only, vault handles locked to custom-.

WHAT WE ARE NOT BUILDING IN v1, said plainly in the menu rather than hidden. An OAuth/subscription LOGIN (ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot, xAI SuperGrok) is a different credential KIND, not a row: a short-lived bearer with an expiry, a refresh token to store, a refresh margin, and for two of the three a set of headers asserting we are the vendor's own editor. Our worker takes one static secret and builds one header; there is nowhere to put any of that. Shipping it honestly would need (a) a CredentialKind that carries expiry, (b) a host-side minter that refreshes and writes the current access token to the vault handle before each call, (c) a loopback listener owned by the Tauri shell. That is a project. v1 says «تسجيل الدخول بالاشتراك غير مدعوم — استخدم مفتاح خطة» — a stated absence is honest; a login button that half-works is not.

A CEILING THE SPEC MUST STATE ALOUD, because it applies to every plan and every cloud row. For all remote providers today: streaming is OFF (cli.ts sets stream only when the provider is local), the response is buffered with a 2 MiB hard cap in the worker, native tool calling is refused for any wire but native-ollama (tools reach cloud models only as a text catalogue in the system prompt), and the openai-compatible encoder sends ONLY {model, stream, temperature:0, presence_penalty:0, stop?, messages} — dropping topP/topK/context and, critically, the output cap. The ledger reserves AGENT_EPOCH_OUTPUT_TOKENS before the call while the provider was never told the limit, so a runaway completion is charged after the fact rather than prevented. Adding max_tokens to the openai-compatible body is a one-line honesty fix that belongs in the same programme as the plan rows (the anthropic wire already sends max_tokens).

## الرزمة الذرّية لكل إضافة

THE ATOMIC SET — a checklist an implementer follows for EACH added provider, in ONE commit. Nine steps; the brief named four, and the two extra ones are where builds actually break.

STEP 1 — CATALOGUE ROW · packages/providers/src/catalog.ts
  { id, version: "1", source: "builtin", label: "<اسم عربي بنفس أسلوب البيت>", local: false, wire, harness, baseUrl, workerUrl, vaultKey: "abdocode-<id>", models: [...], plan?: {...} }
  workerUrl IS NOT A FREE FIELD. prepareChatRequest composes `new URL(pathname-without-trailing-slash + wirePath, origin)` — origin only. So workerUrl MUST equal baseUrl's origin + pathname (no trailing slash) + the wire's fixed path: /chat/completions (openai-compatible), /messages (anthropic), /api/chat (native-ollama). Any query string or userinfo in baseUrl is silently discarded — a provider needing ?api-version= cannot be expressed at all. Never append a path blindly either: some catalogues publish a full endpoint rather than a base.
  id must satisfy /^[a-z][a-z0-9-]{0,63}$/ AND, until the mismatch below is fixed, be ≤32 chars — tool-worker/src/provider.ts hasCredential rejects anything longer.
  models: [] IS A DEFECT, not a blank. xai and groq ship that today: the row draws a key box and then offers nothing in the picker, the datalist or seedCatalog. Every new row carries at least one model id.

STEP 2 — WORKER BINDING · packages/kernel/bins/abdo-tool-worker/src/provider.rs
  ProviderBinding { id, url, vault_key, credential: CredentialKind::{Bearer|ApiKey}, anthropic: bool }
  url must be BYTE-IDENTICAL to workerUrl (binding() matches on `item.id == request.provider && item.url == request.url`, exact string equality on both). vault_key byte-identical to vaultKey.
  AUTH CEILING: the enum expresses exactly two shapes — `Authorization: Bearer <key>` and `x-api-key: <key>` — plus one compiled literal `anthropic-version: 2023-06-01` when anthropic:true. Anything else (api-key:, cf-aig-authorization:, SigV4, an expiring token) is NOT a catalogue edit; it is a Rust change with its own review.

STEP 3 — THE TWO HARD-CODED COUNTS (the step everyone forgets)
  packages/providers/test/providers.test.ts:20 `expect(PROVIDERS).toHaveLength(14)` → bump. Line 21 asserts every remote vaultKey startsWith("abdocode-") — a handle in any other namespace fails here, and would also be unstorable from the UI (see step 8).
  provider.rs test module `assert_eq!(PROVIDERS.len(), 13)` → bump.

STEP 4 — CARGO REBUILD
  cargo build --release --bin abdo-tool-worker (prepare.ts drives it). The shipped BINARY is the security boundary; a TypeScript-only provider is invisible to it.

STEP 5 — REGENERATE THE DESKTOP BUNDLE
  bun packages/desktop/scripts/prepare.ts → rewrites packages/desktop/ui/providers.js from catalog.ts. Never hand-edit providers.js.

STEP 6 — PARITY GATE
  bun scripts/provider-parity-gate.mjs → must print `PROVIDER_PARITY_OK catalogue=N remote=M rust=M`. It also runs inside `bun run structure` (package.json:41) — note it is NOT part of `bun test`.

STEP 7 — SUITES
  bun run test (the kernel gate is `bun run test`, never `bun test`) and cargo test for the worker.

STEP 8 — VAULT HANDLE
  The handle must start with abdocode- or the Tauri shell physically cannot store it: main.rs vault_name refuses anything else. Create it with secrets.ps1, or ship the row greyed — greyed with no key is honest; hidden is not.

STEP 9 — LIVENESS, RECORDED OR ABSENT
  Either a dated probe file in .ai/awareness/ recording provider id + HTTP status + first redacted bytes from ONE minimal call THROUGH THE COMPILED WORKER (never through JS fetch — probe the shipped path), or the row ships as OFFERED-UNPROVEN (visible, greyed, no key). No key = UNPROVEN, never PASS: الغياب رفضٌ لا إذن. A measurement is valid for the session it was taken in.

WHAT THE GATE SAYS WHEN A STEP IS SKIPPED — measured against scripts/provider-parity-gate.mjs as it stands:
  Skip step 1 (worker binding only) → `PROVIDER_PARITY_FAILED — <id>: worker-only provider`.
  Skip step 2 (catalogue row only) → `<id>: missing Rust worker binding`. This is the exact shape of the brief's «invisible to the shipped binary»; at runtime the worker answers «provider identity is neither compiled into this worker nor declared by the owner» (provider.rs:449 — note the brief quoted an OLDER binary's shorter wording, so a stale worker is already in circulation).
  URL typo, even one character or a trailing slash → `<id>: endpoint drift`.
  Vault handle typo → `<id>: vault handle drift`.
  Skip step 5 → `desktop provider bundle is stale; run packages/desktop/scripts/prepare.ts` (the gate imports providers.js as data and compares it to catalog.ts by JSON identity).
  Skip step 3 → THE GATE STAYS GREEN. It fails later, in providers.test.ts and cargo test.
  Skip step 4 → THE GATE STAYS GREEN AND SO DOES EVERY TEST. This is the dangerous one: the gate reads provider.rs SOURCE, not the compiled binary, so a stale worker passes every check and then refuses the new provider at runtime in front of the user. FIX TO ADD IN THIS PROGRAMME: extend the gate with a freshness assertion — the built abdo-tool-worker artefact's mtime must be newer than provider.rs's, and `abdo-tool-worker provider-has <id>` must exit 0 for every remote catalogue row. That turns the one silent failure into a loud one.
  Skip step 9 → nothing anywhere complains. Which is precisely why a public menu needs the probe file: the parity gate proves the three files AGREE, never that any of them is TRUE.

## إدخال المفتاح ميزةً لا ملفّاً

KEY ENTRY AS A FEATURE — a user who is not the owner, on a machine that is not this one, adds a credential with no hand-edited file.

THE PATH THAT ALREADY WORKS, AND SHOULD STAY: الإعدادات ← المزوّدون shows one card per remote row with its label, base URL and a ✓محفوظ / لا مفتاح state fed by the worker's own provider-has (so the state comes from the vault, not a guess). The user pastes into a password field; the renderer calls invoke("vault_set"); Rust writes a temp KEY=VALUE file, calls secrets.ps1 set, deletes the temp, and never returns the value. The key never travels back to JS; the engine never sees it; only the compiled worker materialises it, in Rust, zeroed after use and redacted out of the response. That is the right shape and nothing below weakens it.

WHAT IS BROKEN TODAY — measured, not supposed:

1. THE CUSTOM-PROVIDER KEY BOX CANNOT WRITE A KEY. index.html:1886 derives `const vaultKey = "custom-" + name + "-api-key"` and calls invoke("vault_set"); main.rs:181-189 vault_name refuses every handle that does not start with abdocode-. The await throws, so the two lines that actually register the provider never run and the user sees «تعذّرت الإضافة». Both guards are individually correct — the worker locks custom entries to the custom- namespace (adversarial scan, 2026-09-01) precisely so a declared endpoint can never be handed a compiled provider's secret — but the one namespace the worker accepts is the one namespace the shell refuses to write. This is pre-existing (HEAD's guard demanded abdo-akhbari-, which custom- also fails) and the rename does not fix it. TODAY nobody can add a working custom provider from the app; the only route is to run secrets.ps1 by hand, then add the provider with the key field left EMPTY so the failing invoke is skipped. FIX: vault_name accepts two namespaces — abdocode-* (builtin) and custom-* (owner-declared) — keeping the ≤80 chars and [A-Za-z0-9-] rules, and rejecting everything else. One guard, two namespaces, same lock.

2. THE RENAME ORPHANS EVERY KEY ALREADY STORED. The in-flight sprint moves all thirteen handles from abdo-akhbari-* to abdocode-*; secrets.ps1 stores by name and has no aliasing. A user who saved an OpenAI key yesterday sees «لا مفتاح» tomorrow and their calls fail with «provider credential unavailable» — the secret is in the vault under a name nothing reads any more. FIX, and it must land WITH the rename: a one-shot migration at first run — for each old handle present, read, write under the new name, delete the old, log the count. No silent orphans.

3. vault_has ANSWERS ON A SUBSTRING. main.rs:229 does `secrets.ps1 list` then `lines().any(|l| l.contains(&name))`. abdocode-openai reports PRESENT when only abdocode-openai-org exists. FIX: exact match on the key name in the listed line.

4. NO DELETE, NO ROTATE-OUT. There is no vault_delete command and no delete button. registerCustomProvider refuses to replace an existing id with a different definition and tells the user «احذف القديم من الإعدادات أولاً» — an instruction the UI gives no way to follow, so changing a custom provider's URL currently requires restarting the engine. FIX: a vault_delete command under the same two-namespace guard, a «حذف المفتاح» control on every card, and a remove action for custom providers.

5. CUSTOM PROVIDERS ARE INVISIBLE EVERYWHERE. providers/src/index.ts:36-38 exports PROVIDERS as `registry.snapshot().entries` taken at MODULE LOAD, before any custom provider is registered. registerCustomProvider adds to the registry afterwards and nothing re-snapshots — so a custom provider has no key-state card, no entry in the models group, no datalist suggestion; only registry.get sees it, i.e. the user must hand-type `myprovider/some-model`. FIX: a listProviders() that reads the snapshot at call time, and every consumer (vault-status, models, seedCatalog, the desktop datalist) uses it.

6. A FAIL-CLOSED CATCH THAT LIES. tool-worker/src/provider.ts hasCredential rejects any provider id not matching /^[a-z0-9-]{1,32}$/, while the settings validator, the registry and the Rust worker all allow 64. cli.ts:2792 does `!(await REACH.hasCredential(p.id).catch(() => false))`, so the validation throw is swallowed into «يحتاج مفتاحاً في الخزنة» even when the key is present. FIX: widen the regex to the 64-char contract and surface the distinct error instead of collapsing it to «no key».

7. NO WAY TO TEST A KEY. The only feedback a user gets is a failed chat turn, and the failure is the raw status plus a redacted body. FIX (two parts): a «اختبر المفتاح» button per card that runs one minimal request through the compiled worker and reports status only; and a deterministic status→sentence mapper — 401/403 «رُفض مفتاح <المزوّد> — أعد إدخاله»، 402/429+insufficient_quota «انتهى رصيد الخطة»، an HTML body «حجبت بوابةٌ وسيطة الطلب»، 5xx «المزوّد مثقل — أعد المحاولة». No model involved; tier 1 of the tool ladder.

ASSISTED INTAKE, GROWN NOT REPLACED. Add one optional data-only field to ProviderDefinition: auth?: { methods: [{ type: "api", label, prompts: [{ key, message, placeholder, when? }] }] }. Because prepare.ts bundles catalog.ts verbatim into ui/providers.js, the settings panel renders the right form for free — one field for a normal key, two for a provider that needs an id plus a secret (Google PSE is that case today and is hand-coded in the HTML), a conditional field for a regional/enterprise host. It stays DATA: no code from the descriptor is ever executed, nothing is fetched to obtain it. A per-row keyHint string («عادةً يبدأ بـsk-») and the vendor's conventional env-var NAME may be shown to help the user recognise what they are pasting — as a label only, never as a place we read a key from.

THE INVARIANT: the vault is the single store; Rust is its only reader; the renderer can write and ask yes/no and nothing else; a key never appears in argv, in a log, in a response body, or in a settings file. With a menu of thirty-plus rows, the greyed keyless row plus one click to its own key box IS the onboarding — no documentation, no file editing, and no row that pretends to be ready.

## أفكارٌ من أوبن‑كود (لا شيفرة)

- A PLAN IS A ROW, NOT A MODE — the central idea, taken wholesale. OpenCode's catalogue lists alibaba-token-plan, alibaba-coding-plan, zai-coding-plan, tencent-{coding,token}-plan, xiaomi-token-plan-*, minimax-coding-plan as first-class providers beside their parents, and its code contains no plan concept at all. In our architecture: a plan = one catalog.ts row + one compiled ProviderBinding + its own abdocode-<planid> vault handle + its own ledger bucket. Settings toggle: none — it is the data shape. OFF is not a state; the alternative (a plan flag on one row) would force the worker to build URLs at runtime, which the compiled-constant design exists to forbid.
- DECLARATIVE AUTH DESCRIPTOR (auth.ts Method/TextPrompt/SelectPrompt/When). Pure data: typed prompts with conditional visibility, so a provider needing two fields or a regional choice renders correctly instead of being hand-coded in index.html the way Google PSE is. In our architecture: an optional auth?: { methods } field in catalog.ts, bundled to the renderer by prepare.ts and frozen by the parity gate. Toggle: none needed — a row without the field degrades to today's single key box, which is the OFF behaviour.
- PROVIDER ERROR CODES → HUMAN SENTENCES (error.ts:110-146: insufficient_quota, usage_not_included, context_length_exceeded, server_is_overloaded, and an HTML-body detector that says 'a gateway blocked this' instead of printing markup). In our architecture: a deterministic table beside model-gateway's decodeChatResponse, keyed on status + error.code, wired to the redacted body the worker already returns. Setting: providerErrorHints, default ON. OFF = today's raw status plus redacted body. Without this, every plan row we add produces an unreadable failure the first time a key expires.
- PROVIDER VISIBILITY LIST (disabled_providers / enabled_providers, applied to the picker only). A thirty-row menu needs it. In our architecture: enabledProviders?/hiddenProviders? in Settings (cli.ts, validated exactly like customProviders is). HARD RULE: it filters the UI and NOTHING ELSE — it must never reach the worker, because the compiled binding table is the security boundary and a UI preference must not be able to widen or narrow it. OFF/empty = all rows shown, keyless ones greyed.
- MODEL STATUS FIELD — OpenCode deletes models marked deprecated outright and hides alpha behind a flag. In our architecture: an optional status on catalogue model entries so a retired id leaves the picker instead of failing at call time. Setting: showAlphaModels, default OFF = only stable ids offered. This is the cheap guard against the drift that put gpt-4o and claude-opus-4-1 in our file.
- OWNER-RUN MODEL-LIST REFRESH, NOT A BACKGROUND ONE. Most providers expose GET {baseUrl}/models. In our architecture: an owner-invoked command that fetches through the COMPILED WORKER (no new network surface in the renderer) and prints a DIFF against catalog.ts for review — it writes nothing. Setting: refreshModelList, default OFF and manual. OFF = the compiled seed list only, which stays the shipped truth. This deliberately takes the data idea while refusing the auto-update mechanism (see refusals).
- CREDENTIAL-HANDLE NORMALISATION (auth/index.ts:74-77 strips trailing slashes and deletes the un-normalised twin on write, so one provider can never own two credentials). In our architecture: normalise before deriving 'custom-'+name+'-api-key' in the settings panel, and reject a name that normalises onto an existing handle. No toggle.
- HIDE-UNTIL-CREDENTIALLED IS THE ONE PLACE WE ARE BETTER — keep ours. OpenCode deletes any provider that ends with zero models, so unusable providers vanish; we show the row greyed with a click-through to its key box (index.html:1274), and hasKey comes from the worker's provider-has, i.e. from the vault, not a guess. Keep it and let every new row inherit it: a greyed row is not a promise, it is an offer with its precondition visible — that is the answer to 'a row that cannot complete a call is a lie'. Two upgrades as the list grows: sort greyed rows below ready ones, and batch hasKey into ONE worker call instead of a process spawn per provider.
- A PROBE/TEST-KEY ACTION. OpenCode has no equivalent and we need one: one minimal request through the compiled worker, manual only, reporting status. It doubles as the release-time liveness gate (scripts/provider-liveness-probe.mjs) whose dated output in .ai/awareness/ is what lets a row move from OFFERED-UNPROVEN to PROVEN. Setting: none — it never runs on its own, never at startup, never in CI.

## مرفوضٌ بالاسم

- RUNTIME npm-INSTALLED PROVIDERS. plugin/provider/dynamic.ts: npm.add(evt.package) → import(installedPath) → call whichever export starts with 'create'; provider.ts:1839 does the same inline and has a file:// branch that imports any local path — and the package name is a plain string in user config. That is remote code execution by configuration. It is also what makes their 'any provider' claim cheap: they pay for breadth with downloaded code, we pay with compiled rows and a rebuild. Refused in every form; their ~20 bundled @ai-sdk packages are not a shopping list.
- `.well-known` AUTH COMMAND SPAWN AND REMOTE CONFIG MERGE. cli/cmd/providers.ts:325-348 fetches ${url}/.well-known/opencode, reads wellknown.auth.command: string[], SPAWNS it and takes stdout as the token; config.ts:371-398 then merges wellknown.config and remote_config from the same host into the running configuration. A URL typed by a user becomes arbitrary command execution plus arbitrary configuration on our machine. Never, in any form. If enterprise credential minting is ever wanted, it is an owner-declared LOCAL executable path approved once in settings — never a command name that arrives over the network.
- BACKGROUND CATALOGUE REFRESH + VERSION BEACON. models-dev.ts forks a repeating fetch of https://models.opencode.ai every 60 minutes (on by default) with User-Agent opencode/<channel>/<version>/<client>, and the fetched JSON becomes the provider list. Two refusals in one: our shipped provider list must never change without a rebuild and a gate, and we do not emit a periodic fingerprint of our install. We take their DATA once, offline, by reading a checked-in snapshot, and hand-write rows the parity gate freezes.
- CREDENTIALS OUTSIDE THE VAULT — three paths, all refused: auth/index.ts:59 lets OPENCODE_AUTH_CONTENT replace the entire credential store from an environment variable; auth.json is cleartext on disk at 0600; provider.ts:1578-1588 reads API keys straight out of per-provider env vars and marks the provider source 'env'. Ours stays: the vault is the only store, Rust its only reader, absence is refusal ('provider vault is not configured'), secrets zeroed on Drop and redacted from responses. The one thing worth taking from 'env' is the NAME as a display hint, never as a source.
- CONFIG-SUPPLIED fetch OVERRIDE AND PER-MODEL HEADERS (provider.ts:1794 takes a fetch from merged options; 1780-1785 merges model.headers from config; base URLs are ${VAR}-interpolated from the environment at call time). In our design the request identity lives in Rust — binding() matches (provider, url) against the compiled table or the owner declaration and refuses anything else. Config-driven headers or a fetch hook would reopen exactly the exfiltration hole the 2026-09-01 adversarial scan closed with the custom- namespace lock. A genuinely required static header belongs in the compiled ProviderBinding (anthropic-version is our precedent), never in settings.
- URL TEMPLATING INSIDE THE WORKER. cloudflare-workers-ai, snowflake-cortex, databricks and neon all publish hosts containing ${ACCOUNT_ID}/${HOST}, and OpenCode resolves them from the environment at call time. ProviderBinding.url is a &'static str on purpose: a variable in the endpoint is precisely the property that makes it no longer owner-fixed. Refused inside the worker; the honest home is ABDO_CUSTOM_PROVIDERS, where the OWNER types the already-resolved endpoint once.
- CLIENT-IMPERSONATION SUBSCRIPTION LOGINS — Claude Pro/Max via the Claude Code OAuth flow (Anthropic prohibited it and cut OpenCode off in January 2026, and OpenCode's own docs now carry the prohibition), ChatGPT Plus/Pro via https://chatgpt.com/backend-api/codex/responses reusing the official CLI's auth, and GitHub Copilot via api.githubcopilot.com with Copilot-Integration-Id: vscode-chat / Editor-Version: vscode/… / a GitHubCopilotChat User-Agent. Each works by presenting as the vendor's own first-party client. This product ships to the public under our name; a ban or a takedown would land on OUR users' accounts, and 'OpenCode does it' is the one defence that has already failed in practice. Refused as shipped rows and as shipped logins. The sanctioned plan endpoints in the table deliver the same benefit without it.
- A SECOND CREDENTIAL STORE. OpenCode now has two live implementations — auth.json (Auth.Service) and a SQLite credentials table (core/credential.ts + a migration) — with different consumers reading each. Duplicate implementations are our costliest defect class by measurement. One store, one reader.
- DEFAULT ROUTING THROUGH THIRD-PARTY AGGREGATORS, and silent fallback chains. Gateways may be OFFERED (OpenRouter already is; Vercel's is proposed) but never chosen for the user and never used as an automatic fallback when a provider fails. An agent quietly routing a customer's source code through a router nobody picked is a business decision, not a menu behaviour.

## الخطّة

SPRINT PLAN — ordered by irreversibility of harm, not by effort. Every sprint ends with the parity gate green and a dated note in .ai/awareness/. Nothing here may start while the rename sprint holds catalog.ts / provider.rs / the desktop shell; S0 rides WITH that sprint, the rest queue behind it.

S0 — VAULT RENAME MIGRATION (blocker, ships with the rename). One-shot migration abdo-akhbari-* → abdocode-* at first run: read, write under the new name, delete the old, log the count. Without it every user who already saved a key sees «لا مفتاح» and their calls fail with the secret still sitting in the vault under a dead name. Proof: a key stored under the old handle is readable by provider-has after upgrade.

S1 — MAKE KEY ENTRY WORK AT ALL. vault_name accepts two namespaces (abdocode-* and custom-*) so the custom-provider add stops aborting mid-way; vault_has becomes an exact match; add vault_delete plus delete/rotate controls; listProviders() reads the registry snapshot at call time so custom providers appear in vault-status, the models group and the datalist; widen hasCredential's id regex to the 64-char contract and stop swallowing its throw into «يحتاج مفتاحاً». Proof: a non-owner adds a custom provider from the UI, key and all, and selects its model from the picker — today that is impossible.

S2 — TELL THE TRUTH ABOUT WHAT WE ALREADY SHIP. Correct the six stale/mis-hosted rows: anthropic and openai model ids, gemini-3.8-flash, together → api.together.ai, moonshot → api.moonshot.ai (and decide moonshot-cn), minimax → api.minimax.io pending its probe; fill the two EMPTY model lists (xai, groq) that make those rows unusable today. A defect in a shipped menu outranks every addition.

S3 — THE MISSING GATE. Build scripts/provider-liveness-probe.mjs: one minimal call per keyed provider THROUGH THE COMPILED WORKER, recording id + status + first redacted bytes to a dated file in .ai/awareness/; owner-invoked only, never in CI, never at startup; no key = UNPROVEN, not PASS. Extend provider-parity-gate.mjs with the worker-freshness assertion (built binary newer than provider.rs, and provider-has exits 0 for every remote row) — the one skipped step that is silent today. Record a baseline for the existing thirteen. Add the OFFERED-UNPROVEN rendering state.

S4 — WAVE 1: NINE DOC-VERIFIED ROWS in one atomic set — deepseek (after the owner's egress decision), zai, cerebras, fireworks, deepinfra, baseten, nebius, cohere, vercel-gateway. One cargo build, one prepare.ts, one gate run, one probe pass. Menu goes 14 → 23.

S5 — WAVE 2: LOCAL LANE — lmstudio, llamacpp, vllm as local:true rows (no worker binding, no vault key, no rebuild) plus ollama-cloud as a full remote atomic set. Two checks first: that an openai-compatible LOCAL row encodes with credential none, and that the egress guard passes localhost. Highest value per unit of work in the whole programme.

S6 — PLAN MACHINERY. Add the data-only plan{} field; group and badge plan rows in the settings panel; make token-budget.ts ledger under the PLAN's provider id, not the parent's; add max_tokens to the openai-compatible encoder so the ledger's reserved output cap is actually enforced on the wire. Promote our own measured Qwen token-plan endpoint from ABDO_CUSTOM_PROVIDERS to the compiled qwen-token-plan row — the one plan with a live measurement behind it.

S7 — REMAINING PLAN ROWS, one probe each: qwen-coding-plan, zai-coding-plan, minimax-coding-plan, kimi-code. Each ships only when its own 200 is recorded, or ships visibly unproven. No exceptions for a row the owner is excited about.

S8 — THE THREE THINGS THAT MAKE A THIRTY-ROW MENU USABLE: the auth descriptor, the error-code→sentence mapper, enabledProviders/hiddenProviders as a UI-only filter, and the per-card «اختبر المفتاح» button (which is just the probe, one row at a time).

S9 — ANTHROPIC-WIRE MIRRORS once probed. Our anthropic harness, built for Claude, would then serve five vendors (Claude, Qwen plans, Z.ai, MiniMax, Kimi Code) — the largest capability gain available for a wire we already ship.

S10 — DOCUMENTATION AND REFUSAL RECORD. A user page for ABDO_CUSTOM_PROVIDERS that says ENDPOINT not base URL (the worker requires the URL to end in /chat/completions), https only, max 8, handles must start with custom-; plus a dated refusal file in .ai/awareness/ carrying the npm-provider, .well-known-command, models.dev-auto-refresh, env-credential and impersonation refusals — so the next session does not re-mine OpenCode and re-propose them.

CEILING TO STATE IN THE RELEASE NOTES, not to discover after launch: for every remote provider today streaming is off, the response is capped at 2 MiB in the worker, native tool calling is refused for any wire but native-ollama, and the openai-compatible encoder drops temperature/topP/topK/context and sends no output cap. «Every provider» is true of the menu; it is not yet true of the capabilities behind it. Lifting that is its own programme and needs an owner.

## قراراتٌ للمالك وحده

- DeepSeek is on the egress severance list by decision, not oversight. packages/egress/src/egress.ts BASE_POLICY.forbidden carries deepseek.com with a written reason ('a local harness reference only; not a product dependency'), next to the opencode.ai / models.dev severance entries. Adding the row means deleting that rule. Do you delete it? (Note for accuracy: the guard wraps fetch and explicitly does not cover child processes, and every cloud call leaves through the worker's curl — so today the rule states intent rather than enforcing it on the remote lane.)
- WHICH PROVIDERS GET A REAL KEY FOR A LIVE ONE-CALL PROOF, AND WHO PAYS? Nothing in this specification has been dialled. My shortlist, by value per riyal: (1) minimax — it is our own approved cloud provider AND our shipped host appears in no source we checked, so it is the most embarrassing row to leave wrong; (2) qwen token-plan — we have a live precedent and it is the flagship plan row; (3) deepseek and (4) zai — the two the owner named. A key on each of those four settles more of this document than any amount of further reading.
- DO PLAN ROWS SHIP BEFORE THEY ARE PROVEN? My recommendation: yes, but visibly — greyed, named, with «يتطلب مفتاح خطة <المزوّد>» — never as a ready option. The alternative is to hold every plan row until we hold a key for it, which may be months. Your call on which side of 'honest' this sits.
- THE THREE IMPERSONATION PLANS — Claude Pro/Max, ChatGPT Plus/Pro (Codex), GitHub Copilot. OpenCode ships all three; Anthropic cut OpenCode off for exactly this in January 2026, and Copilot's path requires headers asserting we are Microsoft's editor. I recommend refusing them permanently as shipped rows and saying so in the menu. If you want them anyway, they belong in the custom path where the user supplies the endpoint — but the ban risk still lands on the user's account, not ours. Confirm the refusal, or overrule it in writing.
- AGGREGATORS AND ROUTERS. OpenRouter already ships; Vercel's AI Gateway is the obvious next. Both mean a customer's source code transits a third party. Is offering them acceptable (they are never a default and never a silent fallback in my design), or do we restrict the menu to first-party vendors?
- REGIONAL DUPLICATES (moonshot-cn, alibaba CN hosts, xiaomi/tencent/zhipu plans). Ship them hidden behind the visibility toggle, or leave them to the custom path entirely? They roughly double the row count for an audience we may not have.
- EXPIRING CREDENTIALS — is the OAuth/subscription-login machinery funded at all? It needs a new CredentialKind carrying expiry, a host-side minter that refreshes into the vault before each call, and a loopback listener in the Tauri shell. xAI's SuperGrok flow is the only vendor-published one and would be the clean template. My v1 answer is no, with the absence stated in the UI. Yours?
- THE CLOUD CEILING. For every remote provider today: no streaming, a 2 MiB response cap, no native tool calling (tools reach cloud models only as text in the system prompt), and the openai-compatible encoder drops every sampling knob and sends no output cap — so the 10M ledger reserves a limit the provider was never told. Is that acceptable for a public launch of 'every provider', and who owns lifting it? At minimum I would send max_tokens before any plan row ships.
- THE MENU'S SIZE IS A PRODUCT DECISION, NOT A TECHNICAL ONE. This spec ships ~23 rows and pushes ~25 more to the custom path because we cannot stand behind their endpoints. If you want the long tail visible anyway, say so explicitly and I will design a clearly-labelled 'مزوّدون غير مُختبرين' section — but each such row is a promise we have not verified, which is the thing you told me not to do.