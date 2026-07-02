import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteFile } from "@/lib/blob/client";

export const runtime = "nodejs";

/**
 * DELETE /api/sources/[id]?sessionId=...
 *
 * Removes a file data source from a session (unlinks the row in
 * session_data_sources). If no other session references the data_source,
 * the Blob file and the data_source row are also deleted to avoid
 * orphaned storage.
 *
 * Ownership: the authenticated user must own the session identified by
 * `sessionId` (verified via RLS-bound client before any admin operations).
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { id: dataSourceId } = await params;
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  // Verify the user owns the session (RLS-bound client enforces this).
  const { data: session } = await supabase
    .from("sessions")
    .select("id, user_id")
    .eq("id", sessionId)
    .single();
  if (!session || session.user_id !== user.id) {
    return NextResponse.json(
      { error: "Session not found or access denied" },
      { status: 404 },
    );
  }

  const admin = createAdminClient();

  // 1. Unlink the data source from this session.
  await admin
    .from("session_data_sources")
    .delete()
    .eq("session_id", sessionId)
    .eq("data_source_id", dataSourceId);

  // 2. If no other session references this data_source, delete the Blob
  //    file (best-effort) and the data_source row itself.
  const { count } = await admin
    .from("session_data_sources")
    .select("id", { count: "exact", head: true })
    .eq("data_source_id", dataSourceId);
  if (count === 0) {
    const { data: ds } = await admin
      .from("data_sources")
      .select("type, config_encrypted, meta")
      .eq("id", dataSourceId)
      .single();
    if (ds) {
      const meta = (ds.meta ?? {}) as Record<string, unknown>;
      // Prefer the stored blobPath (cheaper, used by the upload route).
      // Fall back to nothing — Blob deletion is best-effort.
      const blobPath = typeof meta.blobPath === "string" ? meta.blobPath : null;
      if (blobPath) {
        try {
          await deleteFile(blobPath);
        } catch {
          /* best-effort: log and continue */
        }
      }
      await admin.from("data_sources").delete().eq("id", dataSourceId);
    }
  }

  return NextResponse.json({ ok: true });
}
