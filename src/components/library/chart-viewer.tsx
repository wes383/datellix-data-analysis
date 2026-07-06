"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { RechartsRenderer } from "@/components/charts/recharts-renderer";
import { PlotlyRenderer } from "@/components/charts/plotly-renderer";
import type { ChartPayload } from "@/lib/agent/state";
import { buildChartData, type ChartRefreshData } from "@/lib/chart/data";
import { Button } from "@/components/ui/button";

interface ChartViewerProps {
  chartId: string;
  spec: Record<string, unknown>;
  renderer: "recharts" | "plotly";
  sqlText: string | null;
  /** Whether to auto-load data on mount (default: true). Set false for
   *  Plotly charts that already have the figure in spec. */
  autoLoad?: boolean;
  /** Compact mode for library card preview (smaller height, hides Plotly
   *  inline controls since the page chrome owns the download button). */
  compact?: boolean;
  /** Hide the Plotly inline download/fullscreen controls. Defaults to the
   *  value of `compact` (cards always hide them). The detail page sets this
   *  explicitly so Plotly charts don't show a redundant toolbar — the page
   *  already provides its own Download button. */
  hideControls?: boolean;
  /** Delay (ms) before auto-loading data on mount. Used by the library grid
   *  to stagger chart loads so 8 cards mounting at once don't fire 8
   *  simultaneous fetches + Recharts renders, which blocks the main thread
   *  and makes sidebar navigation unresponsive until all charts finish.
   *  Ignored when `initialData` is provided. */
  loadDelay?: number;
  /** Pre-fetched SQL results for this chart. When provided, the viewer
   *  skips its on-mount fetch entirely and renders from this data — used by
   *  the library grid which batch-fetches all visible charts in one request
   *  via `/api/charts/refresh-batch` (one shared sandbox). When null, the
   *  viewer auto-fetches its own data on mount. */
  initialData?: ChartRefreshData | null;
}

/** Unified preview height (px) for library cards — used by both Recharts
 *  and Plotly so the two renderers produce visually consistent card sizes. */
const COMPACT_HEIGHT = 280;

/**
 * Renders a chart from the library.
 *
 * Recharts: lazy-loads data by re-executing the chart's SQL via
 * /api/charts/[id]/refresh. Plotly: renders directly from the stored figure.
 * If the Plotly chart's spec contains `pythonCode`, a manual Refresh button
 * is shown — clicking it re-runs the SQL + Python in the sandbox to
 * regenerate the figure with the latest data from the bound data source.
 */
