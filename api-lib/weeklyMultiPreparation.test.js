import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createWeeklyMultiPreparationHandler } from "./weeklyMultiPreparation.js";
import { createServerPredictionGenerator, readPredictionOdds, saveAuthoritativePrediction } from "./serverPredictions.js";
import { completePrediction, retainPrediction } from "./predictionEligibility.js";
import { snapshotToDatabase, databaseToSnapshot } from "../api/nfl/game-stats.js";
import { createWeeklyMultiCurrentHandler } from "./weeklyMulti.js";
import dataset from "../api/nfl/nflverse-team-metrics.js";
import players from "../data/nflverse-player-metrics.js";
import { playerMetricsResponse } from "./playerMetrics.js";
import { compareTeams } from "../api/nfl/play-by-play.js";
import { FULL_MODEL_VERSION, FULL_MODEL_KEY } from "../src/services/gamePredictionService.js";
import { BEST_BETS_CANDIDATE_VERSION } from "../src/services/bestBetsService.js";

const LOCK = Date.parse("2026-10-15T00:00:00Z");
const KICKOFF = "2026-10-16T00:15:00Z";
const PAIRS = [["SEA", "DEN"], ["BUF", "LV"], ["BAL", "CLE"], ["CHI", "ATL"], ["HOU", "JAX"]];
let originalSecret;
beforeEach(() => { originalSecret = process.env.CRON_SECRET; process.env.CRON_SECRET = "test-secret"; });
afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = originalSecret;
});
const response = () => ({
  statusCode: 200, body: null, setHeader() {},
  status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; },
});
const context = (week = 6, lock = LOCK) => ({
  available: true, eligible: true, season: 2026, week,
  lockAt: new Date(lock).toISOString(), retryDeadline: lock + 1800000,
  deadlineAt: new Date(lock + 1800000).toISOString(), firstKickoffAt: new Date(lock + 86400000).toISOString(),
  games: PAIRS.map(([away, home]) => ({ season: 2026, week, date: new Date(lock + 86400000).toISOString(),
    visitor_team: { abbreviation: away }, home_team: { abbreviation: home } })),
});
function fixture(game, now) {
  const recommendations = [{
    market: "Moneyline", selection: game.away, modelProbability: .7, decimalOdds: 2,
    sportsbook: "Book", updatedAt: now.toISOString(),
  }];
  return {
    season: game.season, week: game.week, kickoff: game.sourceDate, awayCode: game.away, homeCode: game.home,
    fourthDownPick: game.away, fourthDownAwayScore: 24, fourthDownHomeScore: 20,
    fourthDownAwayWinProbability: .7, fourthDownHomeWinProbability: .3, confidenceScore: .7,
    modelVersion: FULL_MODEL_VERSION, modelKey: FULL_MODEL_KEY, predictionPayload: { winner: game.away },
    playerProjections: { available: true },
    dataQuality: { sources: { odds: { available: true } } },
    generatedAt: now.toISOString(), snapshotAt: now.toISOString(),
    bestBets: { candidateVersion: BEST_BETS_CANDIDATE_VERSION, assessed: 4, recommendations, candidates: recommendations,
      anytimeTdScorer: { source: "model-only", selection: "Validated Full Player anytime TD", modelProbability: .68, roleConfidence: 1 } },
  };
}
function odds(now) {
  return { cacheStatus: "fresh", refreshedAt: now.toISOString(), events: PAIRS.map(([away, home]) => ({
    id: away, away_team: away, home_team: home,
    bookmakers: [{ key: "book", title: "Book", last_update: now.toISOString(),
      markets: [{ key: "h2h", outcomes: [{ name: away, price: 100 }, { name: home, price: 100 }] }] }],
  })) };
}
function database(initial = {}) {
  const tables = { prediction_snapshots: [], weekly_best_multis: [], odds_market_snapshots: [], ...initial };
  let version = 0;
  const writes = [];
  return {
    tables, writes,
    from(table) {
      const filters = [];
      let operation, payload;
      const execute = async (single = false) => {
        let data = tables[table].filter((row) => filters.every((match) => match(row)));
        if (operation === "insert") {
          const duplicate = tables[table].some((row) => row.season === payload.season && row.week === payload.week &&
            (table === "weekly_best_multis" || row.away_code === payload.away_code && row.home_code === payload.home_code));
          if (duplicate) return { data: null, error: { code: "23505" } };
          const row = { ...payload, id: `${table}:${++version}`, updated_at: `v${version}` };
          tables[table].push(row); writes.push(table); data = [row];
        } else if (operation === "update") {
          data = data.map((row) => {
            Object.assign(row, payload, { updated_at: `v${++version}` }); writes.push(table); return row;
          });
        }
        return { data: single ? data[0] || null : data, error: null };
      };
      return {
        select() { return this; },
        eq(key, value) { filters.push((row) => row[key] === value); return this; },
        is(key, value) { filters.push((row) => (row[key] ?? null) === value); return this; },
        lt(key, value) { filters.push((row) => row[key] < value); return this; },
        insert(row) { operation = "insert"; payload = row; return this; },
        update(row) { operation = "update"; payload = row; return this; },
        maybeSingle() { return execute(true); }, single() { return execute(true); },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
    },
  };
}
async function run({ db = database(), now = new Date(LOCK), ctx = context(), prepare = false, ...overrides } = {}) {
  const reports = [];
  const handler = createWeeklyMultiPreparationHandler({
    createClient: () => db, getNow: () => now, resolveContext: async () => ctx,
    readOdds: async () => odds(now), generatePrediction: async (game) => fixture(game, now),
    report: (status) => reports.push(status), ...overrides,
  });
  const res = response();
  await handler({ method: "GET", headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, host: "example.test" },
    query: { weeklyMultiMode: prepare ? "prepare" : "lock" } }, res);
  return { res, db, reports };
}

