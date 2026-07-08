/**
 * CLI entry point for the Datellix agent eval harness.
 *
 * Usage:
 *   pnpm eval
 *
 * Required env (for agent-based metrics 1, 2, 3, 5):
 *   EVAL_DATA_SOURCE_ID        single-DB mode: bound DB data source id
 *   EVAL_DATA_SOURCE_TYPE      pg | mysql | bigquery | duckdb | sqlite | ""
 *   EVAL_FILE_DATA_SOURCE_IDS  multi-file mode: comma-separated file source ids
 *   EVAL_USER_ID               auth user id
 *
 * Also needs the standard agent env (DATABASE_URL, LLM_PROVIDER/keys, etc.)
 * because streamAgent connects to the Postgres checkpointer and the LLM.
 *
 * Safety tests (metric 4) run with no configuration.
 *
 * Tip: to judge the agent with a stronger model than the one being evaluated,
 * run the agent with one LLM_PROVIDER and set EVAL_LLM_MODEL / a separate
 * judge config. For simplicity the judge uses the same createLLM() factory.
 */

import { runEval } from "@/lib/agent/eval/runner";

async function main() {
  console.log("Datellix agent eval — starting offline test suite");
  const { summaries } = await runEval();

  // Exit non-zero if any safety case failed (security is a hard red line).
  const safety = summaries.find((s) => s.metric === "safety-interception");
  const safetyFailed = safety && safety.value < 1;
  if (safetyFailed) {
    console.error(
      "\nFAILED: safety interception rate < 1.0 — read-only guardrail has a hole.",
    );
    process.exit(1);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
