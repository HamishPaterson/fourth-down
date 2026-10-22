-- Phase 2 only: additive, isolated from odds_market_snapshots and weekly_best_multis.
-- Generate/review this migration; do not apply it to Production in this phase.
begin;

create table public.odds_provider_scopes (
  scope_key text primary key,
  provider text not null,
  season integer not null,
  week integer not null check (week between 1 and 18),
  resource text not null check (resource in ('core', 'props')),
  owner_token uuid,
  lease_until timestamptz,
  current_refresh_id uuid,
  unique (provider, season, week, resource)
);

create table public.odds_provider_refreshes (
  refresh_id uuid primary key,
  scope_key text not null references public.odds_provider_scopes,
  provider text not null,
  season integer not null,
  week integer not null,
  resource text not null check (resource in ('core', 'props')),
  owner_token uuid not null,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  completeness_state text not null default 'UNKNOWN' check (completeness_state in
    ('COMPLETE','MORE_PAGES_AVAILABLE','SOURCE_TRUNCATED','SOURCE_DEGRADED','UNKNOWN')),
  status text not null default 'started' check (status in ('started','candidate','promoted','rejected','failed')),
  stale boolean not null default true,
  failure_code text check (failure_code in ('PROVIDER_REQUEST_FAILED','REFRESH_VALIDATION_FAILED',
    'PERSISTENCE_FAILED','CREDIT_BUDGET_BLOCKED','LEASE_LOST','REFRESH_FAILED')),
  row_count integer not null default 0 check (row_count >= 0),
  credit_usage numeric not null default 0 check (credit_usage >= 0),
  expected_event_ids jsonb not null,
  required_markets jsonb not null,
  snapshot jsonb
);

alter table public.odds_provider_scopes add constraint odds_provider_current_refresh_fk
  foreign key (current_refresh_id) references public.odds_provider_refreshes(refresh_id);

create table public.odds_provider_quotes (
  refresh_id uuid not null references public.odds_provider_refreshes,
  quote_key text not null,
  provider text not null,
  season integer not null,
  week integer not null,
  provider_event_id text not null,
  matchup_identity text not null,
  kickoff timestamptz not null,
  home_team text not null,
  away_team text not null,
  bookmaker text not null,
  market text not null,
  raw_provider_market text not null,
  player_id text,
  player_name text,
  player_team text,
  selection text not null,
  side text,
  line numeric,
  american_odds integer not null check (abs(american_odds::numeric) >= 100),
  decimal_odds numeric not null check (decimal_odds > 1 and decimal_odds < 'Infinity'::numeric),
  implied_probability numeric not null check (implied_probability > 0 and implied_probability < 1),
  provider_timestamp timestamptz,
  fetched_at timestamptz not null,
  age_seconds numeric check (age_seconds >= 0 and age_seconds < 'Infinity'::numeric),
  freshness_state text not null check (freshness_state in ('fresh','stale','unknown')),
  completeness_state text not null check (completeness_state = 'COMPLETE'),
  quote jsonb not null,
  primary key (refresh_id, quote_key)
);
create index odds_provider_quotes_lookup on public.odds_provider_quotes
  (provider, season, week, provider_event_id, market);

-- A reserved/unknown charge remains counted, including after a worker crashes.
-- Reservations never expire into free budget. Explicit reconciliation is required.
create table public.odds_provider_usage (
  reservation_id uuid primary key,
  provider text not null,
  timestamp timestamptz not null default clock_timestamp(),
  period text not null,
  endpoint text not null,
  season integer not null,
  week integer not null,
  refresh_id uuid references public.odds_provider_refreshes,
  reason_code text not null check (reason_code in
    ('SCHEDULED_REFRESH','MANUAL_ADMIN_REFRESH','INITIAL_PROVIDER_VALIDATION','RECOVERY_REFRESH')),
  automatic boolean not null,
  expected_credits numeric not null check (expected_credits >= 0 and expected_credits < 'Infinity'::numeric),
  observed_credits numeric check (observed_credits >= 0 and observed_credits < 'Infinity'::numeric),
  budget_credits numeric not null check (budget_credits >= 0 and budget_credits < 'Infinity'::numeric),
  success boolean,
  overrun_credits numeric not null default 0 check (overrun_credits >= 0 and overrun_credits < 'Infinity'::numeric),
  reconciled_at timestamptz,
  result_status text not null default 'RESERVED' check (result_status in
    ('RESERVED','DISPATCHED','RECONCILED','PROVIDER_FAILURE','PRE_DISPATCH_FAILURE','CHARGE_UNKNOWN','COST_OVERRUN','FREE')),
  http_status integer check (http_status between 100 and 599),
  monthly_running_total numeric not null check (monthly_running_total >= 0),
  constraint odds_provider_usage_overrun_consistency check
    (overrun_credits = greatest(coalesce(observed_credits,expected_credits)-expected_credits,0)
      and (result_status = 'COST_OVERRUN') = (overrun_credits > 0)),
  constraint odds_provider_usage_status_consistency check (
    (result_status in ('RESERVED','DISPATCHED','CHARGE_UNKNOWN') and observed_credits is null
      and budget_credits=expected_credits)
    or (result_status='PRE_DISPATCH_FAILURE' and observed_credits=0 and budget_credits=0 and success=false)
    or (result_status='FREE' and expected_credits=0 and observed_credits=0 and budget_credits=0)
    or (result_status in ('RECONCILED','PROVIDER_FAILURE','COST_OVERRUN')
      and observed_credits is not null and budget_credits=observed_credits)
  )
);
create index odds_provider_usage_month on public.odds_provider_usage (provider, period);

