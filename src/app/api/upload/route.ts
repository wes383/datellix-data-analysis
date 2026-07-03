import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fileHash } from "@/lib/blob/client";
import { uploadStorageFile } from "@/lib/storage/resolver";
import { encryptConfig } from "@/lib/db/crypto";
import { indexDataSourceSchema } from "@/lib/agent/schema";
import type { FileConfig } from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * File upload interface
 *
 * Request: POST /api/upload
 * form-data: { sessionId: string, file: File }
 *
 * Response: { dataSourceId, fileRef, filename, size, format, indexed, reused }
 *
 * Flow:
 *   1. Compute SHA-256 hash of file contents.
 *   2. If a data_source with the same hash already exists for this user,
 *      reuse it (skip Blob upload + schema indexing). Only bind it to the
 *      session.
 *   3. Otherwise: upload to Blob, create data_source, index schema.
 *   4. Bind data_source to the session.
 *
 * Deduplication is by content hash, so renaming a file or uploading the
 * same file in a different session reuses the existing data_source and
 * Blob object — no storage waste, no redundant indexing.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const formData = await req.formData();
  const sessionId = formData.get("sessionId") as string | null;
  const file = formData.get("file") as File | null;
  if (!sessionId || !file) {
    return NextResponse.json({ error: "Missing sessionId or file" }, { status: 400 });
  }

  // Verify session ownership
  const { data: session } = await supabase
    .from("sessions")
    .select("id, user_id")
    .eq("id", sessionId)
    .single();
  if (!session || session.user_id !== user.id) {
    return NextResponse.json({ error: "Session not found or access denied" }, { status: 404 });
  }

  // Session must not be in single-DB mode (checked early to avoid wasted
  // hash computation / Blob upload for a request that will be rejected).
  const { data: sessionCheck } = await supabase
    .from("sessions")
    .select("data_source_id")
    .eq("id", sessionId)
    .single();
  if (sessionCheck?.data_source_id) {
    return NextResponse.json(
      { error: "This session is connected to a database. Disconnect it first to upload files." },
      { status: 409 },
    );
  }

  const format = detectFormat(file.name);
  // Detect data source type from extension: .duckdb → duckdb,
  // .db/.sqlite/.sqlite3 → sqlite, everything else → file.
  // This lets the chat upload dialog support database files without a
  // separate form — the type is inferred from the file extension.
  const dsType = detectDataSourceType(file.name);

  // 1. Compute content hash for deduplication.
  const hash = await fileHash(file);

  // 2. Check if a data_source with this hash already exists for this user.
  //    meta->>'fileHash' is the dedup key. Only file/duckdb/sqlite types
  //    carry fileHash; DB types never match.
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("data_sources")
    .select("id, config_encrypted, meta")
    .eq("user_id", user.id)
    .in("type", ["file", "duckdb", "sqlite"])
    .filter("meta->>fileHash", "eq", hash)
    .limit(1);

  let dataSourceId: string;
  let blobUrl: string | undefined;
  let indexed: boolean;
  let indexError: string | undefined;
  let reused = false;

  if (existing && existing.length > 0) {
    // Reuse the existing data_source — skip upload and schema indexing.
    const existingDs = existing[0];
    dataSourceId = existingDs.id;
    const meta = (existingDs.meta ?? {}) as Record<string, unknown>;
    blobUrl = typeof meta.blobUrl === "string" ? meta.blobUrl : undefined;
    indexed = true; // already indexed when first created
    reused = true;
  } else {
    // 3. New file: upload to storage (Vercel Blob or S3 per user config),
    //    create data_source, index schema.
    const storageInfo = await uploadStorageFile(user.id, sessionId, file.name, file);
    blobUrl = storageInfo.blobUrl;

    const fileConfig: FileConfig = {
      ...(storageInfo.blobUrl && { blobUrl: storageInfo.blobUrl }),
      ...(storageInfo.s3Key && { s3Key: storageInfo.s3Key, s3Bucket: storageInfo.s3Bucket }),
      filename: file.name,
      format,
      size: file.size,
    };
    const configEncrypted = await encryptConfig(fileConfig);

    const meta: Record<string, unknown> = {
      format,
      size: file.size,
      blobPath: storageInfo.blobPath,
      fileHash: hash,
      storageBackend: storageInfo.storageBackend,
      ...(storageInfo.blobUrl && { blobUrl: storageInfo.blobUrl }),
      ...(storageInfo.s3Key && { s3Key: storageInfo.s3Key, s3Bucket: storageInfo.s3Bucket }),
    };

    const { data: dataSource, error: dsError } = await admin
      .from("data_sources")
      .insert({
        user_id: user.id,
        type: dsType,
        name: file.name,
        config_encrypted: configEncrypted,
        meta,
      })
      .select("id")
      .single();

    if (dsError || !dataSource) {
      return NextResponse.json(
        { error: `Failed to create data source: ${dsError?.message ?? "unknown"}` },
        { status: 500 },
      );
    }

    dataSourceId = dataSource.id;

    // Index schema (best-effort: don't fail the upload if indexing fails)
    try {
      await indexDataSourceSchema({
        dataSourceId,
        userId: user.id,
        type: dsType,
        configEncrypted,
        sessionId,
        meta,
      });
      indexed = true;
    } catch (err) {
      indexed = false;
      indexError = err instanceof Error ? err.message : "Schema indexing failed";
      console.error("[upload] schema indexing failed:", indexError);
    }
  }

  // 4. Bind data_source to session (multi-file mode).
  await supabase.from("session_data_sources").insert({
    session_id: sessionId,
    data_source_id: dataSourceId,
  });

  // Set session title on first file upload only (when no title yet)
  await supabase
    .from("sessions")
    .update({ title: file.name })
    .eq("id", sessionId)
    .is("title", null);

  return NextResponse.json({
    dataSourceId,
    fileRef: blobUrl,
    filename: file.name,
    size: file.size,
    format,
    indexed,
    indexError,
    reused,
  });
}

function detectFormat(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "csv") return "csv";
  if (ext === "xlsx" || ext === "xls") return "excel";
  if (ext === "parquet") return "parquet";
  if (ext === "duckdb") return "duckdb";
  if (ext === "db" || ext === "sqlite" || ext === "sqlite3") return "sqlite";
  return "unknown";
}

/**
 * Map a filename's extension to a data source type.
 * .duckdb → duckdb, .db/.sqlite/.sqlite3 → sqlite, everything else → file.
 */
function detectDataSourceType(
  filename: string,
): "file" | "duckdb" | "sqlite" {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "duckdb") return "duckdb";
  if (ext === "db" || ext === "sqlite" || ext === "sqlite3") return "sqlite";
  return "file";
}
