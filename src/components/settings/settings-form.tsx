"use client";

import { useState, useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Plug, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { saveLlmSettings, saveStorageSettings } from "@/app/actions/settings";
import type { LlmConfig, StorageConfig } from "@/lib/db/schema";

interface SettingsFormProps {
  initialLlmConfig: LlmConfig | null;
  initialStorageConfig: StorageConfig | null;
}

/** Maps a provider key to its translation message key. */
const PROVIDER_LABEL_KEYS: Record<LlmConfig["provider"], string> = {
  openai: "providerOpenai",
  anthropic: "providerAnthropic",
  glm: "providerGlm",
  "openai-compat": "providerOpenaiCompatible",
};

export function SettingsForm({
  initialLlmConfig,
  initialStorageConfig,
}: SettingsFormProps) {
  return (
    <div className="space-y-6">
      <LlmSettingItem initialConfig={initialLlmConfig} />
      <StorageSettingItem initialConfig={initialStorageConfig} />
    </div>
  );
}

/* ============================================================
    Submit button (uses form status to show pending state)
    ============================================================ */
function SubmitButton() {
  const { pending } = useFormStatus();
  const t = useTranslations("Settings");
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {t("buttonSave")}
    </Button>
  );
}

/* ============================================================
    Mode toggle — "Use default" / "Custom" button group
    ============================================================ */
function ModeToggle({
  mode,
  onChange,
}: {
  mode: "default" | "custom";
  onChange: (mode: "default" | "custom") => void;
}) {
  const t = useTranslations("Settings");
  return (
    <div className="inline-flex rounded-lg border border-border p-0.5">
      <button
        type="button"
        onClick={() => onChange("default")}
        className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
          mode === "default"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        {t("useDefault")}
      </button>
      <button
        type="button"
        onClick={() => onChange("custom")}
        className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
          mode === "custom"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
      >
        {t("custom")}
      </button>
    </div>
  );
}

/* ============================================================
    Modal wrapper — overlay + panel with header and close button
    ============================================================ */
function EditModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations("Settings");
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div
        className="relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t("closeAriaLabel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/* ============================================================
    Summary row — shows config summary + Edit button
    ============================================================ */
function SummaryRow({
  summary,
  onEdit,
}: {
  summary: string;
  onEdit: () => void;
}) {
  const t = useTranslations("Settings");
  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 px-4 py-2.5">
      <span className="text-sm text-muted-foreground">{summary}</span>
      <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
        <Pencil className="h-3.5 w-3.5" />
        {t("buttonEdit")}
      </Button>
    </div>
  );
}

/* ============================================================
    Model tag input — add/remove model names for one API config
    ============================================================ */
