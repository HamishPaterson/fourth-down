create or replace function public.replace_prediction_week(p jsonb)
returns jsonb language plpgsql security invoker
set search_path = pg_catalog
set statement_timeout = '30s'
as $$
declare
  op uuid;
  before_state jsonb;
  after_state jsonb;
  item jsonb;
  s jsonb;
  g jsonb;
  m jsonb;
  key text;
  bet jsonb;
  r public.prediction_snapshots%rowtype;
  written integer := 0;
  changed integer;
  expected_payload text;
  actual_payload text;
  failure text := 'BATCH_INVALID';
begin
  if current_user <> 'service_role' then raise exception 'SERVER_ONLY' using errcode = '42501'; end if;
  -- Authorization and operation identity precede the bounded failure-audit scope.
  op := (p->>'operationId')::uuid;
  insert into public.prediction_week_replacements
    (operation_id, season, week, caller_class, expected_count, result)
    values (op, 2026, 8, 'service_role', 14, 'started');
  begin
    if p->>'season' is distinct from '2026' or p->>'week' is distinct from '8' or
        jsonb_typeof(p->'manifest') is distinct from 'array' or
        jsonb_typeof(p->'rows') is distinct from 'array' or
        jsonb_array_length(p->'manifest') <> 14 or jsonb_array_length(p->'rows') <> 14 or
        coalesce(p->>'expectedFingerprint','') !~ '^[0-9a-f]{32}$' then
      raise exception 'invalid';
    end if;
    if (select count(distinct e->>'id') from jsonb_array_elements(p->'manifest') e) <> 14 or
       (select count(distinct (e->>'away',e->>'home')) from jsonb_array_elements(p->'manifest') e) <> 14 then
      raise exception 'invalid';
    end if;
    if (select count(distinct e#>>'{data_quality,snapshot,id}') from jsonb_array_elements(p->'rows') e) <> 14 or
       (select count(distinct e#>>'{data_quality,snapshot,game,id}') from jsonb_array_elements(p->'rows') e) <> 14 then
      raise exception 'invalid';
    end if;
    if (select count(distinct team) from (
      select e->>'away' team from jsonb_array_elements(p->'manifest') e
      union all select e->>'home' from jsonb_array_elements(p->'manifest') e
    ) teams) <> 28 then raise exception 'invalid'; end if;
    for item in select value from jsonb_array_elements(p->'rows') loop
      s := item#>'{data_quality,snapshot}'; g := s->'game';
      if jsonb_path_exists(item,
        'strict $.** ? (@.type() == "number" && (@ > 1.7976931348623157e308 || @ < -1.7976931348623157e308))')
      then raise exception 'invalid'; end if;
      select value into m from jsonb_array_elements(p->'manifest')
        where value->>'id' = g->>'id';
      if m is null or coalesce(g->>'id','') !~ '^[1-9][0-9]*$' or
         (g->>'id')::numeric > 9007199254740991 or
         coalesce(s->>'id','') = '' or
         s->>'season' is distinct from '2026' or s->>'week' is distinct from '8' or
         g->>'season' is distinct from '2026' or g->>'week' is distinct from '8' or
         s->>'awayCode' is distinct from m->>'away' or s->>'homeCode' is distinct from m->>'home' or
         g->>'away' is distinct from m->>'away' or g->>'home' is distinct from m->>'home' or
         m->>'away' = m->>'home' or
         coalesce(m->>'away','') <> all(array['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN',
           'DET','GB','HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WSH']) or
         coalesce(m->>'home','') <> all(array['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN',
           'DET','GB','HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WSH']) or
         (s->>'kickoff')::timestamptz is distinct from (m->>'kickoff')::timestamptz or
         (g->>'sourceDate')::timestamptz is distinct from (m->>'kickoff')::timestamptz or
         (s->>'kickoff')::timestamptz <= clock_timestamp() or
         (s->>'generatedAt')::timestamptz is null or
         (s->>'generatedAt')::timestamptz > clock_timestamp() + interval '1 minute' or
         s->>'source' is distinct from 'shared-full-model' or s->>'authoritative' is distinct from 'true' or
         s#>>'{batchProvenance,source}' is distinct from 'server-week-replacement' or
         s#>>'{batchProvenance,operationId}' is distinct from op::text or
         s->>'modelVersion' is distinct from '12' or
         s->>'modelKey' is distinct from 'full-v12-special-teams-kicker-model' or
         s->>'predictionFeatureVersion' is distinct from '2' or
         s#>>'{bestBets,candidateVersion}' is distinct from '5' or
         s#>>'{playerProjections,available}' is distinct from 'true' or
         s#>>'{dataQuality,sources,odds,available}' is distinct from 'true' or
         s#>>'{dataQuality,sources,playByPlay,available}' is distinct from 'true' or
         s#>>'{dataQuality,sources,playerMetrics,available}' is distinct from 'true' then
        raise exception 'invalid';
      end if;
      foreach key in array array['fourthDownAwayScore','fourthDownHomeScore',
          'fourthDownAwayWinProbability','fourthDownHomeWinProbability','confidenceScore'] loop
        if jsonb_typeof(s->key) is distinct from 'number' or
           abs((s->>key)::numeric) > 1.7976931348623157e308 then raise exception 'invalid'; end if;
      end loop;
      foreach key in array array['kickoff','date','commence_time'] loop
        if g ? key and (g->>key)::timestamptz is distinct from (s->>'kickoff')::timestamptz then
          raise exception 'invalid';
        end if;
      end loop;
      if (s->>'fourthDownAwayScore')::numeric < 0 or (s->>'fourthDownHomeScore')::numeric < 0 or
         (s->>'fourthDownAwayWinProbability')::numeric not between 0 and 1 or
         (s->>'fourthDownHomeWinProbability')::numeric not between 0 and 1 or
         abs((s->>'fourthDownAwayWinProbability')::numeric +
             (s->>'fourthDownHomeWinProbability')::numeric - 1) > 0.0011 or
         coalesce(s->>'fourthDownPick','') not in (m->>'away', m->>'home') or
         s#>'{predictionPayload,away,score}' is distinct from s->'fourthDownAwayScore' or
         s#>'{predictionPayload,home,score}' is distinct from s->'fourthDownHomeScore' or
         s#>'{predictionPayload,awayWinProbability}' is distinct from s->'fourthDownAwayWinProbability' or
         s#>'{predictionPayload,homeWinProbability}' is distinct from s->'fourthDownHomeWinProbability' or
         jsonb_typeof(s#>'{predictionPayload,continuousMargin}') is distinct from 'number' or
         abs((s#>>'{predictionPayload,continuousMargin}')::numeric) > 1.7976931348623157e308 or
         jsonb_typeof(s#>'{bestBets,assessed}') is distinct from 'number' or
         (s#>>'{bestBets,assessed}')::numeric <= 0 or
         jsonb_typeof(s#>'{bestBets,candidates}') is distinct from 'array' or
         jsonb_typeof(s#>'{bestBets,recommendations}') is distinct from 'array' or
         jsonb_typeof(s#>'{bestBets,anytimeTdModelPick}') is distinct from 'object' or
         jsonb_typeof(s#>'{bestBets,anytimeTdModelPick,modelProbability}') is distinct from 'number' or
         (s#>>'{bestBets,anytimeTdModelPick,modelProbability}')::numeric not between 0 and 1 or
         coalesce(s#>>'{bestBets,anytimeTdModelPick,playerId}','') = '' or
         jsonb_typeof(s#>'{playerProjections,away,players}') is distinct from 'array' or
         jsonb_typeof(s#>'{playerProjections,home,players}') is distinct from 'array' or
         jsonb_array_length(s#>'{playerProjections,away,players}') < 1 or
         jsonb_array_length(s#>'{playerProjections,home,players}') < 1 or
         s#>'{dataQuality,bestBetsPayload}' is distinct from s->'bestBets' or
         s#>'{dataQuality,predictionPayload}' is distinct from s->'predictionPayload' or
         (s#>>'{predictionPayload,total}')::numeric is distinct from
           (s->>'fourthDownAwayScore')::numeric + (s->>'fourthDownHomeScore')::numeric then
        raise exception 'invalid';
      end if;
      if s->>'personnelVersion' is distinct from '1' or
         s#>>'{predictionPayload,matchupIntelligence,schemaVersion}' is distinct from '2' or
         s->>'opponentNetworkStatus' is distinct from 'available' or
         s#>>'{predictionPayload,modelLayers,opponentNetwork,available}' is distinct from 'true' or
         s#>>'{dataQuality,sources,opponentNetwork,available}' is distinct from 'true' then raise exception 'invalid'; end if;
      for bet in
        select value from jsonb_array_elements(s#>'{bestBets,candidates}')
        union all
        select value from jsonb_array_elements(s#>'{bestBets,recommendations}')
      loop
        if jsonb_typeof(bet) is distinct from 'object' or
           coalesce(bet->>'market','') = '' or coalesce(bet->>'selection','') = '' or
           coalesce(bet->>'sportsbook','') = '' then raise exception 'invalid'; end if;
        foreach key in array array['modelProbability','marketProbability','edge','expectedValue','price','decimalOdds'] loop
          if jsonb_typeof(bet->key) is distinct from 'number' then raise exception 'invalid'; end if;
        end loop;
        if (bet->>'modelProbability')::numeric not between 0 and 1 or
           (bet->>'marketProbability')::numeric not between 0 and 1 or
           (bet->>'decimalOdds')::numeric <= 1 or abs((bet->>'price')::numeric) < 100 or
           (bet ? 'line' and bet->'line' <> 'null'::jsonb and jsonb_typeof(bet->'line') <> 'number') then
          raise exception 'invalid';
        end if;
      end loop;
      foreach key in array array['away','home'] loop
        if s#>'{personnelViews}'->key->>'version' is distinct from '1' or
           s#>'{personnelViews}'->key->>'team' is distinct from m->>key or
           s#>'{personnelViews}'->key->>'season' is distinct from '2026' or
           s#>'{personnelViews}'->key->>'week' is distinct from '8' or
           s#>'{personnelViews}'->key->'cutoff' is distinct from s#>'{dataQuality,personnelTiming,cutoff}' then
          raise exception 'invalid';
        end if;
      end loop;
      foreach key in array array['espn','nflverse','opponentNetwork','personnel'] loop
        if jsonb_typeof(s#>'{predictionPayload,inputEvidence}'->key) is distinct from 'object' then
          raise exception 'invalid';
        end if;
      end loop;
      r := jsonb_populate_record(null::public.prediction_snapshots, item);
      if r.season is distinct from 2026 or r.week is distinct from 8 or
         r.game_key is distinct from '2026:8:' || (m->>'away') || ':' || (m->>'home') or
         r.game_key is distinct from s->>'gameKey' or
         r.away_code is distinct from m->>'away' or r.home_code is distinct from m->>'home' or
         r.kickoff is distinct from (m->>'kickoff')::timestamptz or
         r.fourth_down_pick is distinct from s->>'fourthDownPick' or
         to_jsonb(r.predicted_away_score) is distinct from s->'fourthDownAwayScore' or
         to_jsonb(r.predicted_home_score) is distinct from s->'fourthDownHomeScore' or
         to_jsonb(r.away_win_probability) is distinct from s->'fourthDownAwayWinProbability' or
         to_jsonb(r.home_win_probability) is distinct from s->'fourthDownHomeWinProbability' or
         to_jsonb(r.confidence_score) is distinct from s->'confidenceScore' or
         r.model_version is distinct from '12' or
         r.data_quality->'quality' is distinct from s->'dataQuality' or
         r.frozen_at is not null or r.actual_winner is not null or r.graded_at is not null or
         r.actual_away_score is not null or r.actual_home_score is not null or
         r.fourth_down_correct is not null or r.market_correct is not null then
        raise exception 'invalid';
      end if;
    end loop;
    failure := 'SCOPE_BUSY';
    if not pg_try_advisory_xact_lock(hashtextextended('prediction-week:2026:8', 0)) then raise exception 'busy'; end if;
    -- Single-row writers do not take the advisory lock. This short table lock
    -- also fences their writes and inserts while the expected state is checked.
    lock table public.prediction_snapshots in share row exclusive mode nowait;
    before_state := public.prediction_week_state();
    failure := 'STALE_STATE';
    if before_state->>'fingerprint' is distinct from p->>'expectedFingerprint' or
       before_state->>'count' is distinct from '14' then raise exception 'stale'; end if;
    if exists (select 1 from public.prediction_snapshots where season = 2026 and week = 8
        and (frozen_at is not null or actual_winner is not null or graded_at is not null or
          actual_away_score is not null or actual_home_score is not null or
          fourth_down_correct is not null or market_correct is not null)) then raise exception 'stale'; end if;
    if exists (select 1 from jsonb_array_elements(p->'manifest') expected(value) where not exists (
      select 1 from public.prediction_snapshots t where t.season = 2026 and t.week = 8
        and t.away_code = expected.value->>'away' and t.home_code = expected.value->>'home'
        and t.kickoff = (expected.value->>'kickoff')::timestamptz
        and t.data_quality#>>'{snapshot,game,id}' = expected.value->>'id'
    )) then raise exception 'stale'; end if;
    failure := 'WRITE_FAILED';
    for item in select value from jsonb_array_elements(p->'rows') loop
      r := jsonb_populate_record(null::public.prediction_snapshots, item);
      insert into public.prediction_snapshots (
        season,week,game_key,kickoff,away_code,home_code,fourth_down_pick,
        predicted_away_score,predicted_home_score,away_win_probability,home_win_probability,
        market_pick,market_away_score,market_home_score,market_total,market_spread,
        confidence_score,confidence_label,model_version,data_quality,active_layers
      ) values (
        2026,8,r.game_key,r.kickoff,r.away_code,r.home_code,r.fourth_down_pick,
        r.predicted_away_score,r.predicted_home_score,r.away_win_probability,r.home_win_probability,
        r.market_pick,r.market_away_score,r.market_home_score,r.market_total,r.market_spread,
        r.confidence_score,r.confidence_label,r.model_version,r.data_quality,r.active_layers
      ) on conflict (season,week,away_code,home_code) do update set
        game_key = excluded.game_key, kickoff = excluded.kickoff, fourth_down_pick = excluded.fourth_down_pick,
        predicted_away_score = excluded.predicted_away_score, predicted_home_score = excluded.predicted_home_score,
        away_win_probability = excluded.away_win_probability, home_win_probability = excluded.home_win_probability,
        market_pick = excluded.market_pick, market_away_score = excluded.market_away_score,
        market_home_score = excluded.market_home_score, market_total = excluded.market_total,
        market_spread = excluded.market_spread, confidence_score = excluded.confidence_score,
        confidence_label = excluded.confidence_label, model_version = excluded.model_version,
        data_quality = excluded.data_quality, active_layers = excluded.active_layers, updated_at = clock_timestamp();
      get diagnostics changed = row_count;
      if changed <> 1 then raise exception 'write'; end if;
      written := written + changed;
    end loop;
    failure := 'FINAL_VERIFICATION_FAILED';
    after_state := public.prediction_week_state();
    select md5(jsonb_agg(e->'data_quality' order by e#>>'{data_quality,snapshot,game,id}')::text)
      into expected_payload from jsonb_array_elements(p->'rows') e;
    select md5(jsonb_agg(t.data_quality order by t.data_quality#>>'{snapshot,game,id}')::text)
      into actual_payload from public.prediction_snapshots t where season = 2026 and week = 8;
    if after_state->>'count' is distinct from '14' or
       actual_payload is distinct from expected_payload or
       (select count(distinct data_quality#>>'{snapshot,game,id}') from public.prediction_snapshots
        where season = 2026 and week = 8 and data_quality#>>'{snapshot,authoritative}' = 'true'
          and data_quality#>>'{snapshot,batchProvenance,operationId}' = op::text) <> 14 or
       exists (
         select 1 from jsonb_populate_recordset(null::public.prediction_snapshots, p->'rows') expected
         left join public.prediction_snapshots t
           on t.season = expected.season and t.week = expected.week
           and t.away_code = expected.away_code and t.home_code = expected.home_code
         where t.id is null or
           row(t.season,t.week,t.game_key,t.kickoff,t.away_code,t.home_code,t.fourth_down_pick,
             t.predicted_away_score,t.predicted_home_score,t.away_win_probability,t.home_win_probability,
             t.market_pick,t.market_away_score,t.market_home_score,t.market_total,t.market_spread,
             t.confidence_score,t.confidence_label,t.model_version,t.data_quality,t.active_layers,
             t.frozen_at,t.actual_away_score,t.actual_home_score,t.actual_winner,
             t.fourth_down_correct,t.market_correct,t.graded_at) is distinct from
           row(expected.season,expected.week,expected.game_key,expected.kickoff,expected.away_code,
             expected.home_code,expected.fourth_down_pick,expected.predicted_away_score,
             expected.predicted_home_score,expected.away_win_probability,expected.home_win_probability,
             expected.market_pick,expected.market_away_score,expected.market_home_score,expected.market_total,
             expected.market_spread,expected.confidence_score,expected.confidence_label,expected.model_version,
             expected.data_quality,expected.active_layers,expected.frozen_at,expected.actual_away_score,
             expected.actual_home_score,expected.actual_winner,expected.fourth_down_correct,
             expected.market_correct,expected.graded_at)
       ) then raise exception 'final'; end if;
  exception when others then
    -- The exception subtransaction rolls back every prediction write first.
    update public.prediction_week_replacements set result = 'rejected', failure_code = failure,
      pre_fingerprint = before_state->>'fingerprint', written_count = 0 where operation_id = op;
    return jsonb_build_object('result','rejected','operationId',op,'writtenCount',0,'failureCode',failure);
  end;
  update public.prediction_week_replacements set result = 'committed', written_count = written,
    committed_at = clock_timestamp(), pre_fingerprint = before_state->>'fingerprint',
    post_fingerprint = after_state->>'fingerprint' where operation_id = op;
  return jsonb_build_object('result','committed','operationId',op,'writtenCount',written,
    'preFingerprint',before_state->>'fingerprint','postFingerprint',after_state->>'fingerprint',
    'payloadFingerprint',actual_payload);
end $$;
