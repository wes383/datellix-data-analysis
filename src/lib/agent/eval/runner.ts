/**
 * Eval runner — orchestrates the full offline evaluation suite.
 *
 * Flow:
 *   1. Run safety tests (metric 4) directly against validateSelectSql — no
 *      agent run, no data source needed.
 *   2. For each agent test case: run the ReAct agent → collect a trace →
 *      compute metrics 1, 2, 3a, 3b → run the LLM-as-judge for metric 5.
 *   3. Aggregate each metric across the test set.
 *   4. Print a readable per-case table + a summary table to stdout.
 *
 * Configuration (read from env vars so secrets stay out of code):
 *   EVAL_DATA_SOURCE_ID        single-DB mode: bound DB data source id
 *   EVAL_DATA_SOURCE_TYPE      pg | mysql | bigquery | duckdb | sqlite | ""
 *   EVAL_FILE_DATA_SOURCE_IDS  multi-file mode: comma-separated file source ids
 *   EVAL_USER_ID               auth user id (for usage logging + file staging)
 *   EVAL_LLM_MODEL             optional model override
 *
 * Agent cases are skipped (with a warning) when no data source is configured;
 * safety cases always run.
 */

import { createSandbox, deleteSandbox, type Sandbox } from "@/lib/daytona/client";
import { loadUserLlmConfig } from "@/lib/storage/resolver";
import { collectTrace } from "@/lib/agent/eval/trace-collector";
import {
  AGENT_TEST_CASES,
  SAFETY_TEST_CASES,
} from "@/lib/agent/eval/testset";
import {
  aggregateAnswerRelevance,
  answerRelevanceScore,
} from "@/lib/agent/eval/judge";
import {
  aggregateReactSteps,
  aggregateSafety,
  aggregateSelfHealRate,
  aggregateSqlSuccessRate,
  aggregateTokenUsage,
  computeTraceMetrics,
  safetyCheck,
} from "@/lib/agent/eval/metrics";
import type {
  AgentTrace,
  MetricResult,
  MetricSummary,
  TestCase,
} from "@/lib/agent/eval/types";

