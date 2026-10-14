create table if not exists public.odds_market_snapshots (
  sport text not null,
  season integer not null,
  week integer not null check (week between 1 and 18),
  market text not null,
  provider text not null default 'SharpAPI',
  rows jsonb not null default '[]'::jsonb check (jsonb_typeof(rows) = 'array'),
  fetched_at timestamptz,
  last_attempt_at timestamptz,
  status text not null default 'missing'
    check (status in ('missing', 'ok', 'rate_limited', 'error', 'empty')),
  last_error text,
  rate_limited_until timestamptz,
  row_count integer not null default 0,
  page_count integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint odds_market_snapshots_pkey primary key (sport, season, week, market)
);

alter table public.odds_market_snapshots enable row level security;

revoke all on table public.odds_market_snapshots from anon, authenticated, service_role;
grant select, insert, update on table public.odds_market_snapshots to service_role;

drop policy if exists "odds_market_snapshots_service_role_select" on public.odds_market_snapshots;
drop policy if exists "odds_market_snapshots_service_role_insert" on public.odds_market_snapshots;
drop policy if exists "odds_market_snapshots_service_role_update" on public.odds_market_snapshots;
create policy "odds_market_snapshots_service_role_select"
  on public.odds_market_snapshots for select to service_role using (true);
create policy "odds_market_snapshots_service_role_insert"
  on public.odds_market_snapshots for insert to service_role with check (true);
create policy "odds_market_snapshots_service_role_update"
  on public.odds_market_snapshots for update to service_role using (true) with check (true);

create or replace function public.touch_odds_market_snapshot()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists odds_market_snapshots_touch on public.odds_market_snapshots;
create trigger odds_market_snapshots_touch
  before update on public.odds_market_snapshots
  for each row execute function public.touch_odds_market_snapshot();