test("server refresh uses the current model and persists all Best Bets before exactly 10:00 AEST locking", async () => {
  const { db, res, reports } = await run();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "locked");
  assert.equal(res.body.record.lock_at, "2026-10-15T00:00:00.000Z");
  assert.equal(res.body.record.legs.length, 5);
  assert.equal(db.tables.prediction_snapshots.length, 5);
  for (const row of db.tables.prediction_snapshots) {
    const snapshot = databaseToSnapshot(row);
    assert.equal(snapshot.modelVersion, String(FULL_MODEL_VERSION));
    assert.ok(completePrediction(snapshot));
    assert.equal(snapshot.bestBets.recommendations.length, 1);
    assert.equal(snapshot.bestBets.anytimeTdScorer.source, "model-only");
  }
  assert.deepEqual(db.writes, [...Array(5).fill("prediction_snapshots"), "weekly_best_multis"]);
  assert.equal(reports.at(-1).lock, "completed");
});

test("stale model-v6 and incomplete first-writer records cannot block complete authoritative predictions", async () => {
  const now = new Date(LOCK);
  for (const modelVersion of [6, 11]) {
    const incoming = fixture({ season: 2026, week: 6, away: "SEA", home: "DEN", sourceDate: KICKOFF }, now);
    const old = { ...incoming, modelVersion, bestBets: null, generatedAt: "2026-09-30T06:52:29Z" };
    assert.equal(retainPrediction(old, incoming, now), false);
    const db = database({ prediction_snapshots: [{ ...snapshotToDatabase(old), id: "old", updated_at: "old" }] });
    const saved = databaseToSnapshot(await saveAuthoritativePrediction(db, incoming, now));
    assert.equal(saved.authoritative, true);
    assert.equal(saved.bestBets.recommendations.length, 1);
    assert.equal(db.tables.prediction_snapshots.length, 1);
    assert.equal(retainPrediction(saved, { ...incoming, bestBets: null }, now), true);
  }
});

test("concurrent server refreshes retain one shared authoritative prediction", async () => {
  const db = database(), now = new Date(LOCK);
  const snapshot = fixture({ season: 2026, week: 6, away: "SEA", home: "DEN", sourceDate: KICKOFF }, now);
  const rows = await Promise.all([saveAuthoritativePrediction(db, snapshot, now), saveAuthoritativePrediction(db, snapshot, now)]);
  assert.equal(rows[0].id, rows[1].id);
  assert.equal(db.tables.prediction_snapshots.length, 1);
});

test("a partial Matchup save cannot replace a complete server prediction or claim server ownership", () => {
  const now = new Date(LOCK), complete = fixture({ season: 2026, week: 6, away: "SEA", home: "DEN", sourceDate: KICKOFF }, now);
  assert.equal(retainPrediction({ ...complete, authoritative: true }, { ...complete, bestBets: null }, now), true);
  assert.equal(retainPrediction(complete, { ...complete, bestBets: null }, now), true);
  const source = readFileSync(new URL("../api/nfl/game-stats.js", import.meta.url), "utf8");
  assert.match(source, /delete merged.authoritative/);
  assert.match(source, /writePredictionVersion\(supabase, merged, existing\)/);
});

