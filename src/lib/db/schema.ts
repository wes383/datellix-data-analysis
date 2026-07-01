/**
 * Database type definitions (manually maintained, can be auto-generated via supabase gen-types later)
 * Corresponds to table structure in supabase/migrations
 */

export type DataSourceType = "file" | "pg" | "api";

export interface DataSource {
  id: string;
  user_id: string;
  type: DataSourceType;
  name: string;
  /** Encrypted config ciphertext (pgcrypto output, TEXT). Decrypted server-side before use. */
  config_encrypted: string;
  meta: Record<string, unknown>;
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
  /** Vercel Blob URL */
  blobUrl: string;
  filename: string;
  /** csv | excel | parquet */
  format: string;
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
  sandbox_id: string | null;
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
  type: "chart" | "table" | "code" | "forecast" | "summary";
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
