import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptConfig } from "@/lib/db/crypto";
import { deleteStorageFile } from "@/lib/storage/resolver";
import type {
  PgConfig,
  MysqlConfig,
  BigQueryConfig,
} from "@/lib/db/schema";

export const runtime = "nodejs";

/**
 * GET /api/sources/[id]
 *
 * Returns metadata for a single data source for the edit form. Excludes
 * `config_encrypted` — secrets are never sent to the client. Non-secret
 * fields (host, database, projectId, …) are read from `meta`.
 */
export async function GET(
  _req: NextRequest,
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

  const { data: source, error } = await supabase
    .from("data_sources")
    .select("id, type, name, meta, created_at, updated_at")
    .eq("id", dataSourceId)
    .eq("user_id", user.id)
    .single();

  if (error || !source) {
    return NextResponse.json(
      { error: "Data source not found or access denied" },
      { status: 404 },
    );
  }

  return NextResponse.json({ source });
}

/**
 * PATCH /api/sources/[id]
 *
 * Update a data source. For DB types (pg/mysql/bigquery), the password /
 * credentialsJson field is optional: if blank, the existing ciphertext is
 * preserved (the user keeps their current secret). If provided, the full
 * config is re-encrypted. For file types (duckdb/sqlite), only `name` can
 * be changed — the file itself is immutable (re-upload via the new flow).
 *
 * Body (JSON):
 *   { name?, host?, port?, database?, user?, password?, ssl?,
 *     projectId?, location?, credentialsJson?, dataset? }
 *
 * The `meta` column is refreshed with the latest non-secret fields so the
 * edit form can prefill them on the next visit.
 */
