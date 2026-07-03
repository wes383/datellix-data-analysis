import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptConfig } from "@/lib/db/crypto";
import { s3TestConnection } from "@/lib/storage/s3-client";
import type { StorageConfig } from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 30;

// Same mask prefix the settings page uses for secret fields. See
// test-llm/route.ts for the full rationale — when the user re-tests an
// existing config without retyping the secret, we fall back to the stored
// decrypted value to avoid ByteString errors in the S3 signing path.
const SECRET_MASK_PREFIX = "\u2022\u2022\u2022\u2022";

/**
 * POST /api/settings/test-storage
 *
 * Tests an S3-compatible storage configuration without saving it.
 * Calls HeadBucket via s3TestConnection.
 *
 * Returns { ok: true } on success or { ok: false, error } on failure.
 *
 * Body: { endpoint, region, accessKeyId, secretAccessKey, bucket }
 *
 * If `secretAccessKey` starts with the mask prefix (`••••`), the user is
 * re-testing an existing config without retyping the secret — we look up
 * the stored decrypted value instead.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = (await req.json()) as {
    endpoint?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    bucket?: string;
  };

  if (!body.accessKeyId || !body.secretAccessKey || !body.bucket) {
    return NextResponse.json(
      { ok: false, error: "Missing required fields: accessKeyId, secretAccessKey, bucket" },
      { status: 400 },
    );
  }

  // Resolve masked secret access key from saved config if needed.
  let secretAccessKey = body.secretAccessKey;
  if (secretAccessKey.startsWith(SECRET_MASK_PREFIX)) {
    const admin = createAdminClient();
    const { data: row } = await admin
      .from("user_settings")
      .select("storage_config_encrypted")
      .eq("user_id", user.id)
      .single();
    const stored = row?.storage_config_encrypted
      ? await decryptConfig<StorageConfig>(row.storage_config_encrypted)
      : null;
    if (!stored?.secretAccessKey) {
      return NextResponse.json(
        { ok: false, error: "Please re-enter your Secret Access Key — the saved value is unavailable." },
        { status: 400 },
      );
    }
    secretAccessKey = stored.secretAccessKey;
  }

  const config: StorageConfig = {
    backend: "s3",
    accessKeyId: body.accessKeyId,
    secretAccessKey,
    bucket: body.bucket,
    ...(body.endpoint && { endpoint: body.endpoint }),
    ...(body.region && { region: body.region }),
  };

  const result = await s3TestConnection(config);
  return NextResponse.json(result);
}
