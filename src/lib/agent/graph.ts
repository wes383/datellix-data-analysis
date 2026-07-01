import { StateGraph, END, START } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { Pool } from "pg";
import { HumanMessage, AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { AgentState, type Route, type Artifact } from "@/lib/agent/state";
import { createLLM } from "@/lib/agent/llm";
import { retrieveSchema } from "@/lib/agent/schema";
import {
  nlToSql,
  summarizeData,
  buildChartPayload,
} from "@/lib/agent/tools";
import type { SqlResults } from "@/lib/agent/state";

/**
 * LangGraph state graph — Phase 1
 *
 * Flow:
 *   START → schemaRetriever → router → {nlSql → summarize → makeChart | synthesizer} → synthesizer → END
 *
 * - schemaRetriever: pgvector retrieval of relevant schema
 * - router: LLM classifies question as "query" (needs SQL) or "chat" (general)
 * - nlSql: NL → SQL (single LLM call also decides chart/summary need) → validate → execute
 * - summarize: descriptive stats on query results (Daytona sandbox); skipped if !needsSummary
 * - makeChart: builds Recharts payload from LLM-decided spec (no extra LLM call); skipped if !needsChart
 * - synthesizer: streams natural-language conclusion
 */

// ============================================================
// Postgres pool + checkpointer (reused across invocations)
// ============================================================

let pool: Pool | null = null;
let checkpointer: PostgresSaver | null = null;

function createPool(): Pool {
  const connString = process.env.DATABASE_URL!;
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
// Node 1: schemaRetriever
// ============================================================

async function schemaRetrieverNode(state: typeof AgentState.State) {
  // Skip if no data source is bound
  if (!state.dataSourceId) {
    return { schemaContext: [] };
  }

  try {
    const schema = await retrieveSchema(state.dataSourceId, state.question);
    return { schemaContext: schema };
  } catch (err) {
    console.error("[schemaRetriever] error:", err);
    return { schemaContext: [] };
  }
}

// ============================================================
// Node 2: router (LLM classifies the question)
// ============================================================

async function routerNode(state: typeof AgentState.State) {
  // If no data source, go straight to synthesis (general chat)
  if (!state.dataSourceId || state.schemaContext.length === 0) {
    return { route: "synthesize" as Route };
  }

  const llm = createLLM();

  const schemaDesc = state.schemaContext
    .slice(0, 15)
    .map((c) => `${c.table_name}.${c.column_name} (${c.data_type})`)
    .join(", ");

  const systemPrompt = `You are a routing agent for a data analysis system. Classify the user's question into one of these routes:

- "query": The question requires querying data (SQL) to answer. Examples: "show me sales by month", "what's the average order value", "list top 10 customers".
- "synthesize": The question is general and doesn't need data retrieval. Examples: "what data do I have?", "explain how this works", "hello".

Available data schema: ${schemaDesc}

Respond with ONLY the route name, nothing else.`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(state.question),
  ]);

  const raw = (response.content as string).trim().toLowerCase();
  // Map LLM output to Route type values ("query" → "nlSql")
  const route: Route = raw === "synthesize" ? "synthesize" : "nlSql";

  return { route };
}

// ============================================================
// Node 3: nlSql (NL → SQL → validate → execute)
// ============================================================

