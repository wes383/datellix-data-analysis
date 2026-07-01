import { Daytona, type Sandbox } from "@daytona/sdk";

/**
 * Daytona sandbox client
 *
 * Session-level binding: each analysis session maps to one sandbox
 * Lifecycle: create on demand → run Python/ML code → destroy on session end
 *
 * Image: datellix-data-analysis built from daytona-image/Dockerfile
 * Pre-installed: duckdb / pandas / scikit-learn / matplotlib / plotly
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
 * Get or create session-level sandbox
 * Phase 1: used for file schema extraction and DuckDB queries
 * Phase 2: adds pause/resume/timeout governance
 */
export async function getOrCreateSandbox(sessionId: string): Promise<Sandbox> {
  const cached = sandboxCache.get(sessionId);
  if (cached) return cached;

  const client = getClient();
  const sandbox = await client.create({
    image: process.env.DAYTONA_IMAGE ?? "datellix-data-analysis",
    language: "python",
  });
  sandboxCache.set(sessionId, sandbox);
  return sandbox;
}

/** Destroy sandbox (called when session ends) */
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
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const sandbox = await getOrCreateSandbox(sessionId);
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
): Promise<void> {
  const sandbox = await getOrCreateSandbox(sessionId);
  await sandbox.fs.uploadFile(fileBuffer, remotePath);
}

/** Standard path for data files inside the sandbox */
export const SANDBOX_DATA_DIR = "/tmp/data";
