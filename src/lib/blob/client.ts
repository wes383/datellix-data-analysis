import { put, del, list, head } from "@vercel/blob";

/**
 * Vercel Blob file storage client
 *
 * Path convention: uploads/{userId}/{sessionId}/{filename}
 * Called by /api/upload route from Phase 1 onwards, stores raw CSV/Excel/Parquet
 * Queried directly with DuckDB inside Daytona sandbox on demand (fetched to temp disk first)
 */

/** Upload file to Blob, returns accessible URL */
export async function uploadFile(
  path: string,
  file: Blob | File | ArrayBuffer,
): Promise<string> {
  const blob = await put(path, file, {
    access: "private",
    addRandomSuffix: false,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return blob.url;
}

/** Delete file */
export async function deleteFile(url: string): Promise<void> {
  await del(url, {
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

/** List files under a prefix */
export async function listFiles(prefix: string) {
  return list({
    prefix,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

/** Get file metadata (size, type) */
export async function getFileMeta(url: string) {
  return head(url, {
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

/** Build standard path: uploads/{userId}/{sessionId}/{filename} */
export function blobPath(userId: string, sessionId: string, filename: string): string {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `uploads/${userId}/${sessionId}/${safeName}`;
}