async function nlSqlNode(state: typeof AgentState.State) {
  try {
    const {
      sql,
      results,
      schema,
      needsSummary,
      needsChart,
      chartSpec,
    } = await nlToSql({
      sessionId: state.sessionId,
      dataSourceId: state.dataSourceId,
      question: state.question,
    });

    const sqlResults: SqlResults = results;

    // Create a table artifact from the results. Pass all rows (already
    // capped at MAX_ROWS upstream) — the frontend renders them inside a
    // fixed-height scroll container so the chat layout isn't stretched.
    const tableArtifact: Artifact = {
      type: "table",
      payload: {
        columns: sqlResults.columns,
        rows: sqlResults.rows,
        truncated: sqlResults.truncated,
        title: `Query Results`,
      },
    };

    return {
      sqlResults,
      schemaContext: schema,
      needsSummary,
      needsChart,
      chartSpec,
      artifacts: [tableArtifact],
      messages: [
        new ToolMessage({
          content: `SQL executed successfully. ${sqlResults.rowCount} rows returned.\nSQL: ${sql}`,
          tool_call_id: "nlsql",
        }),
      ],
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "SQL execution failed";
    return {
      sqlResults: undefined,
      needsSummary: false,
      needsChart: false,
      chartSpec: null,
      messages: [
        new ToolMessage({
          content: `SQL execution failed: ${errorMsg}`,
          tool_call_id: "nlsql",
        }),
      ],
    };
  }
}

// ============================================================
// Node 4: summarize (descriptive stats on query results)
// ============================================================

async function summarizeNode(state: typeof AgentState.State) {
  // Skip if the LLM decided summary stats aren't useful for this query,
  // or if there are no SQL results (e.g., query failed).
  if (!state.sqlResults || !state.needsSummary) {
    return {};
  }

  try {
    const summary = await summarizeData(state.sessionId, state.sqlResults);

    const summaryArtifact: Artifact = {
      type: "summary",
      payload: summary,
    };

    return {
      artifacts: [summaryArtifact],
    };
  } catch (err) {
    console.error("[summarize] error:", err);
    return {};
  }
}

// ============================================================
// Node 5: makeChart (builds chart from LLM-decided spec, no extra LLM call)
// ============================================================

async function makeChartNode(state: typeof AgentState.State) {
  // Skip if the LLM decided a chart isn't useful, or there's no spec /
  // results. The chart spec was decided in the same LLM call that
  // generated the SQL, so this node just builds the payload.
  if (!state.sqlResults || !state.needsChart || !state.chartSpec) {
    return {};
  }

  try {
    const chartPayload = buildChartPayload(state.chartSpec, state.sqlResults);

    if (!chartPayload) {
      return {};
    }

    const chartArtifact: Artifact = {
      type: "chart",
      payload: chartPayload,
    };

    return {
      artifacts: [chartArtifact],
    };
  } catch (err) {
    console.error("[makeChart] error:", err);
    return {};
  }
}

// ============================================================
// Node 6: synthesizer (stream natural-language conclusion)
// ============================================================

async function synthesizerNode(state: typeof AgentState.State) {
  const llm = createLLM();

  // Build context from artifacts and SQL results
  let contextParts: string[] = [];

  if (state.sqlResults) {
    contextParts.push(
      `SQL query executed, returned ${state.sqlResults.rowCount} rows.`,
      `Columns: ${state.sqlResults.columns.join(", ")}`,
      `Sample rows (first 5):`,
      ...state.sqlResults.rows.slice(0, 5).map((row, idx) =>
        `Row ${idx + 1}: ${row.join(" | ")}`,
      ),
    );
  }

  for (const artifact of state.artifacts ?? []) {
    if (artifact.type === "summary") {
      const payload = artifact.payload as { text: string };
      contextParts.push(`Data summary: ${payload.text}`);
    } else if (artifact.type === "chart") {
      const payload = artifact.payload as { title?: string; chartType: string };
      contextParts.push(`Chart generated: ${payload.title ?? payload.chartType}`);
    }
  }

  const schemaDesc = state.schemaContext.length > 0
    ? state.schemaContext
        .slice(0, 10)
        .map((c) => `${c.table_name}.${c.column_name} (${c.data_type})`)
        .join(", ")
    : "No data source connected";

  const systemPrompt = `You are Datellix, an AI data analysis assistant. Answer the user's question based on the available context.

If SQL results are available, reference them in your answer. Be concise and clear.
If there's an error, explain what went wrong and suggest how to fix it.
If no data source is connected, let the user know they should upload a file or connect a database.

Available schema: ${schemaDesc}

${contextParts.length > 0 ? "Context:\n" + contextParts.join("\n") : "No additional context available."}

Answer the user's question in a helpful, concise way.`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(state.question),
  ]);

  return {
    messages: [new AIMessage(response.content as string)],
  };
}

// ============================================================
// Conditional routing
// ============================================================

function routeAfterRouter(state: typeof AgentState.State): "nlSql" | "synthesizer" {
  if (state.route === "nlSql") {
    return "nlSql";
  }
  return "synthesizer";
}

// ============================================================
// Graph compilation
// ============================================================

export async function getGraph() {
  const cp = await getCheckpointer();

  const graph = new StateGraph(AgentState)
    .addNode("schemaRetriever", schemaRetrieverNode)
    .addNode("router", routerNode)
    .addNode("nlSql", nlSqlNode)
    .addNode("summarize", summarizeNode)
    .addNode("makeChart", makeChartNode)
    .addNode("synthesizer", synthesizerNode)
    .addEdge(START, "schemaRetriever")
    .addEdge("schemaRetriever", "router")
    .addConditionalEdges("router", routeAfterRouter, {
      nlSql: "nlSql",
      synthesizer: "synthesizer",
    })
    .addEdge("nlSql", "summarize")
    .addEdge("summarize", "makeChart")
    .addEdge("makeChart", "synthesizer")
    .addEdge("synthesizer", END)
    .compile({ checkpointer: cp });

  return graph;
}

/**
 * Run the Agent and return a streaming event iterator
 *
 * @param sessionId    LangGraph thread_id (session-level persistence)
 * @param question     user question
 * @param dataSourceId data source bound to the session (empty string if none)
 * @param dataSourceType  "file" | "pg" | "" 
 */
export async function* streamAgent(params: {
  sessionId: string;
  question: string;
  dataSourceId: string;
  dataSourceType: string;
}) {
  const { sessionId, question, dataSourceId, dataSourceType } = params;
  const graph = await getGraph();

  const stream = await graph.stream(
    {
      sessionId,
      question,
      dataSourceId,
      dataSourceType,
      messages: [new HumanMessage(question)],
      iterations: 0,
    },
    {
      configurable: { thread_id: sessionId },
      streamMode: ["messages", "updates"],
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
