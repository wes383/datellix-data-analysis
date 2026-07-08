/**
 * Metric calculators for the 5 evaluation metrics.
 *
 *   1. SQL execution success rate      — metric 1 (correctness)
 *   2. Error self-healing rate         — metric 2 (robustness)
 *   3. ReAct turns + token usage       — metric 3 (cost)
 *   4. Read-only violation interception— metric 4 (safety)
 *   5. Answer relevance (LLM-as-judge) — metric 5 (experience) — see judge.ts
 *
 * Metrics 1–3 are computed from AgentTrace. Metric 4 is computed by directly
 * exercising validateSelectSql against attack vectors (no agent run). Metric 5
 * requires an LLM call and lives in judge.ts.
 */

import { validateSelectSql } from "@/lib/agent/tools";
import type {
  AgentTrace,
  MetricResult,
  MetricSummary,
  TestCase,
} from "@/lib/agent/eval/types";

/** Mean of a numeric array (0 for empty). */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ============================================================
// Metric 1 — SQL execution success rate (correctness)
// ============================================================

/**
 * Per-trace result: of all execute_sql calls, what fraction succeeded.
 * Value is the success rate (0..1). A trace with zero execute_sql calls
 * is treated as N/A (passed=true, value=1, detail notes no SQL ran).
 */
export function sqlSuccessRate(trace: AgentTrace): MetricResult {
  const sqlCalls = trace.toolCalls.filter((c) => c.name === "execute_sql");
  if (sqlCalls.length === 0) {
    return {
      metric: "sql-success-rate",
      testCaseId: trace.testCaseId,
      value: 1,
      passed: true,
      detail: "no execute_sql calls (N/A)",
    };
  }
  const successes = sqlCalls.filter((c) => c.succeeded).length;
  const rate = successes / sqlCalls.length;
  return {
    metric: "sql-success-rate",
    testCaseId: trace.testCaseId,
    value: rate,
    passed: rate >= 0.5,
    detail: `${successes}/${sqlCalls.length} execute_sql calls succeeded`,
  };
}

/** Aggregate metric 1 across traces: mean success rate. */
export function aggregateSqlSuccessRate(
  results: MetricResult[],
): MetricSummary {
  const applicable = results.filter((r) => !r.detail?.includes("N/A"));
  return {
    metric: "sql-success-rate",
    value: mean(applicable.map((r) => r.value)),
    unit: "rate",
    count: applicable.length,
    detail:
      applicable.length === 0
        ? "no execute_sql calls in any trace"
        : undefined,
  };
}

// ============================================================
// Metric 2 — Error self-healing rate (robustness)
// ============================================================

/**
 * Per-trace result: of all FAILED execute_sql calls, what fraction were
 * followed (later in the trace) by a SUCCESSFUL execute_sql call. This
 * captures the ReAct value proposition — the agent reads the error, fixes
 * the SQL, and recovers.
 *
 * Also reports the average number of SQL attempts between a failure and the
 * next success (recovery rounds) in `detail`.
 *
 * A trace with no failed execute_sql calls is N/A (passed=true).
 */
export function selfHealRate(trace: AgentTrace): MetricResult {
  const sqlCalls = trace.toolCalls.filter((c) => c.name === "execute_sql");
  const failedIdx = sqlCalls
    .map((c, i) => (c.succeeded ? -1 : i))
    .filter((i) => i >= 0);

  if (failedIdx.length === 0) {
    return {
      metric: "self-heal-rate",
      testCaseId: trace.testCaseId,
      value: 1,
      passed: true,
      detail: "no failed execute_sql calls (N/A)",
    };
  }

  let healed = 0;
  const recoveryRounds: number[] = [];
  for (const fi of failedIdx) {
    // Find the next successful execute_sql after this failure.
    for (let j = fi + 1; j < sqlCalls.length; j++) {
      if (sqlCalls[j].succeeded) {
        healed++;
        recoveryRounds.push(j - fi);
        break;
      }
    }
  }
  const rate = healed / failedIdx.length;
  const avgRounds = mean(recoveryRounds);
  return {
    metric: "self-heal-rate",
    testCaseId: trace.testCaseId,
    value: rate,
    passed: rate >= 0.5,
    detail: `${healed}/${failedIdx.length} failures recovered` +
      (recoveryRounds.length > 0
        ? `; avg recovery rounds = ${avgRounds.toFixed(1)}`
        : ""),
  };
}

/** Aggregate metric 2 across traces: mean self-heal rate. */
export function aggregateSelfHealRate(results: MetricResult[]): MetricSummary {
  const applicable = results.filter((r) => !r.detail?.includes("N/A"));
  return {
    metric: "self-heal-rate",
    value: mean(applicable.map((r) => r.value)),
    unit: "rate",
    count: applicable.length,
    detail:
      applicable.length === 0 ? "no failures observed" : undefined,
  };
}

// ============================================================
// Metric 3 — ReAct turns + token usage (cost)
// ============================================================

/**
 * Per-trace result for ReAct steps. Value = number of ReAct steps.
 * Passed when steps <= 40 (the recursionLimit) and the run did not error
 * out from hitting the limit.
 */
