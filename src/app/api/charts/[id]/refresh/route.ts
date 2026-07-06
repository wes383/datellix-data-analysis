import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { executeSqlForChart } from "@/lib/agent/sql-executor";
import { runPython } from "@/lib/daytona/client";
import { logUsage } from "@/lib/usage";
import type { ChartPayload } from "@/lib/agent/state";

/**
 * POST /api/charts/[id]/refresh — re-execute the chart's query against its
 * bound data sources and return fresh results.
 *
 * Two modes:
 *   - Recharts (renderer === "recharts"): re-execute SQL, return
 *     { columns, rows, rowCount, truncated } so the client can rebuild
 *     chart data objects.
 *   - Plotly (renderer === "plotly"): re-execute SQL to get fresh data,
 *     then re-run the stored Python code in the sandbox to regenerate the
 *     Plotly figure. Returns { plotlyFigure } (the new figure JSON). The
 *     stored spec is also updated with the new figure so it persists.
 *     Requires the chart's spec to contain `pythonCode` (charts saved before
 *     this feature won't have it and get a 400).
 */

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id: chartId } = await params;

  // Verify ownership and load chart spec (needed for Plotly pythonCode)
  const { data: chart, error: chartError } = await supabase
    .from("charts")
    .select("id, sql_text, renderer, user_id, spec")
    .eq("id", chartId)
    .single();

  if (chartError || !chart) {
    return NextResponse.json({ error: "Chart not found" }, { status: 404 });
  }

  if (chart.user_id !== user.id) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  if (!chart.sql_text) {
    return NextResponse.json(
      { error: "This chart has no SQL to refresh" },
      { status: 400 },
    );
  }

  // ---- Plotly: re-run SQL + Python, return new figure ----
  if (chart.renderer === "plotly") {
    const spec = (chart.spec ?? {}) as ChartPayload;
    if (!spec.pythonCode) {
      return NextResponse.json(
        {
          error:
            "This Plotly chart was saved without Python code and cannot be refreshed. Re-generate it from a chat to enable refresh.",
        },
        { status: 400 },
      );
    }

    try {
      // 1. Re-execute SQL to get fresh data
      const results = await executeSqlForChart(chartId, chart.sql_text, user.id);

      // 2. Re-run Python with the fresh data to regenerate the figure
      const dataJson = JSON.stringify({
        columns: results.columns,
        rows: results.rows,
      });
      const wrappedCode = `
import pandas as pd, json, sys
_parsed = json.loads(${JSON.stringify(dataJson)})
df = pd.DataFrame(_parsed["rows"], columns=_parsed["columns"])

${spec.pythonCode}

if 'fig' not in dir():
    print(json.dumps({"error": "Code must assign a plotly figure to variable 'fig'"}))
    sys.exit(1)

figure_json = fig.to_json()
print(figure_json)
`.trim();

      const sandboxId = `chart-${chartId}`;
      const pyResult = await runPython(sandboxId, wrappedCode, {
        onUsage: async (seconds) => {
          await logUsage({
            userId: user.id,
            sessionId: sandboxId,
            sandboxSeconds: seconds,
            source: "daytona",
          });
        },
      });

      if (pyResult.exitCode !== 0) {
        return NextResponse.json(
          {
            error: `Plotly refresh failed: ${pyResult.stderr || pyResult.stdout}`,
          },
          { status: 500 },
        );
      }

      let figure: Record<string, unknown>;
      try {
        figure = JSON.parse(pyResult.stdout) as Record<string, unknown>;
      } catch {
        return NextResponse.json(
          {
            error: `Plotly figure JSON parse failed. Output: ${pyResult.stdout.slice(0, 500)}`,
          },
          { status: 500 },
        );
      }

      if (figure.error) {
        return NextResponse.json(
          { error: `Plotly error: ${figure.error}` },
          { status: 500 },
        );
      }

      // 3. Persist the new figure to the chart's spec so it survives
      //    page refreshes (Plotly renders from spec on load).
      const updatedSpec: ChartPayload = { ...spec, plotlyFigure: figure };
      await supabase
        .from("charts")
        .update({ spec: updatedSpec as unknown as Record<string, unknown> })
        .eq("id", chartId);

      return NextResponse.json({ plotlyFigure: figure });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[charts/refresh] Plotly chart ${chartId} failed:`, err);
      return NextResponse.json(
        { error: `Failed to refresh Plotly chart: ${msg}` },
        { status: 500 },
      );
    }
  }

  // ---- Recharts: re-execute SQL, return columns + rows ----
  try {
    const results = await executeSqlForChart(chartId, chart.sql_text, user.id);
    return NextResponse.json({
      columns: results.columns,
      rows: results.rows,
      rowCount: results.rowCount,
      truncated: results.truncated,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[charts/refresh] Recharts chart ${chartId} failed:`, err);
    return NextResponse.json(
      { error: `Failed to refresh chart data: ${msg}` },
      { status: 500 },
    );
  }
}
