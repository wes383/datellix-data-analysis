import { Pool } from "pg";
import mysql, { type Pool as MysqlPool } from "mysql2/promise";
import { BigQuery } from "@google-cloud/bigquery";
import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptConfig } from "@/lib/db/crypto";
import { runPython, uploadFileToSandbox, SANDBOX_DATA_DIR } from "@/lib/daytona/client";
import { retrieveSchema, retrieveSchemaMulti, type SchemaColumn } from "@/lib/agent/schema";
import type {
  SqlResults,
  ChartPayload,
  SummaryPayload,
  Artifact,
} from "@/lib/agent/state";
import type {
  PgConfig,
  FileConfig,
  MysqlConfig,
  BigQueryConfig,
  DuckdbFileConfig,
  SqliteFileConfig,
} from "@/lib/db/schema";

/**
 * ReAct agent tools (Phase 2 refactor)
 *
 * The previous Phase 1 design orchestrated multiple LLM calls through a
 * 6-node LangGraph state graph (schemaRetriever → router → nlSql → summarize
 * → makeChart → synthesizer). This file now exposes a single LLM agent that
 * autonomously calls the tools below in a ReAct loop, inspects results, and
 * decides what to do next — the Claude Code style the user requested.
 *
 * The SQL executors, Daytona sandbox helpers, and validateSelectSql are kept
 * verbatim from Phase 1; only the LLM-driven orchestration (generateSql,
 * nlToSql) has been removed because the agent writes SQL itself.
 */

// ============================================================
// SQL validation
// ============================================================

const FORBIDDEN_KEYWORDS = [
  "insert", "update", "delete", "drop", "create", "alter", "truncate",
  "grant", "revoke", "vacuum", "copy", "call", "exec", "execute",
  "merge", "replace", "attach", "detach",
];

/**
 * Validate that SQL is a safe read-only SELECT.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
export function validateSelectSql(sql: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = sql.trim().toLowerCase();

  // Must start with SELECT or WITH (CTE)
  if (!trimmed.startsWith("select") && !trimmed.startsWith("with")) {
    return { ok: false, reason: "Query must start with SELECT or WITH" };
  }

  // Strip trailing semicolon
  const body = trimmed.replace(/;+\s*$/, "");

  // Reject multiple statements (semicolon in the middle)
  if (body.includes(";")) {
    return { ok: false, reason: "Multiple statements are not allowed" };
  }

  // Reject comments
  if (body.includes("--") || body.includes("/*")) {
    return { ok: false, reason: "Comments are not allowed in generated SQL" };
  }

  // Reject forbidden keywords (word-boundary match)
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(body)) {
      return { ok: false, reason: `Forbidden keyword in query: ${kw.toUpperCase()}` };
    }
  }

  return { ok: true };
}

// ============================================================
// SQL execution — Postgres
// ============================================================

const MAX_ROWS = 1000;
const QUERY_TIMEOUT_MS = 10000;

/** Execute a SELECT on the user's Postgres data source */
export async function executePgSql(
  config: PgConfig,
  sql: string,
): Promise<SqlResults> {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl === "disable" ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: QUERY_TIMEOUT_MS,
    max: 3,
  });

  try {
    const result = await pool.query({
      text: sql,
      rowMode: "array", // Return rows as arrays (not objects) for consistent handling
    });

    const columns = result.fields.map((f) => f.name);
    const allRows = result.rows as unknown[][];
    const truncated = allRows.length > MAX_ROWS;
    const rows = truncated ? allRows.slice(0, MAX_ROWS) : allRows;

    return {
      sql,
      columns,
      rows,
      rowCount: allRows.length,
      truncated,
    };
  } finally {
    await pool.end();
  }
}

// ============================================================
// SQL execution — MySQL
// ============================================================

/**
 * Execute a SELECT on a MySQL data source.
 * Mirrors executePgSql: returns rows as arrays, capped at MAX_ROWS.
 */
export async function executeMysqlSql(
  config: MysqlConfig,
  sql: string,
): Promise<SqlResults> {
  const pool: MysqlPool = mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl === "disable" ? undefined : { rejectUnauthorized: false },
    connectionLimit: 3,
    connectTimeout: QUERY_TIMEOUT_MS,
  });

  try {
    const [rows, meta] = await pool.execute({ sql, rowsAsArray: true });
    const columns = (meta as unknown as { name: string }[]).map((f) => f.name);
    const allRows = rows as unknown[][];
    const truncated = allRows.length > MAX_ROWS;
    const capped = truncated ? allRows.slice(0, MAX_ROWS) : allRows;
    return {
      sql,
      columns,
      rows: capped,
      rowCount: allRows.length,
      truncated,
    };
  } finally {
    await pool.end();
  }
}

// ============================================================
// SQL execution — BigQuery
// ============================================================

/**
 * Execute a SELECT on a BigQuery data source.
 * Uses a service account JSON for auth. Returns rows as arrays.
 */
