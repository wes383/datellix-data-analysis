import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UsageDashboard, type ByDayRow, type Totals } from "@/components/usage/usage-dashboard";

/**
 * Usage dashboard page (Phase 3 §3.4.1).
 *
 * Aggregates the user's `usage_logs` over the last 90 days and hands the
 * grouped data to the client-side dashboard. Aggregation is done in JS (not a
 * Supabase RPC) to avoid a new DB migration — the row volume here is small
 * (capped at 1000). No cost is computed (per user decision: raw usage only).
 */
export default async function UsagePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("usage_logs")
    .select("sandbox_seconds, tokens_in, tokens_out, source, created_at")
    .eq("user_id", user.id)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) {
    console.error("[usage page] failed to load usage_logs:", error.message);
  }

  const rows = (data ?? []) as Array<{
    sandbox_seconds: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    source: string | null;
    created_at: string;
  }>;

  // Aggregate by day + source.
  const bucket = new Map<string, ByDayRow>();
  const totals: Totals = {
    sandboxSeconds: 0,
    tokensIn: 0,
    tokensOut: 0,
    count: 0,
  };

  for (const r of rows) {
    const day = (r.created_at ?? "").slice(0, 10);
    if (!day) continue;
    const source = r.source ?? "unknown";
    const key = `${day}|${source}`;
    const sb = Number(r.sandbox_seconds ?? 0);
    const ti = Number(r.tokens_in ?? 0);
    const to = Number(r.tokens_out ?? 0);

    const existing = bucket.get(key);
    if (existing) {
      existing.sandboxSeconds += sb;
      existing.tokensIn += ti;
      existing.tokensOut += to;
    } else {
      bucket.set(key, {
        day,
        source,
        sandboxSeconds: sb,
        tokensIn: ti,
        tokensOut: to,
      });
    }

    totals.sandboxSeconds += sb;
    totals.tokensIn += ti;
    totals.tokensOut += to;
    totals.count += 1;
  }

  const byDay = Array.from(bucket.values());

  return <UsageDashboard byDay={byDay} totals={totals} />;
}