function ModelTagInput({
  models,
  onChange,
}: {
  models: string[];
  onChange: (models: string[]) => void;
}) {
  const t = useTranslations("Settings");
  const [draft, setDraft] = useState("");

  function addModel() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (models.includes(trimmed)) {
      setDraft("");
      return;
    }
    onChange([...models, trimmed]);
    setDraft("");
  }

  function removeModel(idx: number) {
    onChange(models.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-2">
      <Label>{t("labelModels")}</Label>
      <p className="text-xs text-muted-foreground">
        {t("hintModels")}
      </p>
      <div className="flex gap-2">
        <Input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addModel();
            }
          }}
          placeholder={t("placeholderModelName")}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addModel}
          disabled={!draft.trim()}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("buttonAdd")}
        </Button>
      </div>
      {models.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {models.map((m, idx) => (
            <span
              key={`${m}-${idx}`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium"
            >
              <span className="font-mono">{m}</span>
              {idx === 0 && (
                <span className="text-[10px] text-muted-foreground">{t("defaultBadge")}</span>
              )}
              <button
                type="button"
                onClick={() => removeModel(idx)}
                className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={t("removeModelAriaLabel", { model: m })}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
    LLM Setting Item
    ============================================================ */
function LlmSettingItem({ initialConfig }: { initialConfig: LlmConfig | null }) {
  const t = useTranslations("Settings");
  const [open, setOpen] = useState(false);
  const [saveState, formAction] = useActionState(saveLlmSettings, null);

  // Form state — synced from initialConfig when modal opens
  const [mode, setMode] = useState<"default" | "custom">("default");
  const [provider, setProvider] = useState<LlmConfig["provider"]>("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);

  function providerLabel(p: LlmConfig["provider"]): string {
    return t(PROVIDER_LABEL_KEYS[p]);
  }

  // Sync form state from initialConfig when modal opens
  useEffect(() => {
    if (open) {
      setMode(initialConfig ? "custom" : "default");
      setProvider(initialConfig?.provider ?? "openai");
      setApiKey(initialConfig?.apiKey ?? "");
      setBaseURL(initialConfig?.baseURL ?? "");
      setModels(initialConfig?.models ?? []);
    }
  }, [open, initialConfig]);

  // Close modal on save success
  useEffect(() => {
    if (!saveState) return;
    if (saveState.ok) {
      toast.success(t("toastLlmSaved"));
      setOpen(false);
    } else if (saveState.error) {
      toast.error(t("toastSaveFailed", { error: saveState.error }));
    }
  }, [saveState, t]);

  const summary = initialConfig
    ? (initialConfig.models && initialConfig.models.length > 0
        ? t("summaryLlm", { provider: providerLabel(initialConfig.provider), models: initialConfig.models.join(", ") })
        : t("summaryLlmNoModels", { provider: providerLabel(initialConfig.provider) }))
    : t("usingDefault");

  async function handleTest() {
    if (!apiKey || models.length === 0) {
      toast.error(t("errApiKeyAndModelRequired"));
      return;
    }
    setTesting(true);
    try {
      const resp = await fetch("/api/settings/test-llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey,
          // Test with the first (default) model
          model: models[0],
          ...(baseURL && { baseURL }),
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        toast.success(t("toastLlmTestSuccess"));
      } else {
        toast.error(t("toastLlmTestFailed", { error: data.error ?? "" }));
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? t("toastLlmTestFailed", { error: err.message })
          : t("toastLlmTestFailedNetwork"),
      );
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("cardLlmProvider")}</CardTitle>
        <CardDescription>
          {t("cardLlmProviderDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SummaryRow summary={summary} onEdit={() => setOpen(true)} />

        {open && (
          <EditModal title={t("dialogEditLlmProvider")} onClose={() => setOpen(false)}>
            <form action={formAction} className="space-y-4">
              <input type="hidden" name="llmMode" value={mode} />
              <input type="hidden" name="llmProvider" value={provider} />
              <input type="hidden" name="llmModels" value={JSON.stringify(models)} />

              <ModeToggle mode={mode} onChange={setMode} />

              {mode === "custom" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="llmProviderSelect">{t("labelProvider")}</Label>
                    <Select
                      id="llmProviderSelect"
                      value={provider}
                      onChange={(v) => setProvider(v as LlmConfig["provider"])}
                      options={[
                        { value: "openai", label: t("optionOpenai") },
                        { value: "anthropic", label: t("optionAnthropic") },
                        { value: "glm", label: t("optionGlmZhipu") },
                        { value: "openai-compat", label: t("optionOpenaiCompatible") },
                      ]}
                    />
                  </div>

                  {provider === "openai-compat" && (
                    <div className="space-y-2">
                      <Label htmlFor="llmBaseURL">{t("labelBaseUrl")}</Label>
                      <Input
                        id="llmBaseURL"
                        name="llmBaseURL"
                        type="url"
                        placeholder={t("placeholderBaseUrl")}
                        value={baseURL}
                        onChange={(e) => setBaseURL(e.target.value)}
                      />
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="llmApiKey">{t("labelApiKey")}</Label>
                    <Input
                      id="llmApiKey"
                      name="llmApiKey"
                      type="password"
                      placeholder={t("placeholderApiKey")}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                  </div>

                  <ModelTagInput models={models} onChange={setModels} />
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={testing || mode !== "custom"}
                >
                  {testing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plug className="h-3.5 w-3.5" />
                  )}
                  {t("buttonTestConnection")}
                </Button>
                <SubmitButton />
              </div>
            </form>
          </EditModal>
        )}
      </CardContent>
    </Card>
  );
}

/* ============================================================
    Storage Setting Item
    ============================================================ */
function StorageSettingItem({ initialConfig }: { initialConfig: StorageConfig | null }) {
  const t = useTranslations("Settings");
  const [open, setOpen] = useState(false);
  const [saveState, formAction] = useActionState(saveStorageSettings, null);

  // Form state — synced from initialConfig when modal opens
  const [mode, setMode] = useState<"default" | "custom">("default");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [bucket, setBucket] = useState("");
  const [testing, setTesting] = useState(false);

  // Sync form state from initialConfig when modal opens
  useEffect(() => {
    if (open) {
      setMode(initialConfig ? "custom" : "default");
      setEndpoint(initialConfig?.endpoint ?? "");
      setRegion(initialConfig?.region ?? "");
      setAccessKeyId(initialConfig?.accessKeyId ?? "");
      setSecretAccessKey(initialConfig?.secretAccessKey ?? "");
      setBucket(initialConfig?.bucket ?? "");
    }
  }, [open, initialConfig]);

  // Close modal on save success
  useEffect(() => {
    if (!saveState) return;
    if (saveState.ok) {
      toast.success(t("toastStorageSaved"));
      setOpen(false);
    } else if (saveState.error) {
      toast.error(t("toastSaveFailed", { error: saveState.error }));
    }
  }, [saveState, t]);

  const summary = initialConfig
    ? t("summaryStorage", { bucket: initialConfig.bucket ?? "" })
    : t("usingDefault");

  async function handleTest() {
    if (!accessKeyId || !secretAccessKey || !bucket) {
      toast.error(t("errStorageFieldsRequired"));
      return;
    }
    setTesting(true);
    try {
      const resp = await fetch("/api/settings/test-storage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint,
          region,
          accessKeyId,
          secretAccessKey,
          bucket,
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        toast.success(t("toastStorageTestSuccess"));
      } else {
        toast.error(t("toastStorageTestFailed", { error: data.error ?? "" }));
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? t("toastStorageTestFailed", { error: err.message })
          : t("toastStorageTestFailedNetwork"),
      );
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("cardFileStorage")}</CardTitle>
        <CardDescription>
          {t("cardFileStorageDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SummaryRow summary={summary} onEdit={() => setOpen(true)} />

        {open && (
          <EditModal title={t("dialogEditFileStorage")} onClose={() => setOpen(false)}>
            <form action={formAction} className="space-y-4">
              <input type="hidden" name="storageMode" value={mode} />

              <ModeToggle mode={mode} onChange={setMode} />

              {mode === "custom" && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="s3Endpoint">{t("labelEndpoint")}</Label>
                    <Input
                      id="s3Endpoint"
                      name="s3Endpoint"
                      type="url"
                      placeholder={t("placeholderEndpoint")}
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t("hintEndpoint")}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="s3Region">{t("labelRegion")}</Label>
                    <Input
                      id="s3Region"
                      name="s3Region"
                      placeholder={t("placeholderRegion")}
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="s3AccessKeyId">{t("labelAccessKeyId")}</Label>
                    <Input
                      id="s3AccessKeyId"
                      name="s3AccessKeyId"
                      value={accessKeyId}
                      onChange={(e) => setAccessKeyId(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="s3SecretAccessKey">{t("labelSecretAccessKey")}</Label>
                    <Input
                      id="s3SecretAccessKey"
                      name="s3SecretAccessKey"
                      type="password"
                      value={secretAccessKey}
                      onChange={(e) => setSecretAccessKey(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="s3Bucket">{t("labelBucket")}</Label>
                    <Input
                      id="s3Bucket"
                      name="s3Bucket"
                      placeholder={t("placeholderBucket")}
                      value={bucket}
                      onChange={(e) => setBucket(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={testing || mode !== "custom"}
                >
                  {testing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plug className="h-3.5 w-3.5" />
                  )}
                  {t("buttonTestConnection")}
                </Button>
                <SubmitButton />
              </div>
            </form>
          </EditModal>
        )}
      </CardContent>
    </Card>
  );
}