export async function executeBigQuerySql(
  config: BigQueryConfig,
  sql: string,
): Promise<SqlResults> {
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

  const [job] = await bq.createQueryJob({
    query: sql,
    location: config.location || "US",
    maximumBytesBilled: "1000000000", // 1 GB safety cap
  });

  const [rows] = await job.getQueryResults({ maxResults: MAX_ROWS + 1 });
  const allRows = rows as Record<string, unknown>[];

  // BigQuery returns rows as objects; columns come from job metadata.
  const [meta] = await job.getMetadata();
  const metaAny = meta as unknown as {
    configuration?: { query?: { destinationTable?: { fields?: { name: string }[] } } };
  };
  const fields = metaAny.configuration?.query?.destinationTable?.fields ?? [];
  // Fallback: derive columns from the first row if metadata lacks fields.
  const columns =
    fields.length > 0
      ? fields.map((f) => f.name)
      : allRows.length > 0
        ? Object.keys(allRows[0])
        : [];

  const truncated = allRows.length > MAX_ROWS;
  const capped = truncated ? allRows.slice(0, MAX_ROWS) : allRows;
  // Convert object rows to array rows in column order.
  const arrayRows = capped.map((r) => columns.map((c) => r[c] ?? null));

  return {
    sql,
    columns,
    rows: arrayRows,
    rowCount: allRows.length,
    truncated,
  };
}

// ============================================================
// SQL execution — DuckDB file (via Daytona sandbox)
// ============================================================

/**
 * Execute a SELECT on a .duckdb file. The file is downloaded from Blob,
 * uploaded to the sandbox, then opened with duckdb.connect(path) so the
 * LLM can reference any table inside it directly.
 */
export async function executeDuckdbFileSql(
  sessionId: string,
  config: DuckdbFileConfig,
  sql: string,
): Promise<SqlResults> {
  const safeName = config.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const remotePath = `${SANDBOX_DATA_DIR}/${safeName}`;

  const code = `
import duckdb, json, sys
con = duckdb.connect("${remotePath}", read_only=True)
try:
    result = con.execute(${JSON.stringify(sql)}).fetchall()
    columns = [desc[0] for desc in con.description]
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
max_rows = ${MAX_ROWS}
truncated = len(result) > max_rows
rows = result[:max_rows]
rows_str = [[str(v) if v is not None else None for v in row] for row in rows]
print(json.dumps({"columns": columns, "rows": rows_str, "rowCount": len(result), "truncated": truncated}))
`.trim();

  const pyResult = await runPython(sessionId, code);
  if (pyResult.exitCode !== 0) {
    throw new Error(`DuckDB file query failed: ${pyResult.stderr || pyResult.stdout}`);
  }
  const parsed = JSON.parse(pyResult.stdout) as {
    error?: string;
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    truncated: boolean;
  };
  if (parsed.error) throw new Error(`DuckDB error: ${parsed.error}`);
  return {
    sql,
    columns: parsed.columns,
    rows: parsed.rows,
    rowCount: parsed.rowCount,
    truncated: parsed.truncated,
  };
}

// ============================================================
// SQL execution — SQLite file (via Daytona sandbox, DuckDB sqlite extension)
// ============================================================

/**
 * Execute a SELECT on a .sqlite/.db file. Uses DuckDB's sqlite_scanner
 * extension inside the sandbox to attach the SQLite file and expose its
 * tables as views, so the LLM can reference them by name.
 */
export async function executeSqliteFileSql(
  sessionId: string,
  config: SqliteFileConfig,
  sql: string,
): Promise<SqlResults> {
  const safeName = config.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const remotePath = `${SANDBOX_DATA_DIR}/${safeName}`;

  const code = `
import duckdb, json, sys
con = duckdb.connect()
try:
    con.execute("INSTALL sqlite; LOAD sqlite;")
    con.execute("CALL sqlite_attach('${remotePath}', read_only=True)")
    result = con.execute(${JSON.stringify(sql)}).fetchall()
    columns = [desc[0] for desc in con.description]
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
max_rows = ${MAX_ROWS}
truncated = len(result) > max_rows
rows = result[:max_rows]
rows_str = [[str(v) if v is not None else None for v in row] for row in rows]
print(json.dumps({"columns": columns, "rows": rows_str, "rowCount": len(result), "truncated": truncated}))
`.trim();

  const pyResult = await runPython(sessionId, code);
  if (pyResult.exitCode !== 0) {
    throw new Error(`SQLite file query failed: ${pyResult.stderr || pyResult.stdout}`);
  }
  const parsed = JSON.parse(pyResult.stdout) as {
    error?: string;
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    truncated: boolean;
  };
  if (parsed.error) throw new Error(`SQLite error: ${parsed.error}`);
  return {
    sql,
    columns: parsed.columns,
    rows: parsed.rows,
    rowCount: parsed.rowCount,
    truncated: parsed.truncated,
  };
}

