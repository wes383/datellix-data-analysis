import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { streamAgent } from "@/lib/agent/graph";
import { loadUserLlmConfig } from "@/lib/storage/resolver";
import { logUsage } from "@/lib/usage";
import {
  createSandbox,
  deleteSandbox,
  type Sandbox,
} from "@/lib/daytona/client";
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

/**
 * Robustly extract the `code` field from a streaming JSON args buffer.
 *
 * LangChain streams tool-call args as JSON fragments. The naive approach
 * (`buffer.trim().endsWith("}") && JSON.parse`) fails when the code string
 * itself contains `}` (e.g. `f"{...}"` or a dict literal), because the
 * fragment with that internal `}` parses to an incomplete object.
 *
 * This helper handles the streamed JSON robustly:
 *   1. Find the substring after the first `"code":` key.
 *   2. Skip the opening `"`.
 *   3. Walk character-by-character honoring JSON string escapes
 *      (`\\`, `\"`, and Unicode `\uXXXX`) so an escaped `}` inside the
 *      code string is not treated as the string terminator.
 *   4. Return the decoded string up to the real closing quote.
 *
 * Returns `undefined` if no parseable `"code"` field is found yet — caller
 * should wait for the next chunk.
 */
function tryExtractCodeFromArgs(buffer: string): string | undefined {
  if (!buffer) return undefined;
  // Locate the "code" key. Accept both "code" and any whitespace padding.
  const keyIdx = buffer.indexOf('"code"');
  if (keyIdx === -1) return undefined;
  // After the key, expect `:` then optional whitespace then `"`.
  let i = keyIdx + '"code"'.length;
  while (i < buffer.length && /\s/.test(buffer[i])) i++;
  if (buffer[i] !== ":") return undefined;
  i++;
  while (i < buffer.length && /\s/.test(buffer[i])) i++;
  if (buffer[i] !== '"') return undefined;
  i++;

  // Walk the string, honoring escapes. If we reach the end without finding
  // the closing quote, the buffer is still streaming — return undefined.
  let out = "";
  while (i < buffer.length) {
    const ch = buffer[i];
    if (ch === "\\") {
      // Escape sequence: \", \\, \/, \n, \r, \t, \b, \f, \uXXXX
      if (i + 1 >= buffer.length) return undefined; // incomplete
      const next = buffer[i + 1];
      if (next === "u") {
        if (i + 6 > buffer.length) return undefined; // incomplete
        const hex = buffer.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          // Malformed escape — abort and let caller wait for more data.
          return undefined;
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else if ("\"\\/nrtbf".includes(next)) {
        out +=
          next === "n"
            ? "\n"
            : next === "r"
              ? "\r"
              : next === "t"
                ? "\t"
                : next === "b"
                  ? "\b"
                  : next === "f"
                    ? "\f"
                    : next;
        i += 2;
      } else {
        // Unknown escape — be conservative and include it as-is so the
        // user at least sees the code; fall through to next char.
        out += ch + next;
        i += 2;
      }
    } else if (ch === '"') {
      // End of string. Trim a trailing comma if any (valid JSON anyway).
      return out;
    } else {
      out += ch;
      i++;
    }
  }
  // Hit the end of the buffer without finding the closing quote — still
  // streaming.
  return undefined;
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
  const { sessionId, message, model } = (await req.json()) as {
    sessionId?: string;
    message?: string;
    model?: string;
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

  // 4b. If this is the first user message, use it as the session title so
  //     the sidebar shows a meaningful name instead of "New analysis session".
  //     The title is truncated to keep the sidebar tidy.
  const { count: userMessageCount } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .eq("role", "user");

  if (userMessageCount === 1) {
    const title = message.trim().slice(0, 60);
    await supabase.from("sessions").update({ title }).eq("id", sessionId);
  }

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
        | { kind: "tool"; id: string; tool: string; content: string; code?: string }
        | { kind: "text"; content: string }
        | { kind: "artifact"; artifactType: string; artifactIndex: number }
      > = [];

      // Track which tool_call ids we've already announced, so we only emit one
      // tool_call SSE event per call even though the args stream in fragments.
      const announcedToolCalls = new Set<string>();
      // Map tool_call_id → segment reference, so tool_result can fill content.
      const toolSegments = new Map<
        string,
        { kind: "tool"; id: string; tool: string; content: string; code?: string }
      >();
      // Accumulate streaming tool-call args so we can extract the code for
      // run_python and emit it as a tool_progress event before execution ends.
      const toolCallArgsBuffers = new Map<
        string,
        { name: string; buffer: string }
      >();
      const codeProgressAnnounced = new Set<string>();
      // Tracks the most recently seen tool_call id. LangChain streams the id
      // only on the first chunk for a tool call; subsequent chunks (args
      // fragments) carry an empty id and need to be attributed to this id.
      let currentToolCallId = "";

      // Accumulate LLM token usage across all AIMessageChunks in this turn.
      // LangChain streams usage_metadata on the final chunk of each LLM call
      // (input_tokens, output_tokens, total_tokens). A ReAct turn may have
      // multiple LLM calls (one per reasoning step), so we sum them all.
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // ----------------------------------------------------------
      // Request-level sandbox reuse
      //
      // One sandbox is shared across all tool calls in this ReAct turn
      // (run_python / run_forecast / run_cluster / build_plotly_chart /
      // execute_*_sql on file/duckdb/sqlite sources). The sandbox is
      // created lazily on the first tool call that needs it (so trivial
      // turns that only answer from prior knowledge pay zero creation
      // latency) and deleted in the `finally` block below when the stream
      // ends — whether successfully, via error, or via client disconnect.
      //
      // `sandboxPromise` is null until the first call to `getSandbox()`.
      // Once set, every subsequent call returns the same promise, so all
      // tool calls in this turn reuse the resolved sandbox.
      // ----------------------------------------------------------
      let sandboxPromise: Promise<Sandbox> | null = null;
      const getSandbox = (): Promise<Sandbox> => {
        if (!sandboxPromise) {
          sandboxPromise = createSandbox();
        }
        return sandboxPromise;
      };

      try {
        const llmConfig = await loadUserLlmConfig(user.id);
        for await (const chunk of streamAgent({
          sessionId,
          question: message,
          dataSourceId,
          dataSourceType,
          fileDataSourceIds,
          userId: user.id,
          llmConfig,
          model,
          getSandbox,
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

            // 0. Token usage metadata — LangChain streams this on the final
            //    chunk of each LLM call. Accumulate across all LLM calls in
            //    this turn (a ReAct loop may issue multiple LLM calls).
            //    usage_metadata shape: { input_tokens, output_tokens, total_tokens }
            const usage = (aiChunk as { usage_metadata?: Record<string, unknown> }).usage_metadata;
            if (usage) {
              const inTok = Number(usage.input_tokens ?? 0);
              const outTok = Number(usage.output_tokens ?? 0);
              if (!Number.isNaN(inTok)) totalInputTokens += inTok;
              if (!Number.isNaN(outTok)) totalOutputTokens += outTok;
            }

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
            //
            // LangChain streaming pattern: the FIRST chunk for a tool call
            // carries id + name (with empty args); subsequent chunks for the
            // SAME tool call carry only the args fragment (id="" name="").
            // We track the "current" tool_call_id so args fragments without
            // an explicit id are attributed to the right tool call.
            const toolCallChunks = aiChunk.tool_call_chunks ?? [];
            for (const tc of toolCallChunks) {
              const id = tc.id;
              const name = tc.name;
              const args = tc.args;

              // Update the "current" tool call id when a chunk carries one.
              // Subsequent chunks without id will reuse this.
              if (id) {
                currentToolCallId = id;
              }
              const effectiveId = id || currentToolCallId;

              // Accumulate args so we can detect run_python code as early as
              // possible and stream it to the UI before execution finishes.
              if (effectiveId) {
                if (!toolCallArgsBuffers.has(effectiveId)) {
                  toolCallArgsBuffers.set(effectiveId, { name: name ?? "", buffer: "" });
                }
                const entry = toolCallArgsBuffers.get(effectiveId)!;
                if (name) entry.name = name;
                if (args && typeof args === "string") {
                  entry.buffer += args;
                }

                // For run_python, extract the code from the args JSON as
                // soon as it parses. We try parsing on every chunk so that
                // even when the code string contains internal `}` (which
                // would make a naive `endsWith("}")` early-detect), the
                // full-buffer parse still works once the stream is complete.
                if (
                  entry.name === "run_python" &&
                  !codeProgressAnnounced.has(effectiveId)
                ) {
                  const code = tryExtractCodeFromArgs(entry.buffer);
                  if (typeof code === "string" && code.length > 0) {
                    codeProgressAnnounced.add(effectiveId);
                    send({
                      tool_progress: {
                        id: effectiveId,
                        name: entry.name,
                        type: "code",
                        code,
                      },
                    });
                  }
                }
              }

              if (id && name && !announcedToolCalls.has(id)) {
                announcedToolCalls.add(id);
                // For run_python, attach the code to the tool_call event
                // itself so the UI has the code from the very first moment
                // (no flicker, no race with tool_progress). If the args
                // buffer hasn't finished yet, code will arrive in a
                // follow-up tool_progress event.
                let code: string | undefined;
                if (name === "run_python" && !codeProgressAnnounced.has(id)) {
                  const extracted = tryExtractCodeFromArgs(
                    toolCallArgsBuffers.get(id)?.buffer ?? "",
                  );
                  if (typeof extracted === "string" && extracted.length > 0) {
                    code = extracted;
                    codeProgressAnnounced.add(id);
                  }
                }
                const toolCallPayload: { id: string; name: string; code?: string } = {
                  id,
                  name,
                };
                if (code) toolCallPayload.code = code;
                send({ tool_call: toolCallPayload });
                // Create a tool segment at this position so the rendered order
                // matches the LLM's narration flow. Content is filled when the
                // ToolMessage (tool_result) arrives.
                const seg: { kind: "tool"; id: string; tool: string; content: string; code?: string } = {
                  kind: "tool",
                  id,
                  tool: name,
                  content: "",
                };
                if (code) seg.code = code;
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

            // Last-chance fallback: if the segment still has no code but
            // we have the full args buffer, try to extract it now. Covers
            // the edge case where the LLM streamed the full args in a
            // single chunk (so tool_call was sent with code already) or
            // where tryExtractCodeFromArgs had a partial parse during
            // streaming and only now has the complete buffer.
            if (
              name === "run_python" &&
              seg &&
              !seg.code &&
              !codeProgressAnnounced.has(id)
            ) {
              const fullBuffer = toolCallArgsBuffers.get(id)?.buffer ?? "";
              const extracted = tryExtractCodeFromArgs(fullBuffer);
              if (typeof extracted === "string" && extracted.length > 0) {
                seg.code = extracted;
                codeProgressAnnounced.add(id);
                send({
                  tool_progress: {
                    id,
                    name,
                    type: "code",
                    code: extracted,
                  },
                });
              }
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
        // Clean up the request-level sandbox if one was created. This runs
        // on success, error, and (best-effort) client disconnect. If the
        // sandbox creation itself failed, `sandboxPromise` is a rejected
        // promise — awaiting it throws, the catch swallows it, and there's
        // nothing to delete. If no sandbox tool was called, `sandboxPromise`
        // is null and we skip cleanup entirely.
        if (sandboxPromise) {
          try {
            const sb = await sandboxPromise;
            await deleteSandbox(sb);
          } catch (err) {
            console.error("[chat] failed to clean up request sandbox:", err);
          }
        }
        // Trim old LangGraph checkpoints to prevent unbounded growth in
        // long conversations. Keeps the most recent 50 checkpoints (enough
        // for replay); older ones are deleted from checkpoints + checkpoint_writes.
        // Then trim orphaned checkpoint_blobs — binary blobs whose parent
        // checkpoints were just deleted. Best-effort: don't block response.
        try {
          const admin = createAdminClient();
          await admin.rpc("trim_checkpoints", {
            p_thread_id: sessionId,
            p_keep: 50,
          });
          await admin.rpc("trim_checkpoint_blobs", {
            p_thread_id: sessionId,
          });
        } catch (err) {
          console.error("[chat] failed to trim old checkpoints:", err);
        }
        // Log LLM token usage for this turn. Accumulated from
        // usage_metadata on AIMessageChunks across all LLM calls in the
        // ReAct loop. Best-effort: don't block response on failure.
        if (totalInputTokens > 0 || totalOutputTokens > 0) {
          try {
            await logUsage({
              userId: user.id,
              sessionId,
              tokensIn: totalInputTokens,
              tokensOut: totalOutputTokens,
              source: "llm",
            });
          } catch (err) {
            console.error("[chat] failed to log LLM usage:", err);
          }
        }
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