test("real stored-odds readers perform no SharpAPI fetch and reject missing snapshots", async () => {
  const markets = ["moneyline", "point_spread", "total_points", "player_pass_yds", "player_rush_yds", "player_receptions",
    "player_reception_yds", "player_pass_tds", "player_pass_attempts", "player_completions", "player_rush_attempts", "player_rush_reception_yds"];
  const now = new Date(LOCK);
  const rows = markets.map((market) => ({
    sport: "nfl", season: 2026, week: 6, market, status: "ok", fetched_at: now.toISOString(),
    rows: [{ id: market, event_id: "SEA", away_team: "Seattle Seahawks", home_team: "Denver Broncos",
      event_start_time: KICKOFF, sportsbook: "Book", market_type: market === "player_pass_yds" ? "player_passing_yards" : market,
      selection: market.startsWith("player") ? "Over" : "Seattle Seahawks",
      player_name: market.startsWith("player") ? "Sam Darnold" : undefined, line: 20.5, odds_american: 100 }],
  }));
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("External provider forbidden"); };
  try {
    const payload = await readPredictionOdds(database({ odds_market_snapshots: rows }), now, context());
    assert.equal(payload.cacheStatus, "fresh");
    assert.ok(payload.events[0].bookmakers[0].markets.some((market) => market.key === "player_pass_yds"));
    await assert.rejects(readPredictionOdds(database(), now, context()), /Fresh core and stored player odds/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

test("actual shared prediction service builds complete Week 6 records with model-only TD and named players", async () => {
  const game = { season: 2026, week: 6, away: "SEA", home: "DEN", sourceDate: KICKOFF, weather: { dome: true } };
  const away = dataset.metricsByWeek[6].SEA, home = dataset.metricsByWeek[6].DEN;
  const generate = createServerPredictionGenerator({ loadInputs: () => ({
    playByPlay: Promise.resolve({ season: 2026, week: 6, away, home, modelLayers: compareTeams(away, home, 6) }),
    playerMetrics: Promise.resolve(playerMetricsResponse(players, { season: 2026, week: 6, away: "SEA", home: "DEN" })),
  }) });
  const snapshot = await generate(game, odds(new Date(LOCK)), new Date(LOCK));
  assert.ok(completePrediction(snapshot));
  assert.equal(snapshot.modelVersion, FULL_MODEL_VERSION);
  assert.equal(snapshot.bestBets.anytimeTdScorer.source, "model-only");
  assert.ok(snapshot.bestBets.anytimeTdScorer.selection);
  assert.ok(snapshot.bestBets.assessed > 0);
});

test("generation failure validates the entire batch before writing and prevents lock", async () => {
  const { res, db } = await run({ generatePrediction: async (game) => {
    if (game.away === "BUF") throw new Error("Validated player input unavailable");
    return fixture(game, new Date(LOCK));
  } });
  assert.equal(res.statusCode, 503);
  assert.match(res.body.reason, /player input unavailable/);
  assert.equal(res.body.lock, "not attempted");
  assert.deepEqual(db.writes, []);
});

test("persistence failure is visible and prevents lock", async () => {
  const { res, db } = await run({ savePrediction: async () => { throw new Error("Shared persistence unavailable"); } });
  assert.equal(res.statusCode, 503);
  assert.match(res.body.reason, /persistence unavailable/);
  assert.equal(db.tables.weekly_best_multis.length, 0);
});

test("late Hobby invocation executes ordered stages, not independent racing jobs", async () => {
  const steps = [], now = new Date(LOCK + 59 * 60000);
  const { res, db } = await run({ now,
    readOdds: async () => { steps.push("odds"); return odds(now); },
    generatePrediction: async (game) => { assert.equal(steps[0], "odds"); steps.push("generate"); return fixture(game, now); },
    savePrediction: async (client, snapshot, at) => {
      assert.equal(steps.filter((step) => step === "generate").length, 5);
      steps.push("save"); return saveAuthoritativePrediction(client, snapshot, at);
    },
  });
  assert.equal(res.body.status, "generated late");
  assert.equal(res.body.record.lock_at, new Date(LOCK).toISOString());
  assert.equal(db.writes.at(-1), "weekly_best_multis");
});

test("pre-lock preparation saves but never locks, then a late lock reuses those exact authoritative candidates", async () => {
  const db = database();
  const prepared = await run({ db, now: new Date(LOCK - 60000), ctx: { ...context(), eligible: false }, prepare: true });
  assert.equal(prepared.res.body.refresh, "completed");
  assert.equal(db.tables.weekly_best_multis.length, 0);
  const savedBefore = structuredClone(db.tables.prediction_snapshots);
  const locked = await run({ db, now: new Date(LOCK + 60000),
    generatePrediction: async () => assert.fail("Prepared authoritative predictions must be reused") });
  assert.equal(locked.res.body.status, "locked");
  assert.deepEqual(db.tables.prediction_snapshots, savedBefore);
});

test("two clients read the exact shared Multi without browser generation; existing lock skips refresh", async () => {
  const { db, res } = await run();
  const again = await run({ db, generatePrediction: async () => assert.fail("immutable lock must not regenerate") });
  assert.equal(again.res.body.status, "already locked");
  for (let client = 0; client < 2; client++) {
    const output = response();
    await createWeeklyMultiCurrentHandler({ createClient: () => db, getNow: () => new Date(LOCK + 60000) })({ method: "GET" }, output);
    assert.deepEqual(output.body.record, res.body.record);
  }
});

test("no qualifying candidates yields an honest empty partial at the deadline, never fabricated legs", async () => {
  const now = new Date(LOCK + 31 * 60000);
  const { res } = await run({ now, generatePrediction: async (game) => {
    const snapshot = fixture(game, now);
    snapshot.bestBets.recommendations = [];
    snapshot.bestBets.candidates = [];
    snapshot.bestBets.anytimeTdScorer = null;
    return snapshot;
  } });
  assert.equal(res.body.record.legs.length, 0);
  assert.equal(res.body.record.partial, true);
  assert.match(res.body.record.reason, /Fewer than five eligible legs/);
});

test("a model-only TD remains eligible alongside priced Best Bets after shared persistence", async () => {
  const { res } = await run({ generatePrediction: async (game) => {
    const snapshot = fixture(game, new Date(LOCK));
    if (game.away === "SEA") {
      snapshot.bestBets.recommendations = [];
      snapshot.bestBets.candidates = [];
    }
    return snapshot;
  } });
  assert.equal(res.body.record.legs.length, 5);
  assert.ok(res.body.record.legs.some((leg) => leg.modelOnly && leg.selection === "Validated Full Player anytime TD"));
});

test("next week does not reuse last week's lock and post-kickoff recovery is prohibited", async () => {
  const { db } = await run();
  const next = LOCK + 7 * 86400000;
  const output = await run({ db, now: new Date(next), ctx: context(7, next) });
  assert.equal(output.res.body.record.week, 7);
  assert.equal(db.tables.weekly_best_multis.length, 2);
  const missed = await run({ now: new Date(LOCK + 25 * 3600000) });
  assert.match(missed.res.body.reason, /kickoff has passed|Outside/);
  assert.deepEqual(missed.db.writes, []);
});

test("Hobby-compatible cron uses full-hour jobs and all lock invocations include preparation", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.ok(config.crons.some((job) => job.path === "/api/weekly-multi/prepare" && job.schedule === "0 23 * * *"));
  assert.deepEqual(config.crons.filter((job) => job.path === "/api/weekly-multi/lock").map((job) => job.schedule), ["0 0 * * *", "0 1 * * *"]);
  assert.equal(config.functions["api/nfl/schedule.js"].maxDuration, 60);
  const source = readFileSync(new URL("../api/nfl/schedule.js", import.meta.url), "utf8");
  assert.match(source, /createWeeklyMultiPreparationHandler\(\)\(req, res\)/);
});

test("dry run validates all predictions and selection without any shared writes", async () => {
  const db = database(), now = new Date(LOCK), res = response();
  await createWeeklyMultiPreparationHandler({
    createClient: () => db, getNow: () => now, resolveContext: async () => context(),
    readOdds: async () => odds(now), generatePrediction: async (game) => fixture(game, now), report() {},
  })({ method: "GET", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    query: { weeklyMultiMode: "lock", dryRun: "1" } }, res);
  assert.equal(res.body.dryRun, true);
  assert.equal(res.body.legCount, 5);
  assert.deepEqual(db.writes, []);
});

test("unauthorized orchestration cannot read inputs or mutate shared data", async () => {
  const res = response();
  await createWeeklyMultiPreparationHandler({
    createClient: () => assert.fail("No unauthorized database access"),
    resolveContext: () => assert.fail("No unauthorized provider access"),
  })({ method: "GET", headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 401);
});

test("stale generated predictions fail before persistence even if model version matches", async () => {
  const { res, db } = await run({ generatePrediction: async (game) => ({
    ...fixture(game, new Date(LOCK)), generatedAt: "2026-09-30T06:52:29Z",
  }) });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(db.writes, []);
});

test("outdated production Multi schema stops before regeneration and gives the migration prerequisite", async () => {
  const db = database();
  const original = db.from;
  db.from = (table) => table === "weekly_best_multis" ? {
    select() { return this; }, eq() { return this; },
    async maybeSingle() { return { data: null, error: { code: "42703" } }; },
  } : original(table);
  const { res } = await run({ db, generatePrediction: async () => assert.fail("Do not regenerate before migration") });
  assert.equal(res.statusCode, 503);
  assert.match(res.body.reason, /schema is outdated; apply supabase\/weekly_best_multis.sql/);
  assert.deepEqual(db.writes, []);
  const sql = readFileSync(new URL("../supabase/weekly_best_multis.sql", import.meta.url), "utf8");
  for (const column of ["generated_late", "partial", "model_probability_threshold", "odds_late", "odds_cache_status"]) {
    assert.ok(sql.includes(`add column if not exists ${column}`));
  }
  assert.doesNotMatch(sql, /delete from|truncate|update public.weekly_best_multis/i);
  assert.match(sql, /notify pgrst, 'reload schema'/);
});
