import { Pool } from "pg";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createLLM } from "@/lib/agent/llm";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptConfig } from "@/lib/db/crypto";
import { runPython, uploadFileToSandbox, SANDBOX_DATA_DIR } from "@/lib/daytona/client";
import { retrieveSchema, type SchemaColumn } from "@/lib/agent/schema";
import type {
  SqlResults,
  ChartPayload,
  SummaryPayload,
} from "@/lib/agent/state";
import type { PgConfig, FileConfig } from "@/lib/db/schema";

/**
 * Phase 1 LangGraph node helper functions (plain functions, not @tool).
 *
 * Each function is called by a graph node in graph.ts.
 * Errors are caught and returned as structured results for the Agent to handle.
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
// NL-to-SQL generation
// ============================================================

/**
 * Generate SQL from a natural-language question using retrieved schema context.
 * The LLM also decides whether a chart and/or summary stats are warranted,
 * so downstream nodes can skip themselves without extra LLM calls.
 *
 * Returns the raw SQL string plus chart/summary decisions.
 */
export interface SqlPlan {
  sql: string;
  needsSummary: boolean;
  needsChart: boolean;
  chartSpec: {
    chartType: "bar" | "line" | "area" | "pie" | "scatter";
    xKey: string;
    yKeys: string[];
    title?: string;
  } | null;
}

