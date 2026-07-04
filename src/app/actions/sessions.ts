"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteStorageFile } from "@/lib/storage/resolver";

/** Create a new analysis session */
export async function createSession(dataSourceId?: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  const { data, error } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      title: "New analysis session",
      data_source_id: dataSourceId ?? null,
    })
    .select()
    .single();
  if (error) throw error;

  revalidatePath("/");
  return data;
}

/**
 * Delete a session and clean up all associated resources.
 *
 * Cleanup order:
 * 1. If the session is in single-DB mode (sessions.data_source_id set) and
 *    the data source is not referenced by any other session: file-type
 *    sources (file/duckdb/sqlite) have their Blob file and data_sources
 *    row deleted (schema_embeddings cascade-deletes via FK); DB-type
 *    sources (pg/mysql/bigquery) are kept so the user can re-bind them
 *    from /sources.
 * 1b. If the session is in multi-file mode (rows in session_data_sources),
 *    for each file data source: if no other session references it, delete
 *    the Blob file (via meta.blobUrl) and the data_sources row. The
 *    session_data_sources join rows themselves cascade-delete with the
 *    session (FK on delete cascade).
 * 2. Delete LangGraph checkpoint rows for this thread (sessionId =
 *    thread_id). These tables have no FK to sessions, so they don't
 *    cascade-delete — must be cleaned up explicitly.
 * 3. Delete the session row — messages, artifacts cascade-delete via FK.
 *    session_data_sources rows also cascade-delete.
 *
 * Blob deletion failures are logged but do not abort the session deletion,
 * since orphaned Blob files are reclaimable via Vercel's lifecycle rules
 * and shouldn't block the user from deleting a session.
 */
export async function deleteSession(sessionId: string) {
  const supabase = await createClient();
  const admin = createAdminClient();

  // 1. Load session to find bound data source
  const { data: session } = await supabase
    .from("sessions")
    .select("id, user_id, data_source_id")
    .eq("id", sessionId)
    .single();

  if (session?.data_source_id) {
    // Check if any other session references the same data source
    const { count } = await admin
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .eq("data_source_id", session.data_source_id)
      .neq("id", sessionId);

    if (count === 0) {
      // No other session references this data source.
      //
      // File-type sources (file/duckdb/sqlite) are session-scoped: clean
      // up their Blob file and data_sources row here. DB-type sources
      // (pg/mysql/bigquery) are long-lived and reusable — keep the
      // data_sources row so the user can re-bind it from /sources. The
      // sessions.data_source_id reference clears automatically when the
      // session row is deleted below.
      const { data: ds } = await admin
        .from("data_sources")
        .select("type, meta")
        .eq("id", session.data_source_id)
        .single();

      const isFileType =
        ds?.type === "file" ||
        ds?.type === "duckdb" ||
        ds?.type === "sqlite";

      if (isFileType && ds) {
        const meta = (ds.meta ?? {}) as Record<string, unknown>;
        try {
          await deleteStorageFile(meta, session.user_id);
        } catch (err) {
          // Log but don't fail the session deletion — orphaned storage files
          // can be reclaimed via backend lifecycle rules.
          console.error(
            `[deleteSession] failed to delete storage file for data source ${session.data_source_id}:`,
            err,
          );
        }
        await admin.from("data_sources").delete().eq("id", session.data_source_id);
      }
      // DB types (pg/mysql/bigquery): keep the data_sources row.
    }
  }

  // 1b. Multi-file mode: clean up each file data source bound via
  //     session_data_sources. The join rows themselves cascade-delete with
  //     the session, but the underlying Blob files and data_sources rows do
  //     not — so we delete them here when no other session shares the file.
  const { data: fileLinks } = await admin
    .from("session_data_sources")
    .select("data_source_id")
    .eq("session_id", sessionId);

  if (fileLinks && fileLinks.length > 0) {
    for (const link of fileLinks) {
      const fileDsId = link.data_source_id as string;

      // Check if any other session references this file data source.
      const { count } = await admin
        .from("session_data_sources")
        .select("id", { count: "exact", head: true })
        .eq("data_source_id", fileDsId)
        .neq("session_id", sessionId);

      if (count === 0) {
        // No other session references it — delete the Blob file
        // (best-effort) and the data_sources row. schema_embeddings
        // cascade-deletes.
        const { data: ds } = await admin
          .from("data_sources")
          .select("type, meta, user_id")
          .eq("id", fileDsId)
          .single();

        if (ds) {
          const meta = (ds.meta ?? {}) as Record<string, unknown>;
          try {
            await deleteStorageFile(meta, ds.user_id as string);
          } catch (err) {
            console.error(
              `[deleteSession] failed to delete storage file for data source ${fileDsId}:`,
              err,
            );
          }
          await admin.from("data_sources").delete().eq("id", fileDsId);
        }
      }
    }
  }

  // 2. Delete LangGraph checkpoint rows for this thread. The checkpoint
  //    tables (checkpoints, checkpoint_blobs, checkpoint_writes) have no
  //    FK to sessions, so they don't cascade-delete. If left behind, they
  //    accumulate indefinitely (each agent turn produces 1-3 checkpoints
  //    with serialized state + binary blobs). Best-effort: log on failure
  //    but don't block session deletion.
  try {
    await admin.from("checkpoints").delete().eq("thread_id", sessionId);
    await admin.from("checkpoint_blobs").delete().eq("thread_id", sessionId);
    await admin.from("checkpoint_writes").delete().eq("thread_id", sessionId);
  } catch (err) {
    console.error(
      `[deleteSession] failed to clean up LangGraph checkpoints for ${sessionId}:`,
      err,
    );
  }

  // 3. Delete the session — messages, artifacts cascade-delete via their
  //    FK on delete cascade. session_data_sources rows also cascade-delete.
  const { error } = await supabase
    .from("sessions")
    .delete()
    .eq("id", sessionId);
  if (error) throw error;

  revalidatePath("/");
}

