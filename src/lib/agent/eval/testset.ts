/**
 * Offline test set for the Datellix agent eval harness.
 *
 * Designed to run against a single CSV data source created by
 * scripts/generate-test-data.mjs (300 rows, table "sales"). All ground-truth
 * hints are computed from that deterministic dataset — re-running the
 * generator produces identical data + ground truth.
 *
 * Dataset schema (table: sales):
 *   order_id (text), order_date (text, YYYY-MM-DD), category (text),
 *   sub_category (text), product_name (text), region (text), segment (text),
 *   sales (number), quantity (integer), discount (number), profit (number)
 *
 * Setup:
 *   1. Run:  node scripts/generate-test-data.mjs
 *   2. Upload scripts/test-data/sales.csv as a file data source in the app
 *   3. Index its schema (happens automatically on upload)
 *   4. Set:  EVAL_FILE_DATA_SOURCE_IDS=<the-data-source-id>
 *            EVAL_USER_ID=<your-auth-user-id>
 *   5. Run:  pnpm eval
 *
 * Two groups:
 *   1. Agent cases — run through the full ReAct agent.
 *   2. Safety cases — fed directly to validateSelectSql (no agent run).
 */

import type { TestCase } from "@/lib/agent/eval/types";

/**
 * Agent cases. Ground-truth hints come from scripts/test-data/ground-truth.json.
 * Categories:
 *   - simple-query:    single-table SELECT, should succeed on first try
 *   - aggregation:     GROUP BY / aggregate, should succeed
 *   - chart:           expects the agent to call build_chart
 *   - error-recovery:  intentionally wrong column names, forcing schema re-exploration
 *   - forecast:        expects run_forecast
 *   - clustering:      expects run_cluster
 *   - report:          expects generate_report
 */
export const AGENT_TEST_CASES: TestCase[] = [
  // ── Simple queries ──────────────────────────────────────────
  {
    id: "agent-simple-1",
    category: "simple-query",
    question: "How many rows are in the sales dataset?",
    expectedAnswerHints: ["300"],
  },
  {
    id: "agent-simple-2",
    category: "simple-query",
    question: "What is the total sales amount across all orders?",
    expectedAnswerHints: ["532367.26"],
  },
  {
    id: "agent-simple-3",
    category: "simple-query",
    question: "What are all the column names in the sales table?",
    expectedAnswerHints: ["order_id", "order_date", "category", "sales", "profit"],
  },
  {
    id: "agent-simple-4",
    category: "simple-query",
    question: "What is the date range of orders in the dataset?",
    expectedAnswerHints: ["2023", "2024"],
  },

  // ── Aggregation ─────────────────────────────────────────────
  {
    id: "agent-agg-1",
    category: "aggregation",
    question: "What is the total sales grouped by category? Show me the numbers.",
    expectedAnswerHints: ["Electronics", "374516.47", "Furniture", "152586.14", "Office Supplies", "5264.65"],
  },
  {
    id: "agent-agg-2",
    category: "aggregation",
    question: "Which region has the highest total sales, and what is the amount?",
    expectedAnswerHints: ["West", "165777.58"],
  },
  {
    id: "agent-agg-3",
    category: "aggregation",
    question: "What are the top 5 products by total sales?",
    expectedAnswerHints: ["Laptop Air", "281080.22", "Standing Desk", "86912.33", "Smartphone Pro", "81744.68"],
  },
  {
    id: "agent-agg-4",
    category: "aggregation",
    question: "How many orders had a negative profit (i.e., a loss)?",
    expectedAnswerHints: ["21"],
  },
  {
    id: "agent-agg-5",
    category: "aggregation",
    question: "What is the total profit grouped by region?",
    expectedAnswerHints: ["South", "20521.06", "West", "18798.45", "East", "14516.88", "North", "11553.52"],
  },

  // ── Chart ───────────────────────────────────────────────────
  {
    id: "agent-chart-1",
    category: "chart",
    question: "Plot a bar chart of total sales by category.",
    expectedAnswerHints: ["Electronics", "bar"],
  },
  {
    id: "agent-chart-2",
    category: "chart",
    question: "Draw a line chart showing the monthly sales trend over time.",
    expectedAnswerHints: ["line", "2023", "2024"],
  },
  {
    id: "agent-chart-3",
    category: "chart",
    question: "Create a pie chart showing the proportion of total sales by region.",
    expectedAnswerHints: ["pie", "West", "South"],
  },

  // ── Error recovery ──────────────────────────────────────────
  {
    id: "agent-recovery-1",
    category: "error-recovery",
    // References a column that does not exist — agent must read the error,
    // call retrieve_schema or list_tables, and rewrite using real columns.
    question: "What is the total revenue grouped by department?",
    expectedAnswerHints: ["Electronics", "Furniture", "Office Supplies"],
  },
  {
    id: "agent-recovery-2",
    category: "error-recovery",
    // "customers" is not a table; agent should explore and use "sales" instead.
    question: "Show me the top 5 customers by purchase amount.",
    expectedAnswerHints: ["Laptop Air", "sales"],
  },
  {
    id: "agent-recovery-3",
    category: "error-recovery",
    // Vague, open-ended request that requires autonomous exploration.
    question: "Tell me something interesting about this data.",
  },

  // ── Forecast ────────────────────────────────────────────────
  {
    id: "agent-forecast-1",
    category: "forecast",
    question: "Forecast the monthly sales trend for the next 3 months using ARIMA.",
    expectedAnswerHints: ["arima", "forecast", "2025"],
  },

  // ── Clustering ──────────────────────────────────────────────
  {
    id: "agent-cluster-1",
    category: "clustering",
    question: "Cluster the orders by sales, quantity, and discount using KMeans with 3 clusters.",
    expectedAnswerHints: ["kmeans", "cluster"],
  },

  // ── Report ──────────────────────────────────────────────────
  {
    id: "agent-report-1",
    category: "report",
    question: "Generate a summary report of sales performance by category and region.",
    expectedAnswerHints: ["Electronics", "West", "report"],
  },
];

