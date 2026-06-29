-- Vector search RPC: called by the LangGraph retrieveSchema tool
-- Called via service_role or RLS user; returns top-k by cosine distance

-- Retrieve schema (tables/columns) related to the data source
-- Parameters: p_query query vector, p_source data source id, p_k number of results returned
create or replace function public.match_schema(
  p_query extensions.vector(1536),
  p_source uuid,
  p_k integer default 10
)
returns table (
  id uuid,
  table_name text,
  column_name text,
  data_type text,
  description text,
  sample_values jsonb,
  similarity float
)
language sql stable as $$
  select
    id,
    table_name,
    column_name,
    data_type,
    description,
    sample_values,
    1 - (embedding <=> p_query) as similarity
  from public.schema_embeddings
  where data_source_id = p_source
  order by embedding <=> p_query
  limit p_k;
$$;

comment on function public.match_schema is 'Retrieve schema related to a data source by query vector (top-k cosine)';

-- Retrieve similar historical Q&A
-- Parameters: p_query query vector, p_user user id, p_k number of results returned
create or replace function public.match_session_history(
  p_query extensions.vector(1536),
  p_user uuid,
  p_k integer default 5
)
returns table (
  id uuid,
  session_id uuid,
  question text,
  answer_summary text,
  similarity float
)
language sql stable as $$
  select
    id,
    session_id,
    question,
    answer_summary,
    1 - (embedding <=> p_query) as similarity
  from public.session_history_embeddings
  where user_id = p_user
  order by embedding <=> p_query
  limit p_k;
$$;

comment on function public.match_session_history is 'Retrieve a user''s similar historical Q&A by query vector';
