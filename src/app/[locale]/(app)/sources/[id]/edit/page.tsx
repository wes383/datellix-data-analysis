import { redirect } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { isLocale, type Locale } from "@/i18n/routing";
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
 *
 * Accepts an optional `?from=<path>` search param so callers (e.g. the chart
 * detail page) can control where the user lands after saving or cancelling.
 * Falls back to /sources when the param is absent.
 */
export default async function EditSourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { locale, id } = await params;
  if (isLocale(locale)) {
    setRequestLocale(locale as Locale);
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { from } = await searchParams;
  // Only allow relative paths (starting with /) to prevent open redirect.
  const returnUrl = from && from.startsWith("/") ? from : "/sources";

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
      doneHref={returnUrl}
      cancelHref={returnUrl}
    />
  );
}
