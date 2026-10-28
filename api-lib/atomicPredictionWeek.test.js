import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { prepareAtomicPredictionWeek, replaceAuthoritativePredictionWeek } from "./atomicPredictionWeek.js";
import { createServerPredictionGenerator, invoke } from "./serverPredictions.js";
import { buildTeamMetricsResponse } from "../api/nfl/play-by-play.js";
import { playerMetricsResponse } from "./playerMetrics.js";
import { createOpponentNetworkHandler } from "../api/nfl/opponent-network.js";
import team from "../api/nfl/nflverse-team-metrics.js";
import players from "../data/nflverse-player-metrics.js";

const migration = await readFile(new URL("../supabase/atomic_prediction_week.sql", import.meta.url), "utf8");
const pairs = ["CAR-GB", "BAL-BUF", "TEN-CIN", "ARI-DAL", "MIN-DET", "LV-NYJ", "CLE-PIT",
  "ATL-TB", "IND-JAX", "LAC-LAR", "KC-DEN", "NE-MIA", "PHI-WSH", "CHI-SEA"];
let fixture;
async function candidates() {
  if (!fixture) fixture = (async () => {
    const now = new Date();
    const kickoff = new Date(now.getTime() + 7 * 86400000).toISOString();
    const games = pairs.map((pair, index) => {
      const [away, home] = pair.split("-");
      return { id: String(1392323 + index), season: 2026, week: 8, away, home, sourceDate: kickoff };
    });
    const network = createOpponentNetworkHandler({ loadNetwork: async () => team.opponentNetworkByWeek[8] });
    const generate = createServerPredictionGenerator({ loadInputs: (query) => ({
      playByPlay: Promise.resolve(buildTeamMetricsResponse(team, query)),
      playerMetrics: Promise.resolve(playerMetricsResponse(players, query)),
      opponentNetwork: invoke(network, query),
    }) });
    const original = globalThis.fetch;
    globalThis.fetch = () => assert.fail("Atomic tests cannot call providers");
    try {
      const snapshots = [];
      for (const game of games) {
        snapshots.push(await generate({ ...game, weather: { weatherAvailable: false, fallbackActive: true } },
          { events: [{ id: `stored-${game.id}`, commence_time: kickoff,
            away_team: game.away, home_team: game.home, bookmakers: [{ key: "fixture",
              last_update: now.toISOString(), markets: [{ key: "h2h", outcomes: [
                { name: game.away, price: 100 }, { name: game.home, price: 100 },
              ] }] }] }] }, now));
      }
      return { context: { season: 2026, week: 8, games }, snapshots };
    } finally { globalThis.fetch = original; }
  })();
  return structuredClone(await fixture);
}

