import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * GET /api/sources/[id]/charts
 *
 * Returns the count and titles of charts in the chart library that are
 * bound to this data source (via the `chart_data_sources` join table).
 * Used by the sources list to warn the user before deleting a data source
 * that has bound charts.
 *
 * Returns: { count: number, charts: { id: string, title: string }[] }
 */
export async function GET(
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

  const { id: dataSourceId } = await params;

  // Verify the user owns the data source.
  const { data: ds } = await supabase
    .from("data_sources")
    .select("id")
    .eq("id", dataSourceId)
    .eq("user_id", user.id)
    .single();
  if (!ds) {
    return NextResponse.json(
      { error: "Data source not found or access denied" },
      { status: 404 },
    );
  }

  // Find charts bound to this data source via the join table, joining the
  // charts table to get titles. RLS on chart_data_sources is derived via
  // chart ownership, so only the user's own charts are visible.
  const { data: links, error } = await supabase
    .from("chart_data_sources")
    .select("chart_id, charts(id, title)")
    .eq("data_source_id", dataSourceId);

  if (error) {
    return NextResponse.json(
      { error: `Failed to fetch bound charts: ${error.message}` },
      { status: 500 },
    );
  }

  const charts = (links ?? [])
    .map((link) => {
      const chartRaw = link.charts as unknown;
      const chart = Array.isArray(chartRaw) ? chartRaw[0] : chartRaw;
      if (!chart || typeof chart !== "object" || !("id" in chart)) return null;
      return {
        id: (chart as { id: string }).id,
        title: (chart as { title: string }).title,
      };
    })
    .filter(
      (c): c is { id: string; title: string } => c !== null,
    );

  return NextResponse.json({ count: charts.length, charts });
}
