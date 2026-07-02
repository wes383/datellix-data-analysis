-- session_data_sources: many-to-many between sessions and file data sources.
-- Used ONLY for file-type data sources. Database-type data sources stay
-- bound via sessions.data_source_id (single database per session).
-- A session is in exactly one mode: either one database (data_source_id set,
-- no rows here) OR one or more files (rows here, data_source_id null).

create table if not exists public.session_data_sources (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  data_source_id uuid not null references public.data_sources (id) on delete cascade,
  added_at timestamptz not null default now(),
  unique (session_id, data_source_id)
);

create index if not exists idx_session_data_sources_session
  on public.session_data_sources (session_id);
create index if not exists idx_session_data_sources_source
  on public.session_data_sources (data_source_id);

alter table public.session_data_sources enable row level security;

drop policy if exists "session_data_sources_select_own" on public.session_data_sources;
create policy "session_data_sources_select_own" on public.session_data_sources
  for select using (
    exists (
      select 1 from public.sessions s
      where s.id = session_data_sources.session_id and s.user_id = auth.uid()
    )
  );

drop policy if exists "session_data_sources_insert_own" on public.session_data_sources;
create policy "session_data_sources_insert_own" on public.session_data_sources
  for insert with check (
    exists (
      select 1 from public.sessions s
      where s.id = session_data_sources.session_id and s.user_id = auth.uid()
    )
  );

drop policy if exists "session_data_sources_delete_own" on public.session_data_sources;
create policy "session_data_sources_delete_own" on public.session_data_sources
  for delete using (
    exists (
      select 1 from public.sessions s
      where s.id = session_data_sources.session_id and s.user_id = auth.uid()
    )
  );

comment on table public.session_data_sources is 'Join table for multi-file sessions (file-type data sources only). Mutually exclusive with sessions.data_source_id.';
