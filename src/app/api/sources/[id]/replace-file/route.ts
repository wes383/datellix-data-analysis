import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptConfig, decryptConfig } from "@/lib/db/crypto";
import { fileHash } from "@/lib/blob/client";
import {
  uploadStorageFile,
  deleteStorageFile,
} from "@/lib/storage/resolver";
import type {
  FileConfig,
  DuckdbFileConfig,
  SqliteFileConfig,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/sources/[id]/replace-file
 *
 * Replace the underlying file of a file-type data source (file, duckdb, sqlite)
 * without changing the data source ID. Charts bound to this data source will
 * automatically use the new file on next re-query.
 *
 * Request: multipart/form-data with a `file` field.
 *
 * Steps:
 *   1. Authenticate user; verify ownership via RLS-aware client.
 *   2. Reject non-file types (pg/mysql/bigquery are not file-based).
 *   3. Read the uploaded file from the FormData.
 *   4. Compute SHA-256 hash of the new file (recorded in meta.fileHash).
 *   5. Upload the new file to storage (Vercel Blob or S3 per user config).
 *   6. Decrypt the old config to locate the old file.
 *   7. Delete the old file from storage (best-effort).
 *   8. Encrypt the new config.
 *   9. Update the data_sources row with the new config_encrypted and refreshed
 *      meta (filename, size, fileHash, blobUrl/s3Key, blobPath, storageBackend).
 *  10. Return the updated data source.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "Not authenticated" },
      { status: 401 },
    );
  }

  const { id: dataSourceId } = await params;

  // Fetch the existing row via the user-aware client (RLS) to verify
  // ownership. We don't trust the client to pass a valid id.
  const { data: existing, error: fetchErr } = await supabase
    .from("data_sources")
    .select("id, type, name, config_encrypted, meta")
    .eq("id", dataSourceId)
    .eq("user_id", user.id)
    .single();
  if (fetchErr || !existing) {
    return NextResponse.json(
      { error: "Data source not found or access denied" },
      { status: 404 },
    );
  }

  // Only file-type data sources support file replacement.
  if (
    existing.type !== "file" &&
    existing.type !== "duckdb" &&
    existing.type !== "sqlite"
  ) {
    return NextResponse.json(
      { error: "Only file-type data sources support file replacement" },
      { status: 400 },
    );
  }

  // Parse multipart form.
  const formData = await _req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json(
      { error: "Missing required field: file" },
      { status: 400 },
    );
  }

  // Compute content hash for the new file (for dedup tracking).
  const hash = await fileHash(file);

  // Determine a sessionId for the blob path. The blob path convention is
  // uploads/{userId}/{sessionId}/{filename}. We try to reuse the existing
  // sessionId from the old meta.blobPath to keep paths stable; if not
  // available (e.g. legacy sources without blobPath), fall back to the
  // data source id so we still get a unique, namespaced path.
  const oldMeta = (existing.meta ?? {}) as Record<string, unknown>;
  const oldBlobPath =
    typeof oldMeta.blobPath === "string" ? oldMeta.blobPath : "";
  const pathSegments = oldBlobPath.split("/");
  // Expected format: ["uploads", userId, sessionId, filename]
  const sessionIdFromPath =
    pathSegments.length >= 4 && pathSegments[0] === "uploads"
      ? pathSegments[2]
      : null;
  const sessionIdForUpload = sessionIdFromPath ?? dataSourceId;

  // Upload the new file to the user's configured storage backend.
  const storageInfo = await uploadStorageFile(
    user.id,
    sessionIdForUpload,
    file.name,
    file,
  );

  // Decrypt the old config (best-effort — used to locate the old file for
  // deletion, but we delete via oldMeta so the decryption is informational).
  try {
    if (existing.type === "file") {
      await decryptConfig<FileConfig>(existing.config_encrypted);
    } else if (existing.type === "duckdb") {
      await decryptConfig<DuckdbFileConfig>(existing.config_encrypted);
    } else {
      await decryptConfig<SqliteFileConfig>(existing.config_encrypted);
    }
  } catch (err) {
    console.error(
      "[replace-file] failed to decrypt old config:",
      err instanceof Error ? err.message : err,
    );
    // Continue — old file deletion uses oldMeta, not the decrypted config.
  }

  // Delete the old file from storage (best-effort). oldMeta contains the
  // blobUrl / s3Key / storageBackend needed by deleteStorageFile.
  try {
    await deleteStorageFile(oldMeta, user.id);
  } catch (err) {
    console.error(
      "[replace-file] failed to delete old file (best-effort):",
      err instanceof Error ? err.message : err,
    );
  }

  // Build and encrypt the new config. The shape matches the type:
  //   file    → FileConfig (includes format)
  //   duckdb  → DuckdbFileConfig
  //   sqlite  → SqliteFileConfig
  let newConfig: FileConfig | DuckdbFileConfig | SqliteFileConfig;
  if (existing.type === "file") {
    const format = detectFormat(file.name);
    newConfig = {
      ...(storageInfo.blobUrl && { blobUrl: storageInfo.blobUrl }),
      ...(storageInfo.s3Key && {
        s3Key: storageInfo.s3Key,
        s3Bucket: storageInfo.s3Bucket,
      }),
      filename: file.name,
      format,
      size: file.size,
    };
  } else {
    newConfig = {
      ...(storageInfo.blobUrl && { blobUrl: storageInfo.blobUrl }),
      ...(storageInfo.s3Key && {
        s3Key: storageInfo.s3Key,
        s3Bucket: storageInfo.s3Bucket,
      }),
      filename: file.name,
      size: file.size,
    };
  }
  const configEncrypted = await encryptConfig(newConfig);

  // Build the new meta, preserving non-file-related fields (e.g. `type`
  // for duckdb/sqlite, or any legacy fields) and refreshing file-related
  // fields with the new upload's metadata.
  const newMeta: Record<string, unknown> = { ...oldMeta };
  newMeta.size = file.size;
  newMeta.fileHash = hash;
  newMeta.blobPath = storageInfo.blobPath;
  newMeta.storageBackend = storageInfo.storageBackend;
  if (storageInfo.blobUrl) {
    newMeta.blobUrl = storageInfo.blobUrl;
  } else {
    delete newMeta.blobUrl;
  }
  if (storageInfo.s3Key) {
    newMeta.s3Key = storageInfo.s3Key;
    newMeta.s3Bucket = storageInfo.s3Bucket;
  } else {
    delete newMeta.s3Key;
    delete newMeta.s3Bucket;
  }
  // filename lives in meta for duckdb/sqlite; harmless for file type.
  newMeta.filename = file.name;
  // For file type, also refresh format.
  if (existing.type === "file") {
    newMeta.format = detectFormat(file.name);
  }

  // Persist the update via the admin client (service-role bypasses RLS,
  // but we already verified ownership above and constrain by user_id).
  const admin = createAdminClient();
  const { data: updated, error: updateErr } = await admin
    .from("data_sources")
    .update({
      config_encrypted: configEncrypted,
      meta: newMeta,
    })
    .eq("id", dataSourceId)
    .eq("user_id", user.id)
    .select("id, type, name, meta, created_at, updated_at")
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      {
        error: `Failed to update data source: ${updateErr?.message ?? "unknown"}`,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ source: updated });
}

function detectFormat(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "csv") return "csv";
  if (ext === "xlsx" || ext === "xls") return "excel";
  if (ext === "parquet") return "parquet";
  return "unknown";
}
