"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Maximize2, X } from "lucide-react";

/**
 * Plotly chart renderer (Phase 2 §2.3)
 *
 * Renders a Plotly figure JSON ({ data, layout, config }) using react-plotly.js.
 * The plotly.js library is ~3MB, so it is dynamically imported with ssr:false
 * to keep it out of the server bundle and the initial client payload.
 *
 * Used by ArtifactRenderer when a chart artifact has `renderer === "plotly"`
 * and a `plotlyFigure` payload. Recharts remains the default renderer for
 * simple chart types (bar/line/area/pie/scatter).
 *
 * Features:
 *   - Scrollable container: large charts scroll within the card instead of
 *     overflowing the chat column.
 *   - Generous top margin: prevents the title and legend from overlapping.
 *   - Fullscreen toggle: a button in the top-right opens the chart in a
 *     fixed full-viewport overlay for detailed inspection.
 */

// Dynamically import react-plotly.js. The loading fallback shows a brief
// "Loading chart…" message while the chunk is fetched.
const Plot = dynamic(() => import("react-plotly.js"), {
  ssr: false,
  loading: () => (
    <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
      Loading chart…
    </div>
  ),
});

interface PlotlyRendererProps {
  /** Plotly figure JSON: { data: [...], layout: {...}, config?: {...} } */
  figure: Record<string, unknown>;
  title?: string;
}

/** Default chart height inside the chat card. */
const CHART_HEIGHT = 420;
/**
 * Plotly needs an explicit width to draw the plot area correctly. We size the
 * inline chart to the artifact card and let the inner SVG auto-fit via
 * `autosize: true`. Wrapping the chart in an `overflow-auto` scroll container
 * used to cause Plotly to size the drawing area to a tiny initial measurement,
 * squeezing the entire chart to the left of the card. The fix is to give Plot
 * an explicit `width: "100%"` and a fixed `height`, and let the card itself
 * handle any overflow if the data is unusually wide (rare for typical data
 * analysis charts).
 */
const TOP_MARGIN_WITH_TITLE = 80;
const TOP_MARGIN_NO_TITLE = 30;

