/**
 * Database type definitions (manually maintained, can be auto-generated via supabase gen-types later)
 * Corresponds to table structure in supabase/migrations
 */

export type DataSourceType = "file" | "pg" | "mysql" | "bigquery" | "duckdb" | "sqlite";

export interface DataSource {
  id: string;
  user_id: string;
  type: DataSourceType;
  name: string;
  /** Encrypted config ciphertext (pgcrypto output, TEXT). Decrypted server-side before use. */
  config_encrypted: string;
  meta: Record<string, unknown>;
  /** For file-type data sources created in multi-file mode: the owning session. */
  session_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Postgres data source config (plaintext, only used after server-side decryption) */
export interface PgConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** SSL mode: disable | require | verify-ca | verify-full */
  ssl?: string;
}

/** File-based data source config */
export interface FileConfig {
  /** Vercel Blob URL (present when storageBackend is vercel-blob) */
  blobUrl?: string;
  /** S3 object key (present when storageBackend is s3) */
  s3Key?: string;
  /** S3 bucket name (present when storageBackend is s3) */
  s3Bucket?: string;
  filename: string;
  /** csv | excel | parquet */
  format: string;
  size: number;
}

/** MySQL data source config (plaintext, only used after server-side decryption) */
export interface MysqlConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: string;
}

/** BigQuery data source config. `credentialsJson` is the service account JSON key file content. */
export interface BigQueryConfig {
  projectId: string;
  /** Location, e.g. "US", "EU". Defaults to "US" if empty. */
  location?: string;
  /** Full contents of the service account JSON key file. */
  credentialsJson: string;
  /** Optional default dataset to scope queries (without project prefix). */
  dataset?: string;
}

/** DuckDB file data source config. The file is uploaded to Vercel Blob or S3. */
export interface DuckdbFileConfig {
  blobUrl?: string;
  s3Key?: string;
  s3Bucket?: string;
  filename: string;
  size: number;
}

/** SQLite file data source config. The file is uploaded to Vercel Blob or S3. */
export interface SqliteFileConfig {
  blobUrl?: string;
  s3Key?: string;
  s3Bucket?: string;
  filename: string;
  size: number;
}

/** REST/GraphQL API data source config */
export interface ApiConfig {
  url: string;
  method: string;
  headers?: Record<string, string>;
  /** Auth type */
  authType?: "none" | "bearer" | "basic" | "apikey";
  authToken?: string;
}

export interface Session {
  id: string;
  user_id: string;
  title: string | null;
  data_source_id: string | null;
  status: "active" | "paused" | "archived";
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  tool_calls: unknown;
  created_at: string;
}

export interface Artifact {
  id: string;
  session_id: string;
  type: "chart" | "table" | "code" | "forecast" | "summary" | "file";
  payload: Record<string, unknown>;
  created_at: string;
}

export interface UsageLog {
  id: string;
  user_id: string;
  session_id: string | null;
  sandbox_seconds: number;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  source: string | null;
  created_at: string;
}

// ============================================================
// Chart library (user-saved charts)
// ============================================================

/** A user-saved chart in the chart library.
 *  Recharts charts store spec + SQL (no inline data); data is re-queried
 *  on display. Plotly charts store the full figure JSON. */
export interface Chart {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  /** Chart spec JSONB:
   *    Recharts: { chartType, xKey, yKeys, title, uiConfig, renderer:"recharts" }
   *    Plotly:    { renderer:"plotly", plotlyFigure:{...}, title } */
  spec: Record<string, unknown>;
  /** SQL to re-execute on display (null for Plotly full-figure mode). */
  sql_text: string | null;
  /** "recharts" | "plotly" */
  renderer: "recharts" | "plotly";
  /** Originating session (set null if session deleted). */
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Join table row for chart ↔ data source binding.
 *  DB-type chart: 1 row. File-type chart: N rows (multi-file SQL). */
export interface ChartDataSource {
  id: string;
  chart_id: string;
  data_source_id: string;
  added_at: string;
}

// ============================================================
// User settings (per-user LLM + storage configuration)
// ============================================================

/** User-configurable LLM provider config (chat model only). Encrypted at rest.
 *
 *  `models` is an array so one API config (provider + apiKey + baseURL) can
 *  serve multiple models — the user switches between them in the chat UI.
 *  The first entry is the default used when no selection is stored.
 *
 *  Backward compat: older configs stored a single `model: string`. The
 *  `normalizeLlmConfig` helper converts old shape → new shape at load time. */
export interface LlmConfig {
  provider: "openai" | "anthropic" | "glm" | "openai-compat";
  apiKey: string;
  /** One or more model names sharing the same provider/apiKey/baseURL. */
  models: string[];
  /** @deprecated kept for backward compat with old encrypted configs. */
  model?: string;
  /** Required for openai-compat; optional for glm (defaults to Zhipu endpoint) */
  baseURL?: string;
  /** Only for openai-compat (default 0) */
  temperature?: number;
}

/** Convert an old-shape LlmConfig ({ model: "gpt-4o" }) to the new shape
 *  ({ models: ["gpt-4o"] }). Safe to call on already-normalized configs. */
export function normalizeLlmConfig(config: LlmConfig): LlmConfig {
  if (config.models && config.models.length > 0) {
    return config;
  }
  if (config.model) {
    return { ...config, models: [config.model], model: undefined };
  }
  return { ...config, models: [] };
}

/** User-configurable file storage config. Encrypted at rest.
 *  Only S3-compatible is supported for custom storage. When null, the
 *  project default (env-based Vercel Blob) is used. */
export interface StorageConfig {
  backend: "s3";
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
}

/** user_settings row (decrypted form; secrets masked before sending to client) */
export interface UserSettings {
  llmConfig: LlmConfig | null;
  storageConfig: StorageConfig | null;
}
