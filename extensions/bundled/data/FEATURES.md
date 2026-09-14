# Data — ميزاتُ الحزمة المثبَتة

- **المعرّف**: `data` · **النوع**: knowledge-work · **الإصدار**: 1.1.0
- **الأصل**: anthropics/knowledge-work-plugins / `data` @ `1f517b9de47e` (Apache-2.0) — منقولٌ ومعدَّلٌ لعبدو كود (انظر NOTICE.md)
- **الاستدعاء**: من الإعدادات ← الامتدادات ← «استخدام في الرسالة التالية»، أو بكتابة `/skill data/<المهارة>` في أوّل سطرٍ من رسالتك

## المهارات (10)

- `/skill data/analyze` — Answer data questions -- from quick lookups to full analyses. Use when looking up a single metric, investigating what's driving a trend or drop, comparing segments over time, or preparing a formal dat
- `/skill data/build-dashboard` — Build an interactive HTML dashboard with charts, filters, and tables. Use when creating an executive overview with KPI cards, turning query results into a shareable self-contained report, building a t
- `/skill data/create-viz` — Create publication-quality visualizations with Python. Use when turning query results or a DataFrame into a chart, selecting the right chart type for a trend or comparison, generating a plot for a rep
- `/skill data/data-context-extractor` — Generate or improve a company-specific data analysis skill by extracting tribal knowledge from analysts.
- `/skill data/data-visualization` — Create effective data visualizations with Python (matplotlib, seaborn, plotly). Use when building charts, choosing the right chart type for a dataset, creating publication-quality figures, or applying
- `/skill data/explore-data` — Profile and explore a dataset to understand its shape, quality, and patterns. Use when encountering a new table or file, checking null rates and column distributions, spotting data quality issues like
- `/skill data/sql-queries` — Write correct, performant SQL across all major data warehouse dialects (Snowflake, BigQuery, Databricks, PostgreSQL, etc.). Use when writing queries, optimizing slow SQL, translating between dialects,
- `/skill data/statistical-analysis` — Apply statistical methods including descriptive stats, trend analysis, outlier detection, and hypothesis testing. Use when analyzing distributions, testing for significance, detecting anomalies, compu
- `/skill data/validate-data` — QA an analysis before sharing -- methodology, accuracy, and bias checks. Use when reviewing an analysis before a stakeholder presentation, spot-checking calculations and aggregation logic, verifying a
- `/skill data/write-query` — Write optimized SQL for your dialect with best practices. Use when translating a natural-language data need into SQL, building a multi-CTE query with joins and aggregations, optimizing a query against

## الأوامرُ المنقولة مهاراتٍ (0)

- (لا أوامر)

## الوكلاء (0)

- (لا وكلاء)

## الموصّلات التي يطلبها الأصل (8)

- **snowflake** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **databricks** — http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **bigquery** — http https://bigquery.googleapis.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **hex** — http https://app.hex.tech/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **amplitude** — http https://mcp.amplitude.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **amplitude-eu** — http https://mcp.eu.amplitude.com/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **atlassian** — http https://mcp.atlassian.com/v1/mcp — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس
- **definite** — http https://api.definite.app/v3/mcp/http — يُوصَل من الإعدادات ← الموصّلات عندما يتوفّر له مقبس

## ما أُسقط بالتصميم

- لا خطّافات في الأصل.

## الإثبات

- تُفحص هذه الحزمة في `extensions/test/bundled-extensions.test.ts`: صحّةُ المانيفست بعقد Rust، وكلُّ مهارةٍ ≤64KB باسمٍ صالح، وبلا نصٍّ يشبه الاعتماد، وبلا اسم «Claude Code/Anthropic» في النثر خارج سطور الأصل.
