import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { Pool } from "pg";
import { HumanMessage } from "@langchain/core/messages";
import { createLLM } from "@/lib/agent/llm";
import { retrieveSchema, retrieveSchemaMulti, type SchemaColumn } from "@/lib/agent/schema";
import { createAgentTools, getDialectLabel, type AgentContext } from "@/lib/agent/tools";
import type { SandboxProvider } from "@/lib/daytona/client";
import type { LlmConfig } from "@/lib/db/schema";

/**
 * ReAct agent graph — Phase 2 refactor
 *
 * Replaces the Phase 1 six-node StateGraph (schemaRetriever → router → nlSql →
 * summarize → makeChart → synthesizer) with a single LLM agent that
 * autonomously calls tools in a ReAct loop, inspects results, and decides what
 * to do next. This is the "Claude Code style" workflow the user requested: one
 * coherent LLM that writes SQL, reads results, requests charts/stats, and
 * answers — instead of multiple LLM calls stitched together by graph edges.
 *
 * What's preserved:
 *   - PostgresSaver checkpointer (thread_id = sessionId) → conversation memory
 *   - createLLM() factory → 4 provider abstraction (openai/anthropic/glm/openai-compat)
 *   - pgvector schema pre-retrieval → injected into the system prompt so the
 *     LLM can start writing SQL immediately, with retrieve_schema available
 *     as a tool to fetch more columns on demand.
 *
 * What's removed:
 *   - router node (LLM decides itself whether to query data or just answer)
 *   - nlSql node + generateSql + nlToSql (LLM writes & executes SQL itself)
 *   - summarize / makeChart nodes (LLM calls summarize_data / build_chart tools)
 *   - synthesizer node (the agent's final text response IS the answer)
 */

// ============================================================
// Postgres pool + checkpointer (reused across invocations)
// ============================================================

let pool: Pool | null = null;
let checkpointer: PostgresSaver | null = null;

function createPool(): Pool {
  const connString = process.env.DATABASE_URL!;
  // Supabase Pooler (port 6543) runs in transaction mode and requires
  // prepared statements to be disabled; the direct URL (5432) does not.
  const isTransactionMode = /:6543\//.test(connString);

  const p = new Pool({
    connectionString: connString,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 15000,
    ...(isTransactionMode ? { prepare: false } : {}),
  });
  p.on("error", (err) => {
    console.error("[pg.Pool] idle client error:", err.message);
  });
  return p;
}

async function getCheckpointer(): Promise<PostgresSaver> {
  if (checkpointer && pool) return checkpointer;
  pool = createPool();
  checkpointer = new PostgresSaver(pool);
  await checkpointer.setup();
  return checkpointer;
}



// ============================================================
// System prompt builder
// ============================================================

/**
 * Build the system prompt for the ReAct agent. Pre-retrieved schema context
 * (top-K columns from pgvector) is injected so the LLM can start writing SQL
 * without an immediate retrieve_schema call; the tool remains available for
 * deeper exploration when the injected slice is insufficient.
 */
