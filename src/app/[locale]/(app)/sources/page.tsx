import { Link } from "@/i18n/navigation";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { isLocale, type Locale } from "@/i18n/routing";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { SourcesList } from "@/components/sources/sources-list";

interface PageProps {
  params: Promise<{ locale: string }>;
}

/**
 * Data source management page (Phase 3 §3.2).
 *
 * Lists all data sources owned by the current user. Each row shows the
 * name, type, and created timestamp, with Edit and Delete actions.
 * `config_encrypted` is never selected — secrets stay server-side.
 */
export default async function SourcesPage({ params }: PageProps) {
  const { locale } = await params;
  if (isLocale(locale)) {
    setRequestLocale(locale as Locale);
  }
  const t = await getTranslations("Sources");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { data: sources } = await supabase
    .from("data_sources")
    .select("id, type, name, meta, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  return (
    <div className="h-screen overflow-y-auto bg-background">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              {t("pageTitle")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("pageDescription")}
            </p>
          </div>
          <Button asChild>
            <Link href="/sources/new">
              <Plus className="h-4 w-4" />
              {t("newDataSource")}
            </Link>
          </Button>
        </div>

        <SourcesList sources={sources ?? []} />
      </div>
    </div>
  );
}
