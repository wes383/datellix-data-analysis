"use client";

import { forwardRef, useRef, useState } from "react";
import { toPng } from "html-to-image";
import { BarChart3, Code2, Download, FileText, FileDown, LineChart, Loader2, Table2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RechartsRenderer } from "@/components/charts/recharts-renderer";
import { PlotlyRenderer } from "@/components/charts/plotly-renderer";
import type {
  ChartPayload,
  CodePayload,
  FilePayload,
  ForecastPayload,
  SummaryPayload,
  TablePayload,
} from "@/lib/agent/state";

/**
 * Frontend artifact shape (mirrors the SSE stream payload from /api/chat).
 * The DB Artifact type uses `Record<string, unknown>` for payload; here we
 * narrow it to the typed union for rendering.
 */
export type ArtifactType =
  | "chart"
  | "table"
  | "code"
  | "forecast"
  | "summary"
  | "file";

export interface ArtifactView {
  type: ArtifactType;
  payload:
    | ChartPayload
    | TablePayload
    | CodePayload
    | FilePayload
    | SummaryPayload
    | ForecastPayload;
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
  forecast: { label: "Forecast", icon: LineChart },
  summary: { label: "Summary", icon: FileText },
  file: { label: "File", icon: FileDown },
};

/**
 * Renders an artifact (chart / table / code / summary) inside a bordered card.
 * Used by the Chat component when streaming artifacts arrive from /api/chat.
 *
 * Exportable artifacts show a Download button in the header:
 *   - chart (recharts) / forecast → PNG via html-to-image
 *   - chart (plotly)              → PNG handled inside PlotlyRenderer
 *   - table                       → CSV download
 */
