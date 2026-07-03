import { Pool } from "pg";
import mysql from "mysql2/promise";
import { BigQuery } from "@google-cloud/bigquery";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptConfig } from "@/lib/db/crypto";
import { embedBatch, embedText } from "@/lib/llm/embeddings";
import { runPython } from "@/lib/daytona/client";
import { downloadStorageFile } from "@/lib/storage/resolver";
import type {
  PgConfig,
  FileConfig,
  MysqlConfig,
  BigQueryConfig,
  DuckdbFileConfig,
  SqliteFileConfig,
  DataSourceType,
} from "@/lib/db/schema";

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
  return `
import pandas as pd
import duckdb
import json
import sys

def load_and_clean_file(file_path, file_format):
    if file_format == "csv":
        df_raw = pd.read_csv(file_path, header=None, dtype=str)
    elif file_format == "excel":
        df_raw = pd.read_excel(file_path, header=None)
    elif file_format == "parquet":
        return pd.read_parquet(file_path)
    else:
        df_raw = pd.read_csv(file_path, header=None, dtype=str)

    # Automatically find the header row (first 10 rows search)
    best_idx = 0
    best_score = -1
    for idx, row in df_raw.head(10).iterrows():
        non_null_count = row.notna().sum()
        string_count = sum(1 for v in row if isinstance(v, str) and len(v.strip()) > 0)
        # Score prioritizing non-empty cells and string-like headers
        score = non_null_count * 2 + string_count
        if score > best_score:
            best_score = score
            best_idx = idx

    # Slice data starting after the header row
    df = df_raw.iloc[best_idx + 1:].copy()
    headers = df_raw.iloc[best_idx].tolist()
    
    # Process column names: trim spaces, replace NaN, deduplicate
    col_names = []
    seen = {}
    for i, col in enumerate(headers):
        name = str(col).strip() if pd.notna(col) else f"Unnamed_{i}"
        if name == "":
            name = f"Unnamed_{i}"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 1
        col_names.append(name)
        
    df.columns = col_names
    df = df.reset_index(drop=True)
    
    # Type inference: convert numeric columns where possible
    for col in df.columns:
        try:
            df[col] = pd.to_numeric(df[col])
        except Exception:
            pass
            
    return df

try:
    df = load_and_clean_file(${JSON.stringify(remotePath)}, ${JSON.stringify(format)})
    con = duckdb.connect()
    cols = con.execute("DESCRIBE SELECT * FROM df").fetchall()
    samples = con.execute("SELECT * FROM df LIMIT 5").fetchall()
except Exception as e:
    print(json.dumps({"error": str(e)}))
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
  meta: Record<string, unknown>,
  userId: string,
  filename: string,
  format: string,
): Promise<SchemaColumn[]> {
  // Download file from the user's configured storage backend (S3 or Vercel Blob)
  const staged = await downloadStorageFile(meta, userId, filename);
  const fileBuffer = staged.buffer;
  const remotePath = staged.remotePath;

  // Run DuckDB schema extraction with the file staged in the ephemeral sandbox
  const code = buildSchemaExtractionCode(remotePath, format);
  const result = await runPython(sessionId, code, {
    files: [{ buffer: fileBuffer, remotePath }],
  });

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

  // Use the same sanitized stem that executeMultiFileSql registers as the
  // DuckDB view name (filename → replace special chars → strip extension).
  // This must stay in sync with the view name logic in tools.ts so the LLM
  // always references the exact table name DuckDB knows about.
  const tableName = filename
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.[^.]+$/, "");

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

/** Extract schema from a MySQL data source */
async function extractMysqlSchema(config: MysqlConfig): Promise<SchemaColumn[]> {
  if (!config.database) {
    throw new Error("Database name must be specified in MySQL connection config");
  }
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl === "disable" ? undefined : { rejectUnauthorized: false },
  });
  try {
    const [tablesRaw] = await conn.execute(
      `SELECT TABLE_NAME AS table_name FROM information_schema.tables WHERE TABLE_SCHEMA = ?`,
      [config.database],
    );
    const tables = (tablesRaw as any[]).map((row) => ({
      table_name: row.table_name ?? row.TABLE_NAME,
    }));
    const result: SchemaColumn[] = [];
    for (const t of tables) {
      if (!t.table_name) continue;
      const [colsRaw] = await conn.execute(
        `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type 
         FROM information_schema.columns
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? 
         ORDER BY ORDINAL_POSITION`,
        [config.database, t.table_name],
      );
      const cols = (colsRaw as any[]).map((row) => ({
        column_name: row.column_name ?? row.COLUMN_NAME,
        data_type: row.data_type ?? row.DATA_TYPE,
      }));
      for (const c of cols) {
        if (!c.column_name) continue;
        result.push({
          table_name: t.table_name,
          column_name: c.column_name,
          data_type: c.data_type || "unknown",
          description: `Column "${c.column_name}" in table "${t.table_name}", type ${c.data_type || "unknown"}`,
          sample_values: [],
        });
      }
    }
    return result;
  } finally {
    await conn.end();
  }
}

/** Extract schema from a BigQuery data source */
async function extractBigQuerySchema(config: BigQueryConfig): Promise<SchemaColumn[]> {
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(config.credentialsJson);
  } catch {
    throw new Error("BigQuery credentials JSON is invalid");
  }
  const bq = new BigQuery({
    projectId: config.projectId,
    credentials,
    location: config.location || "US",
  });
  const result: SchemaColumn[] = [];
  const datasets: string[] = config.dataset
    ? [config.dataset]
    : (await bq.getDatasets())[0]
        .map((d) => d.id)
        .filter((id): id is string => typeof id === "string");
  for (const datasetId of datasets) {
    const [tables] = await bq.dataset(datasetId).getTables();
    for (const table of tables) {
      const [meta] = await table.getMetadata();
      const metaAny = meta as unknown as {
        schema?: { fields?: { name: string; type: string }[] };
      };
      const fields = metaAny.schema?.fields ?? [];
      for (const f of fields) {
        result.push({
          table_name: `${datasetId}.${table.id}`,
          column_name: f.name,
          data_type: f.type,
          description: `Column "${f.name}" in table "${datasetId}.${table.id}", type ${f.type}`,
          sample_values: [],
        });
      }
    }
  }
  return result;
}

/** Extract schema from a DuckDB file via sandbox */
async function extractDuckdbFileSchema(
  sessionId: string,
  config: DuckdbFileConfig,
  meta: Record<string, unknown>,
  userId: string,
): Promise<SchemaColumn[]> {
  const staged = await downloadStorageFile(meta, userId, config.filename);
  const fileBuffer = staged.buffer;
  const remotePath = staged.remotePath;
  const code = `
