import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/charts/[id] — get a single chart with bound data source info.
 * PATCH /api/charts/[id] — update title, description, spec, sql_text.
 * DELETE /api/charts/[id] — delete chart (cascades to chart_data_sources).
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

  const { id: chartId } = await params;

  const { data: chart, error } = await supabase
    .from("charts")
    .select("id, title, description, spec, sql_text, renderer, source_session_id, created_at, updated_at")
    .eq("id", chartId)
    .eq("user_id", user.id)
    .single();

  if (error || !chart) {
    return NextResponse.json({ error: "Chart not found" }, { status: 404 });
  }

  // Load bound data sources
  const { data: links } = await supabase
    .from("chart_data_sources")
    .select("data_source_id, data_sources(id, name, type)")
    .eq("chart_id", chartId);

  const dataSources = (links ?? [])
    .map((link) => {
      const dsRaw = link.data_sources as unknown;
      const ds = Array.isArray(dsRaw) ? dsRaw[0] : dsRaw;
      if (!ds || typeof ds !== "object" || !("id" in ds)) return null;
      return {
        id: (ds as { id: string }).id,
        name: (ds as { name: string }).name,
        type: (ds as { type: string }).type,
      };
    })
    .filter((ds): ds is { id: string; name: string; type: string } => ds !== null);

  return NextResponse.json({ chart: { ...chart, data_sources: dataSources } });
}

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

  // Only allow updating these fields
  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) updates.title = body.title;
  if (body.description !== undefined) updates.description = body.description;
  if (body.spec !== undefined) updates.spec = body.spec;
  if (body.sql_text !== undefined) updates.sql_text = body.sql_text;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const { data: chart, error } = await supabase
    .from("charts")
    .update(updates)
    .eq("id", chartId)
    .eq("user_id", user.id)
    .select("id, title, description, spec, sql_text, renderer, source_session_id, created_at, updated_at")
    .single();

  if (error || !chart) {
    return NextResponse.json(
      { error: `Failed to update chart: ${error?.message ?? "not found"}` },
      { status: error ? 500 : 404 },
    );
  }

  return NextResponse.json({ chart });
}

export async function DELETE(
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

  const { error } = await supabase
    .from("charts")
    .delete()
    .eq("id", chartId)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json(
      { error: `Failed to delete chart: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
