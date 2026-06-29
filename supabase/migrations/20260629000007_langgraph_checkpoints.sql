-- LangGraph Postgres Saver checkpoint tables
-- Usually created automatically by checkpointer.setup() of @langchain/langgraph-checkpoint-postgres
-- Pre-created here to:
-- 1. Explicitly bring under version control for audit
-- 2. Add indexes to optimize retrieval
-- 3. Ensure the schema is ready in one pass during deployment

-- checkpoint table (stores Agent state snapshots)
create table if not exists public.checkpoints (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  parent_checkpoint_id text,
  type text,
  checkpoint jsonb,
  metadata jsonb,
  primary key (thread_id, checkpoint_ns, checkpoint_id)
);

comment on table public.checkpoints is 'LangGraph Agent state snapshots (Postgres Saver)';

-- checkpoint writes table (stores intermediate write records)
create table if not exists public.checkpoint_writes (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  task_id text not null,
  idx integer not null,
  channel text not null,
  type text,
  value jsonb,
  primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

comment on table public.checkpoint_writes is 'LangGraph Agent intermediate write records';

-- Retrieval index: find latest checkpoint by thread_id
create index if not exists idx_checkpoints_thread
  on public.checkpoints (thread_id, checkpoint_ns, checkpoint_id desc);

create index if not exists idx_checkpoint_writes_thread
  on public.checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id);

-- Note: LangGraph Saver uses the public schema by default
-- setup() skips creation if the table already exists, so pre-creation is safe
