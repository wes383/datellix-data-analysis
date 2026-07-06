import { setRequestLocale } from "next-intl/server";
import { isLocale, type Locale } from "@/i18n/routing";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptConfig } from "@/lib/db/crypto";
import { Chat } from "@/components/chat/chat";
import { normalizeLlmConfig, type LlmConfig } from "@/lib/db/schema";

interface PageProps {
  params: Promise<{ locale: string }>;
}

/**
 * Pending new-session page.
 *
 * Visited when the user clicks "New session" but hasn't sent the first
 * message yet — no `sessions` row is created until the first message is
 * submitted (see Chat.tsx). This keeps the sidebar free of empty
 * "New analysis session" entries.
 */
export default async function NewSessionPage({ params }: PageProps) {
  const { locale } = await params;
  if (isLocale(locale)) {
    setRequestLocale(locale as Locale);
  }
  // Pre-fetch the user's existing data sources for the
  // "Add data source" dialog's "Use existing" tab. Both DB types
  // and file types can be bound. If the user is not logged in
  // (shouldn't happen due to middleware), this returns empty.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: userSources } = user
    ? await supabase
        .from("data_sources")
        .select("id, type, name, meta")
        .eq("user_id", user.id)
        .in("type", ["pg", "mysql", "bigquery", "file"])
        .order("updated_at", { ascending: false })
    : { data: null };

  // Load available models for the model switcher (same as the session page).
  let availableModels: string[] = [];
  if (user) {
    const admin = createAdminClient();
    const { data: settingsRow } = await admin
      .from("user_settings")
      .select("llm_config_encrypted")
      .eq("user_id", user.id)
      .single();
    if (settingsRow?.llm_config_encrypted) {
      const cfg = normalizeLlmConfig(
        await decryptConfig<LlmConfig>(settingsRow.llm_config_encrypted),
      );
      availableModels = cfg.models ?? [];
    }
  }

  return (
    <Chat
      sessionId="new"
      initialMessages={[]}
      initialArtifacts={[]}
      dataSource={null}
      existingSources={
        (userSources ?? []) as unknown as {
          id: string;
          type: string;
          name: string;
          meta: Record<string, unknown>;
        }[]
      }
      availableModels={availableModels}
    />
  );
}
