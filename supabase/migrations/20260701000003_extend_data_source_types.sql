-- Extend data_sources.type CHECK constraint to support new database types.
-- Original (20260629000002_app_tables.sql) only allowed: file, pg, api
-- New: adds mysql, bigquery, duckdb, sqlite. Drops "api" (unused) for cleanliness.

alter table public.data_sources
  drop constraint if exists data_sources_type_check;

alter table public.data_sources
  add constraint data_sources_type_check
  check (type in ('file', 'pg', 'mysql', 'bigquery', 'duckdb', 'sqlite'));

comment on constraint data_sources_type_check on public.data_sources is 'Allowed data source types: file, pg, mysql, bigquery, duckdb, sqlite';
