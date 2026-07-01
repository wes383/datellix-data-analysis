"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteFile } from "@/lib/blob/client";
import { decryptConfig } from "@/lib/db/crypto";
import type { FileConfig } from "@/lib/db/schema";

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
 * 1. If the session's data source is not referenced by any other session,
 *    delete the Blob file (file-type sources) and the data_sources row
 *    (schema_embeddings cascade-deletes via FK).
 * 2. Delete the session row — messages, artifacts, and
 *    session_history_embeddings cascade-delete via FK.
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
      // No other session uses this data source — delete the Blob file and
      // the data_sources row. schema_embeddings cascade-deletes.
      const { data: ds } = await admin
        .from("data_sources")
        .select("type, config_encrypted")
        .eq("id", session.data_source_id)
        .single();

      if (ds?.type === "file" && ds.config_encrypted) {
        try {
          const config = await decryptConfig<FileConfig>(ds.config_encrypted);
          if (config.blobUrl) {
            await deleteFile(config.blobUrl);
          }
        } catch (err) {
          // Log but don't fail the session deletion — orphaned Blob files
          // can be reclaimed via Vercel lifecycle rules.
          console.error(
            `[deleteSession] failed to delete Blob file for data source ${session.data_source_id}:`,
            err,
          );
        }
      }

      await admin.from("data_sources").delete().eq("id", session.data_source_id);
    }
  }

  // 2. Delete the session — messages, artifacts, session_history_embeddings
  //    cascade-delete via their FK on delete cascade.
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
