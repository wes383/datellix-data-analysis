import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * PATCH /api/charts/[id]/data-sources — replace the chart's data source
 * bindings. Body: { data_source_ids: string[] }
 *
 * Removes all existing bindings and inserts the new set.
 */

export async function PATCH(
  req: NextRequest,
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
  const body = await req.json();
  const { data_source_ids } = body;

  if (!Array.isArray(data_source_ids) || data_source_ids.length === 0) {
    return NextResponse.json(
      { error: "data_source_ids must be a non-empty array" },
      { status: 400 },
    );
  }

  // Verify chart ownership
  const { data: chart } = await supabase
    .from("charts")
    .select("id")
    .eq("id", chartId)
    .eq("user_id", user.id)
    .single();

  if (!chart) {
    return NextResponse.json({ error: "Chart not found" }, { status: 404 });
  }

  // Remove existing bindings
  await supabase
    .from("chart_data_sources")
    .delete()
    .eq("chart_id", chartId);

  // Insert new bindings
  const bindingRows = data_source_ids.map((dsId: string) => ({
    chart_id: chartId,
    data_source_id: dsId,
  }));
  const { error: bindingError } = await supabase
    .from("chart_data_sources")
    .insert(bindingRows);

  if (bindingError) {
    return NextResponse.json(
      { error: `Failed to update data source bindings: ${bindingError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
