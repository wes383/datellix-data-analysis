-- LangGraph Postgres Saver checkpoint tables
--
-- IMPORTANT: This schema must match exactly what @langchain/langgraph-checkpoint-postgres
-- expects (see node_modules/@langchain/langgraph-checkpoint-postgres/dist/migrations.js).
-- The checkpointer.setup() method uses CREATE TABLE IF NOT EXISTS, so it will skip
-- tables that already exist — getting the schema wrong here requires manual DROP
-- to fix. Pre-creating with the correct schema avoids the issue and lets us add
-- indexes in the same migration.
--
-- Source of truth: official migrations in the @langchain/langgraph-checkpoint-postgres package.

-- 1. Migration tracking table (used by checkpointer.setup() to know which migrations ran)
create table if not exists public.checkpoint_migrations (
  v integer primary key
);

comment on table public.checkpoint_migrations is 'LangGraph Saver migration version tracking';

-- 2. Checkpoint table (stores Agent state snapshots)
create table if not exists public.checkpoints (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  parent_checkpoint_id text,
  type text,
  checkpoint jsonb not null,
  metadata jsonb not null default '{}',
  primary key (thread_id, checkpoint_ns, checkpoint_id)
);

comment on table public.checkpoints is 'LangGraph Agent state snapshots (Postgres Saver)';

-- 3. Checkpoint blobs table (stores serialized channel values — BYTEA, not JSONB)
create table if not exists public.checkpoint_blobs (
  thread_id text not null,
  checkpoint_ns text not null default '',
  channel text not null,
  version text not null,
  type text not null,
  blob bytea,
  primary key (thread_id, checkpoint_ns, channel, version)
);

comment on table public.checkpoint_blobs is 'LangGraph Saver serialized channel values (binary)';

-- 4. Checkpoint writes table (stores intermediate write records — BYTEA blob, not JSONB value)
create table if not exists public.checkpoint_writes (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  task_id text not null,
  idx integer not null,
  channel text not null,
  type text,
  blob bytea not null,
  primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

comment on table public.checkpoint_writes is 'LangGraph Agent intermediate write records (binary)';

-- 5. Match upstream: blob column nullable after migration #5
alter table public.checkpoint_blobs alter column blob drop not null;

-- 6. Retrieval indexes (our addition on top of upstream schema)
create index if not exists idx_checkpoints_thread
  on public.checkpoints (thread_id, checkpoint_ns, checkpoint_id desc);

create index if not exists idx_checkpoint_writes_thread
  on public.checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id);

create index if not exists idx_checkpoint_blobs_thread
  on public.checkpoint_blobs (thread_id, checkpoint_ns);

-- Note: LangGraph Saver uses the public schema by default.
-- setup() will detect tables already exist and skip creation, so pre-creation is safe.
