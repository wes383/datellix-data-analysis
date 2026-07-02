import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptConfig } from "@/lib/db/crypto";
import { indexDataSourceSchema } from "@/lib/agent/schema";
import { uploadFile, blobPath, fileHash } from "@/lib/blob/client";
import type {
  DataSourceType,
  PgConfig,
  MysqlConfig,
  BigQueryConfig,
  DuckdbFileConfig,
  SqliteFileConfig,
} from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * GET /api/sources
 *
 * List the authenticated user's data sources. Returns id, type, name, meta,
 * and timestamps — never config_encrypted.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: sources, error } = await supabase
    .from("data_sources")
    .select("id, type, name, meta, created_at, updated_at")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json(
      { error: `Failed to list data sources: ${error.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ sources: sources ?? [] });
}

/**
 * Create (or reuse) a database data source.
 *
 * Request: POST /api/sources
 *
 * Two request shapes are supported:
 *
 * 1. JSON body (Content-Type: application/json):
 *    {
 *      type: "pg" | "mysql" | "bigquery" | "duckdb" | "sqlite",
 *      name: string,
 *      sessionId?: string,
 *      // pg / mysql fields:
 *      host?, port?, database?, user?, password?, ssl?,
 *      // bigquery fields:
 *      projectId?, location?, credentialsJson?, dataset?,
 *      // duckdb / sqlite fields (file pre-uploaded to Blob):
 *      blobUrl?, filename?, size?,
 *    }
 *
 * 2. FormData body (Content-Type: multipart/form-data):
 *    Used for duckdb / sqlite types when the file is uploaded directly
 *    from the new-source page. Fields:
 *      type: "duckdb" | "sqlite"
 *      name: string
 *      sessionId?: string
 *      file: File
 *
 * Deduplication:
 *  - pg / mysql: matches an existing data_source of the same type where
 *    host + database + user all equal. Reuses the existing row (does NOT
 *    overwrite the stored password — the user can change it via PATCH).
 *  - bigquery: matches by projectId.
 *  - duckdb / sqlite (FormData only): matches by SHA-256 content hash
 *    stored in meta.fileHash. Reuses both the data_source row and the
 *    Blob object — no second upload, no re-indexing.
 *
 * If sessionId is provided, the (newly created or reused) data source is
 * bound to that session (single-DB mode via sessions.data_source_id).
 * Binding is rejected with 409 if the session is already in multi-file
 * mode (rows in session_data_sources).
 */
const ALLOWED_DB_TYPES: readonly string[] = ["pg", "mysql", "bigquery", "duckdb", "sqlite"];

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  const isFormData = contentType.toLowerCase().startsWith("multipart/form-data");

  // Normalize into a common shape regardless of JSON or FormData source.
  let type: string;
  let name: string;
  let sessionId: string | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let database: string | undefined;
  let dbUser: string | undefined;
  let password: string | undefined;
  let ssl: string | undefined;
  let projectId: string | undefined;
  let location: string | undefined;
  let credentialsJson: string | undefined;
  let dataset: string | undefined;
  // For file-based DB types (duckdb / sqlite):
  let blobUrl: string | undefined;
  let filename: string | undefined;
  let size: number | undefined;
  let blobPathValue: string | undefined;
  let uploadedFile: File | null = null;
  // For type === "existing" (bind an already-created data source):
  let existingSourceId: string | undefined;

  if (isFormData) {
    const formData = await req.formData();
    type = (formData.get("type") as string | null) ?? "";
    name = (formData.get("name") as string | null) ?? "";
    sessionId = (formData.get("sessionId") as string | null) ?? undefined;
    uploadedFile = formData.get("file") as File | null;
  } else {
    const body = (await req.json()) as {
      type?: string;
      name?: string;
      sessionId?: string;
      host?: string;
      port?: number;
      database?: string;
      user?: string;
      password?: string;
      ssl?: string;
      projectId?: string;
      location?: string;
      credentialsJson?: string;
      dataset?: string;
      blobUrl?: string;
      filename?: string;
      size?: number;
      sourceId?: string;
    };
    type = body.type ?? "";
    name = body.name ?? "";
    sessionId = body.sessionId;
    host = body.host;
    port = body.port;
    database = body.database;
    dbUser = body.user;
    password = body.password;
    ssl = body.ssl;
    projectId = body.projectId;
    location = body.location;
    credentialsJson = body.credentialsJson;
    dataset = body.dataset;
    blobUrl = body.blobUrl;
    filename = body.filename;
    size = body.size;
    existingSourceId = body.sourceId;
  }

  // ─── Special case: bind an existing data source to a session ───────
  // Triggered by the "Use existing" tab in AddDataSourceDialog. The caller
  // passes type: "existing" + sourceId + sessionId. We skip all
  // creation/dedup logic and just bind the referenced data source to the
  // session via sessions.data_source_id (single-DB mode).
  if (type === "existing") {
    if (!existingSourceId || !sessionId) {
      return NextResponse.json(
        { error: "sourceId and sessionId are required for type=existing" },
        { status: 400 },
      );
    }
    // Verify ownership via RLS-aware client.
    const { data: existing } = await supabase
      .from("data_sources")
      .select("id, type, name")
      .eq("id", existingSourceId)
      .eq("user_id", user.id)
      .single();
    if (!existing) {
      return NextResponse.json(
        { error: "Data source not found or access denied" },
        { status: 404 },
      );
    }

    if (existing.type === "file") {
      // Check if session is in single-DB mode
      const { data: session } = await supabase
        .from("sessions")
        .select("data_source_id")
        .eq("id", sessionId)
        .single();
      if (session?.data_source_id) {
        return NextResponse.json(
          { error: "This session is connected to a database. Disconnect it before adding files." },
          { status: 409 },
        );
      }

      // Check if already bound
      const { data: duplicate } = await supabase
        .from("session_data_sources")
        .select("id")
        .eq("session_id", sessionId)
        .eq("data_source_id", existingSourceId)
        .maybeSingle();

      if (!duplicate) {
        const { error: insertError } = await supabase
          .from("session_data_sources")
          .insert({
            session_id: sessionId,
            data_source_id: existingSourceId,
          });
        if (insertError) {
          return NextResponse.json(
            { error: `Failed to bind session file: ${insertError.message}` },
            { status: 500 },
          );
        }
      }
      return NextResponse.json({
        dataSourceId: existingSourceId,
        indexed: true,
        reused: true,
      });
    }

    // Reject if session is in multi-file mode.
    const { data: existingFiles } = await supabase
      .from("session_data_sources")
      .select("id")
      .eq("session_id", sessionId);
    if (existingFiles && existingFiles.length > 0) {
      return NextResponse.json(
        { error: "This session has uploaded files. Remove them before connecting a database." },
        { status: 409 },
      );
    }
    // Bind to session (single-DB mode).
    const { error: sessionError } = await supabase
      .from("sessions")
      .update({ data_source_id: existingSourceId, title: existing.name })
      .eq("id", sessionId);
    if (sessionError) {
      return NextResponse.json(
        { error: `Failed to bind session: ${sessionError.message}` },
        { status: 500 },
      );
    }
    return NextResponse.json({
      dataSourceId: existingSourceId,
      indexed: true,
      reused: true,
    });
  }

  // Validate type
  if (!ALLOWED_DB_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `Unsupported type: ${type}. Must be one of: ${ALLOWED_DB_TYPES.join(", ")}` },
      { status: 400 },
    );
  }
  const dataSourceType = type as DataSourceType;

  if (!name) {
    return NextResponse.json(
      { error: "Missing required field: name" },
      { status: 400 },
    );
  }

  // Mutual exclusion: if sessionId provided and session is already in
  // multi-file mode (has rows in session_data_sources), reject.
  if (sessionId) {
    const { data: existingFiles } = await supabase
      .from("session_data_sources")
      .select("id")
      .eq("session_id", sessionId);
    if (existingFiles && existingFiles.length > 0) {
      return NextResponse.json(
        { error: "This session has uploaded files. Remove them before connecting a database." },
        { status: 409 },
      );
    }
  }

  // For duckdb / sqlite via FormData, compute content hash now (before
  // uploading to Blob) so we can dedupe against existing data_sources.
  let fileContentHash: string | undefined;
  if ((dataSourceType === "duckdb" || dataSourceType === "sqlite") && isFormData) {
    if (!uploadedFile) {
      return NextResponse.json(
        { error: `Missing required field for ${dataSourceType}: file` },
        { status: 400 },
      );
    }
    if (!sessionId) {
      return NextResponse.json(
        { error: "sessionId is required when uploading a database file" },
        { status: 400 },
      );
    }
    fileContentHash = await fileHash(uploadedFile);
  }

  const admin = createAdminClient();

  // ─── Deduplication lookup ───────────────────────────────────────────
  // pg / mysql: match by host + database + user (type also constrained).
  // bigquery:   match by projectId.
  // duckdb / sqlite (FormData): match by meta.fileHash.
  // The password / credentialsJson from the request is ignored when
  // reusing — the existing encrypted config is kept as-is. The user can
  // update credentials later via PATCH.
  let existingDsId: string | null = null;
  let reused = false;

  if (dataSourceType === "pg" || dataSourceType === "mysql") {
    if (!host || !database || !dbUser || !password) {
      return NextResponse.json(
        { error: `Missing required fields for ${dataSourceType}: host, database, user, password` },
        { status: 400 },
      );
    }
    const { data: existing } = await admin
      .from("data_sources")
      .select("id")
      .eq("user_id", user.id)
      .eq("type", dataSourceType)
      .filter("meta->>host", "eq", host)
      .filter("meta->>database", "eq", database)
      .filter("meta->>user", "eq", dbUser)
      .limit(1);
    existingDsId = existing && existing.length > 0 ? existing[0].id : null;
  } else if (dataSourceType === "bigquery") {
    if (!projectId || !credentialsJson) {
      return NextResponse.json(
        { error: "Missing required fields for bigquery: projectId, credentialsJson" },
        { status: 400 },
      );
    }
    const { data: existing } = await admin
      .from("data_sources")
      .select("id")
      .eq("user_id", user.id)
      .eq("type", "bigquery")
      .filter("meta->>projectId", "eq", projectId)
      .limit(1);
    existingDsId = existing && existing.length > 0 ? existing[0].id : null;
  } else if ((dataSourceType === "duckdb" || dataSourceType === "sqlite") && fileContentHash) {
    const { data: existing } = await admin
      .from("data_sources")
      .select("id")
      .eq("user_id", user.id)
      .in("type", ["duckdb", "sqlite"])
      .filter("meta->>fileHash", "eq", fileContentHash)
      .limit(1);
    existingDsId = existing && existing.length > 0 ? existing[0].id : null;
  }

  if (existingDsId) {
    // Reuse the existing data_source — skip Blob upload, encryption, and
    // schema indexing. Only bind it to the session below if requested.
    reused = true;
    if (sessionId) {
      const { error: sessionError } = await supabase
        .from("sessions")
        .update({ data_source_id: existingDsId, title: name })
        .eq("id", sessionId);
      if (sessionError) {
        console.error("[sources] failed to bind session (reuse):", sessionError.message);
      }
    }
    return NextResponse.json({
      dataSourceId: existingDsId,
      indexed: true,
      reused,
    });
  }

  // ─── New data source: upload file (if FormData), build config, insert ──
  if ((dataSourceType === "duckdb" || dataSourceType === "sqlite") && isFormData) {
    // Only upload now — dedupe lookup above used the hash without uploading.
    blobPathValue = blobPath(user.id, sessionId!, uploadedFile!.name);
    blobUrl = await uploadFile(blobPathValue, uploadedFile!);
    filename = uploadedFile!.name;
    size = uploadedFile!.size;
  }

  // Build config + meta by type
  let config:
    | PgConfig
    | MysqlConfig
    | BigQueryConfig
    | DuckdbFileConfig
    | SqliteFileConfig;
  let meta: Record<string, unknown>;
  if (dataSourceType === "pg" || dataSourceType === "mysql") {
    const dbConfig: PgConfig & MysqlConfig = {
      host: host!,
      port: port ?? (dataSourceType === "mysql" ? 3306 : 5432),
      database: database!,
      user: dbUser!,
      password: password!,
      ssl: ssl ?? "require",
    };
    config = dbConfig;
    // Store host/database/user in meta for dedup lookup and /sources list.
    // Never store the password in meta (plaintext) — it lives only in
    // config_encrypted.
    meta = { type: dataSourceType, host, database, user: dbUser };
  } else if (dataSourceType === "bigquery") {
    const bqConfig: BigQueryConfig = {
      projectId: projectId!,
      location: location ?? "US",
      credentialsJson: credentialsJson!,
      dataset,
    };
    config = bqConfig;
    meta = { type: "bigquery", projectId };
  } else if (dataSourceType === "duckdb" || dataSourceType === "sqlite") {
    if (!blobUrl || !filename || size == null) {
      return NextResponse.json(
        { error: `Missing required fields for ${dataSourceType}: blobUrl, filename, size` },
        { status: 400 },
      );
    }
    const fileConfig: DuckdbFileConfig & SqliteFileConfig = {
      blobUrl,
      filename,
      size,
    };
    config = fileConfig;
    const fileMeta: Record<string, unknown> = {
      type: dataSourceType,
      filename,
      size,
    };
    if (blobPathValue) fileMeta.blobPath = blobPathValue;
    if (blobUrl) fileMeta.blobUrl = blobUrl;
    if (fileContentHash) fileMeta.fileHash = fileContentHash;
    meta = fileMeta;
  } else {
    return NextResponse.json({ error: `Unsupported type: ${type}` }, { status: 400 });
  }

  // Encrypt
  const configEncrypted = await encryptConfig(config);

  // Insert data source
  const { data: dataSource, error: dsError } = await admin
    .from("data_sources")
    .insert({
      user_id: user.id,
      type: dataSourceType,
      name,
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

  // Bind to session if provided (single-DB mode via sessions.data_source_id)
  if (sessionId) {
    const { error: sessionError } = await supabase
      .from("sessions")
      .update({ data_source_id: dataSource.id, title: name })
      .eq("id", sessionId);
    if (sessionError) {
      console.error("[sources] failed to bind session:", sessionError.message);
    }
  }

  // Index schema (best-effort)
  let indexed = false;
  let indexError: string | undefined;
  try {
    await indexDataSourceSchema({
      dataSourceId: dataSource.id,
      userId: user.id,
      type: dataSourceType,
      configEncrypted,
      sessionId,
      meta,
    });
    indexed = true;
  } catch (err) {
    indexError = err instanceof Error ? err.message : "Schema indexing failed";
    console.error("[sources] schema indexing failed:", indexError);
  }

  return NextResponse.json({
    dataSourceId: dataSource.id,
    indexed,
    indexError,
    reused: false,
  });
}
