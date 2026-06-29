-- seed.sql: development test data (optional)
-- Only executed on supabase db reset; not applied in production
-- Usage: after creating a test user locally, you can insert sample data sources

-- Tip: test users are recommended to be created via the supabase auth admin CLI:
--   supabase status  # get service_role key
--   curl -X POST http://localhost:54321/auth/v1/admin/users ...
-- Only inserts business data that depends on a user (replace user_id / data_source_id)

-- Example (commented out; enable once a real user_id is available):
-- insert into public.data_sources (user_id, type, name, config_encrypted)
-- values ('00000000-0000-0000-0000-000000000000', 'file', 'Sample sales data', '{}');
