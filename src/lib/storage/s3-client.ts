import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import type { StorageConfig } from "@/lib/db/schema";

/**
 * S3-compatible storage client.
 *
 * Supports AWS S3, MinIO, Cloudflare R2, and any other S3-compatible service
 * via the `endpoint` field in StorageConfig.
 */

function createS3Client(config: StorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint || undefined,
    region: config.region ?? "us-east-1",
    credentials: {
      accessKeyId: config.accessKeyId!,
      secretAccessKey: config.secretAccessKey!,
    },
    // MinIO and other self-hosted S3 services use path-style addressing
    forcePathStyle: !!config.endpoint,
  });
}

/** Upload a buffer to S3. Returns the object key. */
export async function s3Upload(
  config: StorageConfig,
  key: string,
  data: Buffer | Uint8Array,
): Promise<string> {
  const client = createS3Client(config);
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: data,
    }),
  );
  return key;
}

/** Download an object from S3 as a Buffer. */
export async function s3Download(
  config: StorageConfig,
  key: string,
): Promise<Buffer> {
  const client = createS3Client(config);
  const response = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }),
  );
  if (!response.Body) {
    throw new Error(`S3 object not found: ${key}`);
  }
  // Convert the stream to a Buffer
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Delete an object from S3. */
export async function s3Delete(
  config: StorageConfig,
  key: string,
): Promise<void> {
  const client = createS3Client(config);
  await client.send(
    new DeleteObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }),
  );
}

/** Test S3 connectivity by checking bucket access (HeadBucket). */
export async function s3TestConnection(
  config: StorageConfig,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      return { ok: false, error: "Missing required S3 fields: bucket, accessKeyId, secretAccessKey" };
    }
    const client = createS3Client(config);
    await client.send(
      new HeadBucketCommand({ Bucket: config.bucket }),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeS3Error(err) };
  }
}

/**
 * Turn an AWS SDK error into a human-readable message.
 *
 * The SDK often surfaces a bare "UnknownError" with no context when the HTTP
 * response isn't a recognizable S3 error envelope. This helper pulls out the
 * SDK error `name`, the HTTP status code from `$metadata`, and any nested
 * `Code`/`Message` fields so users can actually diagnose the problem
 * (e.g. DNS failures, TLS handshake errors, wrong endpoint, 403, etc.).
 */
function describeS3Error(err: unknown): string {
  if (!(err instanceof Error)) {
    return `S3 connection failed: ${String(err)}`;
  }
  const parts: string[] = [];
  // SDK error name (e.g. "UnknownError", "NoSuchBucket", "AccessDenied")
  if (err.name && err.name !== "Error") {
    parts.push(err.name);
  }
  // SDK message — only include if it actually says something
  if (err.message && err.message !== err.name) {
    parts.push(err.message);
  }
  // AWS SDK v3 attaches $metadata with httpStatusCode, requestId, etc.
  const metadata = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
  if (metadata?.httpStatusCode) {
    parts.push(`HTTP ${metadata.httpStatusCode}`);
  }
  // Some S3 errors nest Code/Message inside the error object
  const inner = (err as { Code?: string; message?: string }).Code;
  if (inner && inner !== err.name) {
    parts.push(inner);
  }
  // Include the root cause if the SDK chained one (e.g. ENOTFOUND, ECONNREFUSED)
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code) {
    parts.push(`cause: ${cause.code}`);
  } else if (cause?.message) {
    parts.push(`cause: ${cause.message}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "S3 connection failed";
}
