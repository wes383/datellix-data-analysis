import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { streamAgent } from "@/lib/agent/graph";
import { AIMessageChunk } from "@langchain/core/messages";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Chat streaming interface
 *
 * Request: POST /api/chat
 * body: { sessionId: string, message: string }
 *
 * Response: text/event-stream
 *   data: {"content":"..."}    // incremental content
 *   data: [DONE]               // end
 */
export async function POST(req: NextRequest) {
  // 1. Auth
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // 2. Parse request
  const { sessionId, message } = (await req.json()) as {
    sessionId?: string;
    message?: string;
  };
  if (!sessionId || !message) {
    return NextResponse.json({ error: "Missing sessionId or message" }, { status: 400 });
  }

  // 3. Verify session ownership
  const { data: session } = await supabase
    .from("sessions")
    .select("id, user_id")
    .eq("id", sessionId)
    .single();
  if (!session || session.user_id !== user.id) {
    return NextResponse.json({ error: "Session not found or access denied" }, { status: 404 });
  }

  // 4. Persist user message
  await supabase.from("messages").insert({
    session_id: sessionId,
    role: "user",
    content: message,
  });

  // 5. Stream Agent invocation
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let assistantContent = "";
      try {
        for await (const chunk of streamAgent(sessionId, message)) {
          // streamMode: "messages" yields [AIMessageChunk, metadata]
          if (Array.isArray(chunk) && chunk[0] instanceof AIMessageChunk) {
            const text = chunk[0].content as string;
            if (text) {
              assistantContent += text;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ content: text })}\n\n`),
              );
            }
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));

        // 6. Persist assistant reply
        if (assistantContent) {
          await supabase.from("messages").insert({
            session_id: sessionId,
            role: "assistant",
            content: assistantContent,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Agent execution failed";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
