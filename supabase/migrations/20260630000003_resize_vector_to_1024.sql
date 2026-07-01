-- Resize pgvector columns from 1536 to 1024 dimensions
--
-- Reason: switched the embedding backend to Cloudflare Workers AI
-- qwen3-embedding-0.6b, which outputs 1024-dim vectors. The original
-- migration 20260629000003 assumed OpenAI text-embedding-3-small (1536-dim).
--
-- Steps:
--   1. Drop dependent objects (match_schema / match_session_history RPCs,
--      HNSW indexes) — they are bound to the column type.
--   2. ALTER COLUMN ... TYPE vector(1024) USING embedding::vector(1024).
--      Existing 1536-dim vectors cannot be cast losslessly, so they are
--      truncated; in practice the table is empty at this point because
--      indexing never succeeded. If you have data, re-index data sources
--      after running this migration.
--   3. Recreate HNSW indexes.
--   4. Recreate RPCs with the new vector(1024) signature.

-- ============================================================
-- 1. Drop dependent objects
-- ============================================================

drop function if exists public.match_schema(extensions.vector(1536), uuid, int) cascade;
drop function if exists public.match_session_history(extensions.vector(1536), uuid, int) cascade;

drop index if exists public.schema_embeddings_embedding_idx;
drop index if exists public.session_history_embeddings_embedding_idx;

-- ============================================================
-- 2. Resize columns
-- ============================================================

alter table public.schema_embeddings
  alter column embedding type extensions.vector(1024)
  using embedding::extensions.vector(1024);

alter table public.session_history_embeddings
  alter column embedding type extensions.vector(1024)
  using embedding::extensions.vector(1024);

-- ============================================================
-- 3. Recreate HNSW indexes (cosine distance)
-- ============================================================

create index if not exists schema_embeddings_embedding_idx
  on public.schema_embeddings using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists session_history_embeddings_embedding_idx
  on public.session_history_embeddings using hnsw (embedding extensions.vector_cosine_ops);

-- ============================================================
-- 4. Recreate RPCs with vector(1024) signature
-- ============================================================

create or replace function public.match_schema(
  p_query extensions.vector(1024),
  p_source uuid,
  p_k int default 10
)
returns table (
  id uuid,
  table_name text,
  column_name text,
  data_type text,
  description text,
  similarity float
)
language sql stable as $$
  select id, table_name, column_name, data_type, description,
         1 - (embedding <=> p_query) as similarity
  from public.schema_embeddings
  where data_source_id = p_source
  order by embedding <=> p_query
  limit p_k;
$$;

comment on function public.match_schema is 'Retrieve schema related to a data source by query vector (top-k cosine)';

create or replace function public.match_session_history(
  p_query extensions.vector(1024),
  p_user uuid,
  p_k int default 5
)
returns table (
  id uuid,
  session_id uuid,
  question text,
  answer_summary text,
  similarity float
)
language sql stable as $$
  select id, session_id, question, answer_summary,
         1 - (embedding <=> p_query) as similarity
  from public.session_history_embeddings
  where user_id = p_user
  order by embedding <=> p_query
  limit p_k;
$$;

comment on function public.match_session_history is 'Retrieve relevant past Q&A by query vector (top-k cosine)';

-- Re-grant execute
grant execute on function public.match_schema(extensions.vector(1024), uuid, int) to authenticated;
grant execute on function public.match_session_history(extensions.vector(1024), uuid, int) to authenticated;
