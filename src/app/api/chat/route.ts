import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { streamAgent } from "@/lib/agent/graph";
import {
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { Artifact } from "@/lib/agent/state";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Chat streaming interface (Phase 2 ReAct agent)
 *
 * Request: POST /api/chat
 * body: { sessionId: string, message: string }
 *
 * Response: text/event-stream. Events:
 *   data: {"content":"..."}                          // AIMessage text token (narration + final answer)
 *   data: {"thinking":"..."}                         // AIMessage reasoning_content token (collapsible CoT)
 *   data: {"tool_call":{"id":"...","name":"..."}}    // LLM started calling a tool
 *   data: {"tool_result":{"id":"...","name":"...","content":"..."}}  // tool finished
 *   data: {"artifact":{...},"toolCallId":"..."}      // artifact produced by a tool (table/chart/summary)
 *   data: {"error":"..."}                            // error
 *   data: [DONE]                                     // end
 *
 * The agent is a single LLM in a ReAct loop (createReactAgent). It streams
 * text narration, decides to call tools (execute_sql / build_chart / ...),
 * inspects each tool's returned result, and continues until it emits a final
 * answer — all from one coherent LLM, like Claude Code.
 */

/** Extract a plain-text string from a message's content (string or content blocks). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          return String((block as { text: string }).text);
        }
        return "";
      })
      .join("");
  }
  return "";
}

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

  // 3. Verify session ownership and load data source binding
  const { data: session } = await supabase
    .from("sessions")
    .select("id, user_id, data_source_id")
    .eq("id", sessionId)
    .single();
  if (!session || session.user_id !== user.id) {
    return NextResponse.json({ error: "Session not found or access denied" }, { status: 404 });
  }

  // Resolve session data source mode:
  //   - Single-DB mode: sessions.data_source_id points to a database
  //   - Multi-file mode: session_data_sources rows point to file data sources
  let dataSourceId = "";
  let dataSourceType = "";
  let fileDataSourceIds: string[] = [];

  if (session.data_source_id) {
    const admin = createAdminClient();
    const { data: ds } = await admin
      .from("data_sources")
      .select("type")
      .eq("id", session.data_source_id)
      .single();
    if (ds) {
      dataSourceId = session.data_source_id;
      dataSourceType = ds.type;
    }
  } else {
    const admin = createAdminClient();
    const { data: links } = await admin
      .from("session_data_sources")
      .select("data_source_id, data_sources(type)")
      .eq("session_id", sessionId);
    if (links && links.length > 0) {
      fileDataSourceIds = links.map((l) => l.data_source_id as string);
      dataSourceType = "file";
    }
  }

  // 4. Persist user message
  await supabase.from("messages").insert({
    session_id: sessionId,
    role: "user",
    content: message,
  });

  // 5. Stream the ReAct agent
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Accumulated final-answer text (concatenation of all AIMessage content
      // tokens across the whole turn, including intermediate narration). This
      // is persisted as the assistant message's `content` column.
      let assistantContent = "";
      const collectedArtifacts: Artifact[] = [];

      // Persist-friendly record of the turn's segments in arrival order, so
      // the UI can rebuild the interleaved layout (text / tool / artifact)
      // after a page refresh. Stored on the assistant message's `tool_calls`
      // jsonb column. Thinking segments are filtered out before saving.
      const segments: Array<
        | { kind: "tool"; id: string; tool: string; content: string }
        | { kind: "text"; content: string }
        | { kind: "artifact"; artifactType: string; artifactIndex: number }
      > = [];

      // Track which tool_call ids we've already announced, so we only emit one
      // tool_call SSE event per call even though the args stream in fragments.
      const announcedToolCalls = new Set<string>();
      // Map tool_call_id → segment reference, so tool_result can fill content.
      const toolSegments = new Map<
        string,
        { kind: "tool"; id: string; tool: string; content: string }
      >();

      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        for await (const chunk of streamAgent({
          sessionId,
          question: message,
          dataSourceId,
          dataSourceType,
          fileDataSourceIds,
        })) {
          // streamMode: ["messages"] yields [mode, payload] tuples.
          // payload is [message, metadata].
          if (!Array.isArray(chunk) || chunk.length < 2) continue;
          const [mode, payload] = chunk as [string, unknown];
          if (mode !== "messages") continue;

          const pair = payload as [BaseMessage, Record<string, unknown> | undefined];
          const msg = pair[0];
          if (!msg) continue;

          // ----------------------------------------------------------
          // AIMessageChunk: streaming LLM output
          // (text content, reasoning, and tool_call deltas)
          // ----------------------------------------------------------
          if (msg instanceof AIMessageChunk || msg._getType?.() === "ai") {
            const aiChunk = msg as AIMessageChunk;

            // 1. Visible text content (narration + final answer)
            const text = extractText(aiChunk.content);
            if (text) {
              assistantContent += text;
              send({ content: text });
              const last = segments[segments.length - 1];
              if (last && last.kind === "text") {
                last.content += text;
              } else {
                segments.push({ kind: "text", content: text });
              }
            }

            // 2. Reasoning / thinking content (collapsible CoT)
            const reasoning =
              (aiChunk.additional_kwargs?.reasoning_content as string) ??
              (aiChunk.additional_kwargs?.reasoning as string);
            if (reasoning) {
              send({ thinking: reasoning });
              // Thinking segments are NOT persisted (filtered out before save),
              // but we still track them in a throwaway way — since they're not
              // in the segments array, no action needed here.
            }

            // 3. Tool call deltas: announce a new tool call the first time we
            //    see its id+name. Args stream in fragments but we don't need
            //    to forward them — the UI only shows the tool name while
            //    running, and the full result when the ToolMessage arrives.
            const toolCallChunks = aiChunk.tool_call_chunks ?? [];
            for (const tc of toolCallChunks) {
              const id = tc.id;
              const name = tc.name;
              if (id && name && !announcedToolCalls.has(id)) {
                announcedToolCalls.add(id);
                send({ tool_call: { id, name } });
                // Create a tool segment at this position so the rendered order
                // matches the LLM's narration flow. Content is filled when the
                // ToolMessage (tool_result) arrives.
                const seg: { kind: "tool"; id: string; tool: string; content: string } = {
                  kind: "tool",
                  id,
                  tool: name,
                  content: "",
                };
                segments.push(seg);
                toolSegments.set(id, seg);
              }
            }
            continue;
          }

          // ----------------------------------------------------------
          // ToolMessage: a tool finished executing
          // (carries result text + optional artifact)
          // ----------------------------------------------------------
          const isTool =
            msg instanceof ToolMessage ||
            msg._getType?.() === "tool" ||
            (typeof msg === "object" && msg !== null && "tool_call_id" in msg);
          if (isTool) {
            const tm = msg as ToolMessage;
            const id = tm.tool_call_id ?? "";
            const name = (tm.name ?? tm._getType?.() ?? "tool") as string;
            const content =
              typeof tm.content === "string"
                ? tm.content
                : extractText(tm.content) || JSON.stringify(tm.content);

            // Fill the tool segment's content (announced earlier via tool_call).
            const seg = toolSegments.get(id);
            if (seg) {
              seg.content = content;
            } else {
              // Tool result arrived without a prior tool_call announcement
              // (e.g. tool executed without streaming chunks). Create one now.
              const newSeg = { kind: "tool" as const, id, tool: name, content };
              segments.push(newSeg);
              toolSegments.set(id, newSeg);
              send({ tool_call: { id, name } });
            }

            send({ tool_result: { id, name, content } });

            // Surface the tool's artifact (table / chart / summary) if present.
            // content_and_artifact tools store it on ToolMessage.artifact.
            const artifact = (tm as { artifact?: unknown }).artifact as
              | Artifact
              | undefined;
            if (artifact) {
              collectedArtifacts.push(artifact);
              const artifactIndex = collectedArtifacts.length - 1;
              send({ artifact, toolCallId: id });
              segments.push({
                kind: "artifact",
                artifactType: artifact.type,
                artifactIndex,
              });
              // Persist artifact to the artifacts table.
              await supabase.from("artifacts").insert({
                session_id: sessionId,
                type: artifact.type,
                payload: artifact.payload as unknown as Record<string, unknown>,
              });
            }
          }
        }

        send("[DONE]");

        // 6. Persist assistant reply. Segments (tool / artifact / text) are
        //    saved on the `tool_calls` jsonb column so the UI can rebuild the
        //    interleaved layout on refresh. Tool segments keep their id so the
        //    frontend can still pair them if needed.
        if (assistantContent || segments.length > 0) {
          await supabase.from("messages").insert({
            session_id: sessionId,
            role: "assistant",
            content: assistantContent,
            tool_calls: segments.length > 0 ? segments : null,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Agent execution failed";
        send({ error: msg });
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