// ============================================================
// SQL execution — DuckDB on file (via Daytona sandbox)
// ============================================================

/**
 * Shared Python helper that loads a CSV/Excel/Parquet file into a clean
 * Pandas DataFrame, automatically detecting and skipping leading title rows
 * (e.g. merged Excel headers like "TSPDT - 1,000 Greatest Films (Table)").
 *
 * Algorithm:
 *   Scan the first 10 rows and score each row by (non-null count × 2 + string
 *   cell count). The first row that maximises this score is treated as the
 *   header. All rows before it are discarded. Column names are trimmed,
 *   deduplicated, and numeric columns are auto-converted so SQL aggregations
 *   (SUM, AVG, etc.) work without casting.
 */
const PANDAS_LOAD_HELPER = `
import pandas as pd

def load_and_clean_file(file_path, file_format):
    if file_format == "parquet":
        return pd.read_parquet(file_path)
    if file_format == "excel":
        df_raw = pd.read_excel(file_path, header=None)
    else:
        df_raw = pd.read_csv(file_path, header=None, dtype=str)

    # Find header row: maximise (non_null*2 + string_count), prefer earliest
    best_idx, best_score = 0, -1
    for idx, row in df_raw.head(10).iterrows():
        non_null = int(row.notna().sum())
        strings  = sum(1 for v in row if isinstance(v, str) and v.strip())
        score    = non_null * 2 + strings
        if score > best_score:
            best_score, best_idx = score, idx

    df      = df_raw.iloc[best_idx + 1:].copy()
    headers = df_raw.iloc[best_idx].tolist()

    col_names, seen = [], {}
    for i, col in enumerate(headers):
        if pd.isna(col):
            name = f"Unnamed_{i}"
        elif isinstance(col, float) and col == int(col):
            name = str(int(col)).strip()  # e.g. 2025.0 -> "2025"
        else:
            name = str(col).strip()
        if not name:
            name = f"Unnamed_{i}"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 1
        col_names.append(name)

    df.columns = col_names
    df = df.reset_index(drop=True)

    for col in df.columns:
        try:
            df[col] = pd.to_numeric(df[col])
        except Exception:
            pass
    return df
`.trim();


/**
 * Execute a SELECT on a file data source using DuckDB in the Daytona sandbox.
 *
 * Strategy: create a DuckDB view named after the file (without extension) that
 * reads from the file, so the LLM-generated SQL (which references the table
 * name verbatim) works without any string substitution. String substitution
 * is fragile because the LLM may wrap the table name in double quotes, which
 * DuckDB then treats as a quoted identifier rather than a function call.
 */
export async function executeFileSql(
  sessionId: string,
  config: FileConfig,
  sql: string,
): Promise<SqlResults> {
  const safeName = config.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const remotePath = `${SANDBOX_DATA_DIR}/${safeName}`;
  const viewName = safeName.replace(/\.[^.]+$/, "");

  const code = `
import duckdb, json, sys
${PANDAS_LOAD_HELPER}
con = duckdb.connect()
try:
    df = load_and_clean_file(${JSON.stringify(remotePath)}, ${JSON.stringify(config.format)})
    con.register(${JSON.stringify(viewName)}, df)
    result  = con.execute(${JSON.stringify(sql)}).fetchall()
    columns = [desc[0] for desc in con.description]
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
max_rows  = ${MAX_ROWS}
truncated = len(result) > max_rows
rows      = result[:max_rows]
rows_str  = [[str(v) if v is not None else None for v in row] for row in rows]
print(json.dumps({"columns": columns, "rows": rows_str, "rowCount": len(result), "truncated": truncated}))
`.trim();

  const pyResult = await runPython(sessionId, code);
  if (pyResult.exitCode !== 0) {
    throw new Error(`DuckDB query failed: ${pyResult.stderr || pyResult.stdout}`);
  }

  const parsed = JSON.parse(pyResult.stdout) as {
    error?: string;
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    truncated: boolean;
  };
  if (parsed.error) {
    throw new Error(`DuckDB error: ${parsed.error}`);
  }

  return {
    sql,
    columns: parsed.columns,
    rows: parsed.rows,
    rowCount: parsed.rowCount,
    truncated: parsed.truncated,
  };
}

// ============================================================
// SQL execution — Multi-file DuckDB (all files pre-built as views)
// ============================================================

/**
 * Execute a SELECT across multiple file data sources. Each file is staged
 * in the sandbox and gets a CREATE OR REPLACE VIEW named after the file
 * (without extension), so the LLM can freely JOIN across files by table
 * name. All files are pre-built as views before the query runs — no
 * per-query guessing of which files are needed.
 *
 * View name collisions (two files with the same stem) are disambiguated
 * by appending a numeric suffix.
 */
