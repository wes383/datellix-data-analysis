"use client";

import { useState, useTransition, useMemo, useEffect } from "react";
import { Link } from "@/i18n/navigation";
import { useRouter } from "next/navigation";
import { useTranslations, useFormatter } from "next-intl";
import { ChevronDown, ChevronLeft, ChevronRight, Database, LayoutGrid, Loader2, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChartViewer } from "@/components/library/chart-viewer";
import type { ChartRefreshData } from "@/lib/chart/data";

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

/** Maps a data source type key to its translation message key (full labels). */
const TYPE_LABEL_KEYS: Record<string, string> = {
  pg: "typePostgres",
  mysql: "typeMysql",
  bigquery: "typeBigquery",
  duckdb: "typeDuckdbFile",
  sqlite: "typeSqliteFile",
  file: "typeFile",
};

/** Maps a data source type key to its translation message key (short labels).
 *  These live in the Sources namespace since they are data-source type labels. */
const TYPE_SHORT_KEYS: Record<string, string> = {
  pg: "typeShortPostgres",
  mysql: "typeShortMysql",
  bigquery: "typeShortBigquery",
  duckdb: "typeShortDuckdb",
  sqlite: "typeShortSqlite",
  file: "typeShortFile",
};

/** Number of charts shown per page in the grid. */
const PAGE_SIZE = 8;

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
  const t = useTranslations("Library");
  const ts = useTranslations("Sources");
  const tc = useTranslations("Common");
  const format = useFormatter();
  const [, startTransition] = useTransition();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null);
  // Collapse state for the "Filter by data source" sidebar. When collapsed,
  // the data source list is hidden but the active filter (if any) is kept —
  // users can still see which source is active via the header chip and can
  // clear it via the header's "All" link.
  const [filterCollapsed, setFilterCollapsed] = useState(false);
  // Search state. `searchOpen` toggles whether the search input is shown;
  // clicking the search button expands it into a text field.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Pagination state — 1-indexed current page.
  const [currentPage, setCurrentPage] = useState(1);

  // ---- Batch SQL refresh for the visible page ----
  // Instead of each ChartViewer fetching its own data (8 separate HTTP
  // requests, 8 separate Daytona sandboxes), we batch all visible Recharts
  // charts into one POST /api/charts/refresh-batch call. The server creates
  // ONE shared sandbox, runs each chart's SQL sequentially, and returns a
  // results map. We pass `initialData` down to each ChartViewer so it renders
  // immediately without its own fetch.
  //
  // `null` means "no data yet / fetch in progress". A value means "render
  // from this". An entry of `{ error: "..." }` is stored as null so the
  // ChartViewer falls back to its own fetch (and shows the error UI).
  const [batchData, setBatchData] = useState<Record<string, ChartRefreshData | null>>({});

  function typeLabel(type: string): string {
    const key = TYPE_LABEL_KEYS[type];
    return key ? ts(key) : type;
  }

  function typeShort(type: string): string {
    const key = TYPE_SHORT_KEYS[type];
    return key ? ts(key) : type;
  }

  async function handleDelete(
    e: React.MouseEvent,
    chart: LibraryChartRow,
  ) {
    e.preventDefault();
    e.stopPropagation();
    if (deletingId) return;
    if (!confirm(t("confirmDeleteChart", { title: chart.title }))) {
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
            (err as { error?: string }).error || tc("failedStatus", { status: res.status }),
          );
        }
        toast.success(t("toastDeletedNamed", { title: chart.title }));
        router.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : tc("delete");
        toast.error(msg);
      } finally {
        setDeletingId(null);
      }
    });
  }

  // Apply the active data-source filter AND the title search query together.
  // A chart matches if (no source filter OR it's bound to the active source)
  // AND (no query OR its title contains the query, case-insensitive).
  const filteredCharts = useMemo(() => {
    let result = charts;
    if (activeSourceId) {
      result = result.filter((c) =>
        c.data_sources.some((ds) => ds.id === activeSourceId),
      );
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter((c) => c.title.toLowerCase().includes(q));
    }
    return result;
  }, [charts, activeSourceId, searchQuery]);

  // Pagination math. `safePage` guards against the current page exceeding the
  // new total after filters shrink the result set (the effect below resets it,
  // but this keeps the in-between render correct).
  const totalPages = Math.max(1, Math.ceil(filteredCharts.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * PAGE_SIZE;
  const pageCharts = filteredCharts.slice(
    startIndex,
    startIndex + PAGE_SIZE,
  );

  // Reset to the first page whenever the filters change so the user always
  // sees results instead of landing on a now-empty page.
  useEffect(() => {
    setCurrentPage(1);
  }, [activeSourceId, searchQuery]);

  // Batch-fetch SQL results for all Recharts charts on the current page in
  // ONE request. The server creates a single shared sandbox and runs each
  // chart's SQL sequentially, returning a results map. This replaces the old
  // N-fetches-per-page pattern (one per card) and reduces sandbox creation
  // from N to 1 — a 10-30x latency win for a full page of 8 charts.
  //
  // We only batch charts that actually need a fetch: Recharts charts with
  // stored SQL. Plotly charts render from their stored figure, and charts
  // without SQL can't be refreshed. Errors per-chart are stored as null so
  // the ChartViewer falls back to its own fetch + error UI.
  //
  // IMPORTANT: do NOT depend on `pageCharts` directly — it's a new array
  // reference on every render (created via .slice), which would turn this
  // effect into an infinite setState loop. Depend on a stable string
  // signature of the eligible chart IDs instead.
  const eligibleIds = useMemo(
    () =>
      pageCharts
        .filter((c) => c.renderer === "recharts" && c.sql_text)
        .map((c) => c.id),
    [pageCharts],
  );
  const eligibleSignature = eligibleIds.join(",");
  useEffect(() => {
    if (eligibleIds.length === 0) {
      setBatchData({});
      return;
    }
    const ids = eligibleIds;
    let cancelled = false;
    // Mark all eligible charts as "loading" (null) so ChartViewers show
    // their loading spinner immediately rather than flashing old data.
    setBatchData((prev) => {
      const next: Record<string, ChartRefreshData | null> = {};
      for (const id of ids) next[id] = prev[id] ?? null;
      return next;
    });
    fetch("/api/charts/refresh-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chartIds: ids }),
    })
      .then((res) => res.json())
      .then((data: { results?: Record<string, unknown> }) => {
        if (cancelled) return;
        const results = data.results ?? {};
        const next: Record<string, ChartRefreshData | null> = {};
        for (const id of ids) {
          const entry = results[id];
          // Only successful entries have `columns` — errors become null so
          // ChartViewer falls back to its own fetch and surfaces the error.
          if (entry && typeof entry === "object" && "columns" in entry) {
            next[id] = entry as ChartRefreshData;
          } else {
            next[id] = null;
          }
        }
        setBatchData(next);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[library-grid] batch refresh failed:", err);
        // On hard failure, set all to null so ChartViewers fall back to
        // their own per-chart fetch.
        const next: Record<string, ChartRefreshData | null> = {};
        for (const id of ids) next[id] = null;
        setBatchData(next);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibleSignature]);

  if (charts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16 text-center">
        <LayoutGrid className="mb-3 h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {t("emptyStateTitle")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("emptyStateDescription")}
        </p>
        <Button asChild variant="outline" className="mt-4">
          <Link href="/chat/new">{t("emptyStateCta")}</Link>
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
                  ? t("expandFilterTitle")
                  : t("collapseFilterTitle")
              }
              title={
                filterCollapsed
                  ? activeSourceId
                    ? t("filterActiveExpandTitle")
                    : t("expandFilterTitle")
                  : t("collapseFilterTitle")
              }
            >
              {filterCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <>
                  <span>{t("filterByDataSource")}</span>
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
                  <span>{t("allChartsOption")}</span>
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
                      title={`${typeLabel(ds.type)}: ${ds.name}`}
                    >
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Database className="h-3 w-3 shrink-0" />
                        <span className="truncate">{ds.name}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className="rounded border border-border bg-background/60 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                          {typeShort(ds.type)}
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

      {/* Right: chart grid (filtered + paginated) */}
      <div className="min-w-0 flex-1">
        {/* Toolbar: search button in the top-right. Clicking it expands the
            button into a text input for filtering charts by title. */}
        <div className="mb-4 flex items-center justify-end">
          {searchOpen ? (
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                type="text"
                placeholder={t("searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 pl-9 pr-9"
              />
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  setSearchOpen(false);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={t("closeSearchTitle")}
                title={t("closeSearchTitle")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="icon"
              onClick={() => setSearchOpen(true)}
              aria-label={t("searchChartsAriaLabel")}
              title={t("searchByTitleTitle")}
            >
              <Search className="h-4 w-4" />
            </Button>
          )}
        </div>

        {filteredCharts.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {searchQuery.trim()
                ? t("noMatchSearch")
                : t("noMatchDataSource")}
            </p>
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => {
                setActiveSourceId(null);
                setSearchQuery("");
              }}
            >
              {t("showAllCharts")}
            </Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-2">
              {pageCharts.map((chart) => {
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
                          initialData={batchData[chart.id] ?? undefined}
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
                          aria-label={t("deleteChartAriaLabel")}
                          title={t("deleteTitle")}
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
                            title={`${typeLabel(ds.type)}: ${ds.name}`}
                          >
                            {ds.name}
                          </span>
                        ))}
                      </div>

                      <p className="mt-auto font-mono text-[10px] text-muted-foreground" suppressHydrationWarning>
                        {t("updatedLabel")} {format.dateTime(new Date(chart.updated_at), { dateStyle: "medium" })}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>

            {/* Pagination — only shown when there's more than one page. */}
            {totalPages > 1 && (
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {t("paginationRange", {
                    start: startIndex + 1,
                    end: Math.min(startIndex + PAGE_SIZE, filteredCharts.length),
                    total: filteredCharts.length,
                  })}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    {t("paginationPrevious")}
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {t("paginationPageOf", { page: safePage, totalPages })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setCurrentPage((p) => Math.min(totalPages, p + 1))
                    }
                    disabled={safePage >= totalPages}
                  >
                    {t("paginationNext")}
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