export function ChartViewer({
  chartId,
  spec,
  renderer,
  sqlText,
  autoLoad = true,
  compact = false,
  hideControls,
  loadDelay = 0,
  initialData = null,
}: ChartViewerProps) {
  const t = useTranslations("Library");
  const tc = useTranslations("Common");
  // hideControls defaults to compact (cards always hide inline controls).
  const shouldHideControls = hideControls ?? compact;
  // When the parent passes pre-fetched data, skip the loading state and
  // seed the chart immediately — no fetch on mount.
  const hasInitialData = !!initialData;
  const [loading, setLoading] = useState(
    !hasInitialData && autoLoad && renderer === "recharts" && !!sqlText,
  );
  const [error, setError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<Record<string, unknown>[] | null>(
    renderer === "recharts"
      ? hasInitialData
        ? buildChartData(initialData!.columns, initialData!.rows)
        : null
      : (spec.plotlyFigure ? null : []),
  );
  const chartContainerRef = useRef<HTMLDivElement>(null);

  // ---- Plotly refresh state ----
  // When the chart's spec contains pythonCode, the user can manually refresh
  // the figure (re-run SQL + Python in sandbox) to pick up data source changes.
  const [plotlyFigure, setPlotlyFigure] = useState<Record<string, unknown> | undefined>(
    renderer === "plotly"
      ? (spec.plotlyFigure as Record<string, unknown> | undefined)
      : undefined,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const canRefreshPlotly =
    renderer === "plotly" &&
    !!spec.pythonCode &&
    !!sqlText;

  async function loadRechartsData() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/charts/${chartId}/refresh`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error((err as { error?: string }).error || tc("failedStatus", { status: res.status }));
      }
      const data = (await res.json()) as ChartRefreshData;
      setChartData(buildChartData(data.columns, data.rows));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  async function refreshPlotly() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch(`/api/charts/${chartId}/refresh`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error((err as { error?: string }).error || tc("failedStatus", { status: res.status }));
      }
      const data = await res.json();
      const figure = (data.plotlyFigure as Record<string, unknown>) ?? undefined;
      setPlotlyFigure(figure);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    // Skip fetch entirely when the parent already passed pre-fetched data
    // (the library grid batch-fetches all visible charts in one request).
    if (hasInitialData) return;
    if (!autoLoad || renderer !== "recharts" || !sqlText) return;
    // Stagger initial loads so multiple charts mounting at once (e.g. the
    // library grid's 8 cards on a page without batch fetch) don't fire all
    // fetches + Recharts renders in the same tick, which would block the
    // main thread and make sidebar navigation unresponsive.
    if (loadDelay > 0) {
      const timer = setTimeout(() => loadRechartsData(), loadDelay);
      return () => clearTimeout(timer);
    }
    loadRechartsData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartId]);

  // ---- Plotly render ----
  if (renderer === "plotly") {
    const title = spec.title as string | undefined;
    if (!plotlyFigure) {
      return <p className="text-sm text-muted-foreground">{t("plotlyFigureNotFound")}</p>;
    }
    return (
      <div className={compact ? "h-[280px]" : ""}>
        <PlotlyRenderer
          figure={plotlyFigure}
          title={title}
          height={compact ? COMPACT_HEIGHT : undefined}
          hideControls={shouldHideControls}
        />
        {!compact && canRefreshPlotly && (
          <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
            <Button
              variant="outline"
              size="sm"
              onClick={refreshPlotly}
              disabled={refreshing}
            >
              {refreshing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {tc("refreshing")}
                </>
              ) : (
                <>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("buttonRefreshFromDataSource")}
                </>
              )}
            </Button>
            <p className="font-mono text-[10px] text-muted-foreground">
              {t("hintRefreshDescription")}
            </p>
            {refreshError && (
              <p className="ml-auto max-w-xs break-words font-mono text-[10px] text-destructive">
                {refreshError}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  // ---- Recharts render ----
  const chartPayload = spec as unknown as ChartPayload;
  const rechartsHeight = compact ? COMPACT_HEIGHT : undefined;

  if (loading) {
    return (
      <div className={`flex items-center justify-center ${compact ? "h-[280px]" : "h-64"}`}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={`flex flex-col items-center justify-center gap-2 ${compact ? "h-[280px]" : "h-64"}`}>
        <p className="text-sm text-muted-foreground">{tc("dataUnavailable")}</p>
        {!compact && (
          <>
            <p className="max-w-md break-words font-mono text-[10px] text-muted-foreground/70">
              {error}
            </p>
            <Button variant="outline" size="sm" onClick={loadRechartsData} className="mt-2">
              <RefreshCw className="h-3 w-3" />
              {tc("retry")}
            </Button>
          </>
        )}
      </div>
    );
  }

  if (!chartData || chartData.length === 0) {
    return (
      <div className={`flex items-center justify-center ${compact ? "h-[280px]" : "h-64"}`}>
        <p className="text-sm text-muted-foreground">{t("noDataToDisplay")}</p>
      </div>
    );
  }

  return (
    <div ref={chartContainerRef}>
      <RechartsRenderer
        spec={{
          ...chartPayload,
          data: chartData,
        }}
        height={rechartsHeight}
      />
    </div>
  );
}
