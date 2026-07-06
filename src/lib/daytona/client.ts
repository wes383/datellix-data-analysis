import { Daytona, type Sandbox } from "@daytona/sdk";

/**
 * Daytona sandbox client — request-level reuse + ephemeral fallback
 *
 * Each `/api/chat` request can share one sandbox across all tool calls in a
 * single ReAct turn (run_python / run_forecast / run_cluster /
 * build_plotly_chart / execute_*_sql), avoiding repeated 3-8s creation
 * latency. The route handler owns the lifecycle: it lazily creates the
 * sandbox via `createSandbox()` on the first tool call, passes a
 * `SandboxProvider` down through streamAgent → createAgentTools → runPython,
 * and deletes the sandbox in a `finally` block when the stream ends.
 *
 * `runPython` still supports the ephemeral model: when no `getSandbox`
 * provider is supplied (e.g. one-shot callers like schema indexing), it
 * creates + deletes a sandbox around the single call. This eliminates
 * disk-quota leakage from callers that don't participate in the request
 * lifecycle.
 *
 * Image: datellix-data-analysis built from daytona-image/Dockerfile
 * Pre-installed: duckdb / pandas / scikit-learn / matplotlib / plotly
 */

/** Re-export the Sandbox type so callers don't depend on @daytona/sdk directly. */
export type { Sandbox } from "@daytona/sdk";

/**
 * Lazy resolver for a shared request-level sandbox. The first call creates
 * the sandbox; subsequent calls return the same promise. The caller that
 * creates the provider owns the sandbox lifecycle (deletion in `finally`).
 */
export type SandboxProvider = () => Promise<Sandbox>;

let daytonaClient: Daytona | null = null;

/** Get Daytona client singleton */
function getClient(): Daytona {
  if (daytonaClient) return daytonaClient;
  daytonaClient = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    apiUrl: process.env.DAYTONA_API_URL,
  });
  return daytonaClient;
}

/** Label applied to every sandbox this app creates, so we can identify and
 *  clean up leaked sandboxes without touching sandboxes from other apps in
 *  the same Daytona organization. */
const SANDBOX_LABEL_APP = "datellix";

/** Auto-delete interval (minutes). A sandbox is deleted this long after it
 *  stops (either explicitly or via autoStopInterval). This is a safety net —
 *  our code already deletes sandboxes in `finally` blocks, but if the
 *  process is killed (serverless timeout, host restart) before `finally`
 *  runs, the sandbox would leak forever. 30 min gives long-running chat
 *  turns plenty of headroom while ensuring no sandbox survives more than
 *  30 min after it goes idle. */
const SANDBOX_AUTO_DELETE_MINUTES = 30;

/** Detect a Daytona disk-quota error from the SDK's error shape. */
function isDiskLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("disk limit exceeded") ||
    msg.includes("total disk limit") ||
    (msg.includes("storage") && msg.includes("limit"))
  );
}

/** Detect a transient network / TLS / connection error that is safe to retry.
 *
 *  These are typically caused by:
 *    - CloudFront / CDN hiccups ("Client network socket disconnected before
 *      secure TLS connection was established")
 *    - DNS resolution failures
 *    - Connection resets (ECONNRESET)
 *    - 5xx responses from the Daytona API that are not quota-related
 *
 *  Such errors are not the user's fault and usually succeed on retry, so we
 *  retry up to 2 times with exponential backoff before giving up.
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // Network / TLS errors
  if (
    msg.includes("socket disconnected") ||
    msg.includes("tls connection") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("terminate")
  ) {
    return true;
  }
  // Daytona SDK error code: 5xx status codes are typically transient
  // (DaytonaValidationError has statusCode=400, which we exclude).
  const anyErr = err as { statusCode?: number; status?: number };
  const status = anyErr.statusCode ?? anyErr.status;
  if (typeof status === "number" && status >= 500 && status < 600) {
    return true;
  }
  return false;
}

/** Sleep helper — used for retry backoff. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Options for the low-level `createSandboxOnce` helper. Kept separate so
 *  the public `createSandbox()` wrapper can call it without a disk-cleanup
 *  loop on every retry — disk cleanup only runs once per quota error. */
function buildCreateOptions() {
  return {
    image: process.env.DAYTONA_IMAGE ?? "datellix-data-analysis",
    language: "python" as const,
    labels: { app: SANDBOX_LABEL_APP },
    autoDeleteInterval: SANDBOX_AUTO_DELETE_MINUTES,
  };
}

/** Maximum number of retries for transient network errors (TLS disconnects,
 *  connection resets, 5xx responses). Total attempts = 1 + MAX_TRANSIENT_RETRIES.
 *  Base delay 500ms doubles each retry → 500ms, 1000ms, 2000ms. */
const MAX_TRANSIENT_RETRIES = 3;
const TRANSIENT_RETRY_BASE_MS = 500;

