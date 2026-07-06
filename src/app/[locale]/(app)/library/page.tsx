import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { isLocale, type Locale } from "@/i18n/routing";
import { createClient } from "@/lib/supabase/server";
import {
  LibraryGrid,
  type LibraryChartRow,
  type LibraryDataSourceOption,
} from "@/components/library/library-grid";
import { SidebarAwareContainer } from "@/components/library/sidebar-aware-container";

interface PageProps {
  params: Promise<{ locale: string }>;
}

/**
 * Chart library list page.
 *
 * Lists all charts the current user has saved from chat sessions. Each chart
 * is shown as a card with a mini preview (Recharts lazy-loads data via
 * /api/charts/[id]/refresh; Plotly renders from its stored figure).
 *
 * A left sidebar lists every data source the user owns — clicking one
 * filters the grid to charts bound to that source.
 */
export default async function LibraryPage({ params }: PageProps) {
  const { locale } = await params;
  if (isLocale(locale)) {
    setRequestLocale(locale as Locale);
  }
  const t = await getTranslations("Library");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { data: charts } = await supabase
    .from("charts")
    .select(
      "id, title, description, spec, sql_text, renderer, source_session_id, created_at, updated_at",
    )
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  const chartList = charts ?? [];

  // Batch-load bound data source names for all charts in one query.
  const chartIds = chartList.map((c) => c.id);
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

  const rows: LibraryChartRow[] = chartList.map((chart) => ({
    id: chart.id,
    title: chart.title,
    description: chart.description,
    spec: chart.spec as Record<string, unknown>,
    sql_text: chart.sql_text as string | null,
    renderer: (chart.renderer as "recharts" | "plotly") ?? "recharts",
    source_session_id: (chart.source_session_id as string | null) ?? null,
    created_at: chart.created_at,
    updated_at: chart.updated_at,
    data_sources: bindings[chart.id] ?? [],
  }));

  // Load all data sources owned by the user — used to populate the left
  // sidebar's filter list. Only those that have at least one bound chart
  // are shown (a data source with no charts isn't useful as a filter).
  const boundSourceIds = new Set(
    rows.flatMap((c) => c.data_sources.map((ds) => ds.id)),
  );
  const { data: allSources } = await supabase
    .from("data_sources")
    .select("id, type, name")
    .eq("user_id", user.id)
    .order("name", { ascending: true });
  const dataSources: LibraryDataSourceOption[] = (allSources ?? [])
    .filter((s) => boundSourceIds.has(s.id))
    .map((s) => ({
      id: s.id as string,
      name: s.name as string,
      type: s.type as string,
    }));

  return (
    <div className="h-screen overflow-y-auto bg-background">
      <SidebarAwareContainer className="py-10">
        <div className="mb-8">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            {t("pageTitle")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("pageDescription")}
          </p>
        </div>

        <LibraryGrid charts={rows} dataSources={dataSources} />
      </SidebarAwareContainer>
    </div>
  );
}
