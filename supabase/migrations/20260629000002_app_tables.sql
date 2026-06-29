-- Application metadata tables
-- All business tables use auth.users.id as the user_id foreign key and enable RLS (see 03_rls_policies.sql)

-- Data source: file upload / Postgres connection / REST/GraphQL API connection
create table if not exists public.data_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('file', 'pg', 'api')),
  name text not null,
  -- Connection config encrypted with pgcrypto (host/port/db/user/password or api_url/headers)
  config_encrypted jsonb not null,
  -- Vercel Blob path or additional metadata for file-based data sources
  meta jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.data_sources is 'User data sources (file/Postgres/API); credentials stored encrypted';

-- Analysis session
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  data_source_id uuid references public.data_sources (id) on delete set null,
  -- Daytona sandbox id (bound at session level)
  sandbox_id text,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sessions is 'Analysis session; binds data source and Daytona sandbox';

-- Conversation message
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text,
  -- LangGraph tool call records
  tool_calls jsonb,
  created_at timestamptz not null default now()
);

comment on table public.messages is 'Session messages (including tool calls)';

-- Analysis artifacts: chart / table / code / forecast result
create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  type text not null check (type in ('chart', 'table', 'code', 'forecast', 'summary')),
  payload jsonb not null,
  created_at timestamptz not null default now()
);

comment on table public.artifacts is 'Structured artifacts produced by the Agent (charts/tables/code, etc.)';

-- Usage and cost log
create table if not exists public.usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid references public.sessions (id) on delete set null,
  -- Per-resource usage
  sandbox_seconds numeric default 0,
  tokens_in integer default 0,
  tokens_out integer default 0,
  -- Estimated cost (USD)
  cost numeric default 0,
  -- Source: llm | daytona | blob
  source text,
  created_at timestamptz not null default now()
);

comment on table public.usage_logs is 'Usage and cost log';

-- Indexes
create index if not exists idx_data_sources_user on public.data_sources (user_id);
create index if not exists idx_sessions_user on public.sessions (user_id);
create index if not exists idx_sessions_data_source on public.sessions (data_source_id);
create index if not exists idx_messages_session on public.messages (session_id, created_at);
create index if not exists idx_artifacts_session on public.artifacts (session_id, created_at);
create index if not exists idx_usage_logs_user on public.usage_logs (user_id, created_at);

-- updated_at auto-update trigger
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_data_sources_updated on public.data_sources;
create trigger trg_data_sources_updated before update on public.data_sources
  for each row execute function public.set_updated_at();

drop trigger if exists trg_sessions_updated on public.sessions;
create trigger trg_sessions_updated before update on public.sessions
  for each row execute function public.set_updated_at();
