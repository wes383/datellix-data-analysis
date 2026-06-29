import { createClient } from "@supabase/supabase-js";

/**
 * Admin Supabase client (service_role)
 * Bypasses RLS, only used for sensitive server-side operations:
 * - Write usage logs (usage_logs)
 * - Cross-user operations
 * - Call encrypt_config / decrypt_config
 *
 * Warning: never use in browser-side or client bundle
 * Credentials never enter LLM prompt
 */
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