export async function executeMultiFileSql(
  sessionId: string,
  files: FileConfig[],
  sql: string,
): Promise<SqlResults> {
  // Disambiguate duplicate stems by appending _2, _3, etc.
  const usedNames = new Set<string>();
  const viewDefs: { viewName: string; remotePath: string; format: string }[] = [];

  for (const config of files) {
    const safeName = config.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const remotePath = `${SANDBOX_DATA_DIR}/${safeName}`;
    const baseViewName = safeName.replace(/\.[^.]+$/, "");
    let viewName = baseViewName;
    let suffix = 2;
    while (usedNames.has(viewName)) {
      viewName = `${baseViewName}_${suffix++}`;
    }
    usedNames.add(viewName);
    viewDefs.push({ viewName, remotePath, format: config.format });
  }

  // Generate one load + register statement per file
  const loadStatements = viewDefs
    .map(
      (v, idx) =>
        `    df_${idx} = load_and_clean_file(${JSON.stringify(v.remotePath)}, ${JSON.stringify(v.format)})\n` +
        `    con.register(${JSON.stringify(v.viewName)}, df_${idx})`,
    )
    .join("\n");

  const code = `
import duckdb, json, sys
${PANDAS_LOAD_HELPER}
con = duckdb.connect()
try:
${loadStatements}
    result  = con.execute(${JSON.stringify(sql)}).fetchall()
    columns = [desc[0] for desc in con.description]
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
max_rows  = ${MAX_ROWS}
truncated = len(result) > max_rows
rows      = result[:max_rows]
rows_str  = [[str(v) if v is not None else None for v in row] for row in rows]
print(json.dumps({"columns": columns, "rows": rows_str, "rowCount": len(result), "truncated": truncated}))
`.trim();

  const pyResult = await runPython(sessionId, code);
  if (pyResult.exitCode !== 0) {
    throw new Error(`DuckDB multi-file query failed: ${pyResult.stderr || pyResult.stdout}`);
  }
  const parsed = JSON.parse(pyResult.stdout) as {
    error?: string;
    columns: string[];
    rows: unknown[][];
    rowCount: number;
    truncated: boolean;
  };
  if (parsed.error) throw new Error(`DuckDB error: ${parsed.error}`);
  return {
    sql,
    columns: parsed.columns,
    rows: parsed.rows,
    rowCount: parsed.rowCount,
    truncated: parsed.truncated,
  };
}

// ============================================================
// Summarize data (Daytona sandbox)
// ============================================================

/**
 * Run descriptive statistics on query results in the sandbox.
 * Returns a structured summary with stats and anomaly flags.
 */
export async function summarizeData(
  sessionId: string,
  sqlResults: SqlResults,
): Promise<SummaryPayload> {
  // Serialize the query results for Python
  const dataJson = JSON.stringify({
    columns: sqlResults.columns,
    rows: sqlResults.rows.slice(0, MAX_ROWS),
  });

  const code = `
import pandas as pd, json, sys

data = ${JSON.stringify(dataJson)}
parsed = json.loads(data)
df = pd.DataFrame(parsed["rows"], columns=parsed["columns"])

stats = {}
anomalies = []
for col in df.columns:
    s = df[col]
    if pd.api.types.is_numeric_dtype(s):
        desc = s.describe()
        stats[col] = {k: float(v) if pd.notna(v) else None for k, v in desc.items()}
        # IQR anomaly detection
        if len(s.dropna()) > 10:
            q1, q3 = s.quantile(0.25), s.quantile(0.75)
            iqr = q3 - q1
            lower = q1 - 1.5 * iqr
            upper = q3 + 1.5 * iqr
            outlier_count = int(((s < lower) | (s > upper)).sum())
            if outlier_count > 0:
                anomalies.append({"column": col, "outliers": outlier_count, "lower": float(lower), "upper": float(upper)})
    else:
        vc = s.value_counts().head(5)
        stats[col] = {"unique": int(s.nunique()), "top": {str(k): int(v) for k, v in vc.items()}}

result = {
    "shape": list(df.shape),
    "stats": stats,
    "anomalies": anomalies,
    "summary": f"Dataset has {df.shape[0]} rows and {df.shape[1]} columns. " +
               ", ".join([f"{c}: {df[c].dtype}" for c in df.columns[:5]]) +
               ("..." if len(df.columns) > 5 else "."),
}
print(json.dumps(result, default=str))
`.trim();

  const pyResult = await runPython(sessionId, code);
  if (pyResult.exitCode !== 0) {
    // If summarization fails, return a basic summary
    return {
      text: `Query returned ${sqlResults.rowCount} rows with ${sqlResults.columns.length} columns: ${sqlResults.columns.join(", ")}.`,
      stats: { rowCount: sqlResults.rowCount, columnCount: sqlResults.columns.length },
    };
  }

  const parsed = JSON.parse(pyResult.stdout) as {
    shape: number[];
    stats: Record<string, unknown>;
    anomalies: Array<Record<string, unknown>>;
    summary: string;
  };

  let text = parsed.summary;
  if (parsed.anomalies.length > 0) {
    text += ` Detected ${parsed.anomalies.length} column(s) with potential outliers: ${parsed.anomalies.map((a) => a.column).join(", ")}.`;
  }

  return {
    text,
    stats: {
      rowCount: parsed.shape[0],
      columnCount: parsed.shape[1],
      anomalyCount: parsed.anomalies.length,
    },
  };
}

