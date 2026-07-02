-- match_schema_multi: like match_schema, but accepts an ARRAY of data_source
-- ids and returns top-k columns across all of them. Used by multi-file
-- sessions to retrieve schema from every bound file at once.

create or replace function public.match_schema_multi(
  p_query extensions.vector(1024),
  p_sources uuid[],
  p_k int default 20
)
returns table (
  id uuid,
  data_source_id uuid,
  table_name text,
  column_name text,
  data_type text,
  description text,
  similarity float
)
language sql stable as $$
  select id, data_source_id, table_name, column_name, data_type, description,
         1 - (embedding <=> p_query) as similarity
  from public.schema_embeddings
  where data_source_id = any(p_sources)
  order by embedding <=> p_query
  limit p_k;
$$;

comment on function public.match_schema_multi is 'Retrieve schema across multiple data sources by query vector (top-k cosine)';

grant execute on function public.match_schema_multi(extensions.vector(1024), uuid[], int) to authenticated;
