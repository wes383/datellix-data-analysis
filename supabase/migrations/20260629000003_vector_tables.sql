-- pgvector vector tables (same database as application metadata; supports same-DB JOIN)
-- Dimension: 1536 (OpenAI text-embedding-3-small; adjust if the model changes)

-- Data source schema vector: vectorized table/column descriptions, used for NL-to-SQL retrieval
create table if not exists public.schema_embeddings (
  id uuid primary key default gen_random_uuid(),
  data_source_id uuid not null references public.data_sources (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  table_name text not null,
  column_name text,
  data_type text,
  description text,
  -- Masked sample values (no more than 3, used to help the LLM understand column meaning)
  sample_values jsonb default '[]'::jsonb,
  embedding extensions.vector(1536) not null,
  created_at timestamptz not null default now()
);

comment on table public.schema_embeddings is 'Data source schema vector index, used for NL-to-SQL retrieval';

-- Session history vector: vectorized historical Q&A, used for similar question reuse
create table if not exists public.session_history_embeddings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  question text not null,
  answer_summary text,
  embedding extensions.vector(1536) not null,
  created_at timestamptz not null default now()
);

comment on table public.session_history_embeddings is 'Historical Q&A vectors, used for similar question reuse';

-- HNSW index (recommended by Supabase; better query performance than ivfflat and no pre-training required)
-- Uses cosine distance (equivalent to inner product when vectors are normalized)
create index if not exists idx_schema_embeddings_hnsw
  on public.schema_embeddings using hnsw (embedding extensions.vector_cosine_ops);

create index if not exists idx_session_history_embeddings_hnsw
  on public.session_history_embeddings using hnsw (embedding extensions.vector_cosine_ops);

-- Auxiliary indexes: filter by data source/user
create index if not exists idx_schema_embeddings_source
  on public.schema_embeddings (data_source_id);
create index if not exists idx_schema_embeddings_user
  on public.schema_embeddings (user_id);
create index if not exists idx_session_history_embeddings_user
  on public.session_history_embeddings (user_id);
