import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { SourcesList } from "@/components/sources/sources-list";

/**
 * Data source management page (Phase 3 §3.2).
 *
 * Lists all data sources owned by the current user. Each row shows the
 * name, type, and created timestamp, with Edit and Delete actions.
 * `config_encrypted` is never selected — secrets stay server-side.
 */
export default async function SourcesPage() {
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
              Data sources
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage your database connections and uploaded files.
            </p>
          </div>
          <Button asChild>
            <Link href="/sources/new">
              <Plus className="h-4 w-4" />
              New data source
            </Link>
          </Button>
        </div>

        <SourcesList sources={sources ?? []} />
      </div>
    </div>
  );
}
