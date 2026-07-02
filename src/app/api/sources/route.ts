import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptConfig } from "@/lib/db/crypto";
import { indexDataSourceSchema } from "@/lib/agent/schema";
import { uploadFile, blobPath } from "@/lib/blob/client";
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
 * Create a database data source
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
 *    The server uploads the file to Vercel Blob, then creates the
 *    data_source with DuckdbFileConfig / SqliteFileConfig.
 *
 * If sessionId is provided, the data source is bound to that session
 * (single-DB mode via sessions.data_source_id) and schema indexing is
 * triggered immediately. Binding is rejected with 409 if the session is
 * already in multi-file mode (rows in session_data_sources).
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

  // For duckdb / sqlite via FormData, upload the file to Blob now and
  // populate blobUrl / filename / size / blobPathValue.
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
    blobPathValue = blobPath(user.id, sessionId, uploadedFile.name);
    blobUrl = await uploadFile(blobPathValue, uploadedFile);
    filename = uploadedFile.name;
    size = uploadedFile.size;
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
    if (!host || !database || !dbUser || !password) {
      return NextResponse.json(
        { error: `Missing required fields for ${dataSourceType}: host, database, user, password` },
        { status: 400 },
      );
    }
    const dbConfig: PgConfig & MysqlConfig = {
      host,
      port: port ?? (dataSourceType === "mysql" ? 3306 : 5432),
      database,
      user: dbUser,
      password,
      ssl: ssl ?? "require",
    };
    config = dbConfig;
    meta = { type: dataSourceType, host, database };
  } else if (dataSourceType === "bigquery") {
    if (!projectId || !credentialsJson) {
      return NextResponse.json(
        { error: "Missing required fields for bigquery: projectId, credentialsJson" },
        { status: 400 },
      );
    }
    const bqConfig: BigQueryConfig = {
      projectId,
      location: location ?? "US",
      credentialsJson,
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
    meta = fileMeta;
  } else {
    return NextResponse.json({ error: `Unsupported type: ${type}` }, { status: 400 });
  }

  // Encrypt
  const configEncrypted = await encryptConfig(config);

  // Insert data source
  const { data: dataSource, error: dsError } = await supabase
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
    const admin = createAdminClient();
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
  });
}