import duckdb, json, sys
con = duckdb.connect("${remotePath}", read_only=True)
try:
    tables = con.execute("SHOW TABLES").fetchall()
    result = []
    for (tname,) in tables:
        cols = con.execute(f"DESCRIBE SELECT * FROM \\"{tname}\\" LIMIT 1").fetchall()
        for c in cols:
            result.append({"table_name": tname, "column_name": c[0], "data_type": str(c[1]), "description": "", "sample_values": []})
    print(json.dumps({"columns": result}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`.trim();
  const pyResult = await runPython(sessionId, code, {
    files: [{ buffer: fileBuffer, remotePath }],
  });
  if (pyResult.exitCode !== 0) {
    throw new Error(`DuckDB file schema extraction failed: ${pyResult.stderr}`);
  }
  const parsed = JSON.parse(pyResult.stdout) as { columns: SchemaColumn[]; error?: string };
  if (parsed.error) throw new Error(parsed.error);
  return parsed.columns;
}

/** Extract schema from a SQLite file via sandbox (DuckDB sqlite extension) */
async function extractSqliteFileSchema(
  sessionId: string,
  config: SqliteFileConfig,
  meta: Record<string, unknown>,
  userId: string,
): Promise<SchemaColumn[]> {
  const staged = await downloadStorageFile(meta, userId, config.filename);
  const fileBuffer = staged.buffer;
  const remotePath = staged.remotePath;
  const code = `
import duckdb, json, sys
con = duckdb.connect()
try:
    con.execute("INSTALL sqlite; LOAD sqlite;")
    con.execute("CALL sqlite_attach('${remotePath}', read_only=True)")
    tables = con.execute("SHOW TABLES").fetchall()
    result = []
    for (tname,) in tables:
        cols = con.execute(f"DESCRIBE SELECT * FROM \\"{tname}\\" LIMIT 1").fetchall()
        for c in cols:
            result.append({"table_name": tname, "column_name": c[0], "data_type": str(c[1]), "description": "", "sample_values": []})
    print(json.dumps({"columns": result}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`.trim();
  const pyResult = await runPython(sessionId, code, {
    files: [{ buffer: fileBuffer, remotePath }],
  });
  if (pyResult.exitCode !== 0) {
    throw new Error(`SQLite file schema extraction failed: ${pyResult.stderr}`);
  }
  const parsed = JSON.parse(pyResult.stdout) as { columns: SchemaColumn[]; error?: string };
  if (parsed.error) throw new Error(parsed.error);
  return parsed.columns;
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
      meta ?? {},
      userId,
      config.filename,
      config.format,
    );
  } else if (type === "pg") {
    const config = await decryptConfig<PgConfig>(configEncrypted);
    columns = await extractPgSchema(config);
  } else if (type === "mysql") {
    const config = await decryptConfig<MysqlConfig>(configEncrypted);
    columns = await extractMysqlSchema(config);
  } else if (type === "bigquery") {
    const config = await decryptConfig<BigQueryConfig>(configEncrypted);
    columns = await extractBigQuerySchema(config);
  } else if (type === "duckdb") {
    if (!sessionId) {
      throw new Error("DuckDB file schema indexing requires a sessionId (for sandbox access)");
    }
    const config = await decryptConfig<DuckdbFileConfig>(configEncrypted);
    columns = await extractDuckdbFileSchema(sessionId, config, meta ?? {}, userId);
  } else if (type === "sqlite") {
    if (!sessionId) {
      throw new Error("SQLite file schema indexing requires a sessionId (for sandbox access)");
    }
    const config = await decryptConfig<SqliteFileConfig>(configEncrypted);
    columns = await extractSqliteFileSchema(sessionId, config, meta ?? {}, userId);
  } else {
    throw new Error(`Schema indexing not supported for type: ${type}`);
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

  // 4. No sandbox cleanup needed — the ephemeral model in runPython()
  //    creates and deletes the sandbox per call. Sandboxes no longer
  //    persist between requests, so there's nothing to clean up here.
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

/**
 * Retrieve schema columns across multiple data sources (multi-file session).
 * Calls match_schema_multi with the union of data source ids.
 */
export async function retrieveSchemaMulti(
  dataSourceIds: string[],
  question: string,
  topK = 20,
): Promise<SchemaColumn[]> {
  if (dataSourceIds.length === 0) return [];
  const queryVector = await embedText(question);
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("match_schema_multi", {
    p_query: queryVector,
    p_sources: dataSourceIds,
    p_k: topK,
  });
  if (error) {
    throw new Error(`Multi-source schema retrieval failed: ${error.message}`);
  }
  return (data ?? []).map((row: Record<string, unknown>) => ({
    table_name: row.table_name as string,
    column_name: row.column_name as string,
    data_type: row.data_type as string,
    description: row.description as string,
    sample_values: (row.sample_values as unknown[]) ?? [],
  }));
}
