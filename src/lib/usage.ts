import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Usage logging helper — inserts a row into the `usage_logs` table.
 *
 * The table already exists (see supabase/migrations/20260629000002_app_tables.sql)
 * with columns: user_id, session_id, sandbox_seconds, tokens_in, tokens_out,
 * cost, source. RLS is bypassed via the service-role admin client because
 * usage is logged from server-side tool execution, not user-initiated writes.
 *
 * Callers:
 *   - Sandbox tools (run_python / run_forecast / run_cluster / build_plotly_chart)
 *     log sandbox_seconds with source = "daytona" via the onUsage callback.
 *   - Future LLM token logging can call this with source = "llm".
 */

export interface UsageLogParams {
  userId: string;
  sessionId?: string;
  /** Sandbox execution time in seconds. */
  sandboxSeconds?: number;
  /** LLM input tokens (prompt). */
  tokensIn?: number;
  /** LLM output tokens (completion). */
  tokensOut?: number;
  /** Estimated cost in USD. */
  cost?: number;
  /** Source category: "daytona" | "llm" | "blob" | custom string. */
  source?: string;
}

/**
 * Insert a usage_logs row. Best-effort: logs to console on failure but does
 * NOT throw, so usage logging never breaks the calling flow.
 */
export async function logUsage(params: UsageLogParams): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from("usage_logs").insert({
      user_id: params.userId,
      session_id: params.sessionId ?? null,
      sandbox_seconds: params.sandboxSeconds ?? 0,
      tokens_in: params.tokensIn ?? 0,
      tokens_out: params.tokensOut ?? 0,
      cost: params.cost ?? 0,
      source: params.source ?? null,
    });
  } catch (err) {
    // Usage logging is non-critical: never propagate the error.
    console.error("[usage] failed to log usage:", err);
  }
}
