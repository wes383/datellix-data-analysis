-- Allow 'file' as a valid artifact type.
--
-- The export_query tool produces file artifacts (downloadable CSV payloads
-- carried inline, no cloud storage). The original CHECK constraint in
-- 20260629000002_app_tables.sql only allowed chart/table/code/forecast/summary,
-- so inserting a file artifact silently failed (the insert returned an error
-- but the code didn't inspect the response), and the artifact disappeared
-- after page refresh.
--
-- This migration adds 'file' to the allowed types. No data migration is
-- needed — existing rows are unaffected.
alter table public.artifacts
  drop constraint if exists artifacts_type_check;

alter table public.artifacts
  add constraint artifacts_type_check
  check (type in ('chart', 'table', 'code', 'forecast', 'summary', 'file'));
