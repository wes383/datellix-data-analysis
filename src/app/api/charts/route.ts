import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/charts — list current user's saved charts with bound data source names.
 * POST /api/charts — create a new chart (saved from chat or created in library).
 *
 * Body for POST:
 *   { title, description?, spec, sql_text?, renderer, data_source_ids: string[], source_session_id? }
 */

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Load charts with bound data source names via chart_data_sources join
  const { data: charts, error } = await supabase
    .from("charts")
    .select(
      "id, title, description, spec, sql_text, renderer, source_session_id, created_at, updated_at",
    )
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: `Failed to load charts: ${error.message}` },
      { status: 500 },
    );
  }

  // Load data source bindings for all charts in one query
  const chartIds = (charts ?? []).map((c) => c.id);
  let bindings: Record<string, { id: string; name: string; type: string }[]> = {};
  if (chartIds.length > 0) {
    const { data: links } = await supabase
      .from("chart_data_sources")
      .select("chart_id, data_source_id, data_sources(id, name, type)")
      .in("chart_id", chartIds);

    if (links) {
      for (const link of links) {
        const cid = link.chart_id as string;
        if (!bindings[cid]) bindings[cid] = [];
        // data_sources comes back as an array from supabase-js for this join shape
        const dsRaw = link.data_sources as unknown;
        const ds = Array.isArray(dsRaw) ? dsRaw[0] : dsRaw;
        if (ds && typeof ds === "object" && "id" in ds) {
          bindings[cid].push({
            id: (ds as { id: string }).id,
            name: (ds as { name: string }).name,
            type: (ds as { type: string }).type,
          });
        }
      }
    }
  }

  const result = (charts ?? []).map((chart) => ({
    ...chart,
    data_sources: bindings[chart.id] ?? [],
  }));

  return NextResponse.json({ charts: result });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { title, description, spec, sql_text, renderer, data_source_ids, source_session_id } = body;

  if (!title || !spec || !renderer || !Array.isArray(data_source_ids) || data_source_ids.length === 0) {
    return NextResponse.json(
      { error: "Missing required fields: title, spec, renderer, data_source_ids" },
      { status: 400 },
    );
  }

  // Insert chart
  const { data: chart, error: chartError } = await supabase
    .from("charts")
    .insert({
      user_id: user.id,
      title,
      description: description ?? null,
      spec,
      sql_text: sql_text ?? null,
      renderer,
      source_session_id: source_session_id ?? null,
    })
    .select("id, title, description, spec, sql_text, renderer, source_session_id, created_at, updated_at")
    .single();

  if (chartError || !chart) {
    return NextResponse.json(
      { error: `Failed to create chart: ${chartError?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  // Insert data source bindings
  const bindingRows = data_source_ids.map((dsId: string) => ({
    chart_id: chart.id,
    data_source_id: dsId,
  }));
  const { error: bindingError } = await supabase
    .from("chart_data_sources")
    .insert(bindingRows);

  if (bindingError) {
    // Chart was created but bindings failed — return partial success
    return NextResponse.json(
      { chart, warning: `Chart created but data source binding failed: ${bindingError.message}` },
      { status: 201 },
    );
  }

  return NextResponse.json({ chart }, { status: 201 });
}
