# Bio research — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `bio-research` · **النوع**: knowledge-work · **الإصدار**: 1.2.0
- **الأصل**: anthropics/knowledge-work-plugins / `bio-research` @ `1f517b9de47e` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill bio-research/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (6)

- `/skill bio-research/instrument-data-to-allotrope` — Convert laboratory instrument output files (PDF, CSV, Excel, TXT) to Allotrope Simple Model (ASM) JSON format or flattened 2D CSV. Use this skill when scientists need to standardize instrument data fo
- `/skill bio-research/nextflow-development` — Run nf-core bioinformatics pipelines (rnaseq, sarek, atacseq) on sequencing data. Use when analyzing RNA-seq, WGS/WES, or ATAC-seq data—either local FASTQs or public datasets from GEO/SRA. Triggers on
- `/skill bio-research/scientific-problem-selection` — This skill should be used when scientists need help with research problem selection, project ideation, troubleshooting stuck projects, or strategic scientific decisions. Use this skill when users ask
- `/skill bio-research/scvi-tools` — Deep learning for single-cell analysis using scvi-tools. This skill should be used when users need (1) data integration and batch correction with scVI/scANVI, (2) ATAC-seq analysis with PeakVI, (3) CI
- `/skill bio-research/single-cell-rna-qc` — Performs quality control on single-cell RNA-seq data (.h5ad or .h5 files) using scverse best practices with MAD-based filtering and comprehensive visualizations. Use when users request QC analysis, fi
- `/skill bio-research/start` — Set up your bio-research environment and explore available tools. Use when first getting oriented with the plugin, checking which literature, drug-discovery, or visualization MCP servers are connected

## الأوامرُ المنقولة مهاراتٍ (0)

- (لا أوامر)

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (11)

- **pubmed** — http https://pubmed.mcp.claude.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **biorender** — http https://mcp.services.biorender.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **biorxiv** — http https://hcls.mcp.claude.com/biorxiv/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **consensus** — http https://mcp.consensus.app/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **c-trials** — http https://hcls.mcp.claude.com/clinical_trials/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **chembl** — http https://hcls.mcp.claude.com/chembl/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **synapse** — http https://mcp.synapse.org/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **wiley** — http https://connector.scholargateway.ai/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **owkin** — http https://mcp.k.owkin.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **ot** — http https://mcp.platform.opentargets.org/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **benchling** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
