-- Database cleanup and space reclamation
--
-- Addresses 5 issues identified in the database structure audit:
--   1. session_history_embeddings table is a dead table (never written to,
--      never read). Drop it + its RPC + HNSW index to reclaim space.
--   2. sessions.sandbox_id column is obsolete (current sandbox model is
--      request-level, sandbox_id is always null). Drop the column.
--   3. usage_logs has no TTL — rows accumulate forever. Add a pg_cron job
--      to delete rows older than 90 days daily at 03:00 UTC.
--   4. trim_checkpoints RPC: used by the chat route to keep only the most
--      recent N checkpoints per thread, preventing unbounded growth in
--      long conversations. (checkpoint_blobs are not trimmed here — they
--      grow slowly and are versioned per channel.)
--
-- Note: LangGraph checkpoint cleanup on session deletion is handled in
-- application code (deleteSession), not here — it deletes all 3 checkpoint
-- tables' rows for the thread_id directly.

-- ============================================================
-- 1. Drop dead table: session_history_embeddings
-- ============================================================
-- Note: use plain DO blocks to drop each object idempotently. Some
-- Postgres versions raise "relation does not exist" when DROP FUNCTION
-- ... CASCADE tries to resolve dependencies on already-missing tables,
-- so we guard each drop with an existence check.

-- Drop the RPC first (it may depend on the table).
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'match_session_history'
  ) then
    drop function public.match_session_history(extensions.vector(1024), uuid, int) cascade;
  end if;
end $$;

-- Drop indexes (if they exist) — using IF EXISTS for idempotency.
drop index if exists public.session_history_embeddings_embedding_idx;
drop index if exists public.idx_session_history_embeddings_user;

-- Drop the table itself (if it still exists).
drop table if exists public.session_history_embeddings cascade;

-- ============================================================
-- 2. Drop obsolete column: sessions.sandbox_id
-- ============================================================

alter table public.sessions drop column if exists sandbox_id;

-- ============================================================
-- 3. usage_logs TTL: pg_cron job deleting rows older than 90 days
-- ============================================================

-- pg_cron is a Supabase-built-in extension for scheduled SQL jobs.
-- The schedule runs daily at 03:00 UTC (= 11:00 Beijing time).
create extension if not exists pg_cron with schema extensions;

-- Drop any existing schedule with the same name (idempotent re-runs).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'cleanup-old-usage-logs') then
    perform cron.unschedule('cleanup-old-usage-logs');
  end if;
end $$;

select cron.schedule(
  'cleanup-old-usage-logs',
  '0 3 * * *',
  $$delete from public.usage_logs where created_at < now() - interval '90 days'$$
);

-- ============================================================
-- 4. trim_checkpoints RPC
--
-- Deletes old checkpoints (and their writes) for a given thread,
-- keeping only the most recent `p_keep` checkpoints.
--
-- checkpoint_id is a UUID6 string (time-ordered), so lexicographic
-- DESC ordering = newest-first. checkpoint_blobs are NOT trimmed —
-- they are keyed by (thread_id, channel, version) and grow slowly
-- (one row per channel version, not per checkpoint).
--
-- Security: marked SECURITY DEFINER so it can run via the service-role
-- client (admin.rpc). RLS on checkpoint tables is not enabled (they are
-- managed by LangGraph, not user-facing).
-- ============================================================

create or replace function public.trim_checkpoints(
  p_thread_id text,
  p_keep int default 50
) returns void
language plpgsql security definer as $$
declare
  v_cutoff text;
begin
  -- Find the checkpoint_id of the p_keep-th newest checkpoint.
  -- If fewer than p_keep checkpoints exist, v_cutoff stays null and we
  -- do nothing.
  select checkpoint_id into v_cutoff
  from (
    select checkpoint_id,
           row_number() over (order by checkpoint_id desc) as rn
    from public.checkpoints
    where thread_id = p_thread_id and checkpoint_ns = ''
  ) t
  where rn = p_keep;

  if v_cutoff is null then
    return;
  end if;

  -- Delete writes for checkpoints older than the cutoff.
  delete from public.checkpoint_writes
  where thread_id = p_thread_id
    and checkpoint_ns = ''
    and checkpoint_id < v_cutoff;

  -- Delete the old checkpoint rows themselves.
  delete from public.checkpoints
  where thread_id = p_thread_id
    and checkpoint_ns = ''
    and checkpoint_id < v_cutoff;
end;
$$;

comment on function public.trim_checkpoints is 'Delete old LangGraph checkpoints for a thread, keeping only the most recent p_keep (default 50). Called after each agent run to bound long-conversation growth.';

grant execute on function public.trim_checkpoints(text, int) to authenticated;

-- ============================================================
-- 5. trim_checkpoint_blobs RPC
--
-- Deletes checkpoint_blobs rows that are no longer referenced by any
-- checkpoint for the given thread. A blob is "referenced" if its
-- (channel, version) pair appears in the checkpoint.channel_versions
-- JSON object of any remaining checkpoint row.
--
-- Call this AFTER trim_checkpoints to reclaim space from the binary
-- blob rows whose parent checkpoints were just deleted. Safe to call
-- on threads with no checkpoints (deletes all their blobs) or no blobs
-- (no-op).
-- ============================================================

create or replace function public.trim_checkpoint_blobs(
  p_thread_id text
) returns void
language plpgsql security definer as $$
begin
  -- Delete blob rows whose (channel, version) is not referenced by any
  -- remaining checkpoint for this thread. checkpoint_ns is constrained
  -- to '' (this project only uses the default namespace).
  --
  -- checkpoint->'channel_versions'->>channel  returns the version as text
  -- (JSON unescape), which matches checkpoint_blobs.version (text).
  -- If the channel is absent from channel_versions, ->> returns NULL,
  -- NULL = anything is NULL (falsy), so the blob is treated as orphaned.
  delete from public.checkpoint_blobs cb
  where cb.thread_id = p_thread_id
    and cb.checkpoint_ns = ''
    and not exists (
      select 1
      from public.checkpoints c
      where c.thread_id = p_thread_id
        and c.checkpoint_ns = ''
        and (c.checkpoint->'channel_versions'->>cb.channel) = cb.version
    );
end;
$$;

comment on function public.trim_checkpoint_blobs is 'Delete orphaned checkpoint_blobs for a thread — rows whose (channel, version) is not referenced by any remaining checkpoint. Call after trim_checkpoints to reclaim binary blob space.';

grant execute on function public.trim_checkpoint_blobs(text) to authenticated;
