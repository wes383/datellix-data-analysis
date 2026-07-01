import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { streamAgent } from "@/lib/agent/graph";
import { AIMessageChunk, ToolMessage, BaseMessage } from "@langchain/core/messages";
import type { Artifact } from "@/lib/agent/state";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Chat streaming interface
 *
 * Request: POST /api/chat
 * body: { sessionId: string, message: string }
 *
 * Response: text/event-stream
 *   data: {"content":"..."}                    // incremental text from synthesizer
 *   data: {"artifact":{"type":"table",...}}    // artifact (table/chart/summary)
 *   data: {"tool":"nlSql","content":"..."}     // tool progress update
 *   data: [DONE]                               // end
 */

/**
 * After a node completes, surface a friendly "next step" hint so the user
 * sees activity during the sequential summarize → makeChart → synthesizer
 * chain instead of a silent wait. The mapping mirrors the graph edges in
 * lib/agent/graph.ts (nlSql → summarize → makeChart → synthesizer).
 *
 * Hints are conditional on the LLM's decisions stored in state
 * (needsSummary / needsChart) — if a node is going to be skipped, we don't
 * push a hint for it, otherwise the UI would show a "Generating chart…"
 * step that never actually runs.
 */
const STEP_HINTS = {
  summarize: { tool: "summarize", content: "Analyzing data statistics…" },
  makeChart: { tool: "makeChart", content: "Generating chart…" },
} as const;

/**
 * Initial steps pushed immediately before the agent starts streaming.
 * schemaRetriever and router both run before the first graph event
 * arrives (router is a non-streaming llm.invoke), so we surface these
 * hints up front to fill the otherwise-silent "thinking…" gap.
 */
const INITIAL_STEPS: { tool: string; content: string }[] = [
  { tool: "schemaRetriever", content: "Retrieving relevant schema…" },
  { tool: "router", content: "Classifying question…" },
];

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

  // Load data source type if bound
  let dataSourceId = "";
  let dataSourceType = "";
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
      const collectedArtifacts: Artifact[] = [];
      // Persist-friendly record of the turn's segments (tool / thinking /
      // text / artifact) in arrival order. Stored on the assistant
      // message's `tool_calls` jsonb column so the UI can rebuild the
      // interleaved layout after a page refresh.
      const segments: Array<
        | { kind: "tool"; tool: string; content: string }
        | { kind: "thinking"; content: string }
        | { kind: "text"; content: string }
        | { kind: "artifact"; artifactType: string; artifactIndex: number }
      > = [];
      // Track LLM decisions (from nlSql update) so we only push step hints
      // for nodes that will actually run. summarize/makeChart skip
      // themselves when these are false.
      let needsSummary = false;
      let needsChart = false;

      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // Push initial step hints before the first graph event arrives.
        // schemaRetriever (embedding + pgvector retrieval) and router
        // (non-streaming llm.invoke) both complete before any node update
        // is yielded, so without these the UI shows a bare "thinking…"
        // for several seconds.
        for (const step of INITIAL_STEPS) {
          send(step);
        }

        for await (const chunk of streamAgent({
          sessionId,
          question: message,
          dataSourceId,
          dataSourceType,
        })) {
          // streamMode: ["messages", "updates"] yields [mode, payload] tuples
          if (!Array.isArray(chunk) || chunk.length < 2) continue;

          const [mode, payload] = chunk;

          if (mode === "messages") {
            // payload is [AIMessageChunk, metadata] — token-level stream.
            // Forward reasoning_content (thinking) and text from the
            // synthesizer node. Other nodes' output is internal.
            const [messageChunk, metadata] = payload as [
              AIMessageChunk,
              { langgraph_node?: string } | undefined,
            ];
            if (messageChunk instanceof AIMessageChunk) {
              const node = metadata?.langgraph_node;
              if (node === "synthesizer") {
                const text = messageChunk.content as string;
                if (text) {
                  assistantContent += text;
                  send({ content: text });
                  segments.push({ kind: "text", content: text });
                }
                // Reasoning content (DeepSeek-R1, GLM reasoning, doubao
                // reasoning, etc.) is surfaced on additional_kwargs.
                const reasoning =
                  (messageChunk.additional_kwargs?.reasoning_content as string) ??
                  (messageChunk.additional_kwargs?.reasoning as string);
                if (reasoning) {
                  send({ thinking: reasoning });
                  segments.push({ kind: "thinking", content: reasoning });
                }
              }
            }
          } else if (mode === "updates") {
            // payload is a map of node name → state update
            const updates = payload as Record<string, Record<string, unknown>>;
            for (const [nodeName, stateUpdate] of Object.entries(updates)) {
              // Capture LLM decisions from the nlSql node update so we
              // can decide which downstream hints to push.
              if (nodeName === "nlSql") {
                if (typeof stateUpdate.needsSummary === "boolean") {
                  needsSummary = stateUpdate.needsSummary;
                }
                if (typeof stateUpdate.needsChart === "boolean") {
                  needsChart = stateUpdate.needsChart;
                }
              }

              // Check for new artifacts
              if (stateUpdate.artifacts && Array.isArray(stateUpdate.artifacts)) {
                for (const artifact of stateUpdate.artifacts as Artifact[]) {
                  collectedArtifacts.push(artifact);
                  send({ artifact, node: nodeName });
                  segments.push({
                    kind: "artifact",
                    artifactType: artifact.type,
                    artifactIndex: collectedArtifacts.length - 1,
                  });

                  // Persist artifact to database
                  await supabase.from("artifacts").insert({
                    session_id: sessionId,
                    type: artifact.type,
                    payload: artifact.payload as unknown as Record<string, unknown>,
                  });
                }
              }

              // Send tool progress updates (ToolMessages from nlSql node).
              // Use duck-typing on _getType() instead of instanceof, because
              // LangGraph's stream deserialization may return plain objects
              // that are not true ToolMessage instances.
              if (stateUpdate.messages && Array.isArray(stateUpdate.messages)) {
                for (const msg of stateUpdate.messages) {
                  const isTool =
                    msg instanceof ToolMessage ||
                    (typeof msg === "object" &&
                      msg !== null &&
                      "_getType" in msg &&
                      (msg as BaseMessage)._getType?.() === "tool") ||
                    (typeof msg === "object" &&
                      msg !== null &&
                      "tool_call_id" in msg);
                  if (isTool) {
                    const content =
                      typeof msg.content === "string"
                        ? msg.content
                        : JSON.stringify(msg.content);
                    send({ tool: nodeName, content });
                    segments.push({ kind: "tool", tool: nodeName, content });
                  }
                }
              }

              // Push the next-step hint only if that next node will
              // actually run (i.e., not skipped). This avoids showing a
              // "Generating chart…" step for a chart that was never made.
              if (nodeName === "nlSql" && needsSummary) {
                send(STEP_HINTS.summarize);
              }
              if (nodeName === "summarize" && needsChart) {
                send(STEP_HINTS.makeChart);
              }
              // If summarize was skipped but chart is needed, nlSql → makeChart
              if (nodeName === "nlSql" && !needsSummary && needsChart) {
                send(STEP_HINTS.makeChart);
              }
            }
          }
        }

        send("[DONE]");

        // 6. Persist assistant reply — include segments in `tool_calls` so
        //    the UI can rebuild tool / thinking / artifact / text order on
        //    refresh. Only persist when there's something to show.
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