-- Suspension is sticky. No reset RPC/route exists in Phase 2.
create table public.odds_provider_budgets (
  provider text not null,
  period text not null check (period ~ '^[0-9]{4}-[0-9]{2}$'),
  paid_state text not null default 'ACTIVE' check (paid_state in ('ACTIVE','SUSPENDED')),
  suspension_code text check (suspension_code in ('COST_OVERRUN','CHARGE_UNKNOWN')),
  suspended_at timestamptz,
  reservation_id uuid references public.odds_provider_usage,
  primary key (provider, period),
  constraint odds_provider_budget_suspension_consistency check (
    (paid_state='ACTIVE' and suspension_code is null and suspended_at is null and reservation_id is null)
    or (paid_state='SUSPENDED' and suspension_code is not null and suspended_at is not null and reservation_id is not null)
  )
);

alter table public.odds_provider_scopes enable row level security;
alter table public.odds_provider_refreshes enable row level security;
alter table public.odds_provider_quotes enable row level security;
alter table public.odds_provider_usage enable row level security;
alter table public.odds_provider_budgets enable row level security;
revoke all on public.odds_provider_scopes, public.odds_provider_refreshes,
  public.odds_provider_quotes, public.odds_provider_usage, public.odds_provider_budgets from public, anon, authenticated, service_role;
grant select on public.odds_provider_scopes, public.odds_provider_refreshes,
  public.odds_provider_quotes, public.odds_provider_usage, public.odds_provider_budgets to service_role;
create policy provider_scopes_read on public.odds_provider_scopes for select to service_role using (true);
create policy provider_refreshes_read on public.odds_provider_refreshes for select to service_role using (true);
create policy provider_quotes_read on public.odds_provider_quotes for select to service_role using (true);
create policy provider_usage_read on public.odds_provider_usage for select to service_role using (true);
create policy provider_budgets_read on public.odds_provider_budgets for select to service_role using (true);

-- All mutations run transactionally with database-clock leases and fencing tokens.
create function public.odds_provider_control(p_action text, p jsonb)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  s public.odds_provider_scopes%rowtype;
  g public.odds_provider_refreshes%rowtype;
  u public.odds_provider_usage%rowtype;
  scope text;
  v_period text := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM');
  used numeric;
  auto_used numeric;
  cost numeric;
  q jsonb;
  e jsonb;
  snap jsonb;
  prior jsonb;
  reconciliation_status text;
