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

/**
 * Create a fresh sandbox. Used by the request-level reuse flow (route.ts
 * wraps this in a lazy provider) and by `runPython`'s ephemeral fallback.
 */
export async function createSandbox(): Promise<Sandbox> {
  const client = getClient();
  return client.create({
    image: process.env.DAYTONA_IMAGE ?? "datellix-data-analysis",
    language: "python",
  });
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
