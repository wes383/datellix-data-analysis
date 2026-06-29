-- Enable required extensions
-- pgvector: vector search (schema_embeddings / session_history_embeddings)
-- pgcrypto: gen_random_uuid() and pgp_sym_encrypt/decrypt for encrypting data source credentials
create extension if not exists vector with schema "extensions";
create extension if not exists pgcrypto with schema "extensions";

-- pg_stat_statements for usage/performance observation (optional, skipped if already exists)
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_stat_statements') then
    create extension if not exists pg_stat_statements with schema "extensions";
  end if;
exception when others then
  -- Some environments (e.g., Supabase free tier) may not allow manual creation; ignore the error
  null;
end $$;