/**
 * Safety attack vectors. Each is fed to validateSelectSql directly.
 * `expectBlocked: true`  → validator MUST reject (a real attack).
 * `expectBlocked: false` → validator MUST allow (a benign read query,
 *                          ensuring the guardrail has no false positives).
 */
export const SAFETY_TEST_CASES: TestCase[] = [
  // --- Must be blocked (write / DDL / dangerous keywords) ---
  {
    id: "safety-insert",
    category: "safety",
    question: "",
    attackSql: "INSERT INTO users (name) VALUES ('attacker')",
    expectBlocked: true,
  },
  {
    id: "safety-update",
    category: "safety",
    question: "",
    attackSql: "UPDATE users SET role='admin' WHERE id=1",
    expectBlocked: true,
  },
  {
    id: "safety-delete",
    category: "safety",
    question: "",
    attackSql: "DELETE FROM users WHERE id=1",
    expectBlocked: true,
  },
  {
    id: "safety-drop",
    category: "safety",
    question: "",
    attackSql: "DROP TABLE users",
    expectBlocked: true,
  },
  {
    id: "safety-create",
    category: "safety",
    question: "",
    attackSql: "CREATE TABLE evil (id int)",
    expectBlocked: true,
  },
  {
    id: "safety-alter",
    category: "safety",
    question: "",
    attackSql: "ALTER TABLE users ADD COLUMN x int",
    expectBlocked: true,
  },
  {
    id: "safety-truncate",
    category: "safety",
    question: "",
    attackSql: "TRUNCATE TABLE users",
    expectBlocked: true,
  },
  {
    id: "safety-merge",
    category: "safety",
    question: "",
    attackSql: "MERGE INTO users USING src ON users.id=src.id WHEN MATCHED THEN UPDATE SET name=src.name",
    expectBlocked: true,
  },
  // --- Multi-statement injection ---
  {
    id: "safety-multi-stmt",
    category: "safety",
    question: "",
    attackSql: "SELECT 1; DROP TABLE users",
    expectBlocked: true,
  },
  {
    id: "safety-multi-stmt-2",
    category: "safety",
    question: "",
    attackSql: "SELECT * FROM users; DELETE FROM users WHERE 1=1",
    expectBlocked: true,
  },
  // --- Comment-based injection ---
  {
    id: "safety-line-comment",
    category: "safety",
    question: "",
    attackSql: "SELECT * FROM users -- DROP TABLE users",
    expectBlocked: true,
  },
  {
    id: "safety-block-comment",
    category: "safety",
    question: "",
    attackSql: "SELECT * FROM /* evil */ users",
    expectBlocked: true,
  },
  // --- Must be allowed (benign read-only queries using the test schema) ---
  {
    id: "safety-benign-select",
    category: "safety",
    question: "",
    attackSql: "SELECT category, SUM(sales) FROM sales GROUP BY category ORDER BY category",
    expectBlocked: false,
  },
  {
    id: "safety-benign-cte",
    category: "safety",
    question: "",
    attackSql: "WITH t AS (SELECT count(*) AS n FROM sales) SELECT n FROM t",
    expectBlocked: false,
  },
  {
    id: "safety-benign-join",
    category: "safety",
    question: "",
    attackSql: "SELECT region, AVG(sales) FROM sales WHERE profit > 0 GROUP BY region",
    expectBlocked: false,
  },
  {
    id: "safety-benign-aggregate",
    category: "safety",
    question: "",
    attackSql: "SELECT sub_category, count(*) FROM sales GROUP BY sub_category HAVING count(*) > 5",
    expectBlocked: false,
  },
];

/** The full test set: agent cases + safety cases. */
export const FULL_TEST_SET: TestCase[] = [
  ...AGENT_TEST_CASES,
  ...SAFETY_TEST_CASES,
];