// ============================================================
// Chart payload builder (pure function, no LLM call)
// ============================================================

/**
 * Build a Recharts ChartPayload from a chart spec and query results.
 * Validates that xKey and yKeys reference real columns; returns null if not.
 *
 * Used by the buildChart tool. The chart spec (chartType / xKey / yKeys /
 * title) is now decided by the agent LLM when it calls the tool, instead of
 * being pre-decided alongside the SQL in a separate LLM call.
 */
export function buildChartPayload(
  chartSpec: {
    chartType: "bar" | "line" | "area" | "pie" | "scatter";
    xKey: string;
    yKeys: string[];
    title?: string;
  },
  sqlResults: SqlResults,
): ChartPayload | null {
  if (!chartSpec || !chartSpec.xKey || chartSpec.yKeys.length === 0) {
    return null;
  }

  // Validate that xKey and yKeys exist in the result columns
  const colSet = new Set(sqlResults.columns);
  if (!colSet.has(chartSpec.xKey)) return null;
  for (const yk of chartSpec.yKeys) {
    if (!colSet.has(yk)) return null;
  }

  // Build the chart data from full results (up to 100 rows for rendering)
  const chartData = sqlResults.rows.slice(0, 100).map((row) => {
    const obj: Record<string, unknown> = {};
    sqlResults.columns.forEach((col, idx) => {
      // Try to convert numeric strings back to numbers for chart rendering
      const val = row[idx];
      if (typeof val === "string" && val !== "" && !isNaN(Number(val))) {
        obj[col] = Number(val);
      } else {
        obj[col] = val;
      }
    });
    return obj;
  });

  return {
    chartType: chartSpec.chartType,
    xKey: chartSpec.xKey,
    yKeys: chartSpec.yKeys,
    title: chartSpec.title,
    data: chartData,
  };
}

// ============================================================
// File staging helpers
// ============================================================

/**
 * Ensure a file is staged in the sandbox (upload if not already there).
 * Called before file-based queries to make sure the file is available.
 */
export async function ensureFileInSandbox(
  sessionId: string,
  config: FileConfig,
): Promise<void> {
  // The file is uploaded during schema indexing, but if the sandbox was
  // recreated (e.g., session resumed), we need to re-upload.
  // We try a quick check: if the file exists, skip. For simplicity, we just
  // re-upload (idempotent — uploadFile overwrites).
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const fileResp = await fetch(config.blobUrl, {
    headers: blobToken
      ? { Authorization: `Bearer ${blobToken}` }
      : undefined,
  });
  if (!fileResp.ok) {
    throw new Error(`Failed to download file from Blob: ${fileResp.status}`);
  }
  const fileBuffer = Buffer.from(await fileResp.arrayBuffer());
  const safeName = config.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const remotePath = `${SANDBOX_DATA_DIR}/${safeName}`;
  await uploadFileToSandbox(sessionId, fileBuffer, remotePath);
}

/** Ensure a .duckdb file is staged in the sandbox (upload if not present). */
export async function ensureDuckdbFileInSandbox(
  sessionId: string,
  config: DuckdbFileConfig,
): Promise<void> {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const fileResp = await fetch(config.blobUrl, {
    headers: blobToken
      ? { Authorization: `Bearer ${blobToken}` }
      : undefined,
  });
  if (!fileResp.ok) {
    throw new Error(`Failed to download file from Blob: ${fileResp.status}`);
  }
  const fileBuffer = Buffer.from(await fileResp.arrayBuffer());
  const safeName = config.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const remotePath = `${SANDBOX_DATA_DIR}/${safeName}`;
  await uploadFileToSandbox(sessionId, fileBuffer, remotePath);
}

/** Ensure a .sqlite/.db file is staged in the sandbox (upload if not present). */
export async function ensureSqliteFileInSandbox(
  sessionId: string,
  config: SqliteFileConfig,
): Promise<void> {
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  const fileResp = await fetch(config.blobUrl, {
    headers: blobToken
      ? { Authorization: `Bearer ${blobToken}` }
      : undefined,
  });
  if (!fileResp.ok) {
    throw new Error(`Failed to download file from Blob: ${fileResp.status}`);
  }
  const fileBuffer = Buffer.from(await fileResp.arrayBuffer());
  const safeName = config.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const remotePath = `${SANDBOX_DATA_DIR}/${safeName}`;
  await uploadFileToSandbox(sessionId, fileBuffer, remotePath);
}

