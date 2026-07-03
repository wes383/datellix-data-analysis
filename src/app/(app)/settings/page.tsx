import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { decryptConfig } from "@/lib/db/crypto";
import { SettingsForm } from "@/components/settings/settings-form";
import { normalizeLlmConfig, type LlmConfig, type StorageConfig } from "@/lib/db/schema";

/**
 * Settings page — lets the user configure their own LLM provider and file
 * storage backend, or use the project defaults (env-based).
 *
 * Secrets are masked (`••••${last4}`) before being sent to the client. On
 * save, masked values are preserved by the server action.
 */
export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { data: settings } = await supabase
    .from("user_settings")
    .select("llm_config_encrypted, storage_config_encrypted")
    .eq("user_id", user.id)
    .single();

  let llmConfig: LlmConfig | null = null;
  if (settings?.llm_config_encrypted) {
    const raw = await decryptConfig<LlmConfig>(settings.llm_config_encrypted);
    llmConfig = normalizeLlmConfig(raw);
    // Mask the API key — only the last 4 chars are visible
    if (llmConfig.apiKey && llmConfig.apiKey.length > 4) {
      llmConfig.apiKey = `\u2022\u2022\u2022\u2022${llmConfig.apiKey.slice(-4)}`;
    }
  }

  let storageConfig: StorageConfig | null = null;
  if (settings?.storage_config_encrypted) {
    storageConfig = await decryptConfig<StorageConfig>(settings.storage_config_encrypted);
    if (storageConfig.secretAccessKey && storageConfig.secretAccessKey.length > 4) {
      storageConfig.secretAccessKey = `\u2022\u2022\u2022\u2022${storageConfig.secretAccessKey.slice(-4)}`;
    }
  }

  return (
    <div className="h-screen overflow-y-auto bg-background">
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-8">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure your own LLM provider and file storage, or use the project defaults. Credentials are encrypted at rest (pgcrypto AES-256).
          </p>
        </div>

        <SettingsForm
          initialLlmConfig={llmConfig}
          initialStorageConfig={storageConfig}
        />
      </div>
    </div>
  );
}
