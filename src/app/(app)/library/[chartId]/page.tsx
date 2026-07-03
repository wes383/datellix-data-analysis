import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  ChartDetailClient,
  type ChartDetailData,
} from "@/components/library/chart-detail-client";

interface PageProps {
  params: Promise<{ chartId: string }>;
}

/**
 * Chart library detail page.
 *
 * Loads a single saved chart and its bound data sources, then hands off to
 * the client component for rendering + inline editing (title / description /
 * SQL). Recharts charts re-query their data source on view; Plotly charts
 * render from their stored figure.
 */
export default async function ChartDetailPage({ params }: PageProps) {
  const { chartId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    notFound();
  }

  const { data: chart } = await supabase
    .from("charts")
    .select(
      "id, title, description, spec, sql_text, renderer, source_session_id, created_at, updated_at",
    )
    .eq("id", chartId)
    .eq("user_id", user!.id)
    .single();

  if (!chart) {
    notFound();
  }

  // Load bound data sources (id / name / type) for the read-only list.
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

  const detail: ChartDetailData = {
    id: chart.id,
    title: chart.title,
    description: (chart.description as string | null) ?? null,
    spec: chart.spec as Record<string, unknown>,
    sql_text: (chart.sql_text as string | null) ?? null,
    renderer: (chart.renderer as "recharts" | "plotly") ?? "recharts",
    source_session_id: (chart.source_session_id as string | null) ?? null,
    created_at: chart.created_at,
    updated_at: chart.updated_at,
    data_sources: dataSources,
  };

  return <ChartDetailClient chart={detail} />;
}