function buildSystemPrompt(params: {
  schemaContext: SchemaColumn[];
  ctx: AgentContext;
  hasDataSource: boolean;
}): string {
  const { schemaContext, ctx, hasDataSource } = params;
  const dialectLabel = getDialectLabel(ctx.dataSourceType);

  const schemaBlock =
    schemaContext.length > 0
      ? formatSchemaForPrompt(schemaContext)
      : hasDataSource
        ? "(schema not yet retrieved — call list_tables or retrieve_schema to learn the available tables and columns)"
        : "(no data source is connected)";

  return `You are Datellix, an AI data analysis assistant. You answer the user's questions by querying the connected data source and reasoning about the results.

You have access to tools. Use them autonomously and as many times as needed to fully answer the question. Think step by step:

1. If a data source is connected, you already have a slice of relevant schema below. If it's not enough, call \`list_tables\` to see all tables or \`retrieve_schema\` with a topic to fetch more columns.
2. Write a read-only SELECT query in ${dialectLabel} dialect and call \`execute_sql\` to run it. Inspect the returned rows.
3. If the query fails, read the error, fix the SQL (table/column names, dialect syntax), and retry. You may call \`retrieve_schema\` or \`list_tables\` again to confirm names.
4. When the user asks for a visualization, call \`build_chart\` with an appropriate chartType and valid xKey/yKeys from the result columns. Available Recharts chart types: bar (comparisons), line (trends), area (cumulative), pie (proportions), scatter (correlations), radar (multi-axis comparison across categories), radialBar (circular progress / radial comparisons), funnel (conversion stages), treemap (hierarchical area proportions), composed (bar + line mix on the same chart). You can optionally customize the chart layout and styling using \`uiConfig\` (e.g. custom colors, stacking, line interpolation types, legends, grids, dots, and axis labels) to match the user's specific formatting request.
5. When the user asks about distributions, trends, or statistics, call \`summarize_data\` on the relevant query.
6. For time series forecasting, call \`run_forecast\` with the SQL, date column, value column, horizon, and method (arima/ets/linear).
7. For clustering, call \`run_cluster\` with the SQL, feature columns, method (kmeans/dbscan), and optional cluster count.
8. For charts that Recharts can't render (3D, geographic, sankey, candlestick, heatmap, sunburst, large datasets, etc.), call \`build_plotly_chart\` with SQL + Python code that creates a plotly figure and assigns it to \`fig\`. The chart type is entirely determined by the Python code (e.g. \`px.scatter_3d\`, \`px.heatmap\`, \`px.choropleth\`, \`px.sunburst\`, \`px.candlestick\`) — choose the appropriate plotly.express / graph_objects constructor for the user's request.
9. For custom analysis or data transformations beyond SQL, call \`run_python\` with Python code (pandas, duckdb, sklearn, statsmodels, matplotlib, plotly available). Optionally pass a SQL query to pre-load results as a pandas DataFrame \`df\`.
10. When the user asks to generate a report, document, or written summary, call \`generate_report\` with a title and the full Markdown body (which you write yourself in the user's language). To embed charts/tables/summaries produced earlier in this session, insert \`{{artifact:ID}}\` markers on their own lines in the Markdown body at the desired positions, and list the IDs in \`embeddedArtifactIds\`. Each artifact-producing tool result includes an \`[artifact:ID]\` tag — use that ID. You decide what else to include — SQL snippets, result previews, metadata (subtitle, data sources via includeDataSources). The frontend renders the report with react-markdown and offers a download menu (PDF / Markdown).
11. After gathering what you need, write a clear, concise natural-language answer that references the data you found. Do not just dump raw rows — interpret them.

## Autonomous data exploration

For open-ended analysis requests, do NOT run a single SQL and jump straight to a canned summary. Explore the data autonomously over multiple SQL rounds, forming and validating hypotheses as you go.

Process:
1. **Orient**: Inspect schema and run a quick sample/count query to understand the data shape.
2. **Form hypotheses**: Propose 2–3 angles worth investigating. State them before querying.
3. **Query & inspect**: Run one SQL per hypothesis. Look at actual numbers, not just success/failure.
4. **Drill down**: Follow up on surprising or promising results with new SQLs. Don't stop at the first layer.
5. **Validate causes**: For "why" questions, query related columns/tables to confirm or refute causes. Prefer evidence over speculation.
6. **Know when to stop**: Default budget is ~6–10 SQL calls. Stop earlier if the data clearly answers the question; go deeper if the user asked for thorough analysis. Re-querying to fix syntax errors doesn't count.
7. **Synthesize**: Either write the final answer referencing the numbers found, or call \`generate_report\` weaving together findings, embedded artifacts, and interpretation. For statistical deep-dives, use \`summarize_data\` or \`run_python\`.

Transparency: Narrate before each SQL what you're checking and why, and after each result what you noticed. Do NOT silently chain tool calls back-to-back.

Rules:
- Only run SELECT / WITH...SELECT queries. Never INSERT/UPDATE/DELETE/DDL.
- Reference real table and column names exactly as they appear in the schema.
- Table names from file data sources are sanitized (spaces and punctuation become underscores, e.g. "My Films.csv" → "My_Films"). Such names often contain hyphens or other special characters, so ALWAYS wrap table names in double quotes (e.g. FROM "My_Films") to avoid parser errors. Column names with spaces or special characters must also be quoted.
- Be efficient: don't re-run identical queries; reuse prior results.
- If no data source is connected, tell the user to upload a file or connect a database.
- Respond in the same language as the user's question.

Pre-retrieved schema context (top ${schemaContext.length} relevant columns):
${schemaBlock}`;
}

/** Compact schema rendering for the system prompt. */
function formatSchemaForPrompt(schema: SchemaColumn[]): string {
  const tablesMap = new Map<string, SchemaColumn[]>();
  for (const col of schema) {
    const list = tablesMap.get(col.table_name) ?? [];
    list.push(col);
    tablesMap.set(col.table_name, list);
  }
  return [...tablesMap.entries()]
    .map(([table, cols]) => {
      const colLines = cols
        .map(
          (c) =>
            `  ${c.column_name} (${c.data_type})` +
            (c.sample_values.length > 0
              ? ` -- e.g. ${c.sample_values.join(", ")}`
              : ""),
        )
        .join("\n");
      return `${table}\n${colLines}`;
    })
    .join("\n\n");
}

