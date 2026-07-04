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
  type: "chart" | "table" | "code" | "summary" | "forecast" | "file" | "report";
  payload:
    | ChartPayload
    | TablePayload
    | CodePayload
    | SummaryPayload
    | ForecastPayload
    | FilePayload
    | ReportPayload;
}

export interface ChartPayload {
  /** Recharts spec: { chartType, data, xKey, yKeys, title }
   *
   *  Chart types: bar / line / area / pie / scatter (original 5) plus
   *  radar (multi-axis comparison), radialBar (circular progress bars),
   *  funnel (conversion stages), treemap (hierarchical area), composed
   *  (bar + line mix on the same chart). */
  chartType:
    | "bar"
    | "line"
    | "area"
    | "pie"
    | "scatter"
    | "radar"
    | "radialBar"
    | "funnel"
    | "treemap"
    | "composed";
  data: Record<string, unknown>[];
  xKey: string;
  yKeys: string[];
  title?: string;
  /** SQL used to generate the chart data. Stored in DB for re-query on display.
   *  Not present in older artifacts (backward compat). */
  sql?: string;
  /**
   * Optional field name in `data` used to split scatter points into
   * separately-colored series (e.g. "cluster" → one Scatter per cluster).
   * Only honored by the scatter renderer; ignored for other chart types.
   */
  groupKey?: string;
  /** Renderer to use in the frontend. Defaults to "recharts" for backward compat. */
  renderer?: "recharts" | "plotly";
  /** Plotly figure JSON (data + layout). Present only when renderer === "plotly". */
  plotlyFigure?: Record<string, unknown>;
  /** Python code that builds the Plotly figure (present only for Plotly charts).
   *  Stored alongside `sql` so the chart can be manually re-generated when its
   *  bound data source changes (re-run SQL → re-run Python → new figure). */
  pythonCode?: string;
  /** Optional Recharts UI configuration overrides */
  uiConfig?: {
    colors?: string[];
    stacked?: boolean;
    showGrid?: boolean;
    showLegend?: boolean;
    showDot?: boolean;
    yAxisLabel?: string;
    xAxisLabel?: string;
    lineType?: "basis" | "linear" | "monotone" | "step";
    barSize?: number;
  };
}

export interface TablePayload {
  columns: string[];
  rows: unknown[][];
  title?: string;
  /** Whether the result set was truncated at the source-query max row limit */
  truncated?: boolean;
  /** SQL used to generate the table. Stored in DB for re-query on display. */
  sql?: string;
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

/**
 * File artifact — a downloadable CSV produced by the export_query tool.
 *
 * Unlike table artifacts (which render an HTML table inline AND offer CSV
 * download), file artifacts are optimized for the "save these results as a
 * file" use case: the frontend renders a compact download card with the
 * filename, row count, and a Download button. No cloud storage is involved;
 * the CSV content is carried inline in the payload (mirrors how table CSV
 * export works via downloadCsv()).
 */
export interface FilePayload {
  /** Suggested download filename (without extension). */
  filename: string;
  /** CSV column headers. */
  columns: string[];
  /** All result rows (not truncated to the 20-row preview limit). */
  rows: unknown[][];
  /** Total row count (may equal rows.length; kept for explicit display). */
  rowCount: number;
  /** Whether the underlying query hit the source-query max row limit. */
  truncated?: boolean;
  /** Optional human-readable title shown in the card header. */
  title?: string;
}

/**
 * Forecast artifact produced by the run_forecast tool.
 * Contains the forecasting method, evaluation metrics, the full prediction
 * series (historical actuals + future forecasts), and a human-readable summary.
 */
export interface ForecastPayload {
  method: string;
  horizon: number;
  metrics: { mae: number; rmse: number; mape: number };
  predictions: {
    date: string;
    actual: number | null;
    forecast: number | null;
  }[];
  summary: string;
}

/**
 * Report artifact produced by the generate_report tool.
 *
 * The agent LLM writes the full Markdown body itself (in the user's language)
 * and passes it via the `markdownContent` tool argument; the tool just wraps
 * it into this payload. The frontend renders `content` with react-markdown and
 * offers a download menu (PDF via native print / Markdown).
 *
 * `embeddedArtifacts` carries full copies of in-session artifacts (charts,
 * tables, summaries, …) that the LLM chose to embed inline. The LLM inserts
 * `{{artifact:ID}}` markers in the Markdown body; the frontend detects these
 * markers and renders the corresponding artifact at that position. Embedded
 * artifacts are stored with full data so the report is a self-contained
 * snapshot (chart data is NOT stripped, unlike standalone chart artifacts).
 *
 * `referencedArtifactIds` is an older informational list of in-session artifact
 * IDs the report draws on. It is currently stored for traceability; PDF export
 * prints the rendered Markdown body (the references footer is stripped via
 * `data-pdf-exclude`).
 */
export interface ReportPayload {
  /** Markdown body (LLM-generated). Rendered with react-markdown + remark-gfm.
   *  May contain `{{artifact:ID}}` markers that are replaced by inline
   *  artifact rendering on the frontend. */
  content: string;
  /** Report title (also used as the PDF filename). */
  title: string;
  /** Optional metadata shown in the report header. */
  metadata?: {
    author?: string;
    subtitle?: string;
    /** ISO timestamp string. The tool fills this with new Date().toISOString() if omitted. */
    generatedAt?: string;
    /** Names of the data sources the report is based on (filled by the tool from session context). */
    dataSourceNames?: string[];
  };
  /** In-session artifact IDs the report references (informational). */
  referencedArtifactIds?: string[];
  /** Artifacts embedded inline in the Markdown body via {{artifact:ID}} markers.
   *  Each entry pairs the marker ID with the full artifact data so the report
   *  is a self-contained snapshot. */
  embeddedArtifacts?: EmbeddedArtifact[];
}

/** A single artifact embedded in a report, keyed by its marker ID. */
export interface EmbeddedArtifact {
  /** The ID used in `{{artifact:ID}}` markers within the report Markdown. */
  id: string;
  /** The full artifact data (chart spec, table rows, summary text, …). */
  artifact: Artifact;
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