export function PlotlyRenderer({ figure, title }: PlotlyRendererProps) {
  const [hasMounted, setHasMounted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Ref to the inline Plot wrapper div. Plotly renders the graph DOM inside
  // this element, so we pass it to Plotly.downloadImage for PNG export.
  const inlineGraphRef = useRef<HTMLDivElement>(null);
  // Ref to the actual Plotly graph DOM element.
  const plotlyDivRef = useRef<any>(null);

  // Guard against SSR rendering of the dynamic component (defensive — the
  // dynamic import already sets ssr:false, but this ensures the Plot component
  // never renders during hydration).
  useEffect(() => {
    setHasMounted(true);
  }, []);

  // Close fullscreen on Escape key
  useEffect(() => {
    if (!isFullscreen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setIsFullscreen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    // Lock body scroll while fullscreen is open
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isFullscreen]);

  if (!hasMounted) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Loading chart…
      </div>
    );
  }

  /** Download the inline chart as a PNG via Plotly.downloadImage. */
  async function handleDownload() {
    if (!plotlyDivRef.current) return;
    const Plotly = (await import("plotly.js-dist-min")).default;
    const filename = (title ?? "chart").replace(/[^\w-]+/g, "_") || "chart";
    try {
      await Plotly.downloadImage(plotlyDivRef.current, {
        format: "png",
        filename,
        width: inlineGraphRef.current?.clientWidth ?? plotlyDivRef.current.clientWidth ?? 800,
        height: CHART_HEIGHT,
        scale: 2,
      });
    } catch (err) {
      console.error("[plotly] downloadImage failed:", err);
    }
  }

  const data = (figure.data ?? []) as unknown[];
  const layoutFromFigure = (figure.layout ?? {}) as Record<string, unknown>;

  // Build the layout for the inline (card) view. We increase the top margin
  // when a title is present so the title and the legend don't overlap.
  // We do NOT spread the figure's own height/width — we want the chart to
  // fill the card width (via CSS `width: 100%`) and use the fixed height
  // we set. Setting `autosize: true` plus an explicit width:undefined used
  // to confuse Plotly's measurement and squeeze the drawing area.
  const buildLayout = (height: number, fullscreen: boolean) => {
    const tMargin = title ? TOP_MARGIN_WITH_TITLE : TOP_MARGIN_NO_TITLE;
    const userMargin = (layoutFromFigure.margin as Record<string, number>) ?? {};
    return {
      ...layoutFromFigure,
      height: fullscreen ? undefined : height,
      autosize: true,
      margin: {
        l: 60,
        r: 30,
        b: 60,
        ...userMargin,
        // Apply our top margin last so it's not overridden by userMargin
        t: tMargin,
      },
      font: { size: 11, ...((layoutFromFigure.font as Record<string, unknown>) ?? {}) },
      // Move legend below the chart to avoid overlap with the title
      legend: fullscreen
        ? (layoutFromFigure.legend as Record<string, unknown>) ?? {
            orientation: "h",
            y: -0.2,
          }
        : {
            orientation: "h" as const,
            y: -0.15,
            ...((layoutFromFigure.legend as Record<string, unknown>) ?? {}),
          },
    };
  };

  const inlineLayout = buildLayout(CHART_HEIGHT, false);
  const fullscreenLayout = buildLayout(0, true);

  return (
    <>
      {/* Inline view: the Plot component owns its own width via autosize. We
          place it inside a `w-full` wrapper so it always measures against the
          artifact card width. A vertical cap (max-h + overflow-auto) keeps
          very tall charts from dominating the chat without squeezing the
          drawing area to the left. */}
      <div className="relative">
        {/* Action buttons: Download PNG + Fullscreen */}
        <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/80 text-muted-foreground backdrop-blur-sm transition-colors hover:bg-background hover:text-foreground"
            aria-label="Download chart as PNG"
            title="Download PNG"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setIsFullscreen(true)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/80 text-muted-foreground backdrop-blur-sm transition-colors hover:bg-background hover:text-foreground"
            aria-label="Open chart in fullscreen"
            title="Fullscreen"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>

        {title && (
          <p className="mb-3 pr-20 font-display text-sm font-medium tracking-tight text-foreground">
            {title}
          </p>
        )}

        {/* Width-giving wrapper. Plotly's autosize reads the offsetWidth of
            this element; `w-full` ensures it matches the artifact card. The
            ref is used by handleDownload to call Plotly.downloadImage. */}
        <div
          ref={inlineGraphRef}
          className="w-full overflow-hidden rounded-md border border-border bg-background/40"
        >
          <Plot
            data={data}
            layout={inlineLayout}
            config={{ responsive: true, displayModeBar: false }}
            style={{ width: "100%", height: CHART_HEIGHT }}
            useResizeHandler
            onInitialized={(figure, graphDiv) => {
              plotlyDivRef.current = graphDiv;
            }}
            onUpdate={(figure, graphDiv) => {
              plotlyDivRef.current = graphDiv;
            }}
          />
        </div>
      </div>

      {/* Fullscreen overlay — rendered via portal to document.body so it
          escapes any ancestor `transform` (e.g. the artifact card's
          animate-fade-up animation, whose `both` fill mode leaves a
          residual `transform: translateY(0)` that creates a containing
          block and traps `fixed` children inside the card). */}
      {isFullscreen && typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm">
            {/* Overlay header */}
            <div className="flex items-center justify-between border-b border-border px-6 py-3">
              <p className="font-display text-sm font-medium tracking-tight text-foreground">
                {title ?? "Chart"}
              </p>
              <button
                type="button"
                onClick={() => setIsFullscreen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Close fullscreen"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Chart area: fills remaining viewport, scrollable if needed */}
            <div className="flex-1 overflow-auto p-6">
              <div className="mx-auto h-full w-full max-w-6xl">
                <Plot
                  data={data}
                  layout={fullscreenLayout}
                  config={{
                    responsive: true,
                    displayModeBar: true,
                    scrollZoom: true,
                  }}
                  style={{ width: "100%", height: "100%" }}
                  useResizeHandler
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