export function ArtifactRenderer({ artifact }: ArtifactRendererProps) {
  const meta = ARTIFACT_META[artifact.type];
  const Icon = meta.icon;

  // Ref to the Recharts container DOM node, used for PNG export.
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  /** Whether this artifact shows a header-level download button. */
  const canExport =
    artifact.type === "table" ||
    artifact.type === "file" ||
    (artifact.type === "chart" &&
      (artifact.payload as ChartPayload).renderer !== "plotly") ||
    artifact.type === "forecast";

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    try {
      if (artifact.type === "table") {
        const payload = artifact.payload as TablePayload;
        const filename = sanitizeFilename(payload.title ?? "table") + ".csv";
        downloadCsv(payload.columns, payload.rows, filename);
      } else if (artifact.type === "file") {
        const payload = artifact.payload as FilePayload;
        const filename = sanitizeFilename(payload.filename) + ".csv";
        downloadCsv(payload.columns, payload.rows, filename);
      } else if (chartContainerRef.current) {
        // chart (recharts) + forecast both render via RechartsRenderer
        const payload = artifact.payload as ChartPayload | ForecastPayload;
        const title =
          (payload as ChartPayload).title ??
          (artifact.type === "forecast" ? "forecast" : "chart");
        const filename = sanitizeFilename(title) + ".png";
        const dataUrl = await toPng(chartContainerRef.current, {
          backgroundColor: "#ffffff",
          pixelRatio: 2,
          cacheBust: true,
        });
        triggerDownload(dataUrl, filename);
      }
    } catch (err) {
      console.error("[artifact] export failed:", err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="animate-fade-up rounded-lg border border-border bg-card p-4 shadow-sm">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2 border-b border-border pb-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {meta.label}
          {artifact.node ? ` · ${artifact.node}` : ""}
        </span>
        {canExport && (
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            aria-label={
              artifact.type === "table" || artifact.type === "file"
                ? "Download CSV"
                : "Download PNG"
            }
            title={
              artifact.type === "table" || artifact.type === "file"
                ? "Download CSV"
                : "Download PNG"
            }
          >
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Body */}
      <div className="artifact-body">
        {renderBody(artifact, chartContainerRef)}
      </div>
    </div>
  );
}

function renderBody(
  artifact: ArtifactView,
  chartContainerRef: React.Ref<HTMLDivElement>,
): React.ReactNode {
  switch (artifact.type) {
    case "chart": {
      const payload = artifact.payload as ChartPayload;
      // Plotly charts (3D, geo, sankey, etc.) use the dedicated Plotly renderer.
      // Everything else falls back to Recharts.
      if (payload.renderer === "plotly" && payload.plotlyFigure) {
        return (
          <PlotlyRenderer
            figure={payload.plotlyFigure}
            title={payload.title}
          />
        );
      }
      return <RechartsRenderer ref={chartContainerRef} spec={payload} />;
    }

    case "table":
      return <TableArtifactView payload={artifact.payload as TablePayload} />;

    case "file":
      return <FileArtifactView payload={artifact.payload as FilePayload} />;

    case "code":
      return <CodeArtifactView payload={artifact.payload as CodePayload} />;

    case "forecast":
      return (
        <ForecastArtifactView
          ref={chartContainerRef}
          payload={artifact.payload as ForecastPayload}
        />
      );

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

/** Compact download card for file artifacts.
 *  Shows filename, row/column counts, and a prominent Download CSV button.
 *  No inline table — the user's intent is to download, not inspect rows. */
function FileArtifactView({ payload }: { payload: FilePayload }) {
  const { filename, columns, rowCount, title, truncated } = payload;
  return (
    <div className="flex items-center gap-3 py-1">
      <FileDown className="h-8 w-8 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-sm font-medium tracking-tight text-foreground">
          {title ?? filename}
        </p>
        <p className="text-xs text-muted-foreground">
          {filename}.csv · {rowCount.toLocaleString()} row{rowCount === 1 ? "" : "s"} · {columns.length} column{columns.length === 1 ? "" : "s"}
          {truncated ? " · truncated" : ""}
        </p>
      </div>
    </div>
  );
}

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
      <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground">
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
    Forecast artifact (Phase 2 §2.2)
    Renders a forecast result: a line chart with historical actuals +
    future forecast values, plus MAE/RMSE/MAPE metrics below.
    Forwards a ref to the inner RechartsRenderer for PNG export.
    ============================================================ */

const ForecastArtifactView = forwardRef<
  HTMLDivElement,
  { payload: ForecastPayload }
>(function ForecastArtifactView({ payload }, ref) {
  const { method, horizon, metrics, predictions, summary } = payload;

  // Build chart data: one row per prediction entry. `actual` and `forecast`
  // are separate series so Recharts draws them as two lines on the same axis.
  // The forecast line naturally starts where actuals end; the small overlap
  // region (holdout) shows both so the user can visually assess accuracy.
  const chartData = predictions.map((p) => ({
    date: p.date,
    actual: p.actual,
    forecast: p.forecast,
  }));

  return (
    <div>
      <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
        {summary}
      </p>
      <RechartsRenderer
        ref={ref}
        spec={{
          chartType: "line",
          data: chartData,
          xKey: "date",
          yKeys: ["actual", "forecast"],
          title: `${method.toUpperCase()} Forecast · ${horizon} periods`,
        }}
      />
      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3">
        <div className="space-y-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            MAE
          </dt>
          <dd className="font-mono text-sm font-medium text-foreground">
            {metrics.mae.toFixed(2)}
          </dd>
        </div>
        <div className="space-y-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            RMSE
          </dt>
          <dd className="font-mono text-sm font-medium text-foreground">
            {metrics.rmse.toFixed(2)}
          </dd>
        </div>
        <div className="space-y-0.5">
          <dt className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            MAPE
          </dt>
          <dd className="font-mono text-sm font-medium text-foreground">
            {metrics.mape.toFixed(1)}%
          </dd>
        </div>
      </dl>
    </div>
  );
});

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

/* ============================================================
    Export helpers (Phase 3 §3.1)
    ============================================================ */

/** Replace characters that are unsafe in filenames with underscores. */
function sanitizeFilename(name: string): string {
  const cleaned = name.trim().replace(/[^\w\-.]+/g, "_");
  return cleaned || "export";
}

/** Trigger a browser download from a data URL or object URL. */
function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** CSV-escape a single cell value per RFC 4180. */
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str =
    typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  // Quote if the value contains a comma, quote, newline, or carriage return.
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Build a CSV string from columns + rows. */
function toCsvString(columns: string[], rows: unknown[][]): string {
  const header = columns.map(csvEscape).join(",");
  const body = rows
    .map((row) => columns.map((_, i) => csvEscape(row[i])).join(","))
    .join("\n");
  return header + "\n" + body;
}

/** Build a CSV string from table data and trigger a browser download. */
function downloadCsv(columns: string[], rows: unknown[][], filename: string) {
  const csv = toCsvString(columns, rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  // Release the object URL after the download is dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
