import { Daytona, type Sandbox } from "@daytonaio/sdk";

/**
 * Daytona sandbox client
 *
 * Session-level binding: each analysis session maps to one sandbox
 * Lifecycle: create on demand → run Python/ML code → destroy on session end
 *
 * Image: datellix-data-analysis built from daytona-image/Dockerfile
 * Pre-installed: duckdb / pandas / scikit-learn / matplotlib / plotly
 *
 * Docs: https://github.com/daytonaio/daytona
 */

let daytonaClient: Daytona | null = null;

/** Get Daytona client singleton */
function getClient(): Daytona {
  if (daytonaClient) return daytonaClient;
  daytonaClient = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY!,
    serverUrl: process.env.DAYTONA_SERVER_URL,
  });
  return daytonaClient;
}

/** In-memory sandbox cache: sessionId → Sandbox instance */
const sandboxCache = new Map<string, Sandbox>();

/**
 * Get or create session-level sandbox
 * Phase 0: only create and cache; Phase 2 onwards adds pause/resume logic
 */
export async function getOrCreateSandbox(sessionId: string): Promise<Sandbox> {
  const cached = sandboxCache.get(sessionId);
  if (cached) return cached;

  const client = getClient();
  const sandbox = await client.create({
    image: process.env.DAYTONA_IMAGE ?? "datellix-data-analysis",
    // Language identifier: Daytona uses this to select the default execution environment
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
 * Phase 0 placeholder implementation; Phase 2 invoked by LangGraph code node
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
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.exitCode ?? 0,
  };
}
