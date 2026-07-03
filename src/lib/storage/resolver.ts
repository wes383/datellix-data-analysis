import { createAdminClient } from "@/lib/supabase/admin";
import { decryptConfig } from "@/lib/db/crypto";
import { uploadFile, deleteFile, blobPath } from "@/lib/blob/client";
import { s3Upload, s3Download, s3Delete } from "@/lib/storage/s3-client";
import { normalizeLlmConfig, type LlmConfig, type StorageConfig } from "@/lib/db/schema";

/**
 * Storage resolver: routes file operations between Vercel Blob and S3
 * based on the user's storage configuration (user_settings) and the
 * storage backend recorded in data_sources.meta at upload time.
 *
 * Resolution rules:
 *   - Upload: use the user's current storage config (or env default if null).
 *   - Download: use the backend recorded in meta (storageBackend field),
 *     with the user's current credentials for that backend.
 *   - Legacy data sources (no storageBackend in meta): treated as vercel-blob
 *     with the env token (fully backward compatible).
 */

// Per-request cache to avoid repeated DB+decrypt calls within a single
// serverless invocation. Cleared automatically when the function exits.
const storageConfigCache = new Map<string, StorageConfig | null>();
const llmConfigCache = new Map<string, LlmConfig | null>();

/** Load the user's storage config from user_settings (null = use project default). */
export async function loadUserStorageConfig(
  userId: string,
): Promise<StorageConfig | null> {
  if (storageConfigCache.has(userId)) {
    return storageConfigCache.get(userId)!;
  }
  const admin = createAdminClient();
  const { data } = await admin
    .from("user_settings")
    .select("storage_config_encrypted")
    .eq("user_id", userId)
    .single();

  let config: StorageConfig | null = null;
  if (data?.storage_config_encrypted) {
    config = await decryptConfig<StorageConfig>(data.storage_config_encrypted);
  }
  storageConfigCache.set(userId, config);
  return config;
}

/** Load the user's LLM config from user_settings (null = use project default).
 *  Old configs with `model: string` are normalized to `models: [model]`. */
export async function loadUserLlmConfig(
  userId: string,
): Promise<LlmConfig | null> {
  if (llmConfigCache.has(userId)) {
    return llmConfigCache.get(userId)!;
  }
  const admin = createAdminClient();
  const { data } = await admin
    .from("user_settings")
    .select("llm_config_encrypted")
    .eq("user_id", userId)
    .single();

  let config: LlmConfig | null = null;
  if (data?.llm_config_encrypted) {
    const raw = await decryptConfig<LlmConfig>(data.llm_config_encrypted);
    config = normalizeLlmConfig(raw);
  }
  llmConfigCache.set(userId, config);
  return config;
}

export interface StorageUploadResult {
  storageBackend: "vercel-blob" | "s3";
  blobUrl?: string;
  s3Key?: string;
  s3Bucket?: string;
  blobPath: string;
}

/**
 * Upload a file using the user's storage config (or env default if null).
 *   - User has S3 config → upload to S3
 *   - No user config (null) → upload to Vercel Blob using env token
 *
 * Returns the storage metadata to record in data_sources.meta.
 */
export async function uploadStorageFile(
  userId: string,
  sessionId: string,
  filename: string,
  file: Blob | File | ArrayBuffer,
): Promise<StorageUploadResult> {
  const path = blobPath(userId, sessionId, filename);
  const userConfig = await loadUserStorageConfig(userId);

  if (userConfig?.backend === "s3") {
    const buffer =
      file instanceof ArrayBuffer
        ? Buffer.from(file)
        : Buffer.from(await (file as Blob).arrayBuffer());
    const key = await s3Upload(userConfig, path, buffer);
    return {
      storageBackend: "s3",
      s3Key: key,
      s3Bucket: userConfig.bucket,
      blobPath: path,
    };
  }

  // No user config → env default Vercel Blob
  const blobUrl = await uploadFile(path, file);
  return {
    storageBackend: "vercel-blob",
    blobUrl,
    blobPath: path,
  };
}

/**
 * Download a file for sandbox staging.
 * Routes based on meta.storageBackend:
 *   - "s3": use user's S3 config + meta.s3Key
 *   - null / "vercel-blob": fetch meta.blobUrl with Bearer token
 *     (user's custom blob token if set, else env token)
 *
 * Replaces the old downloadFileForSandbox() in tools.ts.
 */
export async function downloadStorageFile(
  meta: Record<string, unknown>,
  userId: string,
  filename: string,
): Promise<{ buffer: Buffer; remotePath: string }> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const remotePath = `/tmp/data/${safeName}`;
  const backend = (meta.storageBackend as string) ?? "vercel-blob";

  if (backend === "s3") {
    const s3Key = meta.s3Key as string;
    const userConfig = await loadUserStorageConfig(userId);
    if (!userConfig || userConfig.backend !== "s3") {
      throw new Error(
        "File was uploaded with S3 but user no longer has an S3 storage config",
      );
    }
    const buffer = await s3Download(userConfig, s3Key);
    return { buffer, remotePath };
  }

  // vercel-blob (env default): fetch with env Bearer token
  const blobUrl = meta.blobUrl as string;
  if (!blobUrl) {
    throw new Error("data source meta is missing blobUrl for vercel-blob download");
  }
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;

  const fileResp = await fetch(blobUrl, {
    headers: blobToken ? { Authorization: `Bearer ${blobToken}` } : undefined,
  });
  if (!fileResp.ok) {
    throw new Error(`Failed to download file from Blob: ${fileResp.status}`);
  }
  const buffer = Buffer.from(await fileResp.arrayBuffer());
  return { buffer, remotePath };
}

/**
 * Delete a file from the appropriate storage backend.
 * Best-effort: errors are caught by the caller.
 */
export async function deleteStorageFile(
  meta: Record<string, unknown>,
  userId: string,
): Promise<void> {
  const backend = (meta.storageBackend as string) ?? "vercel-blob";

  if (backend === "s3") {
    const s3Key = meta.s3Key as string;
    const userConfig = await loadUserStorageConfig(userId);
    if (!userConfig || userConfig.backend !== "s3") {
      // User removed S3 config — can't delete, skip silently
      return;
    }
    await s3Delete(userConfig, s3Key);
    return;
  }

  // vercel-blob (env default): delete with env token
  const blobUrl = meta.blobUrl as string;
  if (!blobUrl) return;
  await deleteFile(blobUrl);
}
