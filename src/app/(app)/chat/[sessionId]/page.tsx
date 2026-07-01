import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Chat } from "@/components/chat/chat";
import type { Message, Artifact } from "@/lib/db/schema";

interface PageProps {
  params: Promise<{ sessionId: string }>;
}

export default async function ChatPage({ params }: PageProps) {
  const { sessionId } = await params;
  const supabase = await createClient();

  // Load session (RLS ensures only the owner can read)
  const { data: session } = await supabase
    .from("sessions")
    .select("id, user_id, title, status, data_source_id, created_at, updated_at")
    .eq("id", sessionId)
    .single();
  if (!session) notFound();

  // Load messages
  const { data: messages } = await supabase
    .from("messages")
    .select("id, session_id, role, content, tool_calls, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  // Load bound data source (name + type) for the composer status bar
  let dataSource: { id: string; type: string; name: string } | null = null;
  if (session.data_source_id) {
    const admin = createAdminClient();
    const { data: ds } = await admin
      .from("data_sources")
      .select("id, type, name")
      .eq("id", session.data_source_id)
      .single();
    if (ds) {
      dataSource = { id: ds.id, type: ds.type, name: ds.name };
    }
  }

  // Load session artifacts (for replay when returning to a session)
  const { data: artifacts } = await supabase
    .from("artifacts")
    .select("id, session_id, type, payload, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  return (
    <Chat
      sessionId={sessionId}
      initialMessages={(messages ?? []) as unknown as Message[]}
      initialArtifacts={(artifacts ?? []) as unknown as Artifact[]}
      dataSource={dataSource}
      key={sessionId}
    />
  );
}
