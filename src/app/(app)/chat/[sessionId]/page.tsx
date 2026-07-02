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

  // Resolve session data source mode:
  //  - Single-DB mode: sessions.data_source_id points to a database data source
  //  - Multi-file mode: session_data_sources rows point to file data sources
  //  The two are mutually exclusive (enforced at upload/connect time).
  // Use the admin client to read data_sources rows regardless of RLS on the
  // join — ownership is already verified by the session RLS check above.
  const admin = createAdminClient();
  let dataSource:
    | { mode: "database"; data: { id: string; type: string; name: string } }
    | {
        mode: "files";
        files: { id: string; name: string; format: string; size: number }[];
      }
    | null = null;

  if (session.data_source_id) {
    // Single-DB mode
    const { data: ds } = await admin
      .from("data_sources")
      .select("id, type, name")
      .eq("id", session.data_source_id)
      .single();
    if (ds) {
      dataSource = {
        mode: "database",
        data: { id: ds.id, type: ds.type, name: ds.name },
      };
    }
  } else {
    // Multi-file mode: fetch all bound file data sources
    const { data: links } = await admin
      .from("session_data_sources")
      .select("data_source_id, data_sources(id, name, meta)")
      .eq("session_id", sessionId);
    if (links && links.length > 0) {
      const files = links
        .map((link) => {
          // Without generated DB types, supabase-js types the nested
          // data_sources select as an array. At runtime it's a single
          // object for this many-to-one join, so coerce via unknown and
          // accept either shape.
          const dsRaw = link.data_sources as unknown;
          const ds = Array.isArray(dsRaw)
            ? (dsRaw[0] as { id: string; name: string; meta: Record<string, unknown> | null } | undefined)
            : (dsRaw as { id: string; name: string; meta: Record<string, unknown> | null } | undefined);
          if (!ds) return null;
          const meta = ds.meta ?? {};
          return {
            id: ds.id,
            name: ds.name,
            format: typeof meta.format === "string" ? meta.format : "file",
            size: typeof meta.size === "number" ? meta.size : 0,
          };
        })
        .filter((f): f is { id: string; name: string; format: string; size: number } => f !== null);
      if (files.length > 0) {
        dataSource = { mode: "files", files };
      }
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
