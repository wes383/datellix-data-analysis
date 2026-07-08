/**
 * Discovery helper — lists data sources and auth users so you can grab the
 * IDs needed to run the full agent eval.
 *
 * Usage:
 *   pnpm list-eval-resources
 *
 * Prints:
 *   - All data sources (id, name, type, created_at) so you can find the
 *     sales.csv data source you uploaded.
 *   - All auth users (id, email) so you can find your EVAL_USER_ID.
 *
 * If no data sources exist yet, upload scripts/test-data/sales.csv via the
 * app's Sources page first, then re-run this helper.
 */

import { createAdminClient } from "@/lib/supabase/admin";

async function main() {
  const admin = createAdminClient();

  // --- List data sources ---
  console.log("\n=== Data sources ===");
  const { data: sources, error: srcErr } = await admin
    .from("data_sources")
    .select("id, name, type, created_at")
    .order("created_at", { ascending: false });

  if (srcErr) {
    console.error("Failed to list data_sources:", srcErr.message);
  } else if (!sources || sources.length === 0) {
    console.log("  (none yet — upload scripts/test-data/sales.csv via the app UI)");
  } else {
    for (const s of sources) {
      console.log(
        `  ${s.id}  type=${(s.type as string).padEnd(6)}  ${(s.name as string).padEnd(30)}  ${s.created_at}`,
      );
    }
  }

  // --- List auth users ---
  console.log("\n=== Auth users ===");
  const {
    data: { users },
    error: userErr,
  } = await admin.auth.admin.listUsers();

  if (userErr) {
    console.error("Failed to list users:", userErr.message);
  } else if (!users || users.length === 0) {
    console.log("  (none yet)");
  } else {
    for (const u of users) {
      console.log(`  ${u.id}  ${u.email ?? "(no email)"}`);
    }
  }

  // --- Hint ---
  console.log(
    "\nTo run the full eval:\n" +
      "  EVAL_FILE_DATA_SOURCE_IDS=<data-source-id> \\\n" +
      "  EVAL_USER_ID=<user-id> \\\n" +
      "  pnpm eval\n",
  );
}

main().catch((err) => {
  console.error("Discovery failed:", err);
  process.exit(1);
});
