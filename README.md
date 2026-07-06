# Datellix

**AI data analysis agent.** Upload a file or connect a warehouse, ask questions in plain English, and get back SQL, charts, forecasts, and narrative insights — all driven by a ReAct agent that writes and runs its own queries.

Built on Next.js 16, LangGraph, Supabase, and the Daytona code sandbox.

---

## Highlights

- **ReAct agent** — One coherent LLM reasons over your schema, writes read-only SQL, inspects results, and decides what to do next.
- **Autonomous exploration** — For open-ended questions, the agent runs multiple SQL rounds, forms and validates hypotheses, then synthesizes a report.
- **Isolated Python sandbox** — Every `run_python` / `run_forecast` / `run_cluster` call executes in a disposable container with pandas, duckdb, scikit-learn, statsmodels, matplotlib, and plotly preinstalled.
- **Multi-source** — Connect PostgreSQL, MySQL, BigQuery, or upload CSV / Excel / Parquet / DuckDB / SQLite files.
- **Live artifacts** — Charts (Recharts + Plotly), tables, forecasts, and Markdown reports stream into the chat as they're produced.
- **Bring-your-own LLM** — Users can configure their own OpenAI / Anthropic / GLM / OpenAI-compatible credentials in Settings.
- **Export** — Charts to PNG, tables to Excel/CSV/JSON, reports to PDF or Markdown ZIP.
- **Secure by default** — DB credentials and storage keys are encrypted at rest with pgcrypto AES-256. Per-user Row Level Security on every table. Read-only SQL enforcement.

## Quick start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env.local` and fill in the values:

```bash
cp .env.example .env.local
```

### 3. Apply database migrations

```bash
supabase db push
```

This creates all tables, RLS policies, the pgcrypto extension, and the pgvector schema-embedding index.

### 4. Run the dev server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000), create an account, and start analyzing.

---

## How it works

### The ReAct agent

The agent is built with LangGraph's `createReactAgent` and a `PostgresSaver` checkpointer (thread_id = session ID, so conversation memory persists across page refreshes).

**Tools available to the agent:**

| Tool | Purpose |
|---|---|
| `list_tables` | List all tables in the bound data source(s) |
| `retrieve_schema` | pgvector-retrieve columns relevant to a topic |
| `execute_sql` | Validate + run a read-only SELECT, returns a table artifact |
| `summarize_data` | Run SELECT + pandas describe / IQR outliers / top-N |
| `export_query` | Run SELECT + return a downloadable CSV file artifact |
| `build_chart` | Run SELECT + build a Recharts chart (bar/line/area/pie/scatter/radar/radialBar/funnel/treemap/composed) |
| `run_python` | Execute arbitrary Python in the sandbox (pandas, duckdb, sklearn, statsmodels, matplotlib, plotly) |
| `run_forecast` | ARIMA / ETS / linear time-series forecasting |
| `run_cluster` | KMeans / DBSCAN clustering with PCA 2D visualization |
| `build_plotly_chart` | Generate complex Plotly charts (3D, geo, sankey, candlestick, heatmap, sunburst) |
| `generate_report` | Wrap a Markdown body (LLM-written) into a report artifact with optional embedded artifacts |

The system prompt pre-retrieves the top-5 relevant schema columns via pgvector so the agent can start writing SQL immediately, with `retrieve_schema` available for deeper exploration.

### Autonomous data exploration

For open-ended analysis requests, the agent is instructed to explore the data over multiple SQL rounds (default budget: 6–10 queries) — form hypotheses, validate causes, drill down on surprising results — then synthesize findings via `generate_report`. This replaces the older single-SQL-plus-template approach.

### SQL safety

All SQL is validated before execution: must start with `SELECT` or `WITH`, no comments, no multiple statements, and a denylist of keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `TRUNCATE`, …). Results are capped at 1000 rows.

### Sandbox execution

Python runs in a disposable Daytona container built from [`daytona-image/Dockerfile`](daytona-image/Dockerfile). Each request can optionally reuse a single sandbox across the whole ReAct turn (via `getSandbox`), falling back to ephemeral create+delete per call.

### Encryption at rest

Database credentials and storage keys are encrypted with pgcrypto AES-256 before being written to `user_settings`. Only the last 4 characters of each secret are sent to the client as a mask (`••••abcd`). On save, masked values are preserved by the server action so unchanged secrets aren't overwritten.
