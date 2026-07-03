import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptConfig } from "@/lib/db/crypto";
import { createLLM } from "@/lib/agent/llm";
import type { LlmConfig } from "@/lib/db/schema";

export const runtime = "nodejs";
export const maxDuration = 30;

// The "••••" mask the settings page prepends to secrets before sending them
// to the client. When the user opens the edit modal and submits without
// retyping the API key, the masked value is sent back here. We detect it and
// fall back to the stored decrypted value rather than sending the mask chars
// (U+2022, code point 8226) into HTTP headers, which would throw a
// "Cannot convert argument to a ByteString" TypeError inside fetch().
const API_KEY_MASK_PREFIX = "\u2022\u2022\u2022\u2022";

/**
 * POST /api/settings/test-llm
 *
 * Tests an LLM provider configuration without saving it. Constructs a
 * chat model from the provided config and sends a minimal "hi" message.
 * Returns { ok: true } on success or { ok: false, error } on failure.
 *
 * Body: { provider, apiKey, baseURL, model }
 *
 * If `apiKey` starts with the mask prefix (`••••`), it means the user is
 * re-testing an existing config without retyping the key — we look up the
 * stored decrypted value instead. This avoids ByteString errors when the
 * masked value reaches the Authorization header.
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
    provider?: string;
    apiKey?: string;
    baseURL?: string;
    model?: string;
  };

  if (!body.provider || !body.apiKey || !body.model) {
    return NextResponse.json(
      { ok: false, error: "Missing required fields: provider, apiKey, model" },
      { status: 400 },
    );
  }

  // Resolve masked API key: if the user submitted the masked placeholder,
  // pull the real key from the user's saved (encrypted) config.
  let apiKey = body.apiKey;
  if (apiKey.startsWith(API_KEY_MASK_PREFIX)) {
    const admin = createAdminClient();
    const { data: row } = await admin
      .from("user_settings")
      .select("llm_config_encrypted")
      .eq("user_id", user.id)
      .single();
    const stored = row?.llm_config_encrypted
      ? await decryptConfig<LlmConfig>(row.llm_config_encrypted)
      : null;
    if (!stored?.apiKey) {
      return NextResponse.json(
        { ok: false, error: "Please re-enter your API key — the saved value is unavailable." },
        { status: 400 },
      );
    }
    apiKey = stored.apiKey;
  }

  const config: LlmConfig = {
    provider: body.provider as LlmConfig["provider"],
    apiKey,
    models: [body.model],
    ...(body.baseURL && { baseURL: body.baseURL }),
  };

  try {
    const model = createLLM(config);
    await model.invoke("hi");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "LLM connection failed",
    });
  }
}
