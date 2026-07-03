/**
 * Shared SQL execution utility for chart refresh and chat history re-query.
 *
 * The agent tools (tools.ts) embed SQL execution inside a closure (`runSql`)
 * that is bound to a session's data source context. This module extracts the
 * same dispatch logic into reusable functions that can be called from API
 * routes outside the agent loop (e.g. /api/charts/[id]/refresh,
 * /api/sessions/[sessionId]/query).
 *
 * For file-based data sources, a temporary sandbox is created and deleted
 * per call (no request-level reuse). This is slower than the agent's
 * shared sandbox but simpler for one-shot re-queries.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { decryptConfig } from "@/lib/db/crypto";
import {
  executePgSql,
  executeMysqlSql,
  executeBigQuerySql,
  executeDuckdbFileSql,
  executeSqliteFileSql,
  executeMultiFileSql,
  validateSelectSql,
} from "@/lib/agent/tools";
import type { SqlResults } from "@/lib/agent/state";
import type {
  PgConfig,
  MysqlConfig,
  BigQueryConfig,
  DuckdbFileConfig,
  SqliteFileConfig,
  FileConfig,
} from "@/lib/db/schema";

/** Information about a bound data source, loaded from DB. */
interface LoadedDataSource {
  id: string;
  type: string;
  config: unknown;
  meta: Record<string, unknown>;
}

/** Load and decrypt a single data source by ID. Returns null if not found. */
async function loadDataSource(
  dataSourceId: string,
): Promise<LoadedDataSource | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("data_sources")
    .select("id, type, config_encrypted, meta")
    .eq("id", dataSourceId)
    .single();
  if (error || !data) return null;
  const config = await decryptConfig(data.config_encrypted);
  return {
    id: data.id,
    type: data.type,
    config,
    meta: (data.meta ?? {}) as Record<string, unknown>,
  };
}

/** Load all data sources bound to a session.
 *  Returns DB-mode (single source) or file-mode (multiple sources). */
async function loadSessionDataSources(
  sessionId: string,
): Promise<{
  mode: "database" | "files";
  sources: LoadedDataSource[];
}> {
  const admin = createAdminClient();
  const { data: session } = await admin
    .from("sessions")
    .select("data_source_id")
    .eq("id", sessionId)
    .single();
  if (!session) throw new Error("Session not found");

  if (session.data_source_id) {
    // Single-DB mode
    const ds = await loadDataSource(session.data_source_id);
    if (!ds) throw new Error("Session data source not found");
    return { mode: "database", sources: [ds] };
  }

  // Multi-file mode
  const { data: links } = await admin
    .from("session_data_sources")
    .select("data_source_id")
    .eq("session_id", sessionId);
  if (!links || links.length === 0) {
    throw new Error("No data sources bound to this session");
  }
  const sources: LoadedDataSource[] = [];
  for (const link of links) {
    const ds = await loadDataSource(link.data_source_id as string);
    if (ds) sources.push(ds);
  }
  if (sources.length === 0) {
    throw new Error("No data sources found for this session");
  }
  return { mode: "files", sources };
}

/** Load all data sources bound to a chart. */
async function loadChartDataSources(
  chartId: string,
): Promise<{ sources: LoadedDataSource[] }> {
  const admin = createAdminClient();
  const { data: links } = await admin
    .from("chart_data_sources")
    .select("data_source_id")
    .eq("chart_id", chartId);
  if (!links || links.length === 0) {
    throw new Error("No data sources bound to this chart");
  }
  const sources: LoadedDataSource[] = [];
  for (const link of links) {
    const ds = await loadDataSource(link.data_source_id as string);
    if (ds) sources.push(ds);
  }
  if (sources.length === 0) {
    throw new Error("No data sources found for this chart");
  }
  return { sources };
}

/** Dispatch a validated SQL string to the right executor by source type.
 *  For file-based sources, creates a temporary sandbox per call. */
async function dispatchSql(
  sources: LoadedDataSource[],
  mode: "database" | "files",
  sessionId: string,
  userId: string,
  sql: string,
): Promise<SqlResults> {
  if (mode === "files" || sources.every((s) => s.type === "file")) {
    // Multi-file mode: all sources are file-type
    const fileConfigs = sources.map((s) => s.config as FileConfig);
    const fileMetas = sources.map((s) => s.meta);
    return executeMultiFileSql(sessionId, fileConfigs, fileMetas, userId, sql);
  }

  // Single-DB mode
  const ds = sources[0];
  switch (ds.type) {
    case "pg":
      return executePgSql(ds.config as PgConfig, sql);
    case "mysql":
      return executeMysqlSql(ds.config as MysqlConfig, sql);
    case "bigquery":
      return executeBigQuerySql(ds.config as BigQueryConfig, sql);
    case "duckdb":
      return executeDuckdbFileSql(
        sessionId,
        ds.config as DuckdbFileConfig,
        ds.meta,
        userId,
        sql,
      );
    case "sqlite":
      return executeSqliteFileSql(
        sessionId,
        ds.config as SqliteFileConfig,
        ds.meta,
        userId,
        sql,
      );
    default:
      throw new Error(`SQL execution not supported for data source type: ${ds.type}`);
  }
}

/** Execute a SQL query against a session's bound data sources.
 *  Used by /api/sessions/[sessionId]/query for chat history re-query. */
export async function executeSqlForSession(
  sessionId: string,
  sql: string,
  userId: string,
): Promise<SqlResults> {
  const validation = validateSelectSql(sql);
  if (!validation.ok) {
    throw new Error(`SQL validation failed: ${validation.reason}`);
  }
  const { mode, sources } = await loadSessionDataSources(sessionId);
  return dispatchSql(sources, mode, sessionId, userId, sql);
}

/** Execute a SQL query against a chart's bound data sources.
 *  Used by /api/charts/[id]/refresh for chart library re-query. */
export async function executeSqlForChart(
  chartId: string,
  sql: string,
  userId: string,
): Promise<SqlResults> {
  const validation = validateSelectSql(sql);
  if (!validation.ok) {
    throw new Error(`SQL validation failed: ${validation.reason}`);
  }
  const { sources } = await loadChartDataSources(chartId);
  // Charts bound to file-type sources use multi-file mode; charts bound
  // to a single DB source use database mode.
  const mode = sources.every((s) => s.type === "file") ? "files" : "database";
  // Use chartId as the sandbox session id (creates a unique sandbox per chart refresh).
  return dispatchSql(sources, mode, `chart-${chartId}`, userId, sql);
}
