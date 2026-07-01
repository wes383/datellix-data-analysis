-- Fix decrypt_config signature mismatch
--
-- pgp_sym_decrypt(msg bytea, psw text) expects bytea as the first argument,
-- but decrypt_config(p_ciphertext text) passed text directly, causing:
--   ERROR: function pgp_sym_decrypt(text, text) does not exist
--
-- encrypt_config worked because bytea->text has an implicit assignment cast
-- (PostgreSQL hex bytea_output), but the reverse text->bytea cast is not
-- applied automatically when resolving the function signature. Fix by
-- explicitly casting p_ciphertext::bytea before calling pgp_sym_decrypt.

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

  -- Cast hex-encoded text back to bytea before decrypting
  return pgp_sym_decrypt(p_ciphertext::bytea, v_key)::jsonb;
end $$;

comment on function public.decrypt_config is 'Decrypt data source configuration (server-side service_role only)';

-- Re-grant execute (drop+recreate loses grants)
grant execute on function public.decrypt_config(text) to authenticated;