/**
 * Create a fresh sandbox. Used by the request-level reuse flow (route.ts
 * wraps this in a lazy provider) and by `runPython`'s ephemeral fallback.
 *
 * Every sandbox is tagged with `labels.app = "datellix"` and configured with
 * `autoDeleteInterval = 30` so Daytona itself deletes the sandbox 30 minutes
 * after it stops — even if our `finally` block never runs (e.g. serverless
 * timeout, host crash). This prevents the disk-quota leakage that occurs when
 * abandoned sandboxes accumulate.
 *
 * Resilience:
 *  1. Disk-quota error → clean up all leaked sandboxes once, then retry.
 *  2. Transient network error (TLS disconnect, ECONNRESET, 5xx) → retry up
 *     to 3 times with exponential backoff (500ms, 1s, 2s).
 *  3. Other errors → throw immediately.
 */
export async function createSandbox(): Promise<Sandbox> {
  const client = getClient();
  let diskCleanupAttempted = false;

  for (let attempt = 0; ; attempt++) {
    try {
      return await client.create(buildCreateOptions());
    } catch (err) {
      // 1. Disk-quota error: clean up once, then continue the retry loop
      //    (the next attempt goes through the transient-retry path below).
      if (isDiskLimitError(err) && !diskCleanupAttempted) {
        diskCleanupAttempted = true;
        console.warn(
          "[daytona] createSandbox hit disk quota — cleaning up stale sandboxes and retrying...",
        );
        // Use includeAll=true so pre-label sandboxes (created before the
        // app=datellix label was added) are also cleaned up. Safe in a
        // single-app Daytona org; in a multi-app org set ADMIN_SECRET and
        // call the admin route with all=false instead.
        const cleanup = await cleanupStaleSandboxes(true);
        console.warn(
          `[daytona] cleanup deleted ${cleanup.deleted}/${cleanup.total} sandboxes, ` +
            `${cleanup.failed} failed — retrying createSandbox...`,
        );
        continue;
      }

      // 2. Transient network error: retry with exponential backoff up to
      //    MAX_TRANSIENT_RETRIES times.
      if (isTransientNetworkError(err) && attempt < MAX_TRANSIENT_RETRIES) {
        const delay = TRANSIENT_RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(
          `[daytona] createSandbox transient error (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES + 1}), ` +
            `retrying in ${delay}ms:`,
          err instanceof Error ? err.message : err,
        );
        await sleep(delay);
        continue;
      }

      // 3. Non-retryable, or retries exhausted — rethrow.
      throw err;
    }
  }
}

/**
 * Delete a sandbox, swallowing errors so cleanup never throws. Safe to call
 * on already-deleted sandboxes (404 is silently ignored). Used by the
 * request-level reuse flow's `finally` block and by `destroySandboxById`.
 */
export async function deleteSandbox(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.delete();
  } catch (err: any) {
    if (
      err?.message?.includes("not found") ||
      err?.status === 404 ||
      err?.code === 404
    ) {
      return;
    }
    console.error("[daytona] failed to delete sandbox:", err);
  }
}

// ============================================================
// Sandbox governance (Phase 2 §2.4)
// ============================================================

/**
 * Cumulative sandbox execution time per session, tracked in-memory.
 * Enforces SANDBOX_MAX_SECONDS (default 300s). In-memory tracking is
 * acceptable for Vercel Serverless — strict cross-instance enforcement
 * would require a DB-backed counter.
 */
const sessionUsage = new Map<string, { totalSeconds: number; lastActivity: number }>();

const SANDBOX_MAX_SECONDS = Number(process.env.SANDBOX_MAX_SECONDS ?? 300);

/**
 * Destroy a sandbox by its Daytona ID. Safe to call on already-deleted
 * sandboxes (404 is silently ignored). Kept for future use; the request-level
 * sandbox model handles cleanup in the `/api/chat` finally block, so this
 * is currently not called from any active code path.
 */
export async function destroySandboxById(sandboxId: string): Promise<void> {
  const client = getClient();
  let sandbox: Sandbox;
  try {
    sandbox = await client.get(sandboxId);
  } catch (err: any) {
    if (
      err?.message?.includes("not found") ||
      err?.status === 404 ||
      err?.code === 404
    ) {
      return;
    }
    throw err;
  }
  await deleteSandbox(sandbox);
}

/**
 * Execute Python code in a sandbox.
 *
 * Two lifecycle modes:
 *
 * 1. Request-level reuse (preferred for chat): pass `options.getSandbox`,
 *    a lazy resolver that returns a shared sandbox created by the route
 *    handler. The caller owns the lifecycle — this function does NOT delete
 *    the sandbox. Multiple `runPython` calls during one ReAct turn reuse
 *    the same sandbox, saving 3-8s of creation latency per call.
 *
 * 2. Ephemeral fallback (one-shot callers like schema indexing): omit
 *    `getSandbox`. A fresh sandbox is created here and deleted in a
 *    `finally` block, preventing disk-quota leakage.
 *
 * @param sessionId  Used for cumulative time-limit tracking only.
 * @param code       Python source to execute.
 * @param options.files       Optional files to stage in /tmp/data before running.
 * @param options.onUsage     Callback invoked with elapsed seconds (best-effort).
 * @param options.getSandbox  Lazy resolver for a shared request-level sandbox.
 *                            When provided, the caller owns deletion.
 */
