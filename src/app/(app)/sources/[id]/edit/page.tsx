import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  SourceForm,
  type SourceInitialValues,
} from "@/components/sources/source-form";

/**
 * Edit data source page (Phase 3 §3.2).
 *
 * Loads the source metadata (excluding config_encrypted) server-side and
 * passes it to the shared <SourceForm> in edit mode. Password/credentials
 * fields are blank by default; leaving them blank preserves the existing
 * ciphertext (handled by PATCH /api/sources/[id]).
 */
export default async function EditSourcePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { id } = await params;

  const { data: source } = await supabase
    .from("data_sources")
    .select("id, type, name, meta")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (!source) {
    redirect("/sources");
  }

  const initialValues: SourceInitialValues = {
    id: source.id,
    type: source.type as SourceInitialValues["type"],
    name: source.name,
    meta: (source.meta ?? {}) as Record<string, unknown>,
  };

  return (
    <SourceForm
      mode="edit"
      initialValues={initialValues}
      doneHref="/sources"
      cancelHref="/sources"
    />
  );
}
