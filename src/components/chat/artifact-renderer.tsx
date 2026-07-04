"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import { toPng } from "html-to-image";
import { BarChart3, Bookmark, Code2, Download, FileText, FileDown, LineChart, Loader2, RefreshCw, Table2 } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { RechartsRenderer } from "@/components/charts/recharts-renderer";
import { PlotlyRenderer } from "@/components/charts/plotly-renderer";
import { SaveChartDialog } from "@/components/library/save-chart-dialog";
import { Markdown } from "@/components/chat/markdown";
import { exportReportToPdf } from "@/lib/export/pdf";
import { exportReportToMarkdownZip } from "@/lib/export/markdown-zip";
import type {
  Artifact,
  ChartPayload,
  CodePayload,
  FilePayload,
  ForecastPayload,
  ReportPayload,
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
  | "file"
  | "report";

export interface ArtifactView {
  type: ArtifactType;
  payload:
    | ChartPayload
    | TablePayload
    | CodePayload
    | FilePayload
    | SummaryPayload
    | ForecastPayload
    | ReportPayload;
  /** Source node that produced this artifact (for label) */
  node?: string;
}

interface ArtifactRendererProps {
  artifact: ArtifactView;
  /** Session id — when provided, charts/tables with stripped data re-query
   *  their SQL on history load, and chart artifacts show a "Save to library"
   *  button. Omitted for non-chat render contexts. */
  sessionId?: string;
  /** Data source ids bound to the session — needed to save a chart to the
   *  library. Derived from the Chat's dataSource prop. */
  dataSourceIds?: string[];
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
  report: { label: "Report", icon: FileText },
};

/**
 * Multi-format download dropdown for table-like artifacts (table / file).
 *
 * Renders a compact Download icon button in the artifact header. Clicking it
 * opens a small popover with three export options: Excel (.xlsx), CSV (.csv),
 * and JSON (.json). The popover closes on outside click or Escape.
 *
 * Excel export uses a dynamic import of xlsx so it's only loaded on demand.
 */
function DownloadMenu({
  columns,
  rows,
  baseName,
}: {
  columns: string[];
  rows: unknown[][];
  baseName: string;
}) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  async function handleDownload(format: "xlsx" | "csv" | "json") {
    if (exporting) return;
    setOpen(false);
    const safe = sanitizeFilename(baseName);
    setExporting(true);
    try {
      if (format === "csv") {
        downloadCsv(columns, rows, `${safe}.csv`);
      } else if (format === "json") {
        downloadJson(columns, rows, `${safe}.json`);
      } else {
        await downloadExcel(columns, rows, `${safe}.xlsx`);
      }
    } catch (err) {
      console.error("[artifact] download failed:", err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div ref={containerRef} className="relative ml-auto">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={exporting}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        aria-label="Download"
        title="Download"
      >
        {exporting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[140px] overflow-hidden rounded-md border border-border bg-white p-1 shadow-lg">
          {([
            { fmt: "xlsx" as const, label: "Excel (.xlsx)" },
            { fmt: "csv" as const, label: "CSV (.csv)" },
            { fmt: "json" as const, label: "JSON (.json)" },
          ]).map((opt) => (
            <button
              key={opt.fmt}
              type="button"
              onClick={() => handleDownload(opt.fmt)}
              className="flex w-full cursor-pointer items-center px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Download dropdown for report artifacts.
 *
 * Offers two export formats:
 *   - PDF → opens the browser's print dialog (Save as PDF) via a hidden
 *           iframe. Produces a real text-based PDF with selectable / copyable
 *           text and native CJK support. Elements annotated with
 *           `data-pdf-exclude` (e.g. the "References" footer) are stripped.
 *   - Markdown → exports a .zip archive containing report.md + images/
 *                folder (one PNG per embedded chart/forecast, screenshotted
 *                from the live DOM). Tables/summaries/code are inlined as
 *                their Markdown equivalent. This produces a portable,
 *                self-contained archive viewable in any Markdown editor.
 */
function ReportDownloadMenu({
  reportRef,
  payload,
}: {
  reportRef: React.RefObject<HTMLDivElement | null>;
  payload: ReportPayload;
}) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function handlePdf() {
    setOpen(false);
    if (!reportRef.current) return;
    try {
      const filename = sanitizeFilename(payload.title || "report");
      exportReportToPdf(reportRef.current, filename);
    } catch (err) {
      console.error("[artifact] PDF export failed:", err);
    }
  }

  async function handleMarkdownZip() {
    if (exporting) return;
    setOpen(false);
    if (!reportRef.current) return;
    setExporting(true);
    try {
      const filename = sanitizeFilename(payload.title || "report");
      await exportReportToMarkdownZip(reportRef.current, payload, filename);
    } catch (err) {
      console.error("[artifact] Markdown ZIP export failed:", err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div ref={containerRef} className="relative ml-auto">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={exporting}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        aria-label="Download"
        title="Download"
      >
        {exporting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Download className="h-3.5 w-3.5" />
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[150px] overflow-hidden rounded-md border border-border bg-white p-1 shadow-lg">
          <button
            type="button"
            onClick={handlePdf}
            className="flex w-full cursor-pointer items-center px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            PDF (.pdf)
          </button>
          <button
            type="button"
            onClick={handleMarkdownZip}
            className="flex w-full cursor-pointer items-center px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent"
          >
            Markdown (.zip)
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Renders an artifact (chart / table / code / summary / file) inside a bordered card.
 * Used by the Chat component when streaming artifacts arrive from /api/chat.
 *
 * Exportable artifacts show a Download button in the header:
 *   - chart (recharts) / forecast → PNG via html-to-image
 *   - chart (plotly)              → PNG handled inside PlotlyRenderer
 *   - table / file                → multi-format dropdown (Excel / CSV / JSON)
 */
export function ArtifactRenderer({
  artifact,
  sessionId,
  dataSourceIds,
}: ArtifactRendererProps) {
  const meta = ARTIFACT_META[artifact.type];
  const Icon = meta.icon;

  // Ref to the Recharts container DOM node, used for PNG export.
  const chartContainerRef = useRef<HTMLDivElement>(null);
  // Ref to the report container DOM node, used for PDF export.
  const reportContainerRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  // ---- Save-to-library (chart artifacts only) ----
  const [saveOpen, setSaveOpen] = useState(false);
  const canSaveToLibrary =
    artifact.type === "chart" &&
    !!sessionId &&
    !!dataSourceIds &&
    dataSourceIds.length > 0;

  // ---- Chat history rehydration ----
  // Recharts charts and tables are persisted without inline data (space
  // optimization). On history load, re-execute the stored SQL against the
  // session's data source to regenerate the data. Plotly charts store their
  // full figure and skip this. During live streaming the data is present,
  // so the re-query only triggers when data/rows is empty AND sql exists.
  const [rehydrating, setRehydrating] = useState(false);
  const [rehydrateError, setRehydrateError] = useState<string | null>(null);
  const [rehydrated, setRehydrated] = useState<{
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    truncated: boolean;
  } | null>(null);
  const lastSqlRef = useRef<string | null>(null);

  async function rehydrate(sql: string) {
    if (!sessionId) return;
    setRehydrating(true);
    setRehydrateError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          (err as { error?: string }).error || `Failed: ${res.status}`,
        );
      }
      const data = await res.json();
      setRehydrated({
        columns: (data.columns as string[]) ?? [],
        rows: (data.rows as unknown[][]) ?? [],
        rowCount: (data.rowCount as number) ?? 0,
        truncated: (data.truncated as boolean) ?? false,
      });
    } catch (err) {
      setRehydrateError(err instanceof Error ? err.message : String(err));
    } finally {
      setRehydrating(false);
    }
  }

  useEffect(() => {
    if (!sessionId) return;
    let sqlToRun: string | undefined;
    if (artifact.type === "chart") {
      const cp = artifact.payload as ChartPayload;
      if (cp.renderer !== "plotly" && (cp.data?.length ?? 0) === 0 && cp.sql) {
        sqlToRun = cp.sql;
      }
    } else if (artifact.type === "table") {
      const tp = artifact.payload as TablePayload;
      if ((tp.rows?.length ?? 0) === 0 && tp.sql) {
        sqlToRun = tp.sql;
      }
    }
    if (sqlToRun) {
      lastSqlRef.current = sqlToRun;
      void rehydrate(sqlToRun);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact, sessionId]);

  // Merge rehydrated data into the artifact payload so renderBody sees the
  // full data (Recharts chart data array / table rows).
  let effectivePayload = artifact.payload;
  if (rehydrated) {
    if (artifact.type === "chart") {
      const cp = artifact.payload as ChartPayload;
      effectivePayload = {
        ...cp,
        data: buildChartData(rehydrated.columns, rehydrated.rows),
      } as ChartPayload;
    } else if (artifact.type === "table") {
      const tp = artifact.payload as TablePayload;
      effectivePayload = {
        ...tp,
        rows: rehydrated.rows,
        truncated: rehydrated.truncated,
      } as TablePayload;
    }
  }
  const effectiveArtifact: ArtifactView = {
    ...artifact,
    payload: effectivePayload,
  };

  // Table-like artifacts (table / file) show a multi-format download menu
  // (Excel / CSV / JSON). Chart-like artifacts (chart non-plotly / forecast)
  // show a single PNG download button. Report artifacts show a PDF/Markdown
  // download menu. Derive from the effective payload so rehydrated tables
  // export their refreshed rows.
  const tableExport =
    artifact.type === "table" || artifact.type === "file";
  const pngExport =
    (artifact.type === "chart" &&
      (effectivePayload as ChartPayload).renderer !== "plotly") ||
    artifact.type === "forecast";

  const tableData = tableExport
    ? artifact.type === "table"
      ? {
          columns: (effectivePayload as TablePayload).columns,
          rows: (effectivePayload as TablePayload).rows,
          baseName: (effectivePayload as TablePayload).title ?? "table",
        }
      : {
          columns: (effectivePayload as FilePayload).columns,
          rows: (effectivePayload as FilePayload).rows,
          baseName: (effectivePayload as FilePayload).filename,
        }
    : null;

  async function handlePngExport() {
    if (exporting) return;
    setExporting(true);
    try {
      if (chartContainerRef.current) {
        const payload = effectivePayload as ChartPayload | ForecastPayload;
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

  // For chart artifacts: compute the spec to save (Recharts strips data;
  // Plotly keeps full figure) — matches the chat persistence strategy.
  const chartPayloadForSave =
    artifact.type === "chart" ? (artifact.payload as ChartPayload) : null;

  return (
    <div className="animate-fade-up rounded-lg border border-border bg-card p-4 shadow-sm">
      {/* Header */}
      <div className="mb-3 flex items-center gap-2 border-b border-border pb-2">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {meta.label}
          {artifact.node ? ` · ${artifact.node}` : ""}
        </span>
        {canSaveToLibrary && (
          <button
            type="button"
            onClick={() => setSaveOpen(true)}
            className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Save to library"
            title="Save to library"
          >
            <Bookmark className="h-3.5 w-3.5" />
          </button>
        )}
        {tableData && (
          <DownloadMenu
            columns={tableData.columns}
            rows={tableData.rows}
            baseName={tableData.baseName}
          />
        )}
        {pngExport && (
          <button
            type="button"
            onClick={handlePngExport}
            disabled={exporting}
            className={`${canSaveToLibrary ? "" : "ml-auto"} inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50`}
            aria-label="Download PNG"
            title="Download PNG"
          >
            {exporting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        {artifact.type === "report" && (
          <ReportDownloadMenu
            reportRef={reportContainerRef}
            payload={effectivePayload as ReportPayload}
          />
        )}
      </div>

      {/* Body */}
      <div className="artifact-body">
        {rehydrating ? (
          <div className="flex h-40 items-center justify-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Re-loading data…
            </span>
          </div>
        ) : rehydrateError ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8">
            <p className="text-sm text-muted-foreground">Data unavailable</p>
            <p className="max-w-md break-words text-center font-mono text-[10px] text-muted-foreground/70">
              {rehydrateError}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (lastSqlRef.current) void rehydrate(lastSqlRef.current);
              }}
              className="mt-2"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </Button>
          </div>
        ) : (
          renderBody(effectiveArtifact, chartContainerRef, reportContainerRef)
        )}
      </div>

      {/* Save-to-library dialog (chart artifacts only) */}
      {canSaveToLibrary &&
        chartPayloadForSave &&
        sessionId &&
        dataSourceIds && (
          <SaveChartDialog
            open={saveOpen}
            onClose={() => setSaveOpen(false)}
            spec={
              chartPayloadForSave.renderer === "plotly"
                ? { ...chartPayloadForSave }
                : { ...chartPayloadForSave, data: [] }
            }
            sql={chartPayloadForSave.sql}
            renderer={
              chartPayloadForSave.renderer === "plotly" ? "plotly" : "recharts"
            }
            defaultTitle={chartPayloadForSave.title ?? "Untitled chart"}
            sessionId={sessionId}
            dataSourceIds={dataSourceIds}
          />
        )}
    </div>
  );
}

function renderBody(
  artifact: ArtifactView,
  chartContainerRef: React.Ref<HTMLDivElement>,
  reportContainerRef: React.Ref<HTMLDivElement>,
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
      return (
        <SummaryArtifactView payload={artifact.payload as SummaryPayload} />
      );

    case "report":
      return (
        <ReportArtifactView
          ref={reportContainerRef}
          payload={artifact.payload as ReportPayload}
        />
      );

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
      {/* Render as Markdown so summarize_data output (with headings,
          lists, tables) displays correctly. Plain-text summaries also
          render fine (no Markdown syntax = plain text). */}
      <div className="text-sm">
        <Markdown content={text} />
      </div>
      {stats && Object.keys(stats).length > 0 && (
        <dl
          data-pdf-exclude
          className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-3"
        >
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
    Inline artifact (embedded in reports)
    Renders any artifact type inline within a report's Markdown body.
    Used when the LLM inserts {{artifact:ID}} markers — the Markdown
    component calls renderArtifact(id), which looks up the artifact
    in the report's embeddedArtifacts list and delegates to this
    component. Reuses the same sub-views as the standalone renderer.
    ============================================================ */

function InlineArtifactView({
  artifact,
  id,
}: {
  artifact: Artifact;
  id?: string;
}) {
  // data-artifact-id is used by the Markdown ZIP export to locate chart
  // DOM nodes for PNG screenshots. Only set when id is provided.
  const dataProps = id ? { "data-artifact-id": id } : {};
  switch (artifact.type) {
    case "chart": {
      const payload = artifact.payload as ChartPayload;
      if (payload.renderer === "plotly" && payload.plotlyFigure) {
        return (
          <div
            {...dataProps}
            className="rounded-lg border border-slate-200 p-3 bg-white"
          >
            <PlotlyRenderer
              figure={payload.plotlyFigure}
              title={payload.title}
              hideControls
            />
          </div>
        );
      }
      return (
        <div
          {...dataProps}
          className="rounded-lg border border-slate-200 p-3 bg-white"
        >
          <RechartsRenderer spec={payload} />
        </div>
      );
    }
    case "table":
      return (
        <div
          {...dataProps}
          className="rounded-lg border border-slate-200 p-3 bg-white"
        >
          <TableArtifactView payload={artifact.payload as TablePayload} />
        </div>
      );
    case "summary":
      return (
        <div
          {...dataProps}
          className="rounded-lg border border-slate-200 p-3 bg-white"
        >
          <SummaryArtifactView payload={artifact.payload as SummaryPayload} />
        </div>
      );
    case "forecast":
      return (
        <div
          {...dataProps}
          className="rounded-lg border border-slate-200 p-3 bg-white"
        >
          <ForecastArtifactView payload={artifact.payload as ForecastPayload} />
        </div>
      );
    case "file":
      return (
        <div
          {...dataProps}
          className="rounded-lg border border-slate-200 p-3 bg-white"
        >
          <FileArtifactView payload={artifact.payload as FilePayload} />
        </div>
      );
    case "code":
      return (
        <div
          {...dataProps}
          className="rounded-lg border border-slate-200 p-3 bg-white"
        >
          <CodeArtifactView payload={artifact.payload as CodePayload} />
        </div>
      );
    default:
      return null;
  }
}

/* ============================================================
    Report artifact (generate_report tool)
    Renders a Markdown report with optional metadata header. Forwards a
    ref to the outer container so the parent ArtifactRenderer can print it
    to PDF via the browser's native print engine (selectable text + CJK).
    The "References" footer is annotated with `data-pdf-exclude` so it is
    stripped from PDF output.
    Embedded artifacts (charts/tables/summaries) are rendered inline at
    {{artifact:ID}} marker positions via content preprocessing (split).
    ============================================================ */

const ReportArtifactView = forwardRef<
  HTMLDivElement,
  { payload: ReportPayload }
>(function ReportArtifactView({ payload }, ref) {
  const { content, title, metadata, referencedArtifactIds, embeddedArtifacts } = payload;

  // Format generatedAt as a human-readable timestamp.
  const generatedAtDisplay = metadata?.generatedAt
    ? new Date(metadata.generatedAt).toLocaleString()
    : null;

  // Build a lookup map (id → artifact) for inline rendering. Embedded
  // artifacts are full self-contained copies (chart data is NOT stripped),
  // so inline rendering works even after the report is persisted and
  // reloaded from chat history.
  const embeddedMap = new Map<string, Artifact>();
  if (embeddedArtifacts) {
    for (const ea of embeddedArtifacts) {
      embeddedMap.set(ea.id, ea.artifact);
    }
  }

  // Preprocess the Markdown content: split by {{artifact:ID}} markers and
  // render each segment separately. Text segments go through <Markdown>,
  // marker segments are replaced by <InlineArtifactView>. This is more
  // reliable than detecting markers inside react-markdown's `p` component
  // override (children format varies across react-markdown versions).
  //
  // The split uses a capture group so markers are kept as separate array
  // elements. The regex tolerates optional internal whitespace.
  //
  // Fallback: if embeddedArtifacts is non-empty but the content contains
  // no markers (LLM listed IDs but forgot to insert {{artifact:ID}} in the
  // Markdown body), append all embedded artifacts at the end so charts
  // still appear in the report.
  function renderReportContent(): React.ReactNode {
    if (embeddedArtifacts && embeddedArtifacts.length > 0) {
      const markerRe = /{{artifact:\s*\w+\s*}}/;
      const hasMarkers = markerRe.test(content);

      if (hasMarkers) {
        const parts = content.split(/({{artifact:\s*\w+\s*}})/g);
        return parts.map((part, i) => {
          const match = part.match(/^{{artifact:\s*(\w+)\s*}}$/);
          if (match) {
            const id = match[1];
            const a = embeddedMap.get(id);
            if (a) {
              return (
                <div key={i} className="my-4">
                  <InlineArtifactView artifact={a} id={id} />
                </div>
              );
            }
            // Marker found but artifact data missing — show a placeholder
            // so the user can see something went wrong (and where).
            return (
              <p key={i} className="my-2 text-sm italic text-slate-400">
                [artifact:{id} not available]
              </p>
            );
          }
          // Text segment — render as Markdown. Skip empty/whitespace-only
          // parts to avoid extra spacing between adjacent markers.
          if (part.trim()) {
            return <Markdown key={i} content={part} />;
          }
          return null;
        });
      }

      // Fallback: no markers in content but embeddedArtifacts exist.
      // Render the Markdown body, then append all embedded artifacts.
      return (
        <>
          <Markdown content={content} />
          {embeddedArtifacts.map((ea) => (
            <div key={ea.id} className="my-4">
              <InlineArtifactView artifact={ea.artifact} id={ea.id} />
            </div>
          ))}
        </>
      );
    }
    // No embedded artifacts — render the whole content as Markdown.
    return <Markdown content={content} />;
  }

  return (
    <div
      ref={ref}
      // Plain white background + explicit colors so the browser's print
      // engine produces a clean PDF (Tailwind oklch()/hsl() CSS variables
      // can resolve oddly in the print iframe's fresh document context).
      style={{ backgroundColor: "#ffffff", color: "#0f172a" }}
      className="rounded-md p-2"
    >
      {/* Report header */}
      <div className="mb-4 border-b border-slate-200 pb-3">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          {title}
        </h1>
        {metadata?.subtitle && (
          <p className="mt-1 text-sm text-slate-600">{metadata.subtitle}</p>
        )}
        {(generatedAtDisplay || (metadata?.dataSourceNames && metadata.dataSourceNames.length > 0)) && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            {generatedAtDisplay && (
              <span>Generated: {generatedAtDisplay}</span>
            )}
            {metadata?.dataSourceNames && metadata.dataSourceNames.length > 0 && (
              <span>Data sources: {metadata.dataSourceNames.join(", ")}</span>
            )}
          </div>
        )}
      </div>

      {/* Report body — {{artifact:ID}} markers are split out and replaced
          by inline artifact rendering; text segments render as Markdown. */}
      <div className="report-body">
        {renderReportContent()}
      </div>

      {/* Referenced artifacts footer (informational, on-screen only —
          excluded from PDF export via data-pdf-exclude) */}
      {referencedArtifactIds && referencedArtifactIds.length > 0 && (
        <div
          data-pdf-exclude
          className="mt-6 border-t border-slate-200 pt-3 text-xs text-slate-500"
        >
          <span className="font-mono uppercase tracking-wider">
            References
          </span>
          : {referencedArtifactIds.length} artifact(s)
        </div>
      )}
    </div>
  );
});

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

/**
 * Build a chart data array (array of row objects keyed by column name) from
 * re-queried columns + array rows. Mirrors the logic in chart-viewer.tsx:
 * numeric strings are coerced to numbers so Recharts renders axes correctly.
 * Capped at 100 rows (same as the in-memory chart render limit).
 */
function buildChartData(
  columns: string[],
  rows: unknown[][],
): Record<string, unknown>[] {
  return rows.slice(0, 100).map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      const val = row[idx];
      if (typeof val === "string" && val !== "" && !isNaN(Number(val))) {
        obj[col] = Number(val);
      } else {
        obj[col] = val;
      }
    });
    return obj;
  });
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

/** Build a JSON array of row-objects and trigger a browser download. */
function downloadJson(columns: string[], rows: unknown[][], filename: string) {
  const data = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Build an .xlsx file from table data and trigger a browser download.
 *  Uses SheetJS (xlsx) for proper Excel format support. */
async function downloadExcel(columns: string[], rows: unknown[][], filename: string) {
  // Dynamic import — xlsx is only loaded when the user actually exports
  // to Excel, keeping the initial bundle smaller.
  const XLSX = await import("xlsx");
  // Map rows to objects keyed by column name so the sheet has headers.
  const data = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
  const ws = XLSX.utils.json_to_sheet(data, { header: columns });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, filename);
}