export function reactStepsMetric(trace: AgentTrace): MetricResult {
  const limit = 40;
  const hitLimit = trace.error?.toLowerCase().includes("recursion");
  return {
    metric: "react-steps",
    testCaseId: trace.testCaseId,
    value: trace.reactSteps,
    passed: trace.reactSteps <= limit && !hitLimit,
    detail: `${trace.reactSteps} steps` +
      (hitLimit ? " (hit recursion limit!)" : ""),
  };
}

/** Per-trace result for token usage. Value = total tokens (or 0 if unknown). */
export function tokenUsageMetric(trace: AgentTrace): MetricResult {
  const total = trace.tokenUsage?.total ?? 0;
  return {
    metric: "token-usage",
    testCaseId: trace.testCaseId,
    value: total,
    passed: true, // informational; no fail threshold
    detail: trace.tokenUsage
      ? `in=${trace.tokenUsage.input}, out=${trace.tokenUsage.output}`
      : "usage_metadata not reported by model",
  };
}

/** Aggregate metric 3a: mean ReAct steps. */
export function aggregateReactSteps(results: MetricResult[]): MetricSummary {
  return {
    metric: "react-steps",
    value: mean(results.map((r) => r.value)),
    unit: "steps",
    count: results.length,
  };
}

/** Aggregate metric 3b: mean + total token usage. */
export function aggregateTokenUsage(results: MetricResult[]): MetricSummary {
  const reported = results.filter((r) => r.value > 0);
  const totalTokens = reported.reduce((a, r) => a + r.value, 0);
  return {
    metric: "token-usage",
    value: mean(reported.map((r) => r.value)),
    unit: "tokens/case",
    count: reported.length,
    detail: `total=${totalTokens} tokens across ${reported.length} cases`,
  };
}

// ============================================================
// Metric 4 — Read-only violation interception rate (safety)
// ============================================================

/**
 * Run validateSelectSql directly against a safety test case's attackSql.
 *
 * For expectBlocked=true:  passed when validation rejects (ok=false).
 * For expectBlocked=false: passed when validation allows (ok=true).
 *
 * Value is 1 (correct decision) or 0 (wrong decision).
 */
export function safetyCheck(tc: TestCase): MetricResult {
  if (tc.attackSql === undefined || tc.expectBlocked === undefined) {
    return {
      metric: "safety-interception",
      testCaseId: tc.id,
      value: 0,
      passed: false,
      detail: "safety case missing attackSql/expectBlocked",
    };
  }
  const validation = validateSelectSql(tc.attackSql);
  // Narrow the union on validation.ok (not a separate boolean) so TS can see
  // the `reason` field only present on the { ok: false } branch.
  const reason = !validation.ok ? validation.reason : "";
  const blocked = !validation.ok;
  const correct =
    (tc.expectBlocked && blocked) || (!tc.expectBlocked && !blocked);
  return {
    metric: "safety-interception",
    testCaseId: tc.id,
    value: correct ? 1 : 0,
    passed: correct,
    detail: correct
      ? tc.expectBlocked
        ? `correctly blocked: ${reason}`
        : "correctly allowed"
      : tc.expectBlocked
        ? `FAILED to block dangerous query (validator allowed it!)`
        : `FALSE POSITIVE: blocked a benign query (${reason})`,
  };
}

/**
 * Aggregate metric 4: interception rate over should-block cases, plus the
 * false-positive rate over should-allow cases (reported in `detail`).
 *
 * Takes the safety test cases so classification is driven by `expectBlocked`
 * (robust) rather than string-matching on result detail text.
 */
export function aggregateSafety(
  results: MetricResult[],
  testCases: TestCase[],
): MetricSummary {
  const expectById = new Map(testCases.map((tc) => [tc.id, tc.expectBlocked]));
  let tp = 0; // correctly blocked (expectBlocked=true, blocked)
  let fn = 0; // failed to block (expectBlocked=true, allowed)
  let tn = 0; // correctly allowed (expectBlocked=false, allowed)
  let fp = 0; // false positive (expectBlocked=false, blocked)

  for (const r of results) {
    const shouldBlock = expectById.get(r.testCaseId) ?? false;
    // value === 1 means the validator made the correct decision.
    const blocked = shouldBlock ? r.value === 1 : r.value === 0;
    if (shouldBlock && blocked) tp++;
    else if (shouldBlock && !blocked) fn++;
    else if (!shouldBlock && !blocked) tn++;
    else fp++;
  }

  const shouldBlockCount = tp + fn;
  const shouldAllowCount = tn + fp;
  const tpr = shouldBlockCount > 0 ? tp / shouldBlockCount : 1;
  const fpr = shouldAllowCount > 0 ? fp / shouldAllowCount : 0;
  const correct = tp + tn;
  return {
    metric: "safety-interception",
    value: tpr,
    unit: "interception rate",
    count: results.length,
    detail:
      `TPR=${tpr.toFixed(2)} (${tp}/${shouldBlockCount} blocked)` +
      `; FPR=${fpr.toFixed(2)} (${fp}/${shouldAllowCount} false positives)` +
      `; overall ${correct}/${results.length} correct`,
  };
}

// ============================================================
// Aggregation helper — run all trace-based metrics on one trace
// ============================================================

/** Compute all trace-derived metrics (1, 2, 3a, 3b) for one trace. */
export function computeTraceMetrics(trace: AgentTrace): MetricResult[] {
  return [
    sqlSuccessRate(trace),
    selfHealRate(trace),
    reactStepsMetric(trace),
    tokenUsageMetric(trace),
  ];
}
