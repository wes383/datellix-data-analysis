import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cleanupStaleSandboxes } from "@/lib/daytona/client";

/**
 * POST /api/admin/cleanup-sandboxes — delete leaked Daytona sandboxes.
 *
 * Body (all optional):
 *   { all: boolean }   When true, delete ALL sandboxes in the org (not just
 *                      those labeled `app=datellix`). Use with caution.
 *
 * Requires an authenticated session. Optionally require an `ADMIN_SECRET`
 * header matching the `ADMIN_SECRET` env var — set that var to lock this
 * endpoint down in multi-user deployments.
 *
 * Returns: { deleted, failed, total }
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // Optional admin-secret gate (only enforced if the env var is set).
  if (process.env.ADMIN_SECRET) {
    const provided = req.headers.get("x-admin-secret");
    if (provided !== process.env.ADMIN_SECRET) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  let includeAll = false;
  try {
    const body = await req.json();
    includeAll = Boolean(body?.all);
  } catch {
    // Empty body is fine — defaults to false.
  }

  const result = await cleanupStaleSandboxes(includeAll);
  console.log(
    `[admin/cleanup-sandboxes] user=${user.id} all=${includeAll} ` +
      `deleted=${result.deleted} failed=${result.failed} total=${result.total}`,
  );
  return NextResponse.json(result);
}