// ============================================================
// ReAct agent tools
// ============================================================

/** Session-level context the tools need to execute against the right source. */
export interface AgentContext {
  sessionId: string;
  /** Single-DB mode: the bound DB data source id. Empty for multi-file. */
  dataSourceId: string;
  /** Data source type: file | pg | mysql | bigquery | duckdb | sqlite | "" */
  dataSourceType: string;
  /** Multi-file mode: bound file data source ids. Empty in single-DB mode. */
  fileDataSourceIds: string[];
}

/** Human-readable SQL dialect label, derived from the data source type. */
function dialectLabelFor(type: string): string {
  switch (type) {
    case "pg": return "PostgreSQL";
    case "mysql": return "MySQL";
    case "bigquery": return "BigQuery standard SQL";
    case "duckdb": return "DuckDB";
    case "sqlite": return "SQLite";
    case "file": return "DuckDB"; // file mode uses DuckDB under the hood
    default: return "SQL";
  }
}

/** Render SchemaColumn[] as a compact text block for the LLM. */
function formatSchemaForLlm(schema: SchemaColumn[]): string {
  if (schema.length === 0) return "(no schema columns found)";
  const tablesMap = new Map<string, SchemaColumn[]>();
  for (const col of schema) {
    const list = tablesMap.get(col.table_name) ?? [];
    list.push(col);
    tablesMap.set(col.table_name, list);
  }
  return [...tablesMap.entries()]
    .map(([table, cols]) => {
      const colLines = cols
        .map(
          (c) =>
            `  ${c.column_name} (${c.data_type})` +
            (c.sample_values.length > 0
              ? ` -- samples: ${c.sample_values.join(", ")}`
              : ""),
        )
        .join("\n");
      return `Table: ${table}\n${colLines}`;
    })
    .join("\n\n");
}

/** Render query results as a compact text preview for the LLM (first 20 rows). */
function formatResultsPreview(results: SqlResults): string {
  const header = results.columns.join(" | ");
  const sampleRows = results.rows.slice(0, 20).map((row, i) =>
    `Row ${i + 1}: ${row.map((v) => (v === null ? "NULL" : String(v))).join(" | ")}`,
  );
  const tail =
    results.truncated
      ? `\n... (${results.rowCount} total rows, showing first 20)`
      : results.rowCount > 20
        ? `\n... (${results.rowCount} total rows, showing first 20)`
        : "";
  return `Columns: ${header}\n${sampleRows.join("\n")}${tail}`;
}

/**
 * Build the 5 LangChain tools the ReAct agent can call, bound to a specific
 * session's data source context. Configs are loaded once here and closed over
 * by the tools, so each tool call doesn't re-fetch them.
 *
 * Tools:
 *   - list_tables:    list all table names in the bound data source(s)
 *   - retrieve_schema: pgvector-retrieve columns relevant to a question
 *   - execute_sql:    validate + run a SELECT; returns a table artifact
 *   - summarize_data: run a SELECT then pandas describe + outlier detection
 *   - build_chart:    run a SELECT then build a Recharts payload
 *
 * execute_sql / summarize_data / build_chart use responseFormat
 * "content_and_artifact": they return [textContent, artifact] tuples so the
 * LLM gets concise text to reason with while the UI receives a rich artifact
 * (table / summary / chart) to render inline.
 */