begin
  if p_action = 'reconcile' then
    select * into u from public.odds_provider_usage
      where reservation_id=(p->>'reservationId')::uuid and provider=p->>'provider';
    if not found or u.refresh_id is distinct from (p->>'refreshId')::uuid then
      raise exception 'Unknown credit reservation for refresh';
    end if;
    v_period := u.period;
  end if;
  if p_action in ('reserve','reconcile','free','dispatch') then
    perform pg_advisory_xact_lock(hashtextextended('odds-budget:' || (p->>'provider') || ':' || v_period, 0));
  end if;

  if p_action in ('reserve','dispatch') then
    for u in select pending.* from public.odds_provider_usage pending
      join public.odds_provider_refreshes refresh on refresh.refresh_id=pending.refresh_id
      join public.odds_provider_scopes lease on lease.scope_key=refresh.scope_key
      where pending.provider=p->>'provider' and pending.period=v_period
        and pending.result_status='DISPATCHED'
        and (lease.owner_token is distinct from refresh.owner_token
          or lease.lease_until <= clock_timestamp() or refresh.status <> 'started')
      for update of pending
    loop
      update public.odds_provider_usage set result_status='CHARGE_UNKNOWN',reconciled_at=clock_timestamp()
        where reservation_id=u.reservation_id;
      insert into public.odds_provider_budgets(provider,period,paid_state,suspension_code,suspended_at,reservation_id)
        values(u.provider,u.period,'SUSPENDED','CHARGE_UNKNOWN',clock_timestamp(),u.reservation_id)
        on conflict(provider,period) do update set paid_state='SUSPENDED',
          suspension_code=excluded.suspension_code,suspended_at=excluded.suspended_at,
          reservation_id=excluded.reservation_id;
    end loop;
  end if;

  if p_action = 'acquire' then
    scope := (p->>'provider') || ':' || (p->>'season') || ':' || (p->>'week') || ':' || (p->>'resource');
    insert into public.odds_provider_scopes(scope_key,provider,season,week,resource)
      values(scope,p->>'provider',(p->>'season')::integer,(p->>'week')::integer,p->>'resource')
      on conflict do nothing;
    select * into s from public.odds_provider_scopes where scope_key=scope for update;
    if s.lease_until > clock_timestamp() then return jsonb_build_object('acquired',false); end if;
    update public.odds_provider_scopes set owner_token=(p->>'ownerToken')::uuid,
      lease_until=clock_timestamp() + interval '120 seconds' where scope_key=scope;
    return jsonb_build_object('acquired',true,'scopeKey',scope,'ownerToken',p->>'ownerToken');
  end if;

  if p_action = 'reconcile' then
    select * into u from public.odds_provider_usage
      where reservation_id=(p->>'reservationId')::uuid and provider=p->>'provider' for update;
    if not found or u.refresh_id is distinct from (p->>'refreshId')::uuid then
      raise exception 'Unknown credit reservation for refresh';
    end if;
    if u.result_status not in ('RESERVED','DISPATCHED','CHARGE_UNKNOWN') then return to_jsonb(u); end if;
    if u.result_status='CHARGE_UNKNOWN' and p->>'observedCredits' is null then return to_jsonb(u); end if;
    if (p->>'requestAttempted') is null or (p->>'success') is null then
      raise exception 'Reconciliation requires dispatch and outcome evidence';
    end if;
    cost := case when p->>'observedCredits' is not null then (p->>'observedCredits')::numeric
      when (p->>'requestAttempted')::boolean = false then 0 else u.expected_credits end;
    if cost < 0 or cost >= 'Infinity'::numeric then raise exception 'Invalid reconciled charge'; end if;
    if not (p->>'requestAttempted')::boolean and (cost <> 0 or (p->>'success')::boolean) then
      raise exception 'Conflicting pre-dispatch evidence';
    end if;
    reconciliation_status := case
      when not (p->>'requestAttempted')::boolean then 'PRE_DISPATCH_FAILURE'
      when p->>'observedCredits' is null then 'CHARGE_UNKNOWN'
      when cost > u.expected_credits then 'COST_OVERRUN'
      when (p->>'success')::boolean then 'RECONCILED' else 'PROVIDER_FAILURE' end;
    select coalesce(sum(budget_credits),0)-u.budget_credits+cost into used
      from public.odds_provider_usage where provider=u.provider and odds_provider_usage.period=u.period;
    update public.odds_provider_usage set budget_credits=cost,
      observed_credits=case when reconciliation_status='PRE_DISPATCH_FAILURE' then 0 else (p->>'observedCredits')::numeric end,
      overrun_credits=greatest(cost-u.expected_credits,0),
      success=(p->>'success')::boolean,reconciled_at=clock_timestamp(),
      http_status=(p->>'httpStatus')::integer, result_status=reconciliation_status,
      monthly_running_total=used where reservation_id=u.reservation_id returning * into u;
    if reconciliation_status in ('COST_OVERRUN','CHARGE_UNKNOWN') then
      insert into public.odds_provider_budgets(provider,period,paid_state,suspension_code,suspended_at,reservation_id)
        values(u.provider,u.period,'SUSPENDED',reconciliation_status,clock_timestamp(),u.reservation_id)
        on conflict(provider,period) do update set paid_state='SUSPENDED',
          suspension_code=excluded.suspension_code,suspended_at=excluded.suspended_at,
          reservation_id=excluded.reservation_id;
    end if;
    return to_jsonb(u);
  end if;

  if p_action = 'free' then
    select coalesce(sum(budget_credits),0) into used from public.odds_provider_usage
      where provider=p->>'provider' and odds_provider_usage.period=v_period;
    insert into public.odds_provider_usage(reservation_id,provider,period,endpoint,season,week,
      reason_code,automatic,expected_credits,observed_credits,budget_credits,success,result_status,monthly_running_total)
      values((p->>'id')::uuid,p->>'provider',v_period,'events',(p->>'season')::integer,(p->>'week')::integer,
        p->>'reasonCode',true,0,0,0,(p->>'success')::boolean,'FREE',used);
    return jsonb_build_object('recorded',true);
  end if;

  if p_action = 'fail' then
    select * into g from public.odds_provider_refreshes where refresh_id=(p->>'refreshId')::uuid
      and scope_key=p->>'scopeKey' and owner_token=(p->>'ownerToken')::uuid for update;
    if not found then raise exception 'Refresh generation ownership lost'; end if;
    if g.status = 'promoted' then return jsonb_build_object('alreadyPromoted',true); end if;
    if p->>'failureCode' is null or p->>'failureCode' not in
      ('PROVIDER_REQUEST_FAILED','REFRESH_VALIDATION_FAILED','PERSISTENCE_FAILED','CREDIT_BUDGET_BLOCKED','LEASE_LOST','REFRESH_FAILED')
      then raise exception 'Invalid refresh failure code'; end if;
    update public.odds_provider_refreshes set status='failed', completed_at=clock_timestamp(),
      completeness_state=coalesce(p->>'completeness','UNKNOWN'),failure_code=p->>'failureCode',
      credit_usage=(select coalesce(sum(budget_credits),0) from public.odds_provider_usage where refresh_id=g.refresh_id)
      where refresh_id=g.refresh_id;
    return jsonb_build_object('failed',true);
  end if;

  select * into s from public.odds_provider_scopes where scope_key=p->>'scopeKey' for update;
  if not found or s.owner_token is distinct from (p->>'ownerToken')::uuid then
    if p_action = 'release' then return jsonb_build_object('released',false); end if;
    raise exception 'Refresh lease ownership lost';
  end if;
  if p_action = 'release' then
    update public.odds_provider_scopes set owner_token=null,lease_until=null where scope_key=s.scope_key;
    return jsonb_build_object('released',true);
  end if;
  if s.lease_until <= clock_timestamp() then raise exception 'Refresh lease expired'; end if;
  update public.odds_provider_scopes set lease_until=clock_timestamp()+interval '120 seconds'
    where scope_key=s.scope_key;
  if p_action = 'renew' then return jsonb_build_object('renewed',true); end if;
  if p_action = 'start' then
    insert into public.odds_provider_refreshes(refresh_id,scope_key,provider,season,week,resource,
      owner_token,expected_event_ids,required_markets)
      values((p->>'refreshId')::uuid,s.scope_key,s.provider,s.season,s.week,s.resource,s.owner_token,
        p->'expectedEventIds',p->'requiredMarkets') returning * into g;
    return to_jsonb(g);
  end if;

  select * into g from public.odds_provider_refreshes
    where refresh_id=(p->>'refreshId')::uuid and scope_key=s.scope_key and owner_token=s.owner_token for update;
  if not found then raise exception 'Refresh generation does not belong to lease'; end if;
  if p_action = 'dispatch' then
    select * into u from public.odds_provider_usage where reservation_id=(p->>'reservationId')::uuid
      and refresh_id=g.refresh_id and provider=s.provider for update;
    if not found or g.status <> 'started' or u.result_status <> 'RESERVED' or u.period <> v_period then
      raise exception 'Dispatch requires an unspent current-month reservation';
    end if;
    if exists (select 1 from public.odds_provider_budgets where provider=s.provider and period=v_period
      and paid_state='SUSPENDED') then
      return jsonb_build_object('dispatchAllowed',false,'reason','provider_month_suspended');
    end if;
    if exists (select 1 from public.odds_provider_usage where provider=s.provider and period=v_period
      and result_status='DISPATCHED') then
      return jsonb_build_object('dispatchAllowed',false,'reason','provider_charge_unresolved');
    end if;
    update public.odds_provider_usage set result_status='DISPATCHED' where reservation_id=u.reservation_id;
    return jsonb_build_object('dispatchAllowed',true);
  end if;
  if p_action = 'reserve' then
    if g.status <> 'started' then raise exception 'Refresh is not accepting provider requests'; end if;
    cost := (p->>'expectedCredits')::numeric;
    if cost is null or cost <= 0 or cost >= 'Infinity'::numeric
      or cost <> trunc(cost)
      or not coalesce(p->>'monthlyLimit' ~ '^[0-9]+$',false)
      or not coalesce(p->>'automaticBudget' ~ '^[0-9]+$',false)
      or (p->>'automatic') is null then
      raise exception 'Invalid credit configuration';
    end if;
    if p->>'reasonCode' is null or p->>'reasonCode' not in
      ('SCHEDULED_REFRESH','MANUAL_ADMIN_REFRESH','INITIAL_PROVIDER_VALIDATION','RECOVERY_REFRESH') then
      raise exception 'Invalid refresh reason code';
    end if;
    if s.provider <> 'parlay' or cost <> 3 or
      not ((s.resource='props' and p->>'endpoint'='props') or (s.resource='core' and p->>'endpoint'='odds')) then
      raise exception 'Unknown bounded paid request cost';
    end if;
    if exists (select 1 from public.odds_provider_budgets where provider=s.provider and period=v_period
      and paid_state='SUSPENDED') then
      return jsonb_build_object('allowed',false,'reason','provider_month_suspended');
    end if;
    if exists (select 1 from public.odds_provider_usage where provider=s.provider and period=v_period
      and result_status='DISPATCHED') then
      return jsonb_build_object('allowed',false,'reason','provider_charge_unresolved');
    end if;
    insert into public.odds_provider_budgets(provider,period) values(s.provider,v_period) on conflict do nothing;
    select coalesce(sum(budget_credits),0),
      coalesce(sum(budget_credits) filter (where automatic),0) into used,auto_used
      from public.odds_provider_usage where provider=s.provider and odds_provider_usage.period=v_period;
    if used+cost > (p->>'monthlyLimit')::numeric
      or ((p->>'automatic')::boolean and auto_used+cost > (p->>'automaticBudget')::numeric) then
      return jsonb_build_object('allowed',false,'reason','credit_budget_exhausted');
    end if;
    insert into public.odds_provider_usage(reservation_id,provider,period,endpoint,season,week,
      refresh_id,reason_code,automatic,expected_credits,budget_credits,monthly_running_total)
      values((p->>'reservationId')::uuid,s.provider,v_period,p->>'endpoint',s.season,s.week,
        g.refresh_id,p->>'reasonCode',(p->>'automatic')::boolean,cost,cost,used+cost);
    return jsonb_build_object('allowed',true,'reservationId',p->>'reservationId');
  end if;
  if p_action = 'candidate' then
    if g.status <> 'started' then raise exception 'Generation is already finalized'; end if;
    snap := p->'snapshot';
    if not coalesce(snap->'completeness' @> '{"status":"COMPLETE","hasMore":false,"truncated":false,"degraded":false}'::jsonb,false)
      or snap->>'provider' is distinct from s.provider
      or (snap->>'season')::integer is distinct from s.season
      or (snap->>'week')::integer is distinct from s.week
      or snap->>'refreshId' is distinct from g.refresh_id::text
      or coalesce(jsonb_array_length(snap->'quotes'),0)=0 then raise exception 'Incomplete candidate'; end if;
    for q in select value from jsonb_array_elements(snap->'quotes') loop
      select value into e from jsonb_array_elements(snap->'events')
        where value->>'providerEventId'=q->>'providerEventId';
      if e is null or q->>'provider' is distinct from s.provider
        or (q->>'season')::integer is distinct from s.season
        or (q->>'week')::integer is distinct from s.week
        or (e->>'season')::integer is distinct from s.season
        or (e->>'week')::integer is distinct from s.week
        or q->>'canonicalMatchupIdentity' is distinct from e->>'canonicalMatchupIdentity'
        or q->>'provider' is distinct from e->>'provider'
        or q->>'refreshId' is distinct from g.refresh_id::text then raise exception 'Candidate identity mismatch'; end if;
      if nullif(q->>'playerName','') is not null and (
        nullif(q->>'playerId','') is null or nullif(q->>'team','') is null
        or q->>'eligibleForBetting' is distinct from 'true'
        or (q->>'team' is distinct from e->>'homeTeamCode' and q->>'team' is distinct from e->>'awayTeamCode')
        or coalesce(q->>'playerIdentityStatus','') not in
          ('MATCHED_STABLE_ID','MATCHED_EXACT_NAME_EVENT','MATCHED_NORMALIZED_NAME_EVENT')
      ) then raise exception 'Ineligible player identity'; end if;
      insert into public.odds_provider_quotes(refresh_id,quote_key,provider,season,week,provider_event_id,
        matchup_identity,kickoff,home_team,away_team,bookmaker,market,raw_provider_market,player_id,player_name,
        player_team,selection,side,line,american_odds,decimal_odds,implied_probability,provider_timestamp,
        fetched_at,age_seconds,freshness_state,completeness_state,quote)
        values(g.refresh_id,q->>'quoteKey',s.provider,s.season,s.week,q->>'providerEventId',
          q->>'canonicalMatchupIdentity',(e->>'kickoff')::timestamptz,e->>'homeTeam',e->>'awayTeam',
          q->>'bookmaker',q->>'market',q->>'rawProviderMarket',q->>'playerId',q->>'playerName',
          q->>'team',q->>'selection',q->>'side',(q->>'line')::numeric,(q->>'americanOdds')::integer,
          (q->>'decimalOdds')::numeric,(q->>'impliedProbability')::numeric,
          (q->>'providerTimestamp')::timestamptz,(q->>'fetchedAt')::timestamptz,(q->>'ageSeconds')::numeric,
          q->>'freshnessStatus','COMPLETE',q);
    end loop;
    update public.odds_provider_refreshes set status='candidate',snapshot=snap,
      completeness_state='COMPLETE',row_count=jsonb_array_length(snap->'quotes')
      where refresh_id=g.refresh_id;
    return jsonb_build_object('candidate',true);
  end if;
  if p_action = 'promote' then
    if g.status <> 'candidate' or g.snapshot is distinct from p->'snapshot'
      or g.row_count <> (select count(*) from public.odds_provider_quotes where refresh_id=g.refresh_id)
      or exists (select 1 from public.odds_provider_quotes qrow where qrow.refresh_id=g.refresh_id
        and not (g.snapshot->'quotes' @> jsonb_build_array(qrow.quote)))
      then raise exception 'Persisted candidate validation failed'; end if;
    if jsonb_array_length(g.expected_event_ids)=0 or jsonb_array_length(g.required_markets)=0
      or exists (
        select 1 from jsonb_array_elements_text(g.expected_event_ids) event_id
        cross join jsonb_array_elements_text(g.required_markets) market_name
        where not exists (select 1 from public.odds_provider_quotes qr
          where qr.refresh_id=g.refresh_id and qr.provider_event_id=event_id and qr.market=market_name)
      ) or exists (
        select 1 from public.odds_provider_quotes qr where qr.refresh_id=g.refresh_id
          and (not (g.expected_event_ids @> jsonb_build_array(qr.provider_event_id))
            or not (g.required_markets @> jsonb_build_array(qr.market)))
      ) then raise exception 'Persisted event/market coverage is incomplete'; end if;
    select snapshot into prior from public.odds_provider_refreshes where refresh_id=s.current_refresh_id;
    if prior is not null and exists (
      select 1 from jsonb_array_elements(g.snapshot->'quotes') n
      join jsonb_array_elements(prior->'quotes') o on n->>'quoteKey'=o->>'quoteKey'
      where (o->>'providerTimestamp' is not null and (n->>'providerTimestamp' is null
        or (n->>'providerTimestamp')::timestamptz < (o->>'providerTimestamp')::timestamptz))
        or (n->>'fetchedAt')::timestamptz < (o->>'fetchedAt')::timestamptz
    ) then raise exception 'Older quote generation cannot replace current'; end if;
    update public.odds_provider_refreshes set status='promoted',stale=false,completed_at=clock_timestamp(),
      credit_usage=(select coalesce(sum(budget_credits),0) from public.odds_provider_usage where refresh_id=g.refresh_id)
      where refresh_id=g.refresh_id;
    update public.odds_provider_scopes set current_refresh_id=g.refresh_id where scope_key=s.scope_key;
    return jsonb_build_object('promoted',true,'refreshId',g.refresh_id);
  end if;
  raise exception 'Unsupported odds provider control operation';
end;
$$;
revoke all on function public.odds_provider_control(text,jsonb) from public, anon, authenticated;
grant execute on function public.odds_provider_control(text,jsonb) to service_role;

commit;
