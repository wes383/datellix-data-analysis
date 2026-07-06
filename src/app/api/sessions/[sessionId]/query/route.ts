import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { executeSqlForSession } from "@/lib/agent/sql-executor";

/**
 * POST /api/sessions/[sessionId]/query — re-execute a SQL query against
 * the session's bound data sources. Used by the chat history view to
 * re-query data for Recharts charts and table artifacts that were stored
 * without inline data (space optimization).
 *
 * Body: { sql: string }
 * Response: { columns, rows, rowCount, truncated }
 */

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { sessionId } = await params;

  // Verify session ownership
  const { data: session } = await supabase
    .from("sessions")
    .select("id, user_id")
    .eq("id", sessionId)
    .single();

  if (!session || session.user_id !== user.id) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await req.json();
  const { sql } = body;

  if (!sql || typeof sql !== "string") {
    return NextResponse.json({ error: "Missing sql field" }, { status: 400 });
  }

  try {
    const results = await executeSqlForSession(sessionId, sql, user.id);
    return NextResponse.json({
      columns: results.columns,
      rows: results.rows,
      rowCount: results.rowCount,
      truncated: results.truncated,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sessions/query] session ${sessionId} failed:`, err);
    return NextResponse.json(
      { error: `Query failed: ${msg}` },
      { status: 500 },
    );
  }
}
