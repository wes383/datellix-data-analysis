-- Row Level Security (RLS) policies
-- Principle: users can only access data where user_id = auth.uid()
-- Credential encryption + RLS provide dual guarantee for data isolation

-- Enable RLS
alter table public.data_sources enable row level security;
alter table public.sessions enable row level security;
alter table public.messages enable row level security;
alter table public.artifacts enable row level security;
alter table public.usage_logs enable row level security;
alter table public.schema_embeddings enable row level security;
alter table public.session_history_embeddings enable row level security;

-- ============ data_sources ============
drop policy if exists "data_sources_select_own" on public.data_sources;
create policy "data_sources_select_own" on public.data_sources
  for select using (user_id = auth.uid());

drop policy if exists "data_sources_insert_own" on public.data_sources;
create policy "data_sources_insert_own" on public.data_sources
  for insert with check (user_id = auth.uid());

drop policy if exists "data_sources_update_own" on public.data_sources;
create policy "data_sources_update_own" on public.data_sources
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "data_sources_delete_own" on public.data_sources;
create policy "data_sources_delete_own" on public.data_sources
  for delete using (user_id = auth.uid());

-- ============ sessions ============
drop policy if exists "sessions_select_own" on public.sessions;
create policy "sessions_select_own" on public.sessions
  for select using (user_id = auth.uid());

drop policy if exists "sessions_insert_own" on public.sessions;
create policy "sessions_insert_own" on public.sessions
  for insert with check (user_id = auth.uid());

drop policy if exists "sessions_update_own" on public.sessions;
create policy "sessions_update_own" on public.sessions
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "sessions_delete_own" on public.sessions;
create policy "sessions_delete_own" on public.sessions
  for delete using (user_id = auth.uid());

-- ============ messages ============
-- Validate user indirectly through session ownership
drop policy if exists "messages_select_own" on public.messages;
create policy "messages_select_own" on public.messages
  for select using (
    exists (select 1 from public.sessions s where s.id = messages.session_id and s.user_id = auth.uid())
  );

drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own" on public.messages
  for insert with check (
    exists (select 1 from public.sessions s where s.id = messages.session_id and s.user_id = auth.uid())
  );

drop policy if exists "messages_delete_own" on public.messages;
create policy "messages_delete_own" on public.messages
  for delete using (
    exists (select 1 from public.sessions s where s.id = messages.session_id and s.user_id = auth.uid())
  );

-- ============ artifacts ============
drop policy if exists "artifacts_select_own" on public.artifacts;
create policy "artifacts_select_own" on public.artifacts
  for select using (
    exists (select 1 from public.sessions s where s.id = artifacts.session_id and s.user_id = auth.uid())
  );

drop policy if exists "artifacts_insert_own" on public.artifacts;
create policy "artifacts_insert_own" on public.artifacts
  for insert with check (
    exists (select 1 from public.sessions s where s.id = artifacts.session_id and s.user_id = auth.uid())
  );

drop policy if exists "artifacts_delete_own" on public.artifacts;
create policy "artifacts_delete_own" on public.artifacts
  for delete using (
    exists (select 1 from public.sessions s where s.id = artifacts.session_id and s.user_id = auth.uid())
  );

-- ============ usage_logs ============
drop policy if exists "usage_logs_select_own" on public.usage_logs;
create policy "usage_logs_select_own" on public.usage_logs
  for select using (user_id = auth.uid());

drop policy if exists "usage_logs_insert_own" on public.usage_logs;
create policy "usage_logs_insert_own" on public.usage_logs
  for insert with check (user_id = auth.uid());

-- ============ schema_embeddings ============
drop policy if exists "schema_embeddings_select_own" on public.schema_embeddings;
create policy "schema_embeddings_select_own" on public.schema_embeddings
  for select using (user_id = auth.uid());

drop policy if exists "schema_embeddings_insert_own" on public.schema_embeddings;
create policy "schema_embeddings_insert_own" on public.schema_embeddings
  for insert with check (user_id = auth.uid());

drop policy if exists "schema_embeddings_update_own" on public.schema_embeddings;
create policy "schema_embeddings_update_own" on public.schema_embeddings
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "schema_embeddings_delete_own" on public.schema_embeddings;
create policy "schema_embeddings_delete_own" on public.schema_embeddings
  for delete using (user_id = auth.uid());

-- ============ session_history_embeddings ============
drop policy if exists "session_history_select_own" on public.session_history_embeddings;
create policy "session_history_select_own" on public.session_history_embeddings
  for select using (user_id = auth.uid());

drop policy if exists "session_history_insert_own" on public.session_history_embeddings;
create policy "session_history_insert_own" on public.session_history_embeddings
  for insert with check (user_id = auth.uid());

drop policy if exists "session_history_delete_own" on public.session_history_embeddings;
create policy "session_history_delete_own" on public.session_history_embeddings
  for delete using (user_id = auth.uid());