/** Resolve data-source + user config from env vars. */
function resolveConfig(): {
  dataSourceId: string;
  dataSourceType: string;
  fileDataSourceIds: string[];
  userId: string;
  model?: string;
} {
  const fileIds = (process.env.EVAL_FILE_DATA_SOURCE_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // When file data source ids are provided, dataSourceType must be "file"
  // so execute_sql routes to executeMultiFileSql (DuckDB in sandbox).
  // Otherwise use the explicitly configured type (pg/mysql/bigquery/etc.).
  const explicitType = process.env.EVAL_DATA_SOURCE_TYPE ?? "";
  const dataSourceType = fileIds.length > 0 ? "file" : explicitType;
  return {
    dataSourceId: process.env.EVAL_DATA_SOURCE_ID ?? "",
    dataSourceType,
    fileDataSourceIds: fileIds,
    userId: process.env.EVAL_USER_ID ?? "",
    model: process.env.EVAL_LLM_MODEL,
  };
}

/** Whether agent cases can run (need a data source + user id). */
function canRunAgentCases(cfg: ReturnType<typeof resolveConfig>): boolean {
  const hasSource =
    !!cfg.dataSourceId || cfg.fileDataSourceIds.length > 0;
  return hasSource && !!cfg.userId;
}

/** Run the full eval suite and return all results + summaries. */
export async function runEval(): Promise<{
  perCase: MetricResult[];
  traces: AgentTrace[];
  summaries: MetricSummary[];
}> {
  const cfg = resolveConfig();
  const perCase: MetricResult[] = [];
  const traces: AgentTrace[] = [];

  // ----------------------------------------------------------
  // Metric 4 — safety (always runs, no data source needed)
  // ----------------------------------------------------------
  console.log(`\n=== Safety tests (${SAFETY_TEST_CASES.length} cases) ===`);
  for (const tc of SAFETY_TEST_CASES) {
    const r = safetyCheck(tc);
    perCase.push(r);
    console.log(
      `  ${r.passed ? "PASS" : "FAIL"}  ${tc.id.padEnd(24)} ${r.detail ?? ""}`,
    );
  }

  // ----------------------------------------------------------
  // Metrics 1, 2, 3, 5 — agent cases (need a data source)
  // ----------------------------------------------------------
  if (!canRunAgentCases(cfg)) {
    console.log(
      "\n=== Agent cases skipped ===\n" +
        "Set EVAL_DATA_SOURCE_ID (or EVAL_FILE_DATA_SOURCE_IDS) and EVAL_USER_ID\n" +
        "to run the agent-based metrics (1, 2, 3, 5).\n",
    );
  } else {
    console.log(
      `\n=== Agent cases (${AGENT_TEST_CASES.length} cases) ===`,
    );
    const llmConfig = await loadUserLlmConfig(cfg.userId).catch(() => null);

    for (const tc of AGENT_TEST_CASES) {
      // Each case gets a fresh thread_id for test independence.
      const sessionId = `eval-${Date.now()}-${tc.id}`;

      // Request-level sandbox reuse (mirrors src/app/api/chat/route.ts).
      let sandboxPromise: Promise<Sandbox> | null = null;
      const getSandbox = (): Promise<Sandbox> => {
        if (!sandboxPromise) sandboxPromise = createSandbox();
        return sandboxPromise;
      };

      console.log(`\n  [${tc.id}] ${tc.question}`);
      try {
        const trace = await collectTrace({
          testCaseId: tc.id,
          sessionId,
          question: tc.question,
          dataSourceId: cfg.dataSourceId,
          dataSourceType: cfg.dataSourceType,
          fileDataSourceIds: cfg.fileDataSourceIds,
          userId: cfg.userId,
          llmConfig,
          model: cfg.model,
          getSandbox,
        });
        traces.push(trace);

        if (trace.error) {
          console.log(`    ERROR: ${trace.error}`);
        }

        // Metrics 1, 2, 3a, 3b.
        const traceMetrics = computeTraceMetrics(trace);
        for (const m of traceMetrics) {
          perCase.push(m);
          console.log(
            `    ${m.metric.padEnd(22)} ${m.value.toFixed(2).padStart(7)}  ${m.detail ?? ""}`,
          );
        }

        // Metric 5 — LLM-as-judge.
        const relevance = await answerRelevanceScore(
          tc,
          trace,
          llmConfig,
          cfg.model,
        );
        perCase.push(relevance);
        console.log(
          `    ${relevance.metric.padEnd(22)} ${relevance.value.toFixed(2).padStart(7)}  ${relevance.detail ?? ""}`,
        );
      } finally {
        // Clean up the request-level sandbox (best-effort).
        if (sandboxPromise) {
          try {
            await deleteSandbox(await sandboxPromise);
          } catch {
            // Swallow — sandbox may not have been created.
          }
        }
      }
    }
  }

  // ----------------------------------------------------------
  // Aggregate summaries
  // ----------------------------------------------------------
  const summaries: MetricSummary[] = [
    aggregateSqlSuccessRate(
      perCase.filter((r) => r.metric === "sql-success-rate"),
    ),
    aggregateSelfHealRate(
      perCase.filter((r) => r.metric === "self-heal-rate"),
    ),
    aggregateReactSteps(perCase.filter((r) => r.metric === "react-steps")),
    aggregateTokenUsage(perCase.filter((r) => r.metric === "token-usage")),
    aggregateSafety(
      perCase.filter((r) => r.metric === "safety-interception"),
      SAFETY_TEST_CASES,
    ),
    aggregateAnswerRelevance(
      perCase.filter((r) => r.metric === "answer-relevance"),
    ),
  ];

  printSummary(summaries);
  return { perCase, traces, summaries };
}

/** Print the aggregate summary table. */
function printSummary(summaries: MetricSummary[]): void {
  console.log("\n" + "=".repeat(72));
  console.log("AGGREGATE SUMMARY");
  console.log("=".repeat(72));
  console.log(
    "metric".padEnd(24) +
      "value".padStart(10) +
      "unit".padStart(14) +
      "count".padStart(8),
  );
  console.log("-".repeat(72));
  for (const s of summaries) {
    console.log(
      s.metric.padEnd(24) +
        s.value.toFixed(3).padStart(10) +
        s.unit.padStart(14) +
        String(s.count).padStart(8),
    );
    if (s.detail) console.log("    " + s.detail);
  }
  console.log("=".repeat(72));
}