export async function PATCH(
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

  // Verify ownership.
  const { data: existing, error: fetchErr } = await supabase
    .from("data_sources")
    .select("id, type, name, config_encrypted, meta")
    .eq("id", dataSourceId)
    .eq("user_id", user.id)
    .single();
  if (fetchErr || !existing) {
    return NextResponse.json(
      { error: "Data source not found or access denied" },
      { status: 404 },
    );
  }

  const body = (await req.json()) as {
    name?: string;
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    ssl?: string;
    projectId?: string;
    location?: string;
    credentialsJson?: string;
    dataset?: string;
  };

  const updates: {
    name?: string;
    config_encrypted?: string;
    meta?: Record<string, unknown>;
  } = {};

  if (typeof body.name === "string" && body.name.trim()) {
    updates.name = body.name.trim();
  }

  const type = existing.type;

  if (type === "pg" || type === "mysql") {
    // Rebuild config only if a new password was supplied. Otherwise keep
    // the existing ciphertext and just refresh non-secret meta fields.
    if (body.password && body.password.trim()) {
      if (!body.host || !body.database || !body.user) {
        return NextResponse.json(
          { error: "host, database, and user are required when changing the password" },
          { status: 400 },
        );
      }
      const config: PgConfig & MysqlConfig = {
        host: body.host.trim(),
        port: body.port ?? (type === "mysql" ? 3306 : 5432),
        database: body.database.trim(),
        user: body.user.trim(),
        password: body.password,
        ssl: body.ssl ?? "require",
      };
      updates.config_encrypted = await encryptConfig(config);
      updates.meta = { type, host: config.host, database: config.database };
    } else {
      // Refresh non-secret meta fields from the submitted form (host/database
      // may have changed even though the password did not). We deliberately
      // do NOT touch config_encrypted here, so the original password remains.
      const prevMeta = (existing.meta ?? {}) as Record<string, unknown>;
      updates.meta = {
        ...prevMeta,
        type,
        host: body.host?.trim() ?? prevMeta.host,
        database: body.database?.trim() ?? prevMeta.database,
      };
    }
  } else if (type === "bigquery") {
    if (body.credentialsJson && body.credentialsJson.trim()) {
      if (!body.projectId) {
        return NextResponse.json(
          { error: "projectId is required when changing credentials" },
          { status: 400 },
        );
      }
      const config: BigQueryConfig = {
        projectId: body.projectId.trim(),
        location: body.location?.trim() || "US",
        credentialsJson: body.credentialsJson,
        dataset: body.dataset?.trim() || undefined,
      };
      updates.config_encrypted = await encryptConfig(config);
      updates.meta = { type: "bigquery", projectId: config.projectId };
    } else {
      const prevMeta = (existing.meta ?? {}) as Record<string, unknown>;
      updates.meta = {
        ...prevMeta,
        type: "bigquery",
        projectId: body.projectId?.trim() ?? prevMeta.projectId,
      };
    }
  }
  // duckdb / sqlite: only name can change (file is immutable). No config work.

  const { data: updated, error: updateErr } = await supabase
    .from("data_sources")
    .update(updates)
    .eq("id", dataSourceId)
    .eq("user_id", user.id)
    .select("id, type, name, meta, created_at, updated_at")
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      { error: `Failed to update data source: ${updateErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  return NextResponse.json({ source: updated });
}

/**
 * DELETE /api/sources/[id]?sessionId=...
 *
 * Two modes:
 *   1. With `sessionId`: unlinks the data source from that session. If no
 *      other session references it, the Blob file (for file types) and the
 *      data_source row are also deleted.
 *   2. Without `sessionId`: deletes the data source entirely — removes all
 *      session_data_sources references, deletes the Blob file (for file
 *      types), then deletes the row. Used by the /sources list page.
 *
 * Ownership: the authenticated user must own the data source (and, when
 * `sessionId` is provided, the session).
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

  // Verify the user owns the data source.
  const { data: ds } = await supabase
    .from("data_sources")
    .select("id, user_id")
    .eq("id", dataSourceId)
    .single();
  if (!ds || ds.user_id !== user.id) {
    return NextResponse.json(
      { error: "Data source not found or access denied" },
      { status: 404 },
    );
  }

  // When sessionId is provided, verify session ownership too.
  if (sessionId) {
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
  }

  const admin = createAdminClient();

  // Find all charts bound to this data source and delete them explicitly.
  // Deleting the charts cascades to delete their `chart_data_sources` rows,
  // but we delete the charts themselves (not just the join rows) so the
  // chart library entries are cleaned up along with the data source.
  const { data: boundLinks } = await admin
    .from("chart_data_sources")
    .select("chart_id")
    .eq("data_source_id", dataSourceId);

  if (boundLinks && boundLinks.length > 0) {
    const chartIds = boundLinks
      .map((l) => l.chart_id)
      .filter((id): id is string => typeof id === "string");
    if (chartIds.length > 0) {
      await admin.from("charts").delete().in("id", chartIds);
    }
  }

  if (sessionId) {
    // Mode 1: unlink from this session only.
    await admin
      .from("sessions")
      .update({ data_source_id: null })
      .eq("id", sessionId)
      .eq("data_source_id", dataSourceId);

    await admin
      .from("session_data_sources")
      .delete()
      .eq("session_id", sessionId)
      .eq("data_source_id", dataSourceId);
  } else {
    // Mode 2: unlink from ALL sessions that reference this data source.
    await admin
      .from("session_data_sources")
      .delete()
      .eq("data_source_id", dataSourceId);
  }

  // If no session references remain, delete the Blob file + the row.
  const { count } = await admin
    .from("session_data_sources")
    .select("id", { count: "exact", head: true })
    .eq("data_source_id", dataSourceId);
  if (count === 0) {
    const { data: dsRow } = await admin
      .from("data_sources")
      .select("type, config_encrypted, meta")
      .eq("id", dataSourceId)
      .single();
    if (dsRow) {
      const meta = (dsRow.meta ?? {}) as Record<string, unknown>;
      const blobUrl = typeof meta.blobUrl === "string" ? meta.blobUrl : null;
      const s3Key = typeof meta.s3Key === "string" ? meta.s3Key : null;
      if (blobUrl || s3Key) {
        try {
          await deleteStorageFile(meta, user.id);
        } catch {
          /* best-effort */
        }
      }
      await admin.from("data_sources").delete().eq("id", dataSourceId);
    }
  }

  return NextResponse.json({ ok: true });
}
