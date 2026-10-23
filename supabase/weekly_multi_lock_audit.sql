begin;

create table if not exists public.weekly_multi_lock_plans (
  id uuid primary key,
  season integer not null,
  week integer not null check (week between 1 and 18),
  lock_at timestamptz not null unique check (lock_at > '2026-10-22T00:00:00Z'),
  prepared_at timestamptz not null check (prepared_at < lock_at),
  source text not null check (source = 'server-prepared'),
  expected_game_count integer not null check (expected_game_count between 1 and 16),
  games jsonb not null check (jsonb_typeof(games) = 'array' and jsonb_array_length(games) = expected_game_count)
);

create table if not exists public.weekly_multi_lock_manifests (
  id uuid primary key,
  operation_id uuid not null,
  season integer,
  week integer,
  lock_at timestamptz,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.weekly_multi_lock_executions (
  id bigint generated always as identity primary key,
  operation_id uuid not null,
  season integer,
  week integer,
  scheduled_at timestamptz not null,
  invoked_at timestamptz not null,
  authorization_result text not null check (authorization_result in ('AUTHORIZED', 'DENIED')),
  handler_reached boolean not null,
  generated_late boolean not null,
  preparation_result text not null check (preparation_result in ('NOT_STARTED', 'READY', 'FAILED')),
  lock_result text not null check (lock_result in ('NOT_ATTEMPTED', 'ATTEMPTED', 'SUCCEEDED', 'EXISTING')),
  existing_lock_result boolean not null,
  stage text not null check (stage in ('STARTED', 'EVALUATED', 'FINISHED', 'FAILED')),
  result text not null check (result in ('HANDLER_REACHED', 'AUTHORIZATION_FAILED', 'LOCK_ALREADY_EXISTED',
    'HISTORICAL_LOCK_PROHIBITED', 'OUTSIDE_LOCK_WINDOW', 'READY', 'READINESS_FAILED', 'PREPARED',
    'DRY_RUN', 'LOCK_SUCCEEDED', 'PIPELINE_FAILED', 'NO_ELIGIBLE_CANDIDATES')),
  readiness_result text check (readiness_result in ('READY', 'NOT_READY', 'DEGRADED_NON_BLOCKING', 'UNKNOWN')),
  failure_code text check (failure_code in ('INPUT_OR_AUDIT_UNAVAILABLE', 'PREPARATION_OR_PERSISTENCE_FAILED')),
  manifest_id uuid references public.weekly_multi_lock_manifests(id),
  created_at timestamptz not null default now()
);

alter table public.weekly_best_multis
  add column if not exists manifest_id uuid references public.weekly_multi_lock_manifests(id);

create index if not exists weekly_multi_execution_operation
  on public.weekly_multi_lock_executions(operation_id, id);
create index if not exists weekly_multi_execution_schedule
  on public.weekly_multi_lock_executions(scheduled_at, invoked_at);

do $$
declare name text;
begin
  foreach name in array array['weekly_multi_lock_plans', 'weekly_multi_lock_manifests', 'weekly_multi_lock_executions']
  loop
    execute format('alter table public.%I enable row level security', name);
    execute format('revoke all on table public.%I from anon, authenticated, service_role', name);
    execute format('grant select, insert on table public.%I to service_role', name);
    execute format('drop policy if exists lock_audit_service_read on public.%I', name);
    execute format('drop policy if exists lock_audit_service_insert on public.%I', name);
    execute format('create policy lock_audit_service_read on public.%I for select to service_role using (true)', name);
    execute format('create policy lock_audit_service_insert on public.%I for insert to service_role with check (true)', name);
    execute format('drop trigger if exists lock_audit_immutable on public.%I', name);
    execute format('create trigger lock_audit_immutable before update or delete on public.%I
      for each row execute function public.prevent_weekly_best_multi_mutation()', name);
  end loop;
end;
$$;
grant usage on sequence public.weekly_multi_lock_executions_id_seq to service_role;

create or replace function public.require_future_multi_manifest()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if new.lock_at <= '2026-10-22T00:00:00Z' or (new.season = 2026 and new.week <= 7) then
    raise exception 'Historical lock creation prohibited';
  end if;
  if new.manifest_id is null or not exists (
    select 1 from public.weekly_multi_lock_manifests m
    where m.id = new.manifest_id and m.season = new.season and m.week = new.week
      and m.lock_at = new.lock_at and m.payload->>'preparationResult' = 'READY'
  ) then
    raise exception 'Ready immutable lock manifest required';
  end if;
  if new.status <> 'locked' or new.partial or jsonb_array_length(new.legs) <> 5 then
    raise exception 'Complete five-leg lock required';
  end if;
  return new;
end;
$$;
drop trigger if exists weekly_multi_require_manifest on public.weekly_best_multis;
create trigger weekly_multi_require_manifest before insert on public.weekly_best_multis
  for each row execute function public.require_future_multi_manifest();

notify pgrst, 'reload schema';
commit;
