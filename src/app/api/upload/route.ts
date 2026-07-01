import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uploadFile, blobPath } from "@/lib/blob/client";
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
 * Response: { dataSourceId, fileRef, filename, size, format, indexed }
 *
 * Flow:
 *   1. Upload file to Vercel Blob
 *   2. Create a `file` data_source with encrypted config (blobUrl, filename, format, size)
 *   3. Bind data_source to the session
 *   4. Index schema (extract columns → embed → store in pgvector)
 *   5. Return data source info
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

  // 1. Upload to Blob
  const path = blobPath(user.id, sessionId, file.name);
  const blobUrl = await uploadFile(path, file);
  const format = detectFormat(file.name);

  // 2. Create data_source with encrypted config
  const fileConfig: FileConfig = {
    blobUrl,
    filename: file.name,
    format,
    size: file.size,
  };
  const configEncrypted = await encryptConfig(fileConfig);

  const { data: dataSource, error: dsError } = await supabase
    .from("data_sources")
    .insert({
      user_id: user.id,
      type: "file",
      name: file.name,
      config_encrypted: configEncrypted,
      meta: { format, size: file.size, blobPath: path },
    })
    .select("id")
    .single();

  if (dsError || !dataSource) {
    return NextResponse.json(
      { error: `Failed to create data source: ${dsError?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  // 3. Bind data_source to session
  await supabase
    .from("sessions")
    .update({ data_source_id: dataSource.id, title: file.name })
    .eq("id", sessionId);

  // 4. Index schema (best-effort: don't fail the upload if indexing fails)
  let indexed = false;
  let indexError: string | undefined;
  try {
    await indexDataSourceSchema({
      dataSourceId: dataSource.id,
      userId: user.id,
      type: "file",
      configEncrypted,
      sessionId,
      meta: { format, size: file.size },
    });
    indexed = true;
  } catch (err) {
    indexError = err instanceof Error ? err.message : "Schema indexing failed";
    console.error("[upload] schema indexing failed:", indexError);
  }

  return NextResponse.json({
    dataSourceId: dataSource.id,
    fileRef: blobUrl,
    filename: file.name,
    size: file.size,
    format,
    indexed,
    indexError,
  });
}

function detectFormat(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "csv") return "csv";
  if (ext === "xlsx" || ext === "xls") return "excel";
  if (ext === "parquet") return "parquet";
  return "unknown";
}
