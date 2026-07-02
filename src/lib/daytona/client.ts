import { Daytona, type Sandbox } from "@daytona/sdk";

/**
 * Daytona sandbox client
 *
 * Session-level binding: each analysis session maps to one sandbox
 * Lifecycle: create on demand → run Python/ML code → destroy on session end
 *
 * Image: datellix-data-analysis built from daytona-image/Dockerfile
 * Pre-installed: duckdb / pandas / scikit-learn / matplotlib / plotly
 *
 * Sandbox lifecycle persistence:
 *  - On creation, the sandbox ID is written to sessions.sandbox_id in the DB.
 *  - On deletion, the sandbox ID is read from the DB so it survives server
 *    restarts (the in-memory cache is only a performance optimisation).
 */

let daytonaClient: Daytona | null = null;

/** Get Daytona client singleton */
function getClient(): Daytona {
  if (daytonaClient) return daytonaClient;
  daytonaClient = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    // SDK 0.192+: use apiUrl (serverUrl is deprecated).
    // Default is https://app.daytona.io/api — the /api suffix is required,
    // hitting the bare domain returns CloudFront 403.
    apiUrl: process.env.DAYTONA_API_URL,
  });
  return daytonaClient;
}

/** In-memory sandbox cache: sessionId → Sandbox instance */
const sandboxCache = new Map<string, Sandbox>();

/**
 * Get or create session-level sandbox.
 *
 * Persistence: the sandbox ID is written back to sessions.sandbox_id so that
 * deleting a session can always destroy the corresponding Daytona sandbox even
 * after a server restart (when the in-memory cache is empty).
 *
 * @param sessionId   The datellix session UUID (LangGraph thread_id).
 * @param persistFn   Optional callback that receives the new sandboxId to
 *                    persist it to the database. Only called when a brand-new
 *                    sandbox is created (not on cache hits).
 */
export async function getOrCreateSandbox(
  sessionId: string,
  persistFn?: (sandboxId: string) => Promise<void>,
): Promise<Sandbox> {
  const cached = sandboxCache.get(sessionId);
  if (cached) return cached;

  const client = getClient();
  const sandbox = await client.create({
    image: process.env.DAYTONA_IMAGE ?? "datellix-data-analysis",
    language: "python",
  });
  sandboxCache.set(sessionId, sandbox);

  // Persist the sandbox ID so we can delete it even after a server restart.
  if (persistFn) {
    try {
      await persistFn(sandbox.id);
    } catch (err) {
      // Non-fatal — worst case we leak the sandbox on session delete, but the
      // in-memory cache will still allow cleanup within the same process.
      console.error("[daytona] failed to persist sandbox_id:", err);
    }
  }

  return sandbox;
}

/**
 * Destroy sandbox by Daytona sandbox ID (retrieved from DB).
 * This is the primary deletion path used by deleteSession — it works even
 * after a server restart when the in-memory cache has been cleared.
 */
export async function destroySandboxById(sandboxId: string): Promise<void> {
  const client = getClient();
  try {
    const sandbox = await client.get(sandboxId);
    await sandbox.delete();
  } catch (err: any) {
    // 404-style errors just mean the sandbox is already gone — safe to ignore.
    if (
      err?.message?.includes("not found") ||
      err?.status === 404 ||
      err?.code === 404
    ) {
      return;
    }
    throw err;
  }
}

/**
 * Destroy sandbox using the in-memory cache (fallback / legacy path).
 * Called when no sandbox_id is stored in the DB (old sessions).
 */
export async function killSandbox(sessionId: string): Promise<void> {
  const sandbox = sandboxCache.get(sessionId);
  if (!sandbox) return;
  try {
    await sandbox.delete();
  } finally {
    sandboxCache.delete(sessionId);
  }
}

/**
 * Execute Python code in sandbox and return the result
 * Returns stdout (result), stderr, and exit code
 */
export async function runPython(
  sessionId: string,
  code: string,
  persistSandboxId?: (sandboxId: string) => Promise<void>,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const sandbox = await getOrCreateSandbox(sessionId, persistSandboxId);
  const result = await sandbox.process.codeRun(code);
  return {
    stdout: result.result ?? "",
    stderr: result.exitCode !== 0 ? result.result ?? "" : "",
    exitCode: result.exitCode ?? 0,
  };
}

/**
 * Upload a file to the session sandbox at a given remote path
 * Used to stage data files for DuckDB queries
 */
export async function uploadFileToSandbox(
  sessionId: string,
  fileBuffer: Buffer,
  remotePath: string,
  persistSandboxId?: (sandboxId: string) => Promise<void>,
): Promise<void> {
  const sandbox = await getOrCreateSandbox(sessionId, persistSandboxId);
  await sandbox.fs.uploadFile(fileBuffer, remotePath);
}

/** Standard path for data files inside the sandbox */
export const SANDBOX_DATA_DIR = "/tmp/data";
