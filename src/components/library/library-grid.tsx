"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Database, LayoutGrid, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ChartViewer } from "@/components/library/chart-viewer";

export interface LibraryChartDataSource {
  id: string;
  name: string;
  type: string;
}

export interface LibraryDataSourceOption {
  id: string;
  name: string;
  type: string;
}

export interface LibraryChartRow {
  id: string;
  title: string;
  description: string | null;
  spec: Record<string, unknown>;
  sql_text: string | null;
  renderer: "recharts" | "plotly";
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
  data_sources: LibraryChartDataSource[];
}

interface LibraryGridProps {
  charts: LibraryChartRow[];
  /** All data sources that have at least one bound chart — used to populate
   *  the left sidebar's filter list. */
  dataSources: LibraryDataSourceOption[];
}

/** Human-readable label for each data source type (mirrors sources-list). */
const TYPE_LABELS: Record<string, string> = {
  pg: "PostgreSQL",
  mysql: "MySQL",
  bigquery: "BigQuery",
  duckdb: "DuckDB file",
  sqlite: "SQLite file",
  file: "File",
};

/** Compact type badge for the sidebar — short label keeps the list scannable. */
const TYPE_SHORT: Record<string, string> = {
  pg: "PG",
  mysql: "MySQL",
  bigquery: "BQ",
  duckdb: "DuckDB",
  sqlite: "SQLite",
  file: "File",
};

/**
 * Client-side grid of saved charts with a left data-source filter sidebar.
 *
 * Sidebar lists every data source that has at least one bound chart. Clicking
 * a source filters the grid to charts bound to it; "All charts" clears the
 * filter.
 *
 * Each card shows a compact preview (Recharts lazy-loads data on mount; Plotly
 * renders from stored figure), the title, renderer badge, bound data source
 * names, and a delete action. Clicking a card navigates to the chart detail page.
 */
export function LibraryGrid({ charts, dataSources }: LibraryGridProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  // Collapse state for the "Filter by data source" sidebar. When collapsed,
  // the data source list is hidden but the active filter (if any) is kept —
  // users can still see which source is active via the header chip and can
  // clear it via the header's "All" link.
  const [filterCollapsed, setFilterCollapsed] = useState(false);

  async function handleDelete(
    e: React.MouseEvent,
    chart: LibraryChartRow,
  ) {
    e.preventDefault();
    e.stopPropagation();
    if (deletingId) return;
    if (!confirm(`Delete chart "${chart.title}"? This cannot be undone.`)) {
      return;
    }
    setDeletingId(chart.id);
    startTransition(async () => {
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
        toast.success(`"${chart.title}" deleted`);
        router.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Delete failed";
        toast.error(msg);
      } finally {
        setDeletingId(null);
      }
    });
  }

  // Apply the active filter (if any) — a chart matches if any of its bound
  // data sources equals the active source id.
  const filteredCharts = activeSourceId
    ? charts.filter((c) =>
        c.data_sources.some((ds) => ds.id === activeSourceId),
      )
    : charts;

  if (charts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16 text-center">
        <LayoutGrid className="mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No saved charts yet.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Save a chart from a chat session to see it here.
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/chat/new">Start a new chat</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex gap-6">
      {/* Left sidebar: data source filter. When collapsed the aside shrinks
          to just the toggle button (w-8) so the chart grid gets the space. */}
      {dataSources.length > 0 && (
        <aside
          className={`shrink-0 transition-[width] duration-200 ${
            filterCollapsed ? "w-8" : "w-56"
          }`}
        >
          <div className="sticky top-4 space-y-1">
            {/* Toggle button — doubles as the header. Expanded: full label +
                chevron-down. Collapsed: just a chevron-right icon, centered. */}
            <button
              type="button"
              onClick={() => setFilterCollapsed((v) => !v)}
              className={`flex items-center rounded-md font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground ${
                filterCollapsed
                  ? "h-7 w-7 justify-center"
                  : "w-full justify-between px-2 py-1.5 text-left"
              }`}
              aria-expanded={!filterCollapsed}
              aria-label={
                filterCollapsed
                  ? "Expand data source filter"
                  : "Collapse data source filter"
              }
              title={
                filterCollapsed
                  ? activeSourceId
                    ? `Filter active — expand to change`
                    : "Expand data source filter"
                  : "Collapse data source filter"
              }
            >
              {filterCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <>
                  <span>Filter by data source</span>
                  <ChevronDown className="h-3 w-3" />
                </>
              )}
            </button>

            {!filterCollapsed && (
              <>
                <button
                  type="button"
                  onClick={() => setActiveSourceId(null)}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                    activeSourceId === null
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  }`}
                >
                  <span>All charts</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {charts.length}
                  </span>
                </button>
                {dataSources.map((ds) => {
                  const count = charts.filter((c) =>
                    c.data_sources.some((b) => b.id === ds.id),
                  ).length;
                  const isActive = activeSourceId === ds.id;
                  return (
                    <button
                      key={ds.id}
                      type="button"
                      onClick={() => setActiveSourceId(ds.id)}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                        isActive
                          ? "bg-accent font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                      }`}
                      title={`${TYPE_LABELS[ds.type] ?? ds.type}: ${ds.name}`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Database className="h-3 w-3 shrink-0" />
                        <span className="truncate">{ds.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="rounded border border-border bg-background/60 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                          {TYPE_SHORT[ds.type] ?? ds.type}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {count}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </aside>
      )}

      {/* Right: chart grid (filtered) */}
      <div className="min-w-0 flex-1">
        {activeSourceId && filteredCharts.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16 text-center">
            <p className="text-sm text-muted-foreground">
              No charts bound to this data source.
            </p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => setActiveSourceId(null)}
            >
              Show all charts
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-2">
            {filteredCharts.map((chart) => {
              const isDeleting = deletingId === chart.id;
              return (
                <Link
                  key={chart.id}
                  href={`/library/${chart.id}`}
                  className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/50 hover:shadow-sm"
                >
                  {/* Mini preview */}
                  <div className="border-b border-border bg-muted/20 px-2 pt-2">
                    <div className="h-[280px] overflow-hidden">
                      <ChartViewer
                        chartId={chart.id}
                        spec={chart.spec}
                        renderer={chart.renderer}
                        sqlText={chart.sql_text}
                        compact
                      />
                    </div>
                  </div>

                  {/* Metadata */}
                  <div className="flex flex-1 flex-col gap-2 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="truncate font-display text-sm font-medium tracking-tight text-foreground">
                        {chart.title}
                      </p>
                      <button
                        type="button"
                        onClick={(e) => handleDelete(e, chart)}
                        disabled={isDeleting}
                        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                        aria-label="Delete chart"
                        title="Delete"
                      >
                        {isDeleting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="inline-flex items-center rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                        {chart.renderer}
                      </span>
                      {chart.data_sources.map((ds) => (
                        <span
                          key={ds.id}
                          className="inline-flex items-center rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                          title={`${TYPE_LABELS[ds.type] ?? ds.type}: ${ds.name}`}
                        >
                          {ds.name}
                        </span>
                      ))}
                    </div>

                    <p className="mt-auto font-mono text-[10px] text-muted-foreground" suppressHydrationWarning>
                      Updated {new Date(chart.updated_at).toLocaleDateString()}
                    </p>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