export async function generateSql(
  question: string,
  schema: SchemaColumn[],
  dataSourceType: string,
): Promise<SqlPlan> {
  const llm = createLLM();

  // Build schema description for the prompt
  const tablesMap = new Map<string, SchemaColumn[]>();
  for (const col of schema) {
    const list = tablesMap.get(col.table_name) ?? [];
    list.push(col);
    tablesMap.set(col.table_name, list);
  }

  const schemaDesc = [...tablesMap.entries()]
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

  const dialectNote =
    dataSourceType === "pg"
      ? "Use standard PostgreSQL syntax."
      : "Use DuckDB syntax (e.g., read_csv_auto is not needed; the table name is the file name without extension).";

  const systemPrompt = `You are a SQL and data analysis expert. Analyze the user's question and respond with a JSON object containing:
1. "sql": a single read-only SELECT query answering the question.
2. "needsSummary": true if descriptive stats on the results would be useful (e.g., when the user asks about trends, distributions, or there are many rows). false for simple lookups, counts of a few rows, or scalar answers.
3. "needsChart": true if a chart would help answer the question. false for single-row/scalar answers, schema questions, or when the question doesn't imply visualization.
4. "chartSpec": when needsChart is true, an object { chartType, xKey, yKeys, title } where:
   - chartType: "bar" | "line" | "area" | "pie" | "scatter" (bar for comparisons, line for trends, pie for proportions, scatter for correlations)
   - xKey: column name for x-axis (must be a real column from the schema)
   - yKeys: array of column names for y-axis (must be real columns)
   - title: short chart title
   When needsChart is false, set chartSpec to null.

Rules for SQL:
- Output a single SELECT statement (no INSERT/UPDATE/DELETE/DDL).
- No semicolons, no comments.
- ${dialectNote}
- Limit results to 1000 rows unless the question asks for aggregation only.

Output ONLY the JSON object, no markdown fences, no explanation. Example:
{"sql":"SELECT region, COUNT(*) AS orders FROM orders GROUP BY region","needsSummary":true,"needsChart":true,"chartSpec":{"chartType":"bar","xKey":"region","yKeys":["orders"],"title":"Orders by Region"}}

Available schema:
${schemaDesc}`;

  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(question),
  ]);

  const raw = (response.content as string)
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  let parsed: {
    sql?: string;
    needsSummary?: boolean;
    needsChart?: boolean;
    chartSpec?: SqlPlan["chartSpec"];
  };

  try {
    parsed = JSON.parse(raw);
  } catch {
    // LLM didn't return valid JSON — fall back to treating the whole
    // response as raw SQL with conservative defaults.
    return {
      sql: raw.replace(/;+\s*$/, ""),
      needsSummary: false,
      needsChart: false,
      chartSpec: null,
    };
  }

  const sql = (parsed.sql ?? "").trim().replace(/;+\s*$/, "");

  return {
    sql,
    needsSummary: parsed.needsSummary === true,
    needsChart: parsed.needsChart === true,
    chartSpec:
      parsed.needsChart && parsed.chartSpec && parsed.chartSpec.xKey
        ? parsed.chartSpec
        : null,
  };
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
// SQL execution — DuckDB on file (via Daytona sandbox)
// ============================================================

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
  // DuckDB view name: filename without extension. UUID-like filenames start
  // with a digit, which is not a valid unquoted identifier, so always wrap
  // the view name in double quotes when creating it.
  const viewName = safeName.replace(/\.[^.]+$/, "");

  const readFunc =
    config.format === "csv"
      ? `read_csv_auto('${remotePath}', header=true)`
      : config.format === "parquet"
        ? `read_parquet('${remotePath}')`
        : config.format === "excel"
          ? `read_xlsx('${remotePath}')`
          : `read_csv_auto('${remotePath}', header=true)`;

  const code = `
import duckdb, json, sys
con = duckdb.connect()
try:
    # Create (or replace) a view so the LLM-generated SQL can reference the
    # table name directly — no string substitution needed.
    con.execute("CREATE OR REPLACE VIEW \\"${viewName}\\" AS SELECT * FROM ${readFunc}")
    result = con.execute(${JSON.stringify(sql)}).fetchall()
    columns = [desc[0] for desc in con.description]
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)

max_rows = ${MAX_ROWS}
truncated = len(result) > max_rows
rows = result[:max_rows]
# Convert all values to strings for JSON serialization
rows_str = [[str(v) if v is not None else None for v in row] for row in rows]
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
// Chart generation (LLM → Recharts spec)
// ============================================================

/**
 * Build a Recharts ChartPayload from the LLM-decided chart spec and the
 * query results. No LLM call — the spec (chartType / xKey / yKeys / title)
 * was decided alongside the SQL in generateSql.
 *
 * Validates that xKey and yKeys reference real columns; returns null if not.
 */
export function buildChartPayload(
  chartSpec: SqlPlan["chartSpec"],
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
// Combined: retrieve schema + generate SQL + execute
// ============================================================

/**
 * Full NL-to-SQL pipeline:
 * 1. Retrieve relevant schema from pgvector
 * 2. Generate SQL (plus chart/summary decisions) via LLM
 * 3. Validate SELECT-only
 * 4. Execute on the data source (PG or file/DuckDB)
 *
 * @returns SqlResults + the SQL + chart/summary decisions, or throws on failure
 */
export async function nlToSql(params: {
  sessionId: string;
  dataSourceId: string;
  question: string;
}): Promise<{
  sql: string;
  results: SqlResults;
  schema: SchemaColumn[];
  needsSummary: boolean;
  needsChart: boolean;
  chartSpec: SqlPlan["chartSpec"];
}> {
  const { sessionId, dataSourceId, question } = params;

  // 1. Retrieve schema
  const schema = await retrieveSchema(dataSourceId, question);

  // 2. Load data source config
  const admin = createAdminClient();
  const { data: ds, error } = await admin
    .from("data_sources")
    .select("type, config_encrypted")
    .eq("id", dataSourceId)
    .single();
  if (error || !ds) {
    throw new Error(`Data source not found: ${error?.message ?? "unknown"}`);
  }

  // 3. Generate SQL + chart/summary decisions in one LLM call
  const plan = await generateSql(question, schema, ds.type);

  // 4. Validate
  const validation = validateSelectSql(plan.sql);
  if (!validation.ok) {
    throw new Error(`Generated SQL failed validation: ${validation.reason}. SQL: ${plan.sql}`);
  }

  // 5. Execute
  let results: SqlResults;
  if (ds.type === "pg") {
    const config = await decryptConfig<PgConfig>(ds.config_encrypted);
    results = await executePgSql(config, plan.sql);
  } else if (ds.type === "file") {
    const config = await decryptConfig<FileConfig>(ds.config_encrypted);
    // Ensure file is staged in sandbox before executing
    await ensureFileInSandbox(sessionId, config);
    results = await executeFileSql(sessionId, config, plan.sql);
  } else {
    throw new Error(`SQL execution not supported for data source type: ${ds.type}`);
  }

  return {
    sql: plan.sql,
    results,
    schema,
    needsSummary: plan.needsSummary,
    needsChart: plan.needsChart,
    chartSpec: plan.chartSpec,
  };
}

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
