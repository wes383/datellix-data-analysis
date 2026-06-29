"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

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

/** Delete session */
export async function deleteSession(sessionId: string) {
  const supabase = await createClient();
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
