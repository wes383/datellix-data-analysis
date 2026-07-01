import { Pool } from "pg";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptConfig } from "@/lib/db/crypto";
import { embedBatch, embedText } from "@/lib/llm/embeddings";
import { runPython, uploadFileToSandbox, SANDBOX_DATA_DIR } from "@/lib/daytona/client";
import type { PgConfig, FileConfig, DataSourceType } from "@/lib/db/schema";

/**
 * Schema indexer
 *
 * Extracts table/column metadata from a data source, generates embeddings,
 * and stores them in the schema_embeddings table for pgvector retrieval.
 *
 * File sources: upload to Daytona sandbox → DuckDB DESCRIBE + sample
 * PG sources:   connect via pg → information_schema query
 */

export interface SchemaColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  description: string;
  sample_values: unknown[];
}

/** Python code to extract schema from a file using DuckDB in the sandbox */
function buildSchemaExtractionCode(remotePath: string, format: string): string {
  // DuckDB read function per format
  const readFunc =
    format === "csv"
      ? `read_csv_auto('${remotePath}', header=true)`
      : format === "parquet"
        ? `read_parquet('${remotePath}')`
        : format === "excel"
          ? `read_xlsx('${remotePath}')` // duckdb-xlsx extension may be needed; fall back to pandas
          : `read_csv_auto('${remotePath}', header=true)`;

  return `
import duckdb, json, sys
con = duckdb.connect()

try:
    # Get column info
    cols = con.execute("DESCRIBE SELECT * FROM ${readFunc} LIMIT 100").fetchall()
    # Get sample rows (up to 5)
    samples = con.execute("SELECT * FROM ${readFunc} LIMIT 5").fetchall()
except Exception as e:
    # Fallback: try pandas for excel
    try:
        import pandas as pd
        if "${format}" == "excel":
            df = pd.read_excel("${remotePath}", nrows=100)
        else:
            df = pd.read_parquet("${remotePath}") if "${format}" == "parquet" else pd.read_csv("${remotePath}", nrows=100)
        cols = [(c, str(df[c].dtype)) for c in df.columns]
        samples = [tuple(df.iloc[i]) for i in range(min(5, len(df)))]
    except Exception as e2:
        print(json.dumps({"error": str(e) + " | fallback: " + str(e2)}))
        sys.exit(1)

# Build result: list of {column_name, data_type, sample_values}
column_names = [c[0] for c in cols]
data_types = [c[1] for c in cols]
sample_values = []
for idx, col_name in enumerate(column_names):
    vals = [str(s[idx]) if s[idx] is not None else "" for s in samples[:5]]
    sample_values.append(vals)

result = {
    "columns": [
        {"column_name": cn, "data_type": dt, "sample_values": sv}
        for cn, dt, sv in zip(column_names, data_types, sample_values)
    ]
}
print(json.dumps(result))
`.trim();
}

/** Extract schema from a file data source using Daytona sandbox + DuckDB */
async function extractFileSchema(
  sessionId: string,
  blobUrl: string,
  filename: string,
  format: string,
): Promise<SchemaColumn[]> {
  // Download file from Vercel Blob (private blobs require Authorization header)
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const fileResp = await fetch(blobUrl, {
    headers: blobToken
      ? { Authorization: `Bearer ${blobToken}` }
      : undefined,
  });
  if (!fileResp.ok) {
    throw new Error(`Failed to download file from Blob: ${fileResp.status}`);
  }
  const fileBuffer = Buffer.from(await fileResp.arrayBuffer());

  // Upload to sandbox
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const remotePath = `${SANDBOX_DATA_DIR}/${safeName}`;
  await uploadFileToSandbox(sessionId, fileBuffer, remotePath);

  // Run DuckDB schema extraction
  const code = buildSchemaExtractionCode(remotePath, format);
  const result = await runPython(sessionId, code);

  if (result.exitCode !== 0) {
    throw new Error(`Schema extraction failed: ${result.stderr || result.stdout}`);
  }

  const parsed = JSON.parse(result.stdout) as {
    error?: string;
    columns?: Array<{ column_name: string; data_type: string; sample_values: string[] }>;
  };
  if (parsed.error) {
    throw new Error(`Schema extraction error: ${parsed.error}`);
  }
  if (!parsed.columns) {
    return [];
  }

  // Use filename (without extension) as table_name
  const tableName = filename.replace(/\.[^.]+$/, "");

  return parsed.columns.map((c) => ({
    table_name: tableName,
    column_name: c.column_name,
    data_type: c.data_type,
    description: `Column "${c.column_name}" in "${tableName}", type ${c.data_type}`,
    sample_values: c.sample_values.slice(0, 3),
  }));
}

