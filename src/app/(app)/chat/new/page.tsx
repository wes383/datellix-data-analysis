import { createClient } from "@/lib/supabase/server";
import { Chat } from "@/components/chat/chat";

/**
 * Pending new-session page.
 *
 * Visited when the user clicks "New session" but hasn't sent the first
 * message yet — no `sessions` row is created until the first message is
 * submitted (see Chat.tsx). This keeps the sidebar free of empty
 * "New analysis session" entries.
 */
export default async function NewSessionPage() {
  // Pre-fetch the user's existing data sources for the
  // "Add data source" dialog's "Use existing" tab. Both DB types
  // and file types can be bound. If the user is not logged in
  // (shouldn't happen due to middleware), this returns empty.
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: userSources } = user
    ? await supabase
        .from("data_sources")
        .select("id, type, name, meta")
        .eq("user_id", user.id)
        .in("type", ["pg", "mysql", "bigquery", "file"])
        .order("updated_at", { ascending: false })
    : { data: null };

  return (
    <Chat
      sessionId="new"
      initialMessages={[]}
      initialArtifacts={[]}
      dataSource={null}
      existingSources={
        (userSources ?? []) as unknown as {
          id: string;
          type: string;
          name: string;
          meta: Record<string, unknown>;
        }[]
      }
    />
  );
}
