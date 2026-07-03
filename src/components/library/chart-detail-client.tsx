"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toPng } from "html-to-image";
import { ArrowLeft, Check, Code2, Download, Loader2, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { ChartViewer } from "@/components/library/chart-viewer";
import type { ChartPayload } from "@/lib/agent/state";

export interface ChartDetailDataSource {
  id: string;
  name: string;
  type: string;
}

export interface ChartDetailData {
  id: string;
  title: string;
  description: string | null;
  spec: Record<string, unknown>;
  sql_text: string | null;
  renderer: "recharts" | "plotly";
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
  data_sources: ChartDetailDataSource[];
}

const TYPE_LABELS: Record<string, string> = {
  pg: "PostgreSQL",
  mysql: "MySQL",
  bigquery: "BigQuery",
  duckdb: "DuckDB file",
  sqlite: "SQLite file",
  file: "File",
};

/** Chart type options for the Recharts renderer. */
const CHART_TYPE_OPTIONS = [
  { value: "bar", label: "Bar" },
  { value: "line", label: "Line" },
  { value: "area", label: "Area" },
  { value: "pie", label: "Pie" },
  { value: "scatter", label: "Scatter" },
  { value: "radar", label: "Radar" },
  { value: "radialBar", label: "Radial Bar" },
  { value: "funnel", label: "Funnel" },
  { value: "treemap", label: "Treemap" },
  { value: "composed", label: "Composed" },
];

type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * Client view + editor for a single saved chart.
 *
 * Layout: left column renders the chart (Recharts re-queries data on mount;
 * Plotly renders from its stored figure — both with inline controls hidden
 * since the page chrome owns the download button). Right column holds inline
 * editors:
 *   - Title / Description: debounced auto-save (800ms after last keystroke)
 *   - Chart type (Recharts only): inline Select, saved immediately on change
 *   - SQL: hidden by default; an "Edit SQL" button opens a modal with a
 *     textarea + explicit Save button.
 *   - Python code (Plotly only): hidden by default; an "Edit Python" button
 *     opens a modal similar to the SQL one.
 *
 * Top-right toolbar: Download PNG (left of Delete). Uses html-to-image for
 * Recharts and Plotly.downloadImage for Plotly (via the ChartViewer ref).
 */
export function ChartDetailClient({ chart }: { chart: ChartDetailData }) {
  const router = useRouter();
  const isPlotly = chart.renderer === "plotly";

  // ---- Inline edit state (title / description with debounced auto-save) ----
  const [title, setTitle] = useState(chart.title);
  const [description, setDescription] = useState(chart.description ?? "");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  // Track last saved values so we only PATCH when something actually changed.
  const lastSavedRef = useRef({
    title: chart.title,
    description: chart.description ?? "",
  });
  // Skip the first render (initial mount) for the debounce effect — we don't
  // want to save on mount when the state is just being initialized.
  const mountedRef = useRef(false);
  // Active debounce timer ref so we can cancel on each new keystroke.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    // Don't save if title is empty (required field).
    if (!title.trim()) return;
    // Don't save if nothing changed since last save.
    if (
      title === lastSavedRef.current.title &&
      description === lastSavedRef.current.description
    ) {
      return;
    }

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaveStatus("saving");
      try {
        const res = await fetch(`/api/charts/${chart.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            description: description.trim() || null,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(
            (err as { error?: string }).error || `Failed: ${res.status}`,
          );
        }
        lastSavedRef.current = { title, description };
        setSaveStatus("saved");
        // Update server-side data so `updated_at` etc. are fresh, but don't
        // disrupt the user's editing focus — refresh silently.
        router.refresh();
        // Clear "saved" badge after 2s.
        setTimeout(() => setSaveStatus("idle"), 2000);
      } catch (err) {
        setSaveStatus("error");
        const msg = err instanceof Error ? err.message : "Save failed";
        toast.error(msg);
      }
    }, 800);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, description, chart.id]);

  // ---- Chart type (Recharts only) ----
  // Stored inline in spec.chartType; saved immediately on change via PATCH
  // (small payload, no need to debounce).
  const chartPayload = chart.spec as unknown as ChartPayload;
  const [chartType, setChartType] = useState<string>(
    isPlotly ? "" : (chartPayload.chartType ?? "bar"),
  );

  async function handleChartTypeChange(newType: string) {
    if (isPlotly || newType === chartType) return;
    setChartType(newType);
    try {
      const updatedSpec = { ...chart.spec, chartType: newType };
      const res = await fetch(`/api/charts/${chart.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: updatedSpec }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          (err as { error?: string }).error || `Failed: ${res.status}`,
        );
      }
      toast.success(`Chart type changed to ${newType}`);
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Update failed";
      toast.error(msg);
      // Revert on failure
      setChartType(chartType);
    }
  }

  // ---- SQL modal state ----
  const [sqlOpen, setSqlOpen] = useState(false);
  const [sqlDraft, setSqlDraft] = useState(chart.sql_text ?? "");
  const [sqlSaving, setSqlSaving] = useState(false);

  function openSqlModal() {
    // Seed the draft from the latest server value each time the modal opens.
    setSqlDraft(chart.sql_text ?? "");
    setSqlOpen(true);
  }

  async function saveSql() {
    if (sqlSaving) return;
    setSqlSaving(true);
    try {
      const res = await fetch(`/api/charts/${chart.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql_text: sqlDraft || null }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          (err as { error?: string }).error || `Failed: ${res.status}`,
        );
      }
      toast.success("SQL updated — chart will re-query on next view");
      setSqlOpen(false);
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Update failed";
      toast.error(msg);
    } finally {
      setSqlSaving(false);
    }
  }

  // ---- Python code modal state (Plotly only) ----
  // Stored in spec.pythonCode; saved via PATCH (same as chart type).
  const [pythonOpen, setPythonOpen] = useState(false);
  const [pythonDraft, setPythonDraft] = useState<string>(
    (chartPayload.pythonCode as string | undefined) ?? "",
  );
  const [pythonSaving, setPythonSaving] = useState(false);

  function openPythonModal() {
    setPythonDraft((chartPayload.pythonCode as string | undefined) ?? "");
    setPythonOpen(true);
  }

  async function savePython() {
    if (pythonSaving) return;
    setPythonSaving(true);
    try {
      const updatedSpec = { ...chart.spec, pythonCode: pythonDraft || undefined };
      const res = await fetch(`/api/charts/${chart.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: updatedSpec }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          (err as { error?: string }).error || `Failed: ${res.status}`,
        );
      }
      toast.success("Python code updated — click Refresh to regenerate");
      setPythonOpen(false);
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Update failed";
      toast.error(msg);
    } finally {
      setPythonSaving(false);
    }
  }

  // ---- Delete ----
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (deleting) return;
    if (!confirm(`Delete chart "${chart.title}"? This cannot be undone.`))
      return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/charts/${chart.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(
          (err as { error?: string }).error || `Failed: ${res.status}`,
        );
      }
      toast.success("Chart deleted");
      router.push("/library");
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed";
      toast.error(msg);
    } finally {
      setDeleting(false);
    }
  }

  // ---- Download PNG ----
  // Recharts: html-to-image on the chart container ref.
  // Plotly: dynamically import plotly.js-dist-min and call downloadImage on
  //   the rendered graph div (looked up via a ref passed down to the
  //   chart-viewer's container).
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  async function handleDownload() {
    if (exporting) return;
    setExporting(true);
    try {
      if (isPlotly) {
        // Plotly renders the graph inside the container; find the .plotly
        // DOM node and call Plotly.downloadImage on it.
        const Plotly = (await import("plotly.js-dist-min")).default;
        const container = chartContainerRef.current;
        const plotlyDiv = container?.querySelector(".js-plotly-plot") as
          | HTMLElement
          | null;
        if (!plotlyDiv) {
          throw new Error("Plotly chart not rendered yet");
        }
        const filename =
          (chart.title ?? "chart").replace(/[^\w-]+/g, "_") || "chart";
        await Plotly.downloadImage(plotlyDiv, {
          format: "png",
          filename,
          width: plotlyDiv.clientWidth ?? 800,
          height: plotlyDiv.clientHeight ?? 420,
          scale: 2,
        });
      } else {
        // Recharts: use html-to-image on the wrapper div.
        if (!chartContainerRef.current) return;
        const filename =
          sanitizeFilename(chart.title || "chart") + ".png";
        const dataUrl = await toPng(chartContainerRef.current, {
          backgroundColor: "#ffffff",
          pixelRatio: 2,
          cacheBust: true,
        });
        triggerDownload(dataUrl, filename);
      }
    } catch (err) {
      console.error("[chart-detail] export failed:", err);
      const msg = err instanceof Error ? err.message : "Export failed";
      toast.error(msg);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="h-screen overflow-y-auto bg-background">
      <div className="mx-auto max-w-6xl px-6 py-8">
        {/* Top bar */}
        <div className="mb-6 flex items-center justify-between">
          <Button asChild variant="ghost" size="sm">
            <Link href="/library">
              <ArrowLeft className="h-4 w-4" />
              Back to library
            </Link>
          </Button>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownload}
              disabled={exporting}
              title="Download PNG"
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              Download
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              Delete
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]">
          {/* Chart preview */}
          <div className="rounded-lg border border-border bg-card p-4 shadow-sm" ref={chartContainerRef}>
            <ChartViewer
              chartId={chart.id}
              spec={chart.spec}
              renderer={chart.renderer}
              sqlText={chart.sql_text}
              hideControls
            />
          </div>

          {/* Edit panel */}
          <div className="space-y-6">
            {/* Inline title + description with debounced auto-save */}
            <div className="space-y-4 rounded-lg border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Details
                </span>
                {saveStatus === "saving" && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Saving…
                  </span>
                )}
                {saveStatus === "saved" && (
                  <span className="flex items-center gap-1 text-xs text-green-600">
                    <Check className="h-3 w-3" />
                    Saved
                  </span>
                )}
                {saveStatus === "error" && (
                  <span className="text-xs text-destructive">Save failed</span>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="title">Title</Label>
                <Input
                  id="title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Chart title"
                />
                {!title.trim() && (
                  <p className="text-xs text-destructive">Title is required</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Add a description..."
                  rows={3}
                />
              </div>
              <p className="font-mono text-[10px] text-muted-foreground">
                Changes are saved automatically.
              </p>
            </div>

            {/* Chart type (Recharts only) */}
            {!isPlotly && (
              <div className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Chart type
                </span>
                <Select
                  value={chartType}
                  options={CHART_TYPE_OPTIONS}
                  onChange={(v) => handleChartTypeChange(v)}
                />
                <p className="font-mono text-[10px] text-muted-foreground">
                  Changing the type re-renders the chart with the same data.
                </p>
              </div>
            )}

            {/* SQL section — shown for both renderers. Recharts re-queries on
                every view; Plotly uses it as input to the Python figure build
                (see the Refresh button below the chart). */}
            <div className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  SQL query
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openSqlModal}
                >
                  <Code2 className="h-3.5 w-3.5" />
                  Edit SQL
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {isPlotly
                  ? chart.sql_text
                    ? "SQL feeds the Python figure build — click Refresh below the chart to regenerate."
                    : "No SQL configured. The Python code needs a DataFrame; add a SQL query."
                  : chart.sql_text
                    ? "SQL is configured — the chart re-queries its bound data source on each view."
                    : "No SQL configured. Click Edit SQL to add one."}
              </p>
            </div>

            {/* Python code section (Plotly only) */}
            {isPlotly && (
              <div className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Python code
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={openPythonModal}
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    Edit Python
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {(chartPayload.pythonCode as string | undefined)
                    ? "Python code is configured — click Refresh below the chart to regenerate the figure."
                    : "No Python code stored. Charts saved before this feature won't have it."}
                </p>
              </div>
            )}

            {/* Bound data sources */}
            <div className="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
              <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Bound data sources
              </p>
              {chart.data_sources.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No data sources bound.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {chart.data_sources.map((ds) => (
                    <li key={ds.id}>
                      <Link
                        href={`/sources/${ds.id}/edit?from=/library/${chart.id}`}
                        className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
                      >
                        <span className="truncate text-foreground">
                          {ds.name}
                        </span>
                        <span className="ml-2 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          {TYPE_LABELS[ds.type] ?? ds.type}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p
                className="font-mono text-[10px] text-muted-foreground"
                suppressHydrationWarning
              >
                Created {new Date(chart.created_at).toLocaleDateString()}
                {" · "}
                Updated {new Date(chart.updated_at).toLocaleDateString()}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* SQL Edit Modal — rendered via portal to escape any ancestor
          transform / containment (same pattern as SaveChartDialog). */}
      {sqlOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-6 shadow-lg">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-display text-base font-semibold tracking-tight">
                  Edit SQL query
                </h2>
                <button
                  type="button"
                  onClick={() => setSqlOpen(false)}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3">
                <Textarea
                  value={sqlDraft}
                  onChange={(e) => setSqlDraft(e.target.value)}
                  placeholder="SELECT ..."
                  rows={12}
                  className="font-mono text-xs"
                  autoFocus
                />
                <p className="font-mono text-[10px] text-muted-foreground">
                  This SQL re-runs against the chart&apos;s bound data source
                  on every view. Editing it changes how the chart refreshes
                  its data.
                </p>
              </div>
              <div className="mt-4 flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setSqlOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={saveSql}
                  disabled={sqlSaving}
                >
                  {sqlSaving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    "Save SQL"
                  )}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Python Code Edit Modal (Plotly only) */}
      {pythonOpen &&
        typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-6 shadow-lg">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-display text-base font-semibold tracking-tight">
                  Edit Python code
                </h2>
                <button
                  type="button"
                  onClick={() => setPythonOpen(false)}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="space-y-3">
                <Textarea
                  value={pythonDraft}
                  onChange={(e) => setPythonDraft(e.target.value)}
                  placeholder={"import pandas as pd\nimport plotly.express as px\n\nfig = px.bar(df, x='col1', y='col2')"}
                  rows={14}
                  className="font-mono text-xs"
                  autoFocus
                />
                <p className="font-mono text-[10px] text-muted-foreground">
                  The code runs in a sandbox with a pandas DataFrame
                  {" "}
                  <code className="rounded bg-muted px-1 py-0.5">df</code>
                  {" "}
                  already populated from the SQL query. Assign your Plotly
                  figure to a variable named
                  {" "}
                  <code className="rounded bg-muted px-1 py-0.5">fig</code>.
                  Click &quot;Refresh from data source&quot; below the chart
                  to regenerate the figure after editing.
                </p>
              </div>
              <div className="mt-4 flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setPythonOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={savePython}
                  disabled={pythonSaving}
                >
                  {pythonSaving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    "Save Python"
                  )}
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Sanitize a string into a safe filename (no path separators, no spaces). */
function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[^\w-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "chart"
  );
}

/** Trigger a browser download from a data URL. */
function triggerDownload(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
