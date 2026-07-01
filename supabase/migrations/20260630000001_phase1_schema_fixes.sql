-- Phase 1 schema fixes
--
-- The encrypt_config() function returns TEXT (pgcrypto ciphertext), but the
-- data_sources.config_encrypted column was declared jsonb in the initial
-- migration. Storing non-JSON ciphertext in a jsonb column fails, so we
-- alter the column type to text.
--
-- This is safe on a fresh project (no existing rows). On a project with
-- existing rows, the jsonb-to-text cast will serialize the JSON value as
-- a string, which is acceptable since we re-encrypt on save.

alter table public.data_sources
  alter column config_encrypted type text
  using config_encrypted::text;

comment on column public.data_sources.config_encrypted is 'Encrypted config ciphertext (pgcrypto pgp_sym_encrypt output, TEXT not JSON)';
