-- Allow 'report' as a valid artifact type.
--
-- The generate_report tool produces report artifacts (Markdown report
-- payload with optional metadata + referenced artifact IDs, rendered by
-- the frontend with react-markdown and exportable to PDF via jsPDF).
-- The CHECK constraint added in 20260703000002_artifacts_allow_file_type.sql
-- only allows chart/table/code/forecast/summary/file, so inserting a report
-- artifact would silently fail.
--
-- This migration adds 'report' to the allowed types. No data migration is
-- needed — existing rows are unaffected.
alter table public.artifacts
  drop constraint if exists artifacts_type_check;

alter table public.artifacts
  add constraint artifacts_type_check
  check (type in ('chart', 'table', 'code', 'forecast', 'summary', 'file', 'report'));