/** Sign out */
export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath("/");
}

/**
 * Permanently delete the current user's account and all associated data.
 *
 * Cleanup order:
 * 1. Load all session ids for the user → delete LangGraph checkpoint rows
 *    (checkpoints / checkpoint_blobs / checkpoint_writes have no FK to
 *    auth.users, so they don't cascade).
 * 2. Load all file-type data sources → delete their stored files (Vercel
 *    Blob / S3). Best-effort: log failures, don't abort.
 * 3. Delete the auth.users row via the admin client. All application
 *    tables (sessions, messages, artifacts, data_sources, user_settings,
 *    usage_logs, schema_embeddings, charts) cascade-delete via their
 *    `references auth.users (id) on delete cascade` FK.
 * 4. Sign out (clears the local session cookie).
 *
 * This action is irreversible. The user is redirected to /login afterward.
 */
export async function deleteAccount() {
  const supabase = await createClient();
  const admin = createAdminClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");

  // 1. Delete LangGraph checkpoints for all the user's sessions.
  //    thread_id = session_id; these tables have no FK to auth.users.
  try {
    const { data: sessions } = await admin
      .from("sessions")
      .select("id")
      .eq("user_id", user.id);
    if (sessions && sessions.length > 0) {
      const threadIds = sessions.map((s) => s.id as string);
      await admin.from("checkpoints").delete().in("thread_id", threadIds);
      await admin.from("checkpoint_blobs").delete().in("thread_id", threadIds);
      await admin.from("checkpoint_writes").delete().in("thread_id", threadIds);
    }
  } catch (err) {
    console.error(
      `[deleteAccount] failed to clean up LangGraph checkpoints for user ${user.id}:`,
      err,
    );
  }

  // 2. Delete stored files for all file-type data sources.
  //    DB-type sources (pg/mysql/bigquery) have no external file to remove.
  try {
    const { data: dataSources } = await admin
      .from("data_sources")
      .select("type, meta")
      .eq("user_id", user.id);
    if (dataSources && dataSources.length > 0) {
      for (const ds of dataSources) {
        const isFileType =
          ds.type === "file" || ds.type === "duckdb" || ds.type === "sqlite";
        if (!isFileType) continue;
        const meta = (ds.meta ?? {}) as Record<string, unknown>;
        try {
          await deleteStorageFile(meta, user.id);
        } catch (err) {
          console.error(
            `[deleteAccount] failed to delete storage file for data source:`,
            err,
          );
        }
      }
    }
  } catch (err) {
    console.error(
      `[deleteAccount] failed to load data sources for user ${user.id}:`,
      err,
    );
  }

  // 3. Delete the auth.users row — cascades to all application tables.
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) throw error;

  // 4. Clear the local session cookie.
  await supabase.auth.signOut();

  revalidatePath("/");
}
