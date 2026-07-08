import { redirect } from "next/navigation";
import { Link } from "@/i18n/navigation";
import { setRequestLocale } from "next-intl/server";
import { getTranslations } from "next-intl/server";
import { isLocale, type Locale } from "@/i18n/routing";
import { createClient } from "@/lib/supabase/server";
import { decryptConfig } from "@/lib/db/crypto";
import { SettingsForm } from "@/components/settings/settings-form";
import { DeleteAccountButton } from "@/components/settings/delete-account-button";
import { LanguageSwitcher } from "@/components/sidebar/language-switcher";
import { ThemeSelector } from "@/components/theme/theme-selector";
import { normalizeLlmConfig, type LlmConfig, type StorageConfig } from "@/lib/db/schema";
import { signOut } from "@/app/actions/sessions";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PageProps {
  params: Promise<{ locale: string }>;
}

/**
 * Settings page — lets the user configure their own LLM provider and file
 * storage backend, or use the project defaults (env-based).
 *
 * Secrets are masked (`••••${last4}`) before being sent to the client. On
 * save, masked values are preserved by the server action.
 */
export default async function SettingsPage({ params }: PageProps) {
  const { locale } = await params;
  if (isLocale(locale)) {
    setRequestLocale(locale as Locale);
  }
  const t = await getTranslations("Settings");
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
            {t("pageTitle")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("pageDescription")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("pageDisclaimer")}
          </p>
        </div>

        <SettingsForm
          initialLlmConfig={llmConfig}
          initialStorageConfig={storageConfig}
        />

        {/* Appearance — choose light/dark/system theme. Persisted via
            localStorage and applied before first paint (no flash). */}
        <div className="mt-6 rounded-lg border border-border p-4">
          <h2 className="font-display text-sm font-medium tracking-tight">
            {t("themeTitle")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("themeDescription")}
          </p>
          <div className="mt-3">
            <ThemeSelector />
          </div>
        </div>

        {/* Language — choose the UI language. Persisted via NEXT_LOCALE cookie. */}
        <div className="mt-6 rounded-lg border border-border p-4">
          <h2 className="font-display text-sm font-medium tracking-tight">
            {t("languageTitle")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("languageDescription")}
          </p>
          <div className="mt-3 max-w-sm">
            <LanguageSwitcher />
          </div>
        </div>

        {/* Account / session — Sign out moved here from the app sidebar. */}
        <div className="mt-6 rounded-lg border border-border p-4">
          <h2 className="font-display text-sm font-medium tracking-tight">
            {t("sectionAccount")}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {user.email
              ? t("signedInAs", { email: user.email })
              : t("signedInAsFallback")}
          </p>
          <form action={signOut} className="mt-3">
            <Button type="submit" variant="outline" size="sm">
              <LogOut className="h-3.5 w-3.5" />
              {t("signOut")}
            </Button>
          </form>

          {/* Danger zone — irreversible account deletion */}
          <div className="mt-4 border-t border-border pt-4">
            <DeleteAccountButton />
          </div>
        </div>

        {/* Legal — Terms & Privacy */}
        <div className="mt-6 flex items-center justify-center gap-4 text-xs text-muted-foreground">
          <Link
            href="/legal/terms"
            className="transition-colors hover:text-foreground"
          >
            {t("termsOfServiceLink")}
          </Link>
          <Link
            href="/legal/privacy"
            className="transition-colors hover:text-foreground"
          >
            {t("privacyPolicyLink")}
          </Link>
        </div>
      </div>
    </div>
  );
}