/** Extract schema from a Postgres data source using information_schema */
async function extractPgSchema(config: PgConfig): Promise<SchemaColumn[]> {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl === "disable" ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    max: 3,
  });

  try {
    // Query information_schema for all tables and columns in non-system schemas
    const result = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast')
      ORDER BY table_name, ordinal_position
      LIMIT 500
    `);

    // Also get a few sample rows per table (best effort, don't fail on error)
    const tables = [...new Set(result.rows.map((r) => r.table_name))];
    const samplesByTable = new Map<string, Record<string, unknown>[]>();

    for (const table of tables.slice(0, 20)) {
      try {
        const sampleRes = await pool.query(`SELECT * FROM "${table}" LIMIT 5`);
        samplesByTable.set(table, sampleRes.rows);
      } catch {
        // Skip tables we can't sample (permissions, views, etc.)
      }
    }

    return result.rows.map((row) => {
      const samples = samplesByTable.get(row.table_name) ?? [];
      const vals = samples
        .slice(0, 3)
        .map((r) => {
          const v = r[row.column_name];
          return v === null || v === undefined ? "" : String(v);
        });
      return {
        table_name: row.table_name,
        column_name: row.column_name,
        data_type: row.data_type,
        description: `Column "${row.column_name}" in table "${row.table_name}", type ${row.data_type}`,
        sample_values: vals,
      };
    });
  } finally {
    await pool.end();
  }
}

/**
 * Index a data source's schema into pgvector.
 * Called after creating a file or PG data source.
 *
 * @param dataSourceId  The data source ID
 * @param userId         The user ID (for RLS)
 * @param type           Data source type (file | pg)
 * @param configEncrypted Encrypted config (ciphertext string)
 * @param sessionId      Session ID (required for file sources to access the sandbox)
 * @param meta           Additional metadata (filename, format, etc.)
 */
export async function indexDataSourceSchema(params: {
  dataSourceId: string;
  userId: string;
  type: DataSourceType;
  configEncrypted: string;
  sessionId?: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const { dataSourceId, userId, type, configEncrypted, sessionId, meta } = params;

  // 1. Extract schema based on source type
  let columns: SchemaColumn[] = [];

  if (type === "file") {
    if (!sessionId) {
      throw new Error("File schema indexing requires a sessionId (for sandbox access)");
    }
    const config = await decryptConfig<FileConfig>(configEncrypted);
    columns = await extractFileSchema(
      sessionId,
      config.blobUrl,
      config.filename,
      config.format,
    );
  } else if (type === "pg") {
    const config = await decryptConfig<PgConfig>(configEncrypted);
    columns = await extractPgSchema(config);
  } else {
    // API sources: no schema to index (handled differently in Phase 3)
    return;
  }

  if (columns.length === 0) return;

  // 2. Generate embeddings for each column description (batch)
  const texts = columns.map((c) => c.description);
  const vectors = await embedBatch(texts);

  // 3. Insert into schema_embeddings (delete old entries first for idempotency)
  const admin = createAdminClient();
  await admin
    .from("schema_embeddings")
    .delete()
    .eq("data_source_id", dataSourceId);

  const rows = columns.map((col, idx) => ({
    data_source_id: dataSourceId,
    user_id: userId,
    table_name: col.table_name,
    column_name: col.column_name,
    data_type: col.data_type,
    description: col.description,
    sample_values: JSON.stringify(col.sample_values),
    embedding: vectors[idx],
  }));

  // Insert in batches of 50 to avoid payload limits
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const { error } = await admin.from("schema_embeddings").insert(batch);
    if (error) {
      throw new Error(`Failed to insert schema embeddings: ${error.message}`);
    }
  }
}

/**
 * Retrieve relevant schema for a question via pgvector match_schema RPC.
 * Used by the retrieveSchema LangGraph tool.
 */
export async function retrieveSchema(
  dataSourceId: string,
  question: string,
  topK = 10,
): Promise<SchemaColumn[]> {
  const queryVector = await embedText(question);

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("match_schema", {
    p_query: queryVector,
    p_source: dataSourceId,
    p_k: topK,
  });

  if (error) {
    throw new Error(`Schema retrieval failed: ${error.message}`);
  }

  return (data ?? []).map((row: Record<string, unknown>) => ({
    table_name: row.table_name as string,
    column_name: row.column_name as string,
    data_type: row.data_type as string,
    description: row.description as string,
    sample_values: (row.sample_values as unknown[]) ?? [],
  }));
}