// ============================================================
// Streaming entry point
// ============================================================

/**
 * Run the ReAct agent and yield raw LangGraph stream chunks for the route
 * handler to translate into SSE events.
 *
 * The agent is constructed per request because the tools close over the
 * session's data-source context (decrypted configs, staged files). The
 * expensive part — the PostgresSaver checkpointer and its connection pool —
 * is memoized and shared across requests.
 *
 * @param params.sessionId         LangGraph thread_id (session-level memory)
 * @param params.question          user question
 * @param params.dataSourceId      single-DB mode: bound DB data source id
 * @param params.dataSourceType    file | pg | mysql | bigquery | duckdb | sqlite | ""
 * @param params.fileDataSourceIds multi-file mode: bound file data source ids
 * @param params.userId            auth user id — used by sandbox tools to log usage
 * @param params.getSandbox        lazy resolver for a shared request-level sandbox.
 *                                 When provided, all sandbox tool calls in this
 *                                 ReAct turn reuse the same sandbox; the caller
 *                                 owns creation and deletion. When omitted, each
 *                                 runPython call falls back to ephemeral mode.
 */
export async function* streamAgent(params: {
  sessionId: string;
  question: string;
  dataSourceId: string;
  dataSourceType: string;
  fileDataSourceIds: string[];
  userId: string;
  llmConfig?: LlmConfig | null;
  /** Override the model from the user's config (lets the user switch between
   *  models in the chat UI). Ignored when llmConfig is null (env default). */
  model?: string;
  getSandbox?: SandboxProvider;
  /** Optional abort signal — when aborted, the stream stops and the
   *  underlying LLM/tool calls are cancelled. Used by the eval harness
   *  to enforce per-case timeouts. */
  signal?: AbortSignal;
}) {
  const { sessionId, question, dataSourceId, dataSourceType, fileDataSourceIds, userId, llmConfig, model, getSandbox, signal } = params;

  const ctx: AgentContext = {
    sessionId,
    dataSourceId,
    dataSourceType,
    fileDataSourceIds,
    userId,
    getSandbox,
    llmConfig,
    model,
    artifacts: new Map(),
    artifactCounter: 0,
  };
  const hasDataSource = !!dataSourceId || fileDataSourceIds.length > 0;

  // 1. Pre-retrieve a small slice of schema (top 5) to seed the system prompt.
  //    This lets the LLM start writing SQL immediately while still leaving
  //    retrieve_schema available for deeper exploration.
  let seedSchema: SchemaColumn[] = [];
  if (hasDataSource) {
    try {
      seedSchema =
        fileDataSourceIds.length > 0
          ? await retrieveSchemaMulti(fileDataSourceIds, question, 5)
          : await retrieveSchema(dataSourceId, question, 5);
    } catch (err) {
      // Non-fatal: the agent can still call retrieve_schema itself.
      console.error("[streamAgent] seed schema retrieval failed:", err);
    }
  }

  // 2. Build tools bound to this session's data source context. This also
  //    stages files in the Daytona sandbox and decrypts DB configs.
  const tools = await createAgentTools(ctx);

  // 3. Build the agent. checkpointer is shared/memoized; tools & prompt are
  //    per-request. recursionLimit caps the ReAct loop (default 25 is plenty
  //    for query → fix → chart flows).
  const cp = await getCheckpointer();
  const llm = createLLM(llmConfig, model);
  const systemPrompt = buildSystemPrompt({
    schemaContext: seedSchema,
    ctx,
    hasDataSource,
  });

  const agent = createReactAgent({
    llm,
    tools,
    prompt: systemPrompt,
    checkpointer: cp,
  });

  // 4. Stream. We only need "messages" mode: it yields AIMessageChunk tokens
  //    (text content, reasoning_content, and tool_call deltas) and the final
  //    ToolMessage for each tool execution — everything the route handler
  //    needs to render thinking, tool calls, tool results, and the answer.
  const stream = await agent.stream(
    { messages: [new HumanMessage(question)] },
    {
      configurable: { thread_id: sessionId },
      streamMode: ["messages"],
      // recursionLimit caps the ReAct loop. Raised from 30 → 40 to support
      // autonomous data exploration (6–10 SQL rounds + narration + final
      // synthesis via generate_report). Each ReAct turn = 1 agent step + 1
      // tool step, so 10 SQL calls alone consume 20 steps before the final
      // answer; 40 leaves comfortable headroom.
      recursionLimit: 40,
      signal,
    },
  );

  for await (const chunk of stream) {
    yield chunk;
  }
}

/** Release connection pool (called on app shutdown, optional in Vercel Serverless) */
export async function closeGraph(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  checkpointer = null;
}
