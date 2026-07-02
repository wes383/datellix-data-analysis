import { Pool } from "pg";
import mysql, { type Pool as MysqlPool } from "mysql2/promise";
import { BigQuery } from "@google-cloud/bigquery";
import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptConfig } from "@/lib/db/crypto";
import { runPython, SANDBOX_DATA_DIR, type SandboxProvider } from "@/lib/daytona/client";
import { retrieveSchema, retrieveSchemaMulti, type SchemaColumn } from "@/lib/agent/schema";
import { logUsage } from "@/lib/usage";
import type {
  SqlResults,
  ChartPayload,
  SummaryPayload,
  ForecastPayload,
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
  getSandbox?: SandboxProvider,
): Promise<SqlResults> {
  const safeName = config.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const remotePath = `${SANDBOX_DATA_DIR}/${safeName}`;
  const stagedFile = await downloadFileForSandbox(config);

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

  const pyResult = await runPython(sessionId, code, { files: [stagedFile], getSandbox });
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
  getSandbox?: SandboxProvider,
): Promise<SqlResults> {
  const safeName = config.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const remotePath = `${SANDBOX_DATA_DIR}/${safeName}`;
  const stagedFile = await downloadFileForSandbox(config);

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

  const pyResult = await runPython(sessionId, code, { files: [stagedFile], getSandbox });
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
  getSandbox?: SandboxProvider,
): Promise<SqlResults> {
  const safeName = config.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const remotePath = `${SANDBOX_DATA_DIR}/${safeName}`;
  const viewName = safeName.replace(/\.[^.]+$/, "");
  const stagedFile = await downloadFileForSandbox(config);

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

  const pyResult = await runPython(sessionId, code, { files: [stagedFile], getSandbox });
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
  getSandbox?: SandboxProvider,
): Promise<SqlResults> {
  // Disambiguate duplicate stems by appending _2, _3, etc.
  const usedNames = new Set<string>();
  const viewDefs: { viewName: string; remotePath: string; format: string }[] = [];
  const stagedFiles: Array<{ buffer: Buffer; remotePath: string }> = [];

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
    // Download each file from Blob for staging in the ephemeral sandbox.
    const staged = await downloadFileForSandbox(config);
    stagedFiles.push(staged);
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

  const pyResult = await runPython(sessionId, code, { files: stagedFiles, getSandbox });
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
  getSandbox?: SandboxProvider,
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

  const pyResult = await runPython(sessionId, code, { getSandbox });
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
// File download helpers
// ============================================================

/** Download a file from Vercel Blob and return { buffer, remotePath } for
 *  staging in the ephemeral sandbox. All file-based configs share the same
 *  blobUrl + filename shape, so one helper covers all types. */
async function downloadFileForSandbox(
  config: FileConfig | DuckdbFileConfig | SqliteFileConfig,
): Promise<{ buffer: Buffer; remotePath: string }> {
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
  return { buffer: fileBuffer, remotePath };
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
  /** Auth user id — used by sandbox tools to log usage to `usage_logs`. */
  userId: string;
  /**
   * Lazy resolver for a shared request-level sandbox. When provided, all
   * tool calls in this ReAct turn reuse the same sandbox (created on first
   * use, deleted by the route handler when the stream ends). When omitted,
   * each `runPython` call falls back to ephemeral create+delete.
   */
  getSandbox?: SandboxProvider;
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
 * Build the LangChain tools the ReAct agent can call, bound to a specific
 * session's data source context. Configs are loaded once here and closed over
 * by the tools, so each tool call doesn't re-fetch them.
 *
 * Tools:
 *   - list_tables:        list all table names in the bound data source(s)
 *   - retrieve_schema:    pgvector-retrieve columns relevant to a question
 *   - execute_sql:        validate + run a SELECT; returns a table artifact
 *   - summarize_data:     run a SELECT then pandas describe + outlier detection
 *   - build_chart:        run a SELECT then build a Recharts payload
 *   - run_python:         execute arbitrary Python in the sandbox (Phase 2 §2.1)
 *   - run_forecast:       ARIMA/ETS/linear time series forecasting (Phase 2 §2.2)
 *   - run_cluster:        KMeans/DBSCAN clustering with PCA 2D viz (Phase 2 §2.2)
 *   - build_plotly_chart: generate complex Plotly charts (Phase 2 §2.3)
 *
 * execute_sql / summarize_data / build_chart / run_python / run_forecast /
 * run_cluster / build_plotly_chart use responseFormat "content_and_artifact":
 * they return [textContent, artifact] tuples so the LLM gets concise text to
 * reason with while the UI receives a rich artifact to render inline.
 */
export async function createAgentTools(
  ctx: AgentContext,
): Promise<DynamicStructuredTool[]> {
  const admin = createAdminClient();

  // Load data source configs once. File mode stores configs for later
  // per-call staging (download + upload in runPython); DB mode decrypts
  // the connection config. No sandbox is created here — request-level
  // reuse lazily creates one on the first runPython call (via
  // ctx.getSandbox) and shares it across the whole ReAct turn; if
  // ctx.getSandbox is absent, runPython falls back to ephemeral mode.
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
  }

  const dialectLabel = dialectLabelFor(ctx.dataSourceType || dbType);

  /** Dispatch a validated SQL string to the right executor by source type. */
  const runSql = async (sql: string): Promise<SqlResults> => {
    if (ctx.dataSourceType === "file") {
      return executeMultiFileSql(ctx.sessionId, fileConfigs, sql, ctx.getSandbox);
    }
    if (dbType === "pg") return executePgSql(dbConfig as PgConfig, sql);
    if (dbType === "mysql") return executeMysqlSql(dbConfig as MysqlConfig, sql);
    if (dbType === "bigquery") return executeBigQuerySql(dbConfig as BigQueryConfig, sql);
    if (dbType === "duckdb") return executeDuckdbFileSql(ctx.sessionId, dbConfig as DuckdbFileConfig, sql, ctx.getSandbox);
    if (dbType === "sqlite") return executeSqliteFileSql(ctx.sessionId, dbConfig as SqliteFileConfig, sql, ctx.getSandbox);
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
        const summary = await summarizeData(ctx.sessionId, results, ctx.getSandbox);
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

  // ----------------------------------------------------------
  // Shared sandbox usage callback — logs each Python execution's
  // elapsed seconds to the usage_logs table. Used by the four
  // Phase 2 tools below (run_python / run_forecast / run_cluster /
  // build_plotly_chart).
  // ----------------------------------------------------------
  const onSandboxUsage = async (seconds: number): Promise<void> => {
    await logUsage({
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      sandboxSeconds: seconds,
      source: "daytona",
    });
  };

  // ----------------------------------------------------------
  // Tool 6: run_python (Phase 2 §2.1)
  // Execute arbitrary Python in the sandbox. Optionally pre-load a
  // SQL query result as a pandas DataFrame variable `df`.
  // ----------------------------------------------------------
  const runPythonTool = tool(
    async ({ code, sql }) => {
      let preamble = "";
      if (sql) {
        const validation = validateSelectSql(sql);
        if (!validation.ok) {
          return [
            `SQL validation failed: ${validation.reason}`,
            null,
          ] as [string, null];
        }
        try {
          const results = await runSql(sql);
          const dataJson = JSON.stringify({
            columns: results.columns,
            rows: results.rows,
          });
          preamble = `
import pandas as pd, json
_parsed = json.loads(${JSON.stringify(dataJson)})
df = pd.DataFrame(_parsed["rows"], columns=_parsed["columns"])
`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return [
            `SQL pre-load failed: ${msg}\nSQL: ${sql}`,
            null,
          ] as [string, null];
        }
      }
      try {
        const result = await runPython(
          ctx.sessionId,
          preamble + "\n" + code,
          { onUsage: onSandboxUsage, getSandbox: ctx.getSandbox },
        );
        if (result.exitCode !== 0) {
          return [
            `Python execution failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
            null,
          ] as [string, null];
        }
        const stdout = result.stdout || "(no output)";
        // The code is streamed to the UI *before* execution starts via
        // tool_progress events emitted from route.ts as soon as the LLM
        // finishes writing the tool-call args. This tool only returns the
        // output so we don't duplicate the code in the final tool result.
        return [stdout, null] as [string, null];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [`Python execution error: ${msg}`, null] as [string, null];
      }
    },
    {
      name: "run_python",
      description:
        "Execute Python code in the sandbox (pandas, duckdb, sklearn, statsmodels, matplotlib, plotly available). " +
        "Optionally provide a SQL query to pre-load results as a pandas DataFrame variable `df`. " +
        "Print results to stdout with print(). Useful for complex transformations, feature engineering, " +
        "custom analysis, and generating Plotly figures. The code runs in an isolated sandbox. " +
        "IMPORTANT: Do NOT call fig.show() — the sandbox has no display and the figure will be lost. " +
        "To render a Plotly chart in the chat, use the build_plotly_chart tool instead, which captures " +
        "the `fig` variable and streams it to the UI as a renderable artifact.",
      schema: z.object({
        code: z
          .string()
          .describe(
            "Python code to execute. If SQL is provided, `df` is available as a pandas DataFrame.",
          ),
        sql: z
          .string()
          .optional()
          .describe(
            "Optional read-only SELECT to pre-load results as `df` before running the code.",
          ),
      }),
      responseFormat: "content_and_artifact" as const,
    },
  );

  // ----------------------------------------------------------
  // Tool 7: run_forecast (Phase 2 §2.2)
  // Time series forecasting via statsmodels (ARIMA / ETS) or
  // sklearn (linear). Evaluates on a holdout, then refits on the
  // full series and forecasts `horizon` future periods. Returns a
  // forecast artifact with predictions + metrics.
  // ----------------------------------------------------------
  const runForecastTool = tool(
    async ({ sql, dateColumn, valueColumn, horizon, method }) => {
      const validation = validateSelectSql(sql);
      if (!validation.ok) {
        return [
          `SQL validation failed: ${validation.reason}`,
          null,
        ] as [string, null];
      }
      try {
        const results = await runSql(sql);
        const dataJson = JSON.stringify({
          columns: results.columns,
          rows: results.rows,
        });

        const pythonCode = `
import pandas as pd, json, sys, warnings
import numpy as np
from sklearn.metrics import mean_absolute_error, mean_squared_error

# Suppress all warnings to keep stdout clean for JSON.parse. statsmodels,
# sklearn, and pandas emit ConvergenceWarning / DeprecationWarning to
# stdout/stderr that would otherwise corrupt the JSON output.
warnings.filterwarnings("ignore")

_parsed = json.loads(${JSON.stringify(dataJson)})
df = pd.DataFrame(_parsed["rows"], columns=_parsed["columns"])
df[${JSON.stringify(dateColumn)}] = pd.to_datetime(df[${JSON.stringify(dateColumn)}], errors='coerce')
df = df.dropna(subset=[${JSON.stringify(dateColumn)}])
df = df.sort_values(${JSON.stringify(dateColumn)}).reset_index(drop=True)
df[${JSON.stringify(valueColumn)}] = pd.to_numeric(df[${JSON.stringify(valueColumn)}], errors='coerce')
series = df.dropna(subset=[${JSON.stringify(valueColumn)}]).reset_index(drop=True)

horizon = ${horizon}
method = ${JSON.stringify(method)}

if len(series) <= horizon * 2:
    result = {"error": "Not enough data points for forecasting with holdout evaluation"}
    print(json.dumps(result)); sys.exit(0)

train = series.iloc[:-horizon]
test = series.iloc[-horizon:]

if method == "arima":
    from statsmodels.tsa.arima.model import ARIMA
    model = ARIMA(train[${JSON.stringify(valueColumn)}].astype(float), order=(1,1,1))
    fitted = model.fit()
    fc = fitted.forecast(steps=horizon)
elif method == "ets":
    from statsmodels.tsa.holtwinters import ExponentialSmoothing
    model = ExponentialSmoothing(train[${JSON.stringify(valueColumn)}].astype(float), trend='add')
    fitted = model.fit()
    fc = fitted.forecast(steps=horizon)
else:
    from sklearn.linear_model import LinearRegression
    X = np.arange(len(train)).reshape(-1, 1)
    lr = LinearRegression().fit(X, train[${JSON.stringify(valueColumn)}].astype(float))
    fc = lr.predict(np.arange(len(train), len(train) + horizon).reshape(-1, 1))

test_vals = test[${JSON.stringify(valueColumn)}].astype(float).values
mae = float(mean_absolute_error(test_vals, fc))
rmse = float(np.sqrt(mean_squared_error(test_vals, fc)))
nonzero = test_vals != 0
mape = float(np.mean(np.abs((test_vals[nonzero] - fc[nonzero]) / test_vals[nonzero])) * 100) if nonzero.any() else 0.0

# Refit on full data and forecast future
if method == "arima":
    model_full = ARIMA(series[${JSON.stringify(valueColumn)}].astype(float), order=(1,1,1))
    fitted_full = model_full.fit()
    future_fc = fitted_full.forecast(steps=horizon)
elif method == "ets":
    model_full = ExponentialSmoothing(series[${JSON.stringify(valueColumn)}].astype(float), trend='add')
    fitted_full = model_full.fit()
    future_fc = fitted_full.forecast(steps=horizon)
else:
    X_full = np.arange(len(series)).reshape(-1, 1)
    lr_full = LinearRegression().fit(X_full, series[${JSON.stringify(valueColumn)}].astype(float))
    future_fc = lr_full.predict(np.arange(len(series), len(series) + horizon).reshape(-1, 1))

# Infer frequency from the date column. If inference fails (e.g. yearly data
# with only 1-year gaps), fall back to "YS" for year-start or "D" otherwise.
# Without a valid freq string, pd.date_range with a string start date would
# fall back to a numeric offset and crash with a TypeError when the start
# is a Timestamp and the offset is a string.
inferred_freq = pd.infer_freq(series[${JSON.stringify(dateColumn)}])
if inferred_freq is None:
    # Try common yearly fallback: if the median gap between consecutive
    # dates is ~1 year, use "YS" (year start); otherwise default to "D".
    deltas = series[${JSON.stringify(dateColumn)}].diff().dropna().dt.days
    if len(deltas) > 0 and float(deltas.median()) >= 360:
        inferred_freq = "YS"
    else:
        inferred_freq = "D"

last_date = series[${JSON.stringify(dateColumn)}].iloc[-1]
future_dates = pd.date_range(start=last_date, periods=horizon + 1, freq=inferred_freq)[1:]

predictions = []
for _, row in series.iterrows():
    predictions.append({"date": str(row[${JSON.stringify(dateColumn)}].date()), "actual": float(row[${JSON.stringify(valueColumn)}]), "forecast": None})
for dt, val in zip(future_dates, future_fc):
    predictions.append({"date": str(dt.date()), "actual": None, "forecast": float(val)})

result = {
    "method": method,
    "horizon": horizon,
    "metrics": {"mae": mae, "rmse": rmse, "mape": mape},
    "predictions": predictions,
    "summary": f"{method.upper()} forecast for {horizon} periods. Holdout metrics: MAE={mae:.2f}, RMSE={rmse:.2f}, MAPE={mape:.1f}%."
}
print(json.dumps(result, default=str))
`.trim();

        const pyResult = await runPython(
          ctx.sessionId,
          pythonCode,
          { onUsage: onSandboxUsage, getSandbox: ctx.getSandbox },
        );
        if (pyResult.exitCode !== 0) {
          return [
            `Forecast failed: ${pyResult.stderr || pyResult.stdout}`,
            null,
          ] as [string, null];
        }
        const parsed = JSON.parse(pyResult.stdout) as ForecastPayload & {
          error?: string;
        };
        if (parsed.error) {
          return [`Forecast error: ${parsed.error}`, null] as [string, null];
        }
        const artifact: Artifact = { type: "forecast", payload: parsed };
        return [parsed.summary, artifact] as [string, Artifact];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [`Forecast error: ${msg}`, null] as [string, null];
      }
    },
    {
      name: "run_forecast",
      description:
        "Run time series forecasting on query results. Supports ARIMA, ETS (exponential smoothing), and linear regression. " +
        "Evaluates on a holdout set and reports MAE/RMSE/MAPE, then forecasts future periods. " +
        "Returns a forecast artifact with historical actuals + future predictions and evaluation metrics. " +
        "The SQL must return a date/time column and a numeric value column.",
      schema: z.object({
        sql: z.string().describe("Read-only SELECT returning the time series data."),
        dateColumn: z.string().describe("Column name containing dates/timestamps."),
        valueColumn: z.string().describe("Column name containing the numeric value to forecast."),
        horizon: z.number().int().min(1).max(90).describe("Number of future periods to forecast."),
        method: z.enum(["arima", "ets", "linear"]).describe("Forecasting method."),
      }),
      responseFormat: "content_and_artifact" as const,
    },
  );

  // ----------------------------------------------------------
  // Tool 8: run_cluster (Phase 2 §2.2)
  // KMeans / DBSCAN clustering on query results. Reduces features
  // to 2D via PCA and returns a Recharts scatter chart colored by
  // cluster label, plus a textual summary.
  // ----------------------------------------------------------
  const runClusterTool = tool(
    async ({ sql, features, method, nClusters }) => {
      const validation = validateSelectSql(sql);
      if (!validation.ok) {
        return [
          `SQL validation failed: ${validation.reason}`,
          null,
        ] as [string, null];
      }
      try {
        const results = await runSql(sql);
        const dataJson = JSON.stringify({
          columns: results.columns,
          rows: results.rows,
        });
        const featuresJson = JSON.stringify(features);
        const methodJson = JSON.stringify(method);
        const kVal = nClusters ?? 3;

        const pythonCode = `
import pandas as pd, json, sys
import numpy as np
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA
from sklearn.cluster import KMeans, DBSCAN

_parsed = json.loads(${JSON.stringify(dataJson)})
df = pd.DataFrame(_parsed["rows"], columns=_parsed["columns"])
features = ${featuresJson}
method = ${methodJson}

for f in features:
    df[f] = pd.to_numeric(df[f], errors='coerce')
X = df[features].dropna()
if len(X) < 2:
    result = {"error": "Not enough valid numeric rows for clustering"}
    print(json.dumps(result)); sys.exit(0)

X_scaled = StandardScaler().fit_transform(X.values)

if method == "dbscan":
    clusterer = DBSCAN(eps=0.5, min_samples=5)
    labels = clusterer.fit_predict(X_scaled)
else:
    k = ${kVal}
    clusterer = KMeans(n_clusters=k, n_init=10, random_state=42)
    labels = clusterer.fit_predict(X_scaled)

pca = PCA(n_components=2)
coords = pca.fit_transform(X_scaled)

chart_data = []
for i, (x, y) in enumerate(coords):
    chart_data.append({"x": float(x), "y": float(y), "cluster": int(labels[i])})

n_clusters = len(set(labels)) - (1 if -1 in labels else 0)
n_noise = int(sum(labels == -1))

summary = (
    f"{method} clustering found {n_clusters} cluster(s) across {len(labels)} points"
    + (f", {n_noise} noise points" if n_noise > 0 else "")
    + f". Features: {', '.join(features)}."
)

result = {
    "chartData": chart_data,
    "nClusters": n_clusters,
    "nNoise": n_noise,
    "nPoints": len(labels),
    "method": method,
    "summary": summary
}
print(json.dumps(result, default=str))
`.trim();

        const pyResult = await runPython(
          ctx.sessionId,
          pythonCode,
          { onUsage: onSandboxUsage, getSandbox: ctx.getSandbox },
        );
        if (pyResult.exitCode !== 0) {
          return [
            `Clustering failed: ${pyResult.stderr || pyResult.stdout}`,
            null,
          ] as [string, null];
        }
        const parsed = JSON.parse(pyResult.stdout) as {
          chartData: { x: number; y: number; cluster: number }[];
          nClusters: number;
          nNoise: number;
          nPoints: number;
          method: string;
          summary: string;
          error?: string;
        };
        if (parsed.error) {
          return [`Clustering error: ${parsed.error}`, null] as [string, null];
        }

        // Build a Recharts scatter chart: x = PC1, y = PC2, color by cluster.
        // Recharts scatter takes a single data array; cluster id is encoded
        // per-point so the frontend could split series later if needed.
        const chartData = parsed.chartData.map((pt, i) => ({
          idx: i,
          x: pt.x,
          y: pt.y,
          cluster: pt.cluster === -1 ? "Noise" : `Cluster ${pt.cluster}`,
        }));

        const artifact: Artifact = {
          type: "chart",
          payload: {
            chartType: "scatter" as const,
            data: chartData,
            xKey: "x",
            yKeys: ["y"],
            groupKey: "cluster",
            title: `Clustering (${parsed.method})`,
          },
        };
        return [parsed.summary, artifact] as [string, Artifact];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [`Clustering error: ${msg}`, null] as [string, null];
      }
    },
    {
      name: "run_cluster",
      description:
        "Run KMeans or DBSCAN clustering on query results and visualize with PCA 2D projection. " +
        "Returns a scatter chart colored by cluster assignment and a summary of cluster counts. " +
        "The SQL must return numeric feature columns suitable for clustering.",
      schema: z.object({
        sql: z.string().describe("Read-only SELECT returning data to cluster."),
        features: z
          .array(z.string())
          .min(2)
          .describe("Numeric column names to use as clustering features."),
        method: z.enum(["kmeans", "dbscan"]).describe("Clustering algorithm."),
        nClusters: z
          .number()
          .int()
          .min(2)
          .max(10)
          .optional()
          .describe("Number of clusters (KMeans only). Default 3."),
      }),
      responseFormat: "content_and_artifact" as const,
    },
  );

  // ----------------------------------------------------------
  // Tool 9: build_plotly_chart (Phase 2 §2.3)
  // Run Python code that builds a Plotly figure and assigns it to
  // `fig`. The figure JSON is extracted via fig.to_json() and
  // returned as a chart artifact with renderer="plotly".
  // ----------------------------------------------------------
  const buildPlotlyChartTool = tool(
    async ({ sql, pythonCode, title }) => {
      const validation = validateSelectSql(sql);
      if (!validation.ok) {
        return [
          `SQL validation failed: ${validation.reason}`,
          null,
        ] as [string, null];
      }
      try {
        const results = await runSql(sql);
        const dataJson = JSON.stringify({
          columns: results.columns,
          rows: results.rows,
        });

        const wrappedCode = `
import pandas as pd, json, sys
_parsed = json.loads(${JSON.stringify(dataJson)})
df = pd.DataFrame(_parsed["rows"], columns=_parsed["columns"])

${pythonCode}

if 'fig' not in dir():
    print(json.dumps({"error": "Code must assign a plotly figure to variable 'fig'"}))
    sys.exit(1)

figure_json = fig.to_json()
print(figure_json)
`.trim();

        const pyResult = await runPython(
          ctx.sessionId,
          wrappedCode,
          { onUsage: onSandboxUsage, getSandbox: ctx.getSandbox },
        );
        if (pyResult.exitCode !== 0) {
          return [
            `Plotly chart generation failed: ${pyResult.stderr || pyResult.stdout}`,
            null,
          ] as [string, null];
        }

        let figure: Record<string, unknown>;
        try {
          figure = JSON.parse(pyResult.stdout) as Record<string, unknown>;
        } catch {
          return [
            `Plotly figure JSON parse failed. Output was: ${pyResult.stdout.slice(0, 500)}`,
            null,
          ] as [string, null];
        }

        if (figure.error) {
          return [
            `Plotly error: ${figure.error}`,
            null,
          ] as [string, null];
        }

        const artifact: Artifact = {
          type: "chart",
          payload: {
            renderer: "plotly" as const,
            plotlyFigure: figure,
            // Required Recharts fields (unused but must satisfy ChartPayload type):
            chartType: "scatter" as const,
            data: [],
            xKey: "",
            yKeys: [],
            title,
          } as ChartPayload,
        };
        return [
          `Plotly chart "${title ?? "Chart"}" generated successfully.`,
          artifact,
        ] as [string, Artifact];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [`Plotly chart error: ${msg}`, null] as [string, null];
      }
    },
    {
      name: "build_plotly_chart",
      description:
        "Generate a complex Plotly chart (3D, geographic, large scatter, etc.) by running Python code in the sandbox. " +
        "Provide a SQL query to load data as `df`, then Python code that creates a plotly figure and assigns it to variable `fig`. " +
        "The plotly, plotly.express, and plotly.graph_objects libraries are available. " +
        "Use this for visualizations that Recharts can't handle: 3D scatter/surface, choropleth maps, sankey, treemap, large datasets.",
      schema: z.object({
        sql: z.string().describe("Read-only SELECT to load data as DataFrame `df`."),
        pythonCode: z
          .string()
          .describe(
            "Python code that creates a plotly figure and assigns it to `fig`. Example: `import plotly.express as px; fig = px.scatter_3d(df, x='col1', y='col2', z='col3')`",
          ),
        title: z.string().optional().describe("Optional chart title."),
      }),
      responseFormat: "content_and_artifact" as const,
    },
  );

  return [
    listTablesTool,
    retrieveSchemaTool,
    executeSqlTool,
    summarizeDataTool,
    buildChartTool,
    runPythonTool,
    runForecastTool,
    runClusterTool,
    buildPlotlyChartTool,
  ];
}

/** Dialect label for the system prompt (kept for graph.ts to reuse). */
export function getDialectLabel(type: string): string {
  return dialectLabelFor(type);
}
