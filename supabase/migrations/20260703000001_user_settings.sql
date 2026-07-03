-- Per-user configurable LLM provider and file storage settings.
-- Both config columns are pgcrypto ciphertext (same pattern as data_sources.config_encrypted).
-- NULL means "use project default" (env-based configuration).

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  llm_config_encrypted text,      -- null = use project default (env)
  storage_config_encrypted text,  -- null = use project default (Vercel Blob env)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

create policy "users select own settings"
  on public.user_settings for select
  using (user_id = auth.uid());

create policy "users insert own settings"
  on public.user_settings for insert
  with check (user_id = auth.uid());

create policy "users update own settings"
  on public.user_settings for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "users delete own settings"
  on public.user_settings for delete
  using (user_id = auth.uid());

-- Reuse the existing set_updated_at() function from 20260629000002_app_tables.sql
create trigger trg_user_settings_updated
  before update on public.user_settings
  for each row execute function public.set_updated_at();
