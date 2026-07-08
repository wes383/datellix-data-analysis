/**
 * Trace collector — runs the ReAct agent for one question and accumulates a
 * structured AgentTrace, mirroring the stream-consumption pattern in
 * src/app/api/chat/route.ts.
 *
 * The stream yields [mode, payload] tuples (mode === "messages"). The payload
 * is [message, metadata], where message is either:
 *   - AIMessageChunk: streaming LLM output (text, reasoning, tool_call deltas,
 *     usage_metadata on the final chunk of each LLM call)
 *   - ToolMessage:    a completed tool execution (tool_call_id, name, content,
 *     optional artifact)
 *
 * We accumulate tool-call args from streamed fragments (keyed by tool_call_id)
 * and match each ToolMessage to its announced tool call to capture args,
 * result text, success, and duration.
 */

import {
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { streamAgent } from "@/lib/agent/graph";
import type { LlmConfig } from "@/lib/db/schema";
import type { SandboxProvider } from "@/lib/daytona/client";
import type { AgentTrace, ToolCallRecord } from "@/lib/agent/eval/types";

/** Extract a plain-text string from message content (string or content blocks). */
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
 * Run the agent for one question and return a structured trace.
 *
 * Each test case gets a fresh sessionId (thread_id) so the checkpointer
 * starts with no conversation memory — guaranteeing test independence.
 */
export async function collectTrace(params: {
  testCaseId: string;
  sessionId: string;
  question: string;
  dataSourceId: string;
  dataSourceType: string;
  fileDataSourceIds: string[];
  userId: string;
  llmConfig?: LlmConfig | null;
  model?: string;
  getSandbox?: SandboxProvider;
  /** Per-case timeout in ms (default: 120000 = 2 min). */
  timeoutMs?: number;
}): Promise<AgentTrace> {
  const { testCaseId, sessionId, question } = params;
  const timeoutMs = params.timeoutMs ?? 120_000;

  const startedAt = Date.now();

  // Abort controller for the per-case timeout.
  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), timeoutMs);

  // --- Accumulators ---
  let agentText = "";
  // Text emitted after the last ToolMessage — approximates the final answer.
  let textAfterLastTool = "";
  let reactSteps = 0;
  let lastWasAI = false;
  let inputTokens = 0;
  let outputTokens = 0;

  const toolCalls: ToolCallRecord[] = [];
  // tool_call_id → index in toolCalls (to fill args/result when ToolMessage arrives)
  const toolCallIndex = new Map<string, number>();
  // tool_call_id → args buffer (streamed JSON fragments)
  const argsBuffers = new Map<string, string>();
  // tool_call_id → announce timestamp (for durationMs)
  const announceTimes = new Map<string, number>();
  // Tracks the most recent tool_call_id (LangChain streams the id only on the
  // first chunk for a call; subsequent args-only chunks carry an empty id).
  let currentToolCallId = "";

  let runError: string | undefined;

  try {
    for await (const chunk of streamAgent({
      sessionId,
      question,
      dataSourceId: params.dataSourceId,
      dataSourceType: params.dataSourceType,
      fileDataSourceIds: params.fileDataSourceIds,
      userId: params.userId,
      llmConfig: params.llmConfig,
      model: params.model,
      getSandbox: params.getSandbox,
      signal: controller.signal,
    })) {
      // streamMode: ["messages"] yields [mode, payload] tuples.
      if (!Array.isArray(chunk) || chunk.length < 2) continue;
      const [mode, payload] = chunk as [string, unknown];
      if (mode !== "messages") continue;

      const pair = payload as [BaseMessage, Record<string, unknown> | undefined];
      const msg = pair[0];
      if (!msg) continue;

      // ----------------------------------------------------------
      // AIMessageChunk: streaming LLM output
      // ----------------------------------------------------------
      if (msg instanceof AIMessageChunk || msg._getType?.() === "ai") {
        const aiChunk = msg as AIMessageChunk;

        // Count a new ReAct step on each transition into an AI message.
        if (!lastWasAI) reactSteps++;
        lastWasAI = true;

        // Token usage (streamed on the final chunk of each LLM call).
        const usage = (aiChunk as { usage_metadata?: Record<string, unknown> })
          .usage_metadata;
        if (usage) {
          const inTok = Number(usage.input_tokens ?? 0);
          const outTok = Number(usage.output_tokens ?? 0);
          if (!Number.isNaN(inTok)) inputTokens += inTok;
          if (!Number.isNaN(outTok)) outputTokens += outTok;
        }

        // Visible text content (narration + final answer).
        const text = extractText(aiChunk.content);
        if (text) {
          agentText += text;
          textAfterLastTool += text;
        }

        // Tool call deltas.
        const toolCallChunks = aiChunk.tool_call_chunks ?? [];
        for (const tc of toolCallChunks) {
          const id = tc.id;
          const name = tc.name;
          const args = tc.args;

          if (id) currentToolCallId = id;
          const effectiveId = id || currentToolCallId;
          if (!effectiveId) continue;

          // First time we see this id → announce a new tool call.
          if (!toolCallIndex.has(effectiveId)) {
            announceTimes.set(effectiveId, Date.now());
            const idx = toolCalls.length;
            toolCalls.push({
              name: name ?? "",
              args: {},
              resultText: "",
              succeeded: false,
              durationMs: 0,
            });
            toolCallIndex.set(effectiveId, idx);
            argsBuffers.set(effectiveId, "");
            // Real-time progress log.
            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
            console.log(
              `    [${elapsed}s] → tool: ${name ?? "?"}`,
            );
          } else if (name) {
            // Fill in the name if it arrived on a later chunk.
            const rec = toolCalls[toolCallIndex.get(effectiveId)!];
            if (!rec.name) rec.name = name;
          }

          // Accumulate args fragments.
          if (args && typeof args === "string") {
            argsBuffers.set(effectiveId, argsBuffers.get(effectiveId)! + args);
          }
        }
        continue;
      }

      // ----------------------------------------------------------
      // ToolMessage: a tool finished executing
      // ----------------------------------------------------------
      const isTool =
        msg instanceof ToolMessage ||
        msg._getType?.() === "tool" ||
        (typeof msg === "object" && msg !== null && "tool_call_id" in msg);
      if (isTool) {
        const tm = msg as ToolMessage;
        const id = tm.tool_call_id ?? currentToolCallId ?? "";
        const name = (tm.name ?? "tool") as string;
        const content =
          typeof tm.content === "string"
            ? tm.content
            : extractText(tm.content) || JSON.stringify(tm.content);

        const idx = toolCallIndex.get(id);
        if (idx !== undefined) {
          const rec = toolCalls[idx];
          rec.name = name;
          rec.resultText = content;
          rec.succeeded = isToolSuccess(name, content);
          const announce = announceTimes.get(id);
          if (announce) rec.durationMs = Date.now() - announce;
          // Real-time progress log.
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          if (rec.succeeded) {
            console.log(
              `    [${elapsed}s] ← ${name} ok (${rec.durationMs}ms)`,
            );
          } else {
            // Show first 200 chars of error for debugging.
            const errPreview = rec.resultText.slice(0, 200).replace(/\n/g, " ");
            console.log(
              `    [${elapsed}s] ← ${name} FAIL (${rec.durationMs}ms): ${errPreview}`,
            );
          }
          // Parse the accumulated args JSON.
          const buf = argsBuffers.get(id);
          if (buf) {
            try {
              rec.args = JSON.parse(buf) as Record<string, unknown>;
            } catch {
              // Partial/unparseable args — leave rec.args empty.
            }
          }
        } else {
          // Tool result without a prior announce (no streamed tool_call chunk).
          toolCalls.push({
            name,
            args: {},
            resultText: content,
            succeeded: isToolSuccess(name, content),
            durationMs: 0,
          });
        }

        // Reset final-answer accumulator: subsequent text is the next answer.
        lastWasAI = false;
        textAfterLastTool = "";
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      runError = `timeout after ${timeoutMs / 1000}s`;
    } else {
      runError = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timeoutTimer);
  }

  const finalAnswer = textAfterLastTool.trim() || agentText.trim();
  const tokenUsage =
    inputTokens > 0 || outputTokens > 0
      ? {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens,
        }
      : undefined;

  return {
    testCaseId,
    agentText,
    finalAnswer,
    toolCalls,
    reactSteps,
    tokenUsage,
    error: runError,
    totalDurationMs: Date.now() - startedAt,
  };
}

/**
 * Determine whether a tool call succeeded from its result text.
 *
 * execute_sql / summarize_data / build_chart / export_query / run_python /
 * run_forecast / run_cluster / build_plotly_chart / generate_report all emit
 * distinctive failure prefixes when they catch an error. Anything else is
 * treated as success.
 */
function isToolSuccess(name: string, resultText: string): boolean {
  const t = resultText.trim();
  // execute_sql success marker.
  if (name === "execute_sql") {
    return t.startsWith("Query executed successfully");
  }
  // Generic failure prefixes shared by most tools.
  const failurePrefixes = [
    "SQL validation failed",
    "SQL execution failed",
    "Build chart failed",
    "Summarize failed",
    "Export failed",
    "Python execution failed",
    "Python execution error",
    "Forecast failed",
    "Forecast error",
    "Clustering failed",
    "Clustering error",
    "Plotly chart generation failed",
    "Plotly chart error",
    "Plotly error",
    "Generate report failed",
  ];
  for (const p of failurePrefixes) {
    if (t.startsWith(p)) return false;
  }
  return true;
}
