-- Chart library: user-saved charts (spec + SQL, no inline data for Recharts)
-- Charts are saved from chat sessions and can be viewed/edited later.
-- Each chart binds to one or more data sources (multiple file data sources
-- supported for multi-file SQL). Recharts charts store spec + SQL and
-- re-execute on display; Plotly charts store the full figure JSON.

create table if not exists public.charts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  description text,
  -- Chart spec JSONB:
  --   Recharts: { chartType, xKey, yKeys, title, uiConfig, renderer:"recharts" }
  --   Plotly:    { renderer:"plotly", plotlyFigure:{...}, title }
  spec jsonb not null,
  -- SQL to re-execute on display (null for Plotly full-figure mode)
  sql_text text,
  -- "recharts" | "plotly"
  renderer text not null default 'recharts',
  -- Originating session (for traceability; set null if session deleted)
  source_session_id uuid references public.sessions (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.charts is 'User-saved chart library (spec + SQL, no inline data for Recharts)';

-- Chart ↔ data source binding (many-to-many)
-- DB-type chart: 1 row (single DB source)
-- File-type chart: N rows (multiple file sources for multi-file SQL)
create table if not exists public.chart_data_sources (
  id uuid primary key default gen_random_uuid(),
  chart_id uuid not null references public.charts (id) on delete cascade,
  data_source_id uuid not null references public.data_sources (id) on delete cascade,
  added_at timestamptz not null default now(),
  unique (chart_id, data_source_id)
);

comment on table public.chart_data_sources is 'Join table for chart ↔ data source binding (supports multi-file per chart)';

-- Indexes
create index if not exists idx_charts_user on public.charts (user_id, updated_at);
create index if not exists idx_chart_data_sources_chart on public.chart_data_sources (chart_id);
create index if not exists idx_chart_data_sources_source on public.chart_data_sources (data_source_id);

-- updated_at trigger (reuse set_updated_at function from app_tables migration)
drop trigger if exists trg_charts_updated on public.charts;
create trigger trg_charts_updated before update on public.charts
  for each row execute function public.set_updated_at();

-- RLS for charts
alter table public.charts enable row level security;

drop policy if exists "charts_select_own" on public.charts;
create policy "charts_select_own" on public.charts
  for select using (user_id = auth.uid());

drop policy if exists "charts_insert_own" on public.charts;
create policy "charts_insert_own" on public.charts
  for insert with check (user_id = auth.uid());

drop policy if exists "charts_update_own" on public.charts;
create policy "charts_update_own" on public.charts
  for update using (user_id = auth.uid());

drop policy if exists "charts_delete_own" on public.charts;
create policy "charts_delete_own" on public.charts
  for delete using (user_id = auth.uid());

-- RLS for chart_data_sources (ownership derived via chart_id → charts.user_id)
alter table public.chart_data_sources enable row level security;

drop policy if exists "cds_select_own" on public.chart_data_sources;
create policy "cds_select_own" on public.chart_data_sources
  for select using (
    exists (
      select 1 from public.charts c
      where c.id = chart_data_sources.chart_id and c.user_id = auth.uid()
    )
  );

drop policy if exists "cds_insert_own" on public.chart_data_sources;
create policy "cds_insert_own" on public.chart_data_sources
  for insert with check (
    exists (
      select 1 from public.charts c
      where c.id = chart_data_sources.chart_id and c.user_id = auth.uid()
    )
  );

drop policy if exists "cds_delete_own" on public.chart_data_sources;
create policy "cds_delete_own" on public.chart_data_sources
  for delete using (
    exists (
      select 1 from public.charts c
      where c.id = chart_data_sources.chart_id and c.user_id = auth.uid()
    )
  );