async function database(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    alter default privileges in schema public grant all on tables to service_role;
    create table public.prediction_snapshots (
      id uuid not null primary key default gen_random_uuid(), season integer not null, week integer not null, game_key text not null,
      kickoff timestamptz not null, away_code text not null, home_code text not null, fourth_down_pick text,
      predicted_away_score integer, predicted_home_score integer, away_win_probability numeric, home_win_probability numeric,
      market_pick text, market_away_score numeric, market_home_score numeric, market_total numeric, market_spread numeric,
      confidence_score numeric, confidence_label text, model_version text, data_quality jsonb, active_layers jsonb,
      frozen_at timestamptz, actual_away_score integer, actual_home_score integer, actual_winner text,
      fourth_down_correct boolean, market_correct boolean, graded_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique(season,week,away_code,home_code)
    );
    grant all on public.prediction_snapshots to anon, authenticated, service_role;
    alter table public.prediction_snapshots enable row level security;
    alter table public.prediction_snapshots no force row level security;
    create policy "Anyone can read official predictions" on public.prediction_snapshots
      for select to anon, authenticated using (true);
  `);
  await db.exec(migration);
  await db.exec(migration);
  const input = await candidates();
  const batch = prepareAtomicPredictionWeek({ ...input, operationId: randomUUID() });
  for (const [index, row] of batch.rows.entries()) {
    await db.query(`insert into public.prediction_snapshots
      (season,week,game_key,kickoff,away_code,home_code,data_quality)
      values (2026,8,$1,$2,$3,$4,$5::jsonb)`,
    [`old-${index}`, row.kickoff, row.away_code, row.home_code,
      JSON.stringify({ stale: true, snapshot: { game: { id: batch.manifest[index].id } } })]);
  }
  await db.exec(`insert into public.prediction_snapshots
    (season,week,game_key,kickoff,away_code,home_code,data_quality)
    values (2026,7,'protected-week7','2026-10-23T00:15:00Z','NE','CHI','{"original":[24,28],"final":[24,30]}')`);
  const dump = async () => (await db.query("select jsonb_agg(to_jsonb(t) order by id)::text as value from public.prediction_snapshots t")).rows[0].value;
  const before = await dump();
  const beforeRows = (await db.query("select id,away_code,home_code,created_at from public.prediction_snapshots where week=8 order by away_code")).rows;
  const week7Before = (await db.query("select to_jsonb(t)::text as value from public.prediction_snapshots t where week=7")).rows[0].value;
  await db.exec("set role service_role");
  const state = (await db.query("select public.prediction_week_state() as result")).rows[0].result;
  batch.expectedFingerprint = state.fingerprint;
  const run = async (value = batch) => (await db.query(
    "select public.replace_prediction_week($1::jsonb) as result", [JSON.stringify(value)])).rows[0].result;
  return { db, input, batch, dump, before, beforeRows, week7Before, run };
}

test("atomic replacement commits all 14, preserves Week 7 and records bounded success audit", async (t) => {
  const { db, batch, run, beforeRows, week7Before } = await database(t);
  const result = await run();
  assert.equal(result.result, "committed", JSON.stringify(result));
  assert.equal(result.writtenCount, 14);
  assert.notEqual(result.preFingerprint, result.postFingerprint);
  assert.match(result.payloadFingerprint, /^[0-9a-f]{32}$/);
  assert.deepEqual((await db.query("select id,away_code,home_code,created_at from public.prediction_snapshots where week=8 order by away_code")).rows, beforeRows);
  assert.equal((await db.query("select to_jsonb(t)::text as value from public.prediction_snapshots t where week=7")).rows[0].value, week7Before);
  const rows = (await db.query("select * from public.prediction_snapshots where week=8")).rows;
  assert.equal(rows.length, 14);
  assert.deepEqual(rows.map(r => r.data_quality.snapshot.game.id).sort(), batch.manifest.map(g => g.id).sort());
  assert(rows.every(r => r.data_quality.snapshot.authoritative === true));
  assert.deepEqual((await db.query("select data_quality from public.prediction_snapshots where week=7")).rows[0].data_quality,
    { original: [24, 28], final: [24, 30] });
  const audit = (await db.query("select * from public.prediction_week_replacements")).rows[0];
  assert.equal(audit.result, "committed");
  assert.equal(audit.caller_class, "service_role");
  assert.equal(audit.written_count, 14);
  assert(audit.committed_at);
});

for (const [name, mutate] of [
  ["invalid item 14", b => { b.rows[13].data_quality.snapshot.modelKey = "old"; }],
  ["duplicate schedule ID", b => { b.rows[13].data_quality.snapshot.game.id = b.manifest[0].id; }],
  ["duplicate prediction ID", b => { b.rows[13].data_quality.snapshot.id = b.rows[0].data_quality.snapshot.id; }],
  ["duplicate matchup", b => { b.manifest[13].away = b.manifest[0].away; b.manifest[13].home = b.manifest[0].home; }],
  ["missing game", b => { b.rows.pop(); }],
  ["unexpected extra game", b => { b.rows.push(structuredClone(b.rows[0])); }],
  ["wrong season", b => { b.season = 2027; }],
  ["wrong week", b => { b.rows[13].week = 7; }],
  ["non-finite required value", b => { b.rows[13].data_quality.snapshot.confidenceScore = "NaN"; }],
  ["malformed betting payload", b => { b.rows[13].data_quality.snapshot.bestBets.candidates = null; }],
  ["wrong canonical kickoff", b => { b.manifest[13].kickoff = "2099-01-01T00:00:00Z"; }],
  ["missing provenance", b => { delete b.rows[13].data_quality.snapshot.predictionPayload.inputEvidence; }],
  ["fractional integer score", b => { b.rows[13].predicted_away_score = 20.5; }],
  ["missing TD probability", b => { delete b.rows[13].data_quality.snapshot.bestBets.anytimeTdModelPick.modelProbability; }],
  ["empty prediction ID", b => { b.rows[13].data_quality.snapshot.id = ""; }],
  ["non-finite betting probability", b => {
    const s = b.rows[13].data_quality.snapshot;
    s.bestBets.candidates.push({ market: "Moneyline", selection: "CHI", sportsbook: "fixture",
      modelProbability: "Infinity", marketProbability: .5, edge: .1, expectedValue: .2, price: 100, decimalOdds: 2 });
    s.dataQuality.bestBetsPayload = structuredClone(s.bestBets);
    b.rows[13].data_quality.quality = structuredClone(s.dataQuality);
  }],
  ["missing betting edge", b => {
    const s = b.rows[13].data_quality.snapshot;
    s.bestBets.candidates.push({ market: "Moneyline", selection: "CHI", sportsbook: "fixture",
      modelProbability: .6, marketProbability: .5, expectedValue: .2, price: 100, decimalOdds: 2 });
    s.dataQuality.bestBetsPayload = structuredClone(s.bestBets);
    b.rows[13].data_quality.quality = structuredClone(s.dataQuality);
  }],
  ["unexpected canonical manifest", b => {
    b.manifest[13].id = "9999999";
    b.rows[13].data_quality.snapshot.game.id = "9999999";
  }],
  ["stale expected fingerprint", b => { b.expectedFingerprint = "0".repeat(32); }],
]) {
  test(`atomic rejection: ${name} changes zero rows and records safe failure`, async (t) => {
    const { db, batch, run, dump, before } = await database(t);
    mutate(batch);
    const result = await run();
    assert.equal(result.result, "rejected");
    assert.equal(result.writtenCount, 0);
    assert.equal(await dump(), before);
    const audit = (await db.query("select * from public.prediction_week_replacements")).rows[0];
    assert.equal(audit.result, "rejected");
    assert.equal(audit.written_count, 0);
    assert.equal(audit.failure_code, name.startsWith("stale") || name === "unexpected canonical manifest" ? "STALE_STATE" : "BATCH_INVALID");
  });
}

for (const finalFailure of [false, true]) {
  test(`rollback after ${finalFailure ? "final verification failure" : "simulated item 8 write failure"}`, async (t) => {
    const { db, run, dump, before } = await database(t);
    await db.exec("reset role");
    await db.exec(`create function fixture_failure() returns trigger language plpgsql as $$
      begin
        if new.away_code = 'ATL' then
          ${finalFailure ? "new.data_quality := '{}'::jsonb;" : "raise exception 'private database error';"}
        end if;
        return new;
      end $$;
      create trigger fixture_failure before update on public.prediction_snapshots
      for each row execute function fixture_failure(); set role service_role;`);
    const result = await run();
    assert.equal(result.failureCode, finalFailure ? "FINAL_VERIFICATION_FAILED" : "WRITE_FAILED");
    assert.equal(await dump(), before);
    assert(!JSON.stringify(result).includes("private database error"));
  });
}

test("serialized competing replacements cannot overwrite the first committed version", async (t) => {
  const { run, batch } = await database(t);
  const second = structuredClone(batch);
  second.operationId = randomUUID();
  second.rows.forEach(row => { row.data_quality.snapshot.batchProvenance.operationId = second.operationId; });
  const results = await Promise.all([run(), run(second)]);
  assert.deepEqual(results.map(r => r.result), ["committed", "rejected"]);
  assert.equal(results[1].failureCode, "STALE_STATE");
  assert.match(migration, /pg_try_advisory_xact_lock/);
  assert.match(migration, /share row exclusive mode nowait/i);
});

test("final count mismatch rolls back every update and the unexpected inserted row", async (t) => {
  const { db, run, dump, before } = await database(t);
  await db.exec(`reset role;
    create function fixture_extra() returns trigger language plpgsql as $$
    begin
      if new.away_code = 'CAR' then
        insert into public.prediction_snapshots (season,week,game_key,kickoff,away_code,home_code)
          values (2026,8,'unexpected',new.kickoff,'HOU','SF');
      end if;
      return new;
    end $$;
    create trigger fixture_extra after update on public.prediction_snapshots
      for each row execute function fixture_extra(); set role service_role;`);
  assert.equal((await run()).failureCode, "FINAL_VERIFICATION_FAILED");
  assert.equal(await dump(), before);
});

test("malformed JSON cannot enter the operation and changes nothing", async (t) => {
  const { db, dump, before } = await database(t);
  await assert.rejects(db.query("select public.replace_prediction_week($1::jsonb)", ['{"rows": [NaN]}']), /json/i);
  assert.equal(await dump(), before);
});

test("browser roles lack RPC and audit privileges; service role has only required access", async (t) => {
  const { db, batch } = await database(t);
  await db.exec("reset role");
  assert.deepEqual((await db.query(`select a.privilege_type
    from pg_class c cross join lateral aclexplode(c.relacl) a
    where c.oid='public.prediction_week_replacements'::regclass
      and a.grantee=(select oid from pg_roles where rolname='service_role')
    order by a.privilege_type`)).rows.map(r => r.privilege_type), ["INSERT", "SELECT", "UPDATE"]);
  for (const role of ["anon", "authenticated"]) {
    const rights = (await db.query(`select
      has_function_privilege($1,'public.replace_prediction_week(jsonb)','execute') as rpc,
      has_function_privilege($1,'public.prediction_week_state()','execute') as state,
      has_table_privilege($1,'public.prediction_week_replacements','insert') as audit`, [role])).rows[0];
    assert.deepEqual(rights, { rpc: false, state: false, audit: false });
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query("select public.replace_prediction_week($1::jsonb)", [JSON.stringify(batch)]), /permission denied/);
    assert.equal((await db.query("select count(*)::integer as count from public.prediction_snapshots")).rows[0].count, 15);
    assert.equal((await db.query("update public.prediction_snapshots set model_version='untrusted' where week=8 returning id")).rows.length, 0);
    assert.equal((await db.query("delete from public.prediction_snapshots where week=8 returning id")).rows.length, 0);
    await assert.rejects(db.query(`insert into public.prediction_snapshots
      (season,week,game_key,kickoff,away_code,home_code)
      values (2026,8,'browser','2026-11-01T18:00:00Z','HOU','SF')`), /row-level security/);
    await db.exec("reset role");
  }
  assert.equal((await db.query("select relrowsecurity from pg_class where oid='public.prediction_week_replacements'::regclass")).rows[0].relrowsecurity, true);
  assert.deepEqual((await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.prediction_snapshots'::regclass")).rows[0],
    { relrowsecurity: true, relforcerowsecurity: false });
  assert.deepEqual((await db.query("select policyname,roles,cmd,qual from pg_policies where tablename='prediction_snapshots'")).rows,
    [{ policyname: "Anyone can read official predictions", roles: ["anon", "authenticated"], cmd: "SELECT", qual: "true" }]);
  const functions = (await db.query(`select pg_get_userbyid(proowner) as owner,prosecdef,proconfig
    from pg_proc where oid in ('public.prediction_week_state()'::regprocedure,'public.replace_prediction_week(jsonb)'::regprocedure)`)).rows;
  assert(functions.every(f => f.owner === "postgres" && !f.prosecdef && f.proconfig.includes("search_path=pg_catalog")));
});

test("migration reruns unchanged and conflicting reserved objects fail without altering predictions", async (t) => {
  const { db, dump, before } = await database(t);
  await db.exec("reset role");
  await db.exec(migration);
  assert.equal(await dump(), before);
  await db.exec("comment on table public.prediction_week_replacements is 'unrelated-object'");
  await assert.rejects(db.exec(migration), /ATOMIC_MIGRATION_OBJECT_CONFLICT/);
  await db.exec("rollback");
  assert.equal(await dump(), before);
});

test("integration table exactly reproduces Production types, nullability, defaults and keys", async (t) => {
  const { db } = await database(t);
  const columns = (await db.query(`select column_name,data_type,is_nullable,column_default,is_generated,is_identity
    from information_schema.columns where table_schema='public' and table_name='prediction_snapshots'
    order by ordinal_position`)).rows;
  assert.equal(columns.length, 31);
  const required = ["id", "season", "week", "game_key", "kickoff", "away_code", "home_code", "created_at", "updated_at"];
  assert.deepEqual(columns.filter(c => c.is_nullable === "NO").map(c => c.column_name), required);
  const scores = ["predicted_away_score", "predicted_home_score", "actual_away_score", "actual_home_score"];
  assert(columns.filter(c => scores.includes(c.column_name)).every(c => c.data_type === "integer"));
  assert.deepEqual(columns.filter(c => c.column_default).map(c => [c.column_name, c.column_default]),
    [["id", "gen_random_uuid()"], ["created_at", "now()"], ["updated_at", "now()"]]);
  assert(columns.every(c => c.is_generated === "NEVER" && c.is_identity === "NO"));
  assert.deepEqual((await db.query(`select pg_get_constraintdef(oid) as definition from pg_constraint
    where conrelid='public.prediction_snapshots'::regclass and contype <> 'n' order by contype`)).rows.map(c => c.definition),
  ["PRIMARY KEY (id)", "UNIQUE (season, week, away_code, home_code)"]);
  assert.equal((await db.query("select count(*)::integer as count from pg_trigger where tgrelid='public.prediction_snapshots'::regclass")).rows[0].count, 0);
});

test("server caller validates finite unchanged outputs and sanitizes RPC errors without retries", async () => {
  const input = await candidates(), original = JSON.stringify(input);
  let calls = 0;
  const op = randomUUID();
  const batch = prepareAtomicPredictionWeek({ ...input, operationId: op });
  assert.equal(JSON.stringify(input), original);
  assert.deepEqual(batch.rows.map(r => r.data_quality.snapshot.predictionPayload),
    input.snapshots.map(s => s.predictionPayload));
  assert.deepEqual(batch.rows.map(r => r.data_quality.snapshot.bestBets), input.snapshots.map(s => s.bestBets));
  await assert.rejects(replaceAuthoritativePredictionWeek({ rpc: async () => {
    calls++; return { error: { message: "private token" } };
  } }, { ...input, operationId: op, expectedFingerprint: "a".repeat(32) }), /^Error: ATOMIC_WEEK_RPC_FAILED$/);
  assert.equal(calls, 1);
  input.snapshots[13].predictionPayload.continuousMargin = Infinity;
  assert.throws(() => prepareAtomicPredictionWeek({ ...input, operationId: op }));
});
