import { createAdminClient } from "@/lib/supabase/admin";
import type { PgConfig, FileConfig, ApiConfig } from "@/lib/db/schema";

/**
 * Data source credential encryption/decryption
 *
 * Uses Supabase RPC functions (public.encrypt_config / public.decrypt_config)
 * backed by pgcrypto's pgp_sym_encrypt / pgp_sym_decrypt.
 * The encryption key is managed by Supabase Vault (production) or app.crypto_key (dev).
 *
 * IMPORTANT: only call decryptConfig server-side with service_role.
 * Decrypted credentials never enter LLM prompts.
 */

/**
 * Encrypt a config object and return the ciphertext string.
 * The ciphertext is stored in data_sources.config_encrypted.
 */
export async function encryptConfig(config: PgConfig | FileConfig | ApiConfig): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("encrypt_config", {
    p_plaintext: config as unknown as Record<string, unknown>,
  });
  if (error) {
    throw new Error(`encrypt_config failed: ${error.message}`);
  }
  return data as string;
}

/**
 * Decrypt a ciphertext string and return the config object.
 * Only call this server-side, immediately before use; never log or persist the result.
 */
export async function decryptConfig<T = PgConfig | FileConfig | ApiConfig>(
  ciphertext: string,
): Promise<T> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("decrypt_config", {
    p_ciphertext: ciphertext,
  });
  if (error) {
    throw new Error(`decrypt_config failed: ${error.message}`);
  }
  return data as T;
}
