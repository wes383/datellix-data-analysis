"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { RechartsRenderer } from "@/components/charts/recharts-renderer";
import { PlotlyRenderer } from "@/components/charts/plotly-renderer";
import type { ChartPayload } from "@/lib/agent/state";
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
}: ChartViewerProps) {
  // hideControls defaults to compact (cards always hide inline controls).
  const shouldHideControls = hideControls ?? compact;
  const [loading, setLoading] = useState(autoLoad && renderer === "recharts" && !!sqlText);
  const [error, setError] = useState<string | null>(null);
  const [chartData, setChartData] = useState<Record<string, unknown>[] | null>(
    renderer === "recharts" ? null : (spec.plotlyFigure ? null : []),
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
        throw new Error((err as { error?: string }).error || `Failed: ${res.status}`);
      }
      const data = await res.json();
      // Build chart data array from columns + rows (same as buildChartPayload)
      const chartPayload = spec as unknown as ChartPayload;
      const rows = (data.rows as unknown[][]).slice(0, 100);
      const built = rows.map((row) => {
        const obj: Record<string, unknown> = {};
        (data.columns as string[]).forEach((col, idx) => {
          const val = row[idx];
          if (typeof val === "string" && val !== "" && !isNaN(Number(val))) {
            obj[col] = Number(val);
          } else {
            obj[col] = val;
          }
        });
        return obj;
      });
      setChartData(built);
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
        throw new Error((err as { error?: string }).error || `Failed: ${res.status}`);
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
    if (autoLoad && renderer === "recharts" && sqlText) {
      loadRechartsData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartId]);

  // ---- Plotly render ----
  if (renderer === "plotly") {
    const title = spec.title as string | undefined;
    if (!plotlyFigure) {
      return <p className="text-sm text-muted-foreground">Plotly figure not found</p>;
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
                  Refreshing…
                </>
              ) : (
                <>
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh from data source
                </>
              )}
            </Button>
            <p className="font-mono text-[10px] text-muted-foreground">
              Re-runs SQL + Python to regenerate the figure with the latest data.
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
        <p className="text-sm text-muted-foreground">Data unavailable</p>
        {!compact && (
          <>
            <p className="max-w-md break-words font-mono text-[10px] text-muted-foreground/70">
              {error}
            </p>
            <Button variant="outline" size="sm" onClick={loadRechartsData} className="mt-2">
              <RefreshCw className="h-3 w-3" />
              Retry
            </Button>
          </>
        )}
      </div>
    );
  }

  if (!chartData || chartData.length === 0) {
    return (
      <div className={`flex items-center justify-center ${compact ? "h-[280px]" : "h-64"}`}>
        <p className="text-sm text-muted-foreground">No data to display</p>
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
