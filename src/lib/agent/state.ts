import { Annotation, MessagesAnnotation } from "@langchain/langgraph";
import type { SchemaColumn } from "@/lib/agent/schema";

/**
 * Agent state definition (AgentState) — Phase 1
 *
 * Corresponds to PRD §6.2. Phase 0 had minimal state (messages + question).
 * Phase 1 adds: dataSourceId, schemaContext, sqlResults, artifacts, route.
 */

/** Route decision: which node should execute next */
export type Route = "nlSql" | "summarize" | "makeChart" | "synthesize" | "end";

/** Artifact types produced by the Agent (rendered by the frontend) */
export interface Artifact {
  type: "chart" | "table" | "code" | "summary";
  payload: ChartPayload | TablePayload | CodePayload | SummaryPayload;
}

export interface ChartPayload {
  /** Recharts spec: { chartType, data, xKey, yKeys, title } */
  chartType: "bar" | "line" | "area" | "pie" | "scatter";
  data: Record<string, unknown>[];
  xKey: string;
  yKeys: string[];
  title?: string;
}

export interface TablePayload {
  columns: string[];
  rows: unknown[][];
  title?: string;
  /** Whether the result set was truncated at the source-query max row limit */
  truncated?: boolean;
}

export interface CodePayload {
  language: string;
  code: string;
  title?: string;
}

export interface SummaryPayload {
  text: string;
  stats?: Record<string, number>;
}

/** SQL query results stored in state after nlSql node */
export interface SqlResults {
  sql: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export const AgentState = Annotation.Root({
  // LangGraph 1.x: spread .spec (channel definitions)
  ...MessagesAnnotation.spec,

  /** Current session id (used as LangGraph thread_id) */
  sessionId: Annotation<string>,

  /** Current user question */
  question: Annotation<string>,

  /** Data source id bound to the session (file or pg) */
  dataSourceId: Annotation<string>,

  /** Data source type: file | pg | api */
  dataSourceType: Annotation<string>,

  /** Schema context retrieved from pgvector (injected into LLM prompt) */
  schemaContext: Annotation<SchemaColumn[]>,

  /** Route decision from the router node */
  route: Annotation<Route>,

  /** SQL results from the nlSql node */
  sqlResults: Annotation<SqlResults>,

  /** Whether the query results warrant a summary (descriptive stats) and
   *  chart. Decided by the same LLM call that generates the SQL, so the
   *  summarize / makeChart nodes can skip themselves without another call. */
  needsSummary: Annotation<boolean>,
  needsChart: Annotation<boolean>,

  /** Chart spec (chartType / xKey / yKeys / title) decided alongside the
   *  SQL. When needsChart is true, makeChart uses this to build the chart
   *  artifact directly — no extra LLM call. */
  chartSpec: Annotation<{
    chartType: "bar" | "line" | "area" | "pie" | "scatter";
    xKey: string;
    yKeys: string[];
    title?: string;
  } | null>,

  /** Artifacts produced by the Agent (charts, tables, summaries) */
  artifacts: Annotation<Artifact[]>,

  /** Iteration counter to prevent infinite loops */
  iterations: Annotation<number>,
});

export type AgentStateType = typeof AgentState.State;
