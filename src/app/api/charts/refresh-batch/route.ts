import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { executeSqlForChart } from "@/lib/agent/sql-executor";
import {
  createSandbox,
  deleteSandbox,
  type Sandbox,
} from "@/lib/daytona/client";
import type { SqlResults } from "@/lib/agent/state";

/**
 * POST /api/charts/refresh-batch — re-execute SQL for many charts in ONE
 * request, sharing a single Daytona sandbox across all of them.
 *
 * This is the optimised data-load path for the chart library page. Instead
 * of 8 cards each calling `POST /api/charts/{id}/refresh` (which creates 8
 * separate sandboxes, ~3-8s creation each), the library grid calls this
 * endpoint once with all visible Recharts chart ids. The server:
 *
 *   1. Verifies ownership of all charts in one query.
 *   2. Creates ONE sandbox (lazily — only if at least one chart is file-backed
 *      and actually needs a sandbox; pure-DB charts skip sandbox creation).
 *   3. Iterates charts sequentially, executing each chart's SQL with the
 *      shared sandbox via `getSandbox`. Each chart's bound files are staged
 *      fresh before its SQL runs (DuckDB connections are per-call so views
 *      don't leak between charts).
 *   4. Deletes the sandbox in a `finally` block.
 *
 * Request:  { chartIds: string[] }
 * Response: { results: Record<chartId, { columns, rows, rowCount, truncated } | { error }> }
 *
 * Charts are processed sequentially (not in parallel) to avoid interleaved
 * file uploads overwriting each other inside the shared sandbox. SQL
 * execution itself is fast (~50-200ms) so the total time is dominated by
 * the single sandbox creation (~3-8s) rather than N× creation.
 */

/** Cap to prevent abuse — the library grid shows 8 per page, so 20 is
 *  plenty of headroom. */
const MAX_CHARTS_PER_BATCH = 20;

interface BatchRequest {
  chartIds?: string[];
}

type BatchResultEntry =
  | ({ columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean })
  | { error: string };

interface BatchResponse {
  results: Record<string, BatchResultEntry>;
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  let body: BatchRequest;
  try {
    body = (await req.json()) as BatchRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const chartIds = Array.isArray(body.chartIds) ? body.chartIds : [];
  if (chartIds.length === 0) {
    return NextResponse.json({ results: {} });
  }
  if (chartIds.length > MAX_CHARTS_PER_BATCH) {
    return NextResponse.json(
      { error: `Too many chart ids (max ${MAX_CHARTS_PER_BATCH})` },
      { status: 400 },
    );
  }

  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const uniqueIds: string[] = [];
  for (const id of chartIds) {
    if (typeof id === "string" && !seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }

  // Load all charts in one query (ownership + sql_text + renderer).
  const { data: charts, error: loadError } = await supabase
    .from("charts")
    .select("id, sql_text, renderer, user_id")
    .in("id", uniqueIds);

  if (loadError) {
    console.error("[charts/refresh-batch] load failed:", loadError.message);
    return NextResponse.json({ error: "Failed to load charts" }, { status: 500 });
  }

  const chartsById = new Map(
    (charts ?? []).map((c) => [c.id as string, c]),
  );

  // Pre-filter: only Recharts charts with SQL are eligible. Plotly charts
  // have their figure stored in spec and don't need refresh. Charts without
  // sql_text can't be refreshed. Return an explicit error for skipped ones
  // so the client can distinguish "missing" from "failed".
  const eligible: { id: string; sql: string }[] = [];
  const results: Record<string, BatchResultEntry> = {};

  for (const id of uniqueIds) {
    const chart = chartsById.get(id);
    if (!chart) {
      results[id] = { error: "Chart not found" };
      continue;
    }
    if (chart.user_id !== user.id) {
      results[id] = { error: "Access denied" };
      continue;
    }
    if (chart.renderer === "plotly") {
      results[id] = { error: "Plotly charts render from stored figure, no refresh needed" };
      continue;
    }
    if (!chart.sql_text) {
      results[id] = { error: "This chart has no SQL to refresh" };
      continue;
    }
    eligible.push({ id, sql: chart.sql_text });
  }

  if (eligible.length === 0) {
    return NextResponse.json<BatchResponse>({ results });
  }

  // Lazily create ONE sandbox shared across all eligible charts. The sandbox
  // is only created on the first call to `getSandbox()` — if all charts are
  // pure-DB (Postgres/MySQL/BigQuery), no sandbox is created at all.
  let sandboxPromise: Promise<Sandbox> | null = null;
  const getSandbox = (): Promise<Sandbox> => {
    if (!sandboxPromise) {
      sandboxPromise = createSandbox();
    }
    return sandboxPromise;
  };

  try {
    for (const { id, sql } of eligible) {
      try {
        const r: SqlResults = await executeSqlForChart(id, sql, user.id, getSandbox);
        results[id] = {
          columns: r.columns,
          rows: r.rows,
          rowCount: r.rowCount,
          truncated: r.truncated,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[charts/refresh-batch] chart ${id} failed:`, err);
        results[id] = { error: msg };
      }
    }
  } finally {
    // Delete the shared sandbox if one was created. This runs even if
    // the loop above threw an unhandled error (defensive).
    if (sandboxPromise) {
      try {
        const sb = await sandboxPromise;
        await deleteSandbox(sb);
      } catch (err) {
        console.error("[charts/refresh-batch] failed to clean up sandbox:", err);
      }
    }
  }

  return NextResponse.json<BatchResponse>({ results });
}