export async function runPython(
  sessionId: string,
  code: string,
  options?: {
    files?: Array<{ buffer: Buffer; remotePath: string }>;
    onUsage?: (seconds: number) => Promise<void>;
    getSandbox?: SandboxProvider;
  },
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  seconds: number;
}> {
  // Check cumulative time limit before running.
  const usage = sessionUsage.get(sessionId) ?? {
    totalSeconds: 0,
    lastActivity: Date.now(),
  };
  if (usage.totalSeconds >= SANDBOX_MAX_SECONDS) {
    throw new Error(
      `Sandbox time limit reached (${SANDBOX_MAX_SECONDS}s cumulative for this session). ` +
        `Start a new session to continue.`,
    );
  }

  const start = Date.now();
  // `ownsSandbox` is true in ephemeral mode — we create and delete here.
  // When `getSandbox` is provided, the caller owns deletion (request-level).
  const ownsSandbox = !options?.getSandbox;
  let sandbox: Sandbox | null = null;

  try {
    // 1. Resolve (or create) the sandbox.
    sandbox = options?.getSandbox ? await options.getSandbox() : await createSandbox();

    // 2. Stage files (if any) before running code.
    if (options?.files && options.files.length > 0) {
      for (const file of options.files) {
        await sandbox.fs.uploadFile(file.buffer, file.remotePath);
      }
    }

    // 3. Execute the Python code.
    const result = await sandbox.process.codeRun(code);

    const elapsed = (Date.now() - start) / 1000;

    // Update cumulative tracker.
    usage.totalSeconds += elapsed;
    usage.lastActivity = Date.now();
    sessionUsage.set(sessionId, usage);

    // Best-effort usage callback.
    if (options?.onUsage) {
      try {
        await options.onUsage(elapsed);
      } catch (err) {
        console.error("[daytona] onUsage callback failed:", err);
      }
    }

    return {
      stdout: result.result ?? "",
      stderr: result.exitCode !== 0 ? result.result ?? "" : "",
      exitCode: result.exitCode ?? 0,
      seconds: elapsed,
    };
  } finally {
    // Only delete in ephemeral mode. In request-level mode the route
    // handler's `finally` block owns deletion.
    if (ownsSandbox && sandbox) {
      await deleteSandbox(sandbox);
    }
  }
}

/** Standard path for data files inside the sandbox */
export const SANDBOX_DATA_DIR = "/tmp/data";

// ============================================================
// Sandbox cleanup (disk-quota safety net)
// ============================================================

/** Result of a cleanup pass. */
export interface CleanupResult {
  /** Number of sandboxes successfully deleted. */
  deleted: number;
  /** Number of sandboxes that failed to delete. */
  failed: number;
  /** Total number of sandboxes found before cleanup. */
  total: number;
}

/**
 * List and delete all sandboxes created by this app (identified by the
 * `app=datellix` label), or ALL sandboxes in the organization when
 * `includeAll` is true.
 *
 * This is the recovery path for leaked sandboxes — sandboxes whose `finally`
 * cleanup never ran (e.g. serverless function was killed mid-execution).
 * Call this when `createSandbox()` fails with a disk-quota error, or expose
 * it via an admin route for manual cleanup.
 *
 * Deletion is best-effort: failures are counted but don't abort the pass.
 *
 * @param includeAll  When true, delete ALL sandboxes in the org (including
 *                   those from other apps). Use with caution. Defaults to
 *                   false (only `app=datellix` sandboxes).
 * @param except     Optional sandbox ID to skip (e.g. a currently-in-use
 *                   sandbox that must not be deleted).
 */
export async function cleanupStaleSandboxes(
  includeAll = false,
  except?: string,
): Promise<CleanupResult> {
  const client = getClient();
  let total = 0;
  let deleted = 0;
  let failed = 0;

  for await (const sandbox of client.list()) {
    total++;
    if (except && sandbox.id === except) continue;
    if (!includeAll && sandbox.labels?.app !== SANDBOX_LABEL_APP) {
      continue;
    }
    try {
      await sandbox.delete();
      deleted++;
    } catch (err: any) {
      // 404 = already deleted, skip silently
      if (
        err?.message?.includes("not found") ||
        err?.status === 404 ||
        err?.code === 404
      ) {
        continue;
      }
      failed++;
      console.error(
        `[daytona] cleanup: failed to delete sandbox ${sandbox.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return { deleted, failed, total };
}
