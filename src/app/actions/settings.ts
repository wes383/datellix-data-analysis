"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptConfig, decryptConfig } from "@/lib/db/crypto";
import { normalizeLlmConfig, type LlmConfig, type StorageConfig } from "@/lib/db/schema";

/**
 * Save only the LLM provider configuration.
 *
 * Form fields:
 *   llmMode:     "default" | "custom"
 *   llmProvider: "openai" | "anthropic" | "glm" | "openai-compat"
 *   llmApiKey:   API key (may be masked)
 *   llmBaseURL:  base URL (openai-compat only)
 *   llmModels:   JSON-encoded string[] of model names
 *
 * When llmMode === "default", the encrypted column is set to NULL, which
 * signals "use project default" to downstream code.
 *
 * API key masking: when the settings page loads, secrets are masked as
 * `••••${last4}`. If the user saves without changing the field, the masked
 * value is submitted back. We detect the `••••` prefix and preserve the
 * existing decrypted value instead of overwriting with the mask.
 */
export async function saveLlmSettings(
  _prevState: { ok: boolean; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const admin = createAdminClient();

  // Load existing LLM config (for masked-secret preservation)
  const { data: existing } = await admin
    .from("user_settings")
    .select("llm_config_encrypted")
    .eq("user_id", user.id)
    .single();

  const existingLlm = existing?.llm_config_encrypted
    ? normalizeLlmConfig(await decryptConfig<LlmConfig>(existing.llm_config_encrypted))
    : null;

  const llmMode = formData.get("llmMode") as string;
  let llmConfig: LlmConfig | null = null;

  if (llmMode === "custom") {
    const provider = formData.get("llmProvider") as string;
    let apiKey = (formData.get("llmApiKey") as string) ?? "";
    const baseURL = (formData.get("llmBaseURL") as string) ?? "";

    // Parse models array from JSON string
    const modelsRaw = (formData.get("llmModels") as string) ?? "[]";
    let models: string[] = [];
    try {
      const parsed = JSON.parse(modelsRaw);
      if (Array.isArray(parsed)) {
        models = parsed.filter((m) => typeof m === "string" && m.trim() !== "").map((m) => m.trim());
      }
    } catch {
      return { ok: false, error: "Invalid models format" };
    }
    if (models.length === 0) {
      return { ok: false, error: "At least one model is required" };
    }

    // Preserve masked API key
    if (apiKey.startsWith("\u2022\u2022\u2022\u2022") && existingLlm) {
      apiKey = existingLlm.apiKey;
    }

    llmConfig = {
      provider: provider as LlmConfig["provider"],
      apiKey,
      models,
      ...(baseURL && { baseURL }),
    };
  }

  const llmEncrypted = llmConfig ? await encryptConfig(llmConfig) : null;

  // Only touch the llm_config_encrypted column; leave storage untouched.
  const { error } = await admin
    .from("user_settings")
    .upsert(
      {
        user_id: user.id,
        llm_config_encrypted: llmEncrypted,
      },
      { onConflict: "user_id" },
    );

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/settings");
  revalidatePath("/chat");
  return { ok: true };
}

/**
 * Save only the file storage configuration (S3-compatible only).
 *
 * Form fields:
 *   storageMode:        "default" | "custom"
 *   s3Endpoint:         S3 endpoint (optional, for MinIO/R2)
 *   s3Region:           S3 region
 *   s3AccessKeyId:      S3 access key ID
 *   s3SecretAccessKey:  S3 secret (may be masked)
 *   s3Bucket:           S3 bucket name
 *
 * When storageMode === "default", the encrypted column is set to NULL,
 * signaling "use project default" (env-based Vercel Blob).
 *
 * Same masked-secret preservation logic as saveLlmSettings.
 */
export async function saveStorageSettings(
  _prevState: { ok: boolean; error?: string } | null,
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const admin = createAdminClient();

  // Load existing storage config (for masked-secret preservation)
  const { data: existing } = await admin
    .from("user_settings")
    .select("storage_config_encrypted")
    .eq("user_id", user.id)
    .single();

  const existingStorage = existing?.storage_config_encrypted
    ? await decryptConfig<StorageConfig>(existing.storage_config_encrypted)
    : null;

  const storageMode = formData.get("storageMode") as string;
  let storageConfig: StorageConfig | null = null;

  if (storageMode === "custom") {
    const endpoint = (formData.get("s3Endpoint") as string) ?? "";
    const region = (formData.get("s3Region") as string) ?? "";
    const accessKeyId = (formData.get("s3AccessKeyId") as string) ?? "";
    let secretAccessKey = (formData.get("s3SecretAccessKey") as string) ?? "";
    const bucket = (formData.get("s3Bucket") as string) ?? "";

    if (secretAccessKey.startsWith("\u2022\u2022\u2022\u2022") && existingStorage?.secretAccessKey) {
      secretAccessKey = existingStorage.secretAccessKey;
    }

    storageConfig = {
      backend: "s3",
      accessKeyId,
      secretAccessKey,
      bucket,
      ...(endpoint && { endpoint }),
      ...(region && { region }),
    };
  }

  const storageEncrypted = storageConfig ? await encryptConfig(storageConfig) : null;

  // Only touch the storage_config_encrypted column; leave LLM untouched.
  const { error } = await admin
    .from("user_settings")
    .upsert(
      {
        user_id: user.id,
        storage_config_encrypted: storageEncrypted,
      },
      { onConflict: "user_id" },
    );

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath("/settings");
  return { ok: true };
}
