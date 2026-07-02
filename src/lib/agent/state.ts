import type { SchemaColumn } from "@/lib/agent/schema";

/**
 * Artifact & payload type definitions (Phase 2 refactor)
 *
 * The Phase 1 AgentState Annotation (Route, QueryPlan, schemaContext,
 * sqlResults, artifacts, iterations, …) has been removed: the ReAct agent
 * in graph.ts now uses LangGraph's built-in MessagesAnnotation and drives
 * everything through tool calls, so there is no custom graph state to
 * declare.
 *
 * What remains here are the plain data types shared across the stack:
 *   - Artifact / ChartPayload / TablePayload / CodePayload / SummaryPayload
 *     → used by tools.ts (tool return artifacts), route.ts (SSE + DB persist),
 *       and the frontend renderers (artifact-renderer.tsx, recharts-renderer.tsx).
 *   - SqlResults → used by the SQL executors in tools.ts.
 */

/** Artifact types produced by the Agent tools (rendered by the frontend) */
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

/** SQL query results returned by the execute_sql tool / SQL executors */
export interface SqlResults {
  sql: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

// SchemaColumn is re-exported for convenience; many modules historically
// imported it via state. New code should import from @/lib/agent/schema.
export type { SchemaColumn };
