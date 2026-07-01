"use client";

import { BarChart3, Code2, FileText, Table2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RechartsRenderer } from "@/components/charts/recharts-renderer";
import type {
  ChartPayload,
  CodePayload,
  SummaryPayload,
  TablePayload,
} from "@/lib/agent/state";

/**
 * Frontend artifact shape (mirrors the SSE stream payload from /api/chat).
 * The DB Artifact type uses `Record<string, unknown>` for payload; here we
 * narrow it to the typed union for rendering. "forecast" is included for
 * forward-compat with Phase 2 but rendered as a fallback in Phase 1.
 */
export type ArtifactType =
  | "chart"
  | "table"
  | "code"
  | "forecast"
  | "summary";

export interface ArtifactView {
  type: ArtifactType;
  payload: ChartPayload | TablePayload | CodePayload | SummaryPayload;
  /** Source node that produced this artifact (for label) */
  node?: string;
}

interface ArtifactRendererProps {
  artifact: ArtifactView;
}

const ARTIFACT_META: Record<
  ArtifactType,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  chart: { label: "Chart", icon: BarChart3 },
  table: { label: "Table", icon: Table2 },
  code: { label: "Code", icon: Code2 },
  forecast: { label: "Forecast", icon: FileText },
  summary: { label: "Summary", icon: FileText },
};

/**
 * Renders an artifact (chart / table / code / summary) inside a bordered card.
 * Used by the Chat component when streaming artifacts arrive from /api/chat.
 */
export function ArtifactRenderer({ artifact }: ArtifactRendererProps) {
  const meta = ARTIFACT_META[artifact.type];
  const Icon = meta.icon;

  return (
    <div className="animate-fade-up rounded-lg border border-border bg-card p-4 shadow-sm">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2 border-b border-border pb-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {meta.label}
          {artifact.node ? ` · ${artifact.node}` : ""}
        </span>
      </div>

      {/* Body */}
      <div className="artifact-body">
        {renderBody(artifact)}
      </div>
    </div>
  );
}

function renderBody(artifact: ArtifactView): React.ReactNode {
  switch (artifact.type) {
    case "chart":
      return (
        <RechartsRenderer spec={artifact.payload as ChartPayload} />
      );

    case "table":
      return <TableArtifactView payload={artifact.payload as TablePayload} />;

    case "code":
      return <CodeArtifactView payload={artifact.payload as CodePayload} />;

    case "summary":
      return <SummaryArtifactView payload={artifact.payload as SummaryPayload} />;

    default:
      return (
        <p className="text-sm text-muted-foreground">
          Unknown artifact type
        </p>
      );
  }
}

/* ============================================================
    Table artifact
    ============================================================ */

function TableArtifactView({ payload }: { payload: TablePayload }) {
  const { columns, rows, title } = payload;

  if (!columns || columns.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Empty result set</p>
    );
  }

  return (
    <div>
      {title && (
        <p className="mb-2 font-display text-sm font-medium tracking-tight text-foreground">
          {title}
        </p>
      )}
      {/* Fixed-height scroll container: keeps long tables from stretching the
          chat. Sticky thead stays visible while scrolling vertically; wide
          tables scroll horizontally. max-h-80 ≈ 320px (~10 rows visible). */}
      <div className="max-h-80 overflow-auto rounded-md border border-border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card shadow-[0_1px_0_0_hsl(var(--border))]">
            <TableRow className="hover:bg-transparent">
              {columns.map((col) => (
                <TableHead
                  key={col}
                  className="whitespace-nowrap"
                >
                  {col}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, rowIdx) => (
              <TableRow key={rowIdx}>
                {columns.map((_, colIdx) => (
                  <TableCell
                    key={colIdx}
                    className="max-w-[240px] truncate font-mono text-xs text-foreground"
                    title={String(row[colIdx] ?? "")}
                  >
                    {formatCell(row[colIdx])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="mt-2 font-mono text-[10px] text-muted-foreground">
        {rows.length} {rows.length === 1 ? "row" : "rows"}
        {rows.length >= 1000 ? " · truncated at 1000 (max)" : ""}
        {payload.truncated ? " · truncated" : ""}
      </p>
    </div>
  );
}

/* ============================================================
    Code artifact
    ============================================================ */

function CodeArtifactView({ payload }: { payload: CodePayload }) {
  const { code, language, title } = payload;
  return (
    <div>
      {title && (
        <p className="mb-2 font-display text-sm font-medium tracking-tight text-foreground">
          {title}
        </p>
      )}
      <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
      {language && (
        <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {language}
        </p>
      )}
    </div>
  );
}

/* ============================================================
    Summary artifact
    ============================================================ */

function SummaryArtifactView({ payload }: { payload: SummaryPayload }) {
  const { text, stats } = payload;
  return (
    <div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
        {text}
      </p>
      {stats && Object.keys(stats).length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-3">
          {Object.entries(stats).map(([key, value]) => (
            <div key={key} className="space-y-0.5">
              <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                {key}
              </dt>
              <dd className="font-mono text-sm font-medium text-foreground">
                {formatStat(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/* ============================================================
    Utilities
    ============================================================ */

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(4);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    // Truncate very long strings
    return value.length > 100 ? value.slice(0, 100) + "…" : value;
  }
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatStat(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return String(value);
  // For floats, show 4 significant digits
  if (Math.abs(value) >= 1000 || Math.abs(value) < 0.01) {
    return value.toExponential(2);
  }
  return value.toFixed(4);
}
