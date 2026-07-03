import { put, del, list, head } from "@vercel/blob";
import { createHash } from "node:crypto";

/**
 * Vercel Blob file storage client
 *
 * Path convention: uploads/{userId}/{sessionId}/{filename}
 * Called by /api/upload route from Phase 1 onwards, stores raw CSV/Excel/Parquet
 * Queried directly with DuckDB inside Daytona sandbox on demand (fetched to temp disk first)
 *
 * All functions accept an optional `token` parameter. When omitted, the
 * project-level BLOB_READ_WRITE_TOKEN env var is used. This allows per-user
 * custom Blob tokens via user_settings.
 */

/** Upload file to Blob, returns accessible URL.
 *  Uses addRandomSuffix to avoid conflicts when the same filename is uploaded
 *  multiple times (Vercel Blob rejects overwrites by default). */
export async function uploadFile(
  path: string,
  file: Blob | File | ArrayBuffer,
  token?: string,
): Promise<string> {
  const blob = await put(path, file, {
    access: "private",
    addRandomSuffix: true,
    token: token ?? process.env.BLOB_READ_WRITE_TOKEN,
  });
  return blob.url;
}

/** Delete file */
export async function deleteFile(url: string, token?: string): Promise<void> {
  await del(url, {
    token: token ?? process.env.BLOB_READ_WRITE_TOKEN,
  });
}

/** List files under a prefix */
export async function listFiles(prefix: string, token?: string) {
  return list({
    prefix,
    token: token ?? process.env.BLOB_READ_WRITE_TOKEN,
  });
}

/** Get file metadata (size, type) */
export async function getFileMeta(url: string, token?: string) {
  return head(url, {
    token: token ?? process.env.BLOB_READ_WRITE_TOKEN,
  });
}

/** Build standard path: uploads/{userId}/{sessionId}/{filename} */
export function blobPath(userId: string, sessionId: string, filename: string): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `uploads/${userId}/${sessionId}/${safeName}`;
}

/**
 * Compute SHA-256 hash of a file's contents (hex digest).
 * Used for deduplication: if a file with the same hash already exists as a
 * data_source, we reuse it instead of uploading a second copy to Blob.
 */
export async function fileHash(file: Blob | File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}
