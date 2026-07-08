/**
 * Evaluation types for the Datellix ReAct agent.
 *
 * The offline eval harness runs a fixed test set against the agent, collects
 * a structured execution trace per test case, and computes the 5 metrics:
 *   1. SQL execution success rate      (correctness)
 *   2. Error self-healing rate         (robustness)
 *   3. ReAct turns + token usage       (cost)
 *   4. Read-only violation interception(safety)
 *   5. Answer relevance (LLM-as-judge) (experience)
 */

/** Test case category drives which metrics apply. */
export type TestCaseCategory =
  | "simple-query"
  | "aggregation"
  | "chart"
  | "error-recovery"
  | "forecast"
  | "clustering"
  | "report"
  | "safety";

/** A single offline test case. */
export interface TestCase {
  id: string;
  category: TestCaseCategory;
  /** The user question fed to the agent. */
  question: string;
  /** Optional substrings/numbers the final answer should reference.
   *  Used as soft hints for the LLM-as-judge. */
  expectedAnswerHints?: string[];
  /** For "safety" cases: the raw SQL fed directly to validateSelectSql
   *  (the agent is NOT run for safety cases). */
  attackSql?: string;
  /** For "safety" cases: whether validation SHOULD reject this query. */
  expectBlocked?: boolean;
}

/** One tool call recorded in a trace. */
export interface ToolCallRecord {
  name: string;
  /** Parsed tool-call args (e.g. { sql: "SELECT ..." }). Empty if unparsable. */
  args: Record<string, unknown>;
  /** The text content the tool returned. */
  resultText: string;
  /** Whether the tool call succeeded (derived from result text). */
  succeeded: boolean;
  /** Elapsed milliseconds (announce → result). */
  durationMs: number;
}

/** Full execution trace of one agent run. */
export interface AgentTrace {
  testCaseId: string;
  /** All AI message text concatenated (narration + final answer). */
  agentText: string;
  /** Final answer text (text emitted after the last tool result).
   *  Falls back to agentText when no tools were called. */
  finalAnswer: string;
  /** Ordered list of tool calls. */
  toolCalls: ToolCallRecord[];
  /** Number of ReAct steps (one per AI message / LLM call). */
  reactSteps: number;
  /** Token usage summed across all LLM calls, if reported by the model. */
  tokenUsage?: { input: number; output: number; total: number };
  /** Any error that aborted the run. */
  error?: string;
  /** Wall-clock duration of the whole run. */
  totalDurationMs: number;
}

/** Result of one metric computation for one test case. */
export interface MetricResult {
  metric: string;
  testCaseId: string;
  /** Normalized value 0..1 for rate metrics, or a raw number for counts. */
  value: number;
  /** Whether the case met its pass threshold. */
  passed: boolean;
  detail?: string;
}

/** Aggregate metric summary across a test set. */
export interface MetricSummary {
  metric: string;
  /** Aggregated value (rate 0..1, mean score, mean steps, etc.). */
  value: number;
  /** Human-readable unit (e.g. "rate", "steps", "tokens", "score"). */
  unit: string;
  /** Number of test cases contributing. */
  count: number;
  detail?: string;
}
