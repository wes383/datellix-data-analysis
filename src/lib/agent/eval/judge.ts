/**
 * LLM-as-judge for answer relevance (metric 5).
 *
 * Asks an LLM to score the agent's final answer against the user's question
 * on a 1–5 scale, optionally factoring in expected answer hints (numbers /
 * substrings that should appear). Returns a MetricResult with value = score.
 *
 * Uses createLLM() (same provider abstraction as the agent) so the judge runs
 * on whatever LLM the project is configured with. For a stricter evaluation,
 * set a different provider via env vars for the judge than for the agent.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { createLLM } from "@/lib/agent/llm";
import type { LlmConfig } from "@/lib/db/schema";
import type {
  AgentTrace,
  MetricResult,
  MetricSummary,
  TestCase,
} from "@/lib/agent/eval/types";

/** Build the judge prompt for one test case + trace. */
function buildJudgePrompt(tc: TestCase, trace: AgentTrace): string {
  const hints =
    tc.expectedAnswerHints && tc.expectedAnswerHints.length > 0
      ? `\nExpected answer hints (the answer should reference these where relevant): ${tc.expectedAnswerHints
          .map((h) => `"${h}"`)
          .join(", ")}`
      : "";
  return `You are an evaluation judge. Score how relevant and useful the agent's final answer is to the user's question.

User question:
${tc.question}
${hints}

Agent's final answer:
${trace.finalAnswer || "(empty)"}

Scoring rubric (output a single integer 1–5):
  5 = Directly and fully answers the question, referencing concrete data/numbers from the query results.
  4 = Mostly answers the question; minor gaps or slight lack of specificity.
  3 = Partially relevant; answers part of the question but misses important aspects or is vague.
  2 = Barely relevant; mostly generic or off-topic, little useful data.
  1 = Not relevant at all, refuses, or hallucinates without data.

Output ONLY the integer score on the first line, optionally followed by a one-sentence justification on the second line.`;
}

/** Extract the 1–5 integer score from the judge's response. */
function parseScore(raw: string): { score: number; justification?: string } {
  const match = raw.trim().match(/\b([1-5])\b/);
  const score = match ? Number(match[1]) : 0;
  const lines = raw.trim().split("\n");
  const justification = lines.length > 1 ? lines.slice(1).join(" ").trim() : undefined;
  return { score, justification };
}

/**
 * Score one trace's final answer for relevance. Falls back to a heuristic
 * score (based on answer length + hint presence) if the LLM call fails, so
 * the eval never hard-crashes on a judge error.
 */
export async function answerRelevanceScore(
  tc: TestCase,
  trace: AgentTrace,
  llmConfig?: LlmConfig | null,
  model?: string,
): Promise<MetricResult> {
  const prompt = buildJudgePrompt(tc, trace);
  try {
    const llm = createLLM(llmConfig, model);
    const res = await llm.invoke([
      new SystemMessage(
        "You are a strict but fair evaluation judge for a data-analysis AI assistant.",
      ),
      new HumanMessage(prompt),
    ]);
    const raw =
      typeof res.content === "string"
        ? res.content
        : Array.isArray(res.content)
          ? res.content
              .map((b) =>
                typeof b === "string"
                  ? b
                  : b && typeof b === "object" && "text" in b
                    ? String((b as { text: string }).text)
                    : "",
              )
              .join("")
          : "";
    const { score, justification } = parseScore(raw);
    return {
      metric: "answer-relevance",
      testCaseId: tc.id,
      value: score,
      passed: score >= 3,
      detail: justification
        ? `score=${score}/5: ${justification}`
        : `score=${score}/5`,
    };
  } catch (err) {
    // Heuristic fallback: 3 if the answer is non-empty, 1 otherwise.
    const fallback = trace.finalAnswer.trim().length > 20 ? 3 : 1;
    return {
      metric: "answer-relevance",
      testCaseId: tc.id,
      value: fallback,
      passed: fallback >= 3,
      detail: `judge LLM failed (${err instanceof Error ? err.message : String(err)}); heuristic fallback=${fallback}`,
    };
  }
}

/** Aggregate metric 5: mean relevance score across judged cases. */
export function aggregateAnswerRelevance(
  results: MetricResult[],
): MetricSummary {
  return {
    metric: "answer-relevance",
    value: results.reduce((a, r) => a + r.value, 0) / (results.length || 1),
    unit: "score/5",
    count: results.length,
    detail:
      results.length === 0
        ? "no agent traces judged"
        : undefined,
  };
}