export async function createAgentTools(
  ctx: AgentContext,
): Promise<DynamicStructuredTool[]> {
  const admin = createAdminClient();

  // Load data source configs once. File mode stages every bound file in the
  // sandbox up front; DB mode decrypts the connection config.
  let fileConfigs: FileConfig[] = [];
  let dbType = "";
  let dbConfig:
    | PgConfig
    | MysqlConfig
    | BigQueryConfig
    | DuckdbFileConfig
    | SqliteFileConfig
    | null = null;

  if (ctx.dataSourceType === "file") {
    if (ctx.fileDataSourceIds.length === 0) {
      throw new Error("Multi-file mode selected but no file data sources provided");
    }
    const { data: dsRows } = await admin
      .from("data_sources")
      .select("config_encrypted")
      .in("id", ctx.fileDataSourceIds);
    if (!dsRows || dsRows.length === 0) {
      throw new Error("No file data sources found");
    }
    for (const row of dsRows) {
      const cfg = await decryptConfig<FileConfig>(row.config_encrypted);
      fileConfigs.push(cfg);
      await ensureFileInSandbox(ctx.sessionId, cfg);
    }
  } else if (ctx.dataSourceId) {
    const { data: ds, error } = await admin
      .from("data_sources")
      .select("type, config_encrypted")
      .eq("id", ctx.dataSourceId)
      .single();
    if (error || !ds) {
      throw new Error(`Data source not found: ${error?.message ?? "unknown"}`);
    }
    dbType = ds.type;
    dbConfig = await decryptConfig<
      PgConfig | MysqlConfig | BigQueryConfig | DuckdbFileConfig | SqliteFileConfig
    >(ds.config_encrypted);

    if (dbType === "duckdb") {
      await ensureDuckdbFileInSandbox(ctx.sessionId, dbConfig as DuckdbFileConfig);
    } else if (dbType === "sqlite") {
      await ensureSqliteFileInSandbox(ctx.sessionId, dbConfig as SqliteFileConfig);
    }
  }

  const dialectLabel = dialectLabelFor(ctx.dataSourceType || dbType);

  /** Dispatch a validated SQL string to the right executor by source type. */
  const runSql = async (sql: string): Promise<SqlResults> => {
    if (ctx.dataSourceType === "file") {
      return executeMultiFileSql(ctx.sessionId, fileConfigs, sql);
    }
    if (dbType === "pg") return executePgSql(dbConfig as PgConfig, sql);
    if (dbType === "mysql") return executeMysqlSql(dbConfig as MysqlConfig, sql);
    if (dbType === "bigquery") return executeBigQuerySql(dbConfig as BigQueryConfig, sql);
    if (dbType === "duckdb") return executeDuckdbFileSql(ctx.sessionId, dbConfig as DuckdbFileConfig, sql);
    if (dbType === "sqlite") return executeSqliteFileSql(ctx.sessionId, dbConfig as SqliteFileConfig, sql);
    throw new Error(`SQL execution not supported for data source type: ${dbType}`);
  };

  // ----------------------------------------------------------
  // Tool 1: list_tables
  // ----------------------------------------------------------
  const listTablesTool = tool(
    async () => {
      // Query schema_embeddings for distinct table names across all bound sources.
      let rows: { table_name: string }[] = [];
      if (ctx.fileDataSourceIds.length > 0) {
        const { data, error } = await admin
          .from("schema_embeddings")
          .select("table_name")
          .in("data_source_id", ctx.fileDataSourceIds);
        if (error) throw new Error(`list_tables failed: ${error.message}`);
        rows = (data ?? []) as { table_name: string }[];
      } else if (ctx.dataSourceId) {
        const { data, error } = await admin
          .from("schema_embeddings")
          .select("table_name")
          .eq("data_source_id", ctx.dataSourceId);
        if (error) throw new Error(`list_tables failed: ${error.message}`);
        rows = (data ?? []) as { table_name: string }[];
      } else {
        return "No data source is connected. Ask the user to upload a file or connect a database.";
      }

      const tables = [...new Set(rows.map((r) => r.table_name))].sort();
      if (tables.length === 0) {
        return "No tables found. The data source may not have been indexed yet.";
      }
      return `Tables in the connected data source (${dialectLabel}):\n${tables.map((t) => `- ${t}`).join("\n")}`;
    },
    {
      name: "list_tables",
      description:
        "List all table names available in the currently connected data source. " +
        "Call this first to discover what tables exist before writing SQL. " +
        "Takes no arguments.",
      schema: z.object({}),
    },
  );

  // ----------------------------------------------------------
  // Tool 2: retrieve_schema
  // ----------------------------------------------------------
  const retrieveSchemaTool = tool(
    async ({ question }) => {
      let schema: SchemaColumn[];
      if (ctx.fileDataSourceIds.length > 0) {
        schema = await retrieveSchemaMulti(ctx.fileDataSourceIds, question);
      } else if (ctx.dataSourceId) {
        schema = await retrieveSchema(ctx.dataSourceId, question);
      } else {
        return "No data source is connected.";
      }
      return formatSchemaForLlm(schema);
    },
    {
      name: "retrieve_schema",
      description:
        "Retrieve the table/column schema most relevant to a natural-language " +
        "question using semantic (pgvector) search. Returns table names, column " +
        "names, data types, and sample values. Use this to learn the exact column " +
        "names and types before writing SQL. Pass the question or topic to search for.",
      schema: z.object({
        question: z
          .string()
          .describe("The question or topic to find relevant schema columns for."),
      }),
    },
  );

  // ----------------------------------------------------------
  // Tool 3: execute_sql (returns a table artifact)
  // ----------------------------------------------------------
  const executeSqlTool = tool(
    async ({ sql }) => {
      const validation = validateSelectSql(sql);
      if (!validation.ok) {
        return [
          `SQL validation failed: ${validation.reason}\nSQL: ${sql}`,
          null,
        ] as [string, null];
      }
      try {
        const results = await runSql(sql);
        const text =
          `Query executed successfully. ${results.rowCount} row(s) returned ` +
          `(${results.truncated ? "truncated at " + MAX_ROWS : "not truncated"}).\n` +
          `SQL: ${results.sql}\n\n` +
          formatResultsPreview(results);
        const artifact: Artifact = {
          type: "table",
          payload: {
            columns: results.columns,
            rows: results.rows,
            truncated: results.truncated,
            title: "Query Results",
          },
        };
        return [text, artifact] as [string, Artifact];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [
          `SQL execution failed: ${msg}\nSQL: ${sql}\n\nYou may rewrite the SQL and try again. Common fixes: check table/column names (call retrieve_schema or list_tables), or adjust syntax for the ${dialectLabel} dialect.`,
          null,
        ] as [string, null];
      }
    },
    {
      name: "execute_sql",
      description:
        `Execute a read-only SELECT query against the connected data source (${dialectLabel}). ` +
        "Only SELECT (or WITH ... SELECT) statements are allowed — no INSERT/UPDATE/DELETE/DDL. " +
        "Results are capped at 1000 rows. The tool returns a preview of the first 20 rows plus a " +
        "rendered table artifact. If the query fails, inspect the error and rewrite the SQL.",
      schema: z.object({
        sql: z.string().describe("The read-only SELECT SQL query to execute."),
      }),
      responseFormat: "content_and_artifact" as const,
    },
  );

  // ----------------------------------------------------------
  // Tool 4: summarize_data (returns a summary artifact)
  // ----------------------------------------------------------
  const summarizeDataTool = tool(
    async ({ sql }) => {
      const validation = validateSelectSql(sql);
      if (!validation.ok) {
        return [
          `SQL validation failed: ${validation.reason}\nSQL: ${sql}`,
          null,
        ] as [string, null];
      }
      try {
        const results = await runSql(sql);
        const summary = await summarizeData(ctx.sessionId, results);
        const artifact: Artifact = {
          type: "summary",
          payload: { text: summary.text, stats: summary.stats },
        };
        return [summary.text, artifact] as [string, Artifact];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [`Summarize failed: ${msg}\nSQL: ${sql}`, null] as [string, null];
      }
    },
    {
      name: "summarize_data",
      description:
        "Run a SELECT query and compute descriptive statistics (count, mean, std, min, max, " +
        "quartiles) on numeric columns, plus top value frequencies on categorical columns, and " +
        "IQR-based outlier detection. Use this when the user asks about distributions, trends, or " +
        "wants statistical insight on a result set. Returns the summary text and a summary artifact.",
      schema: z.object({
        sql: z
          .string()
          .describe("The read-only SELECT SQL whose results should be summarized."),
      }),
      responseFormat: "content_and_artifact" as const,
    },
  );

  // ----------------------------------------------------------
  // Tool 5: build_chart (returns a chart artifact)
  // ----------------------------------------------------------
  const buildChartTool = tool(
    async ({ sql, chartType, xKey, yKeys, title }) => {
      const validation = validateSelectSql(sql);
      if (!validation.ok) {
        return [
          `SQL validation failed: ${validation.reason}\nSQL: ${sql}`,
          null,
        ] as [string, null];
      }
      try {
        const results = await runSql(sql);
        const chartPayload = buildChartPayload(
          { chartType, xKey, yKeys, title },
          results,
        );
        if (!chartPayload) {
          const cols = results.columns.join(", ");
          return [
            `Could not build chart: xKey "${xKey}" or yKeys ${JSON.stringify(yKeys)} not found in result columns [${cols}]. Choose valid columns.`,
            null,
          ] as [string, null];
        }
        const chartTitle = title || "Chart";
        const text =
          `Chart "${chartTitle}" built (${chartType}). ` +
          `x: ${xKey}, y: ${yKeys.join(", ")}, ${results.rowCount} rows.`;
        const artifact: Artifact = { type: "chart", payload: chartPayload };
        return [text, artifact] as [string, Artifact];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [`Build chart failed: ${msg}\nSQL: ${sql}`, null] as [string, null];
      }
    },
    {
      name: "build_chart",
      description:
        "Run a SELECT query and build a Recharts chart payload from the results. " +
        "Choose the chart type based on the data and the user's question: " +
        "bar (comparisons), line (trends over time), area (cumulative), pie (proportions), " +
        "scatter (correlations). xKey and yKeys MUST be actual column names in the query result. " +
        "Returns the chart text and a rendered chart artifact.",
      schema: z.object({
        sql: z.string().describe("The read-only SELECT SQL whose results feed the chart."),
        chartType: z
          .enum(["bar", "line", "area", "pie", "scatter"])
          .describe("Chart type to render."),
        xKey: z.string().describe("Column name for the x-axis."),
        yKeys: z
          .array(z.string())
          .min(1)
          .describe("Column name(s) for the y-axis (numeric measures)."),
        title: z.string().optional().describe("Optional chart title."),
      }),
      responseFormat: "content_and_artifact" as const,
    },
  );

  return [listTablesTool, retrieveSchemaTool, executeSqlTool, summarizeDataTool, buildChartTool];
}

/** Dialect label for the system prompt (kept for graph.ts to reuse). */
export function getDialectLabel(type: string): string {
  return dialectLabelFor(type);
}
