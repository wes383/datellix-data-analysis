-- Data source credential encryption/decryption helper functions
-- Uses pgcrypto's pgp_sym_encrypt / pgp_sym_decrypt
-- Key is managed via Supabase Vault (production); during development, a fixed key injected via environment variables can be used

-- Encryption function: takes plaintext jsonb, returns encrypted text
-- Note: must be called via SECURITY DEFINER, because the pgp_sym_encrypt key should not be exposed to the frontend
-- Key source: Vault recommended (vault.decrypted_secret); two implementations provided here

-- Option A: read key from Vault (recommended for production; create secret 'datellix_db_crypto_key' in Vault first)
create or replace function public.encrypt_config(p_plaintext jsonb)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key text;
begin
  -- Read from Vault first
  begin
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'datellix_db_crypto_key' limit 1;
  exception when others then
    v_key := null;
  end;

  -- Fallback to environment variable when Vault is not configured (development only)
  if v_key is null then
    v_key := current_setting('app.crypto_key', true);
  end if;

  if v_key is null then
    raise exception 'Encryption key not configured: please create datellix_db_crypto_key in Vault or set app.crypto_key';
  end if;

  return pgp_sym_encrypt(p_plaintext::text, v_key);
end $$;

comment on function public.encrypt_config is 'Encrypt data source configuration (pgcrypto + Vault)';

-- Decryption function: takes encrypted text, returns plaintext jsonb
create or replace function public.decrypt_config(p_ciphertext text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key text;
begin
  begin
    select decrypted_secret into v_key from vault.decrypted_secrets where name = 'datellix_db_crypto_key' limit 1;
  exception when others then
    v_key := null;
  end;

  if v_key is null then
    v_key := current_setting('app.crypto_key', true);
  end if;

  if v_key is null then
    raise exception 'Encryption key not configured';
  end if;

  return pgp_sym_decrypt(p_ciphertext, v_key)::jsonb;
end $$;

comment on function public.decrypt_config is 'Decrypt data source configuration (server-side service_role only)';

-- Grant execute permission to authenticated users (actual access is still controlled by RLS and the business-layer service_role)
grant execute on function public.encrypt_config(jsonb) to authenticated;
grant execute on function public.decrypt_config(text) to authenticated;
