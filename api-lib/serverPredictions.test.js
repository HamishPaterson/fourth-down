import test from "node:test";
import assert from "node:assert/strict";
import { createServerPredictionGenerator, readPredictionOdds, saveAuthoritativePrediction } from "./serverPredictions.js";
import { completePrediction } from "./predictionEligibility.js";
import { createPredictionLedgerHandler, snapshotToDatabase, databaseToSnapshot } from "../api/nfl/game-stats.js";
import dataset from "../api/nfl/nflverse-team-metrics.js";
import players from "../data/nflverse-player-metrics.js";
import { playerMetricsResponse } from "./playerMetrics.js";
import { compareTeams } from "../api/nfl/play-by-play.js";
import { predictionFeatureStatus } from "../src/services/predictionFeatures.js";
import { lockFixture, PREPARED_AT, FUTURE_LOCK, lockResponse } from "./weeklyLockTestHelpers.js";
import { lockPredictionRejections } from "./weeklyLockProvenance.js";
import { CURRENT_MODEL_KEY, CURRENT_MODEL_VERSION } from "../src/services/modelIdentity.js";
import { useFixedTestClock as installFixedTestClock } from "./testClock.js";
import { createPredictionRefreshHandler } from "./predictionRefresh.js";
import { NFL_TEAMS } from "../api/nfl/opponent-network.js";
import { BEST_BETS_CANDIDATE_VERSION, selectTdModelPick } from "../src/services/bestBetsService.js";

installFixedTestClock();

function database(initial = {}) {
  const tables = { prediction_snapshots: [], odds_market_snapshots: [], ...initial };
  let version = 0;
  return { tables, from(table) {
    const filters = [];
    let operation, payload;
    const execute = async (single = false) => {
      let data = tables[table].filter((row) => filters.every((match) => match(row)));
      if (operation === "insert") {
        if (tables[table].some((row) => row.season === payload.season && row.week === payload.week &&
            row.away_code === payload.away_code && row.home_code === payload.home_code)) {
          return { data: null, error: { code: "23505" } };
        }
        data = [{ ...payload, id: `prediction-${++version}`, updated_at: `v${version}` }];
        tables[table].push(...data);
      } else if (operation === "update") {
        data = data.map((row) => Object.assign(row, payload, { updated_at: `v${++version}` }));
      }
      return { data: single ? data[0] || null : data, error: null };
    };
    return {
      select() { return this; }, eq(key, value) { filters.push((row) => row[key] === value); return this; },
      is(key, value) { filters.push((row) => (row[key] ?? null) === value); return this; },
      insert(row) { operation = "insert"; payload = row; return this; },
      update(row) { operation = "update"; payload = row; return this; },
      single() { return execute(true); }, maybeSingle() { return execute(true); },
      then(resolve, reject) { return execute().then(resolve, reject); },
    };
  } };
}

test("concurrent authoritative saves retain one shared logical prediction and pre-lock provenance", async () => {
  const db = database(), snapshot = lockFixture().predictions[0], now = new Date(PREPARED_AT);
  const rows = await Promise.all([saveAuthoritativePrediction(db, snapshot, now), saveAuthoritativePrediction(db, snapshot, now)]);
  assert.equal(rows[0].id, rows[1].id);
  assert.equal(db.tables.prediction_snapshots.length, 1);
  const saved = databaseToSnapshot(rows[0]);
  assert.equal(saved.id, snapshot.id);
  assert.deepEqual(lockPredictionRejections(saved, { season: 2026, week: 8, lockAt: FUTURE_LOCK }, now), []);
});

test("pre-lock explicit refresh may replace stale authority, but cannot upgrade authority after cutoff", async () => {
  const snapshot = lockFixture().predictions[0], now = new Date(PREPARED_AT);
  const old = { ...snapshot, generatedAt: "2026-10-26T00:00Z", lockProvenance: null };
  const db = database({ prediction_snapshots: [{ ...snapshotToDatabase(old), id: "old", updated_at: "old" }] });
  const saved = databaseToSnapshot(await saveAuthoritativePrediction(db, snapshot, now, { requireLockProvenance: true }));
  assert.equal(saved.generatedAt, PREPARED_AT);
  assert.deepEqual(lockPredictionRejections(saved, { season: 2026, week: 8, lockAt: FUTURE_LOCK }, now), []);
  await assert.rejects(saveAuthoritativePrediction(database(), snapshot, new Date(FUTURE_LOCK),
    { requireLockProvenance: true }), /AUTHORITATIVE_LOCK_PROVENANCE_REQUIRED/);
  await assert.rejects(saveAuthoritativePrediction(database(), { ...snapshot, week: 7 }, now), /Week 7.*prohibited/);
});

test("client saves cannot claim authority or replace server prediction inputs when supplying final results", async () => {
  const snapshot = lockFixture().predictions[0];
  const original = { ...snapshotToDatabase(snapshot), id: "server", updated_at: "server" };
  for (const existing of [[], [original]]) {
    const db = database({ prediction_snapshots: structuredClone(existing) });
    const res = lockResponse();
    await createPredictionLedgerHandler({ createClient: () => db })({
      method: "POST", headers: { host: "example.test", origin: "https://example.test" }, query: {},
      body: { snapshots: [{ ...snapshot, fourthDownAwayScore: 99,
        actualWinner: snapshot.awayCode, actualAwayScore: 24, actualHomeScore: 20 }] },
    }, res);
    assert.equal(res.statusCode, 200);
    const saved = databaseToSnapshot(db.tables.prediction_snapshots[0]);
    if (existing.length) {
      assert.equal(saved.fourthDownAwayScore, snapshot.fourthDownAwayScore);
      assert.deepEqual(saved.bestBets, snapshot.bestBets);
      assert.deepEqual(saved.lockProvenance, snapshot.lockProvenance);
    } else {
      assert.notEqual(saved.authoritative, true);
      assert.equal(saved.lockProvenance, undefined);
    }
  }
});

test("real saved odds readers retain market-specific stale diagnostics and never fetch providers", async () => {
  const now = new Date("2026-10-15T00:00Z");
  const rows = ["moneyline", "point_spread", "total_points"].map((market) => ({
    sport: "nfl", season: 2026, week: 6, market, status: "ok",
    fetched_at: market === "total_points" ? "2026-10-13T10:00Z" : now.toISOString(),
    rows: [{ id: market, event_id: "SEA", away_team: "Seattle Seahawks", home_team: "Denver Broncos",
      event_start_time: "2026-10-16T00:15Z", sportsbook: "Book", market_type: market,
      selection: market === "total_points" ? "Over" : "Seattle Seahawks", line: 20.5, odds_american: 100 }],
  }));
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("External provider forbidden"); };
  try {
    const payload = await readPredictionOdds(database({ odds_market_snapshots: rows }), now, { season: 2026, week: 6 });
    assert.equal(payload.cacheStatus, "unavailable");
    assert.equal(payload.markets.find((market) => market.market === "total_points").stale, true);
    assert.ok(payload.partialMarkets.includes("player_pass_yds"));
    const outcomes = payload.events[0].bookmakers[0].markets.flatMap((market) => market.outcomes);
    assert.ok(outcomes.every((outcome) => outcome.quoteSource.snapshotId?.startsWith("nfl:2026:6:")));
    await assert.rejects(readPredictionOdds(database(), now, { season: 2026, week: 6 }), /Stored odds snapshots are unavailable/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

  test("all 14 Week 10 games persist one highest-probability eligible model TD pick without TD prices", async (t) => {
    const began = performance.now(), now = new Date("2026-11-11T00:00:00Z");
    t.mock.timers.setTime(now.getTime());
    const db = database();
    const matchups = ["WSH-NYG", "NE-DET", "CAR-NO", "BUF-NYJ", "HOU-CLE", "JAX-TEN", "KC-ATL",
      "MIN-GB", "MIA-IND", "SEA-LV", "LAR-ARI", "SF-DAL", "PIT-CIN", "LAC-BAL"];
    const roster = (team, metrics) => ({ team, sourceAsOf: now.toISOString(),
      groups: { players: metrics.expectedLineup.roster.map((player) => ({
        id: `live-${player.gsisId}`, gsisId: player.gsisId, fullName: player.name, team,
        position: player.position, depthChartPosition: player.position, depthChartOrder: player.rank,
        status: "Active", injuryStatus: "Active",
      })) },
    });
    const generate = createServerPredictionGenerator({ loadInputs: ({ away: awayCode, home: homeCode }) => {
      const away = dataset.metricsByWeek[10][awayCode], home = dataset.metricsByWeek[10][homeCode];
      return {
        playByPlay: Promise.resolve({ season: 2026, week: 10, away, home, modelLayers: compareTeams(away, home, 10) }),
        opponentNetwork: Promise.resolve({ available: true,
          modelLayer: { available: true, awayPoints: .3, homePoints: -.3, confidence: .6 } }),
        playerMetrics: Promise.resolve(playerMetricsResponse(players, { season: 2026, week: 10, away: awayCode, home: homeCode })),
        awayRoster: Promise.resolve(roster(awayCode, away)), homeRoster: Promise.resolve(roster(homeCode, home)),
      };
    } });
    for (const [index, matchup] of matchups.entries()) {
      const [away, home] = matchup.split("-");
      const game = { id: String(1000 + index), season: 2026, week: 10, away, home,
        sourceDate: dataset.metricsByWeek[10][away].expectedLineup.cutoff, weather: { dome: true } };
      const event = { away_team: away, home_team: home, commence_time: game.sourceDate,
        bookmakers: ["one", "two"].map((key) => ({ key, last_update: now.toISOString(), markets: [
          { key: "h2h", outcomes: [{ name: away, price: 100 }, { name: home, price: 100 }] },
          // Keep this completeness fixture away from a legitimate no-pick tie.
          { key: "spreads", outcomes: [{ name: away, point: -7.5, price: 100 }, { name: home, point: 7.5, price: 100 }] },
          { key: "totals", outcomes: [{ name: "Over", point: 44.5, price: 100 }, { name: "Under", point: 44.5, price: 100 }] },
        ] })) };
      const snapshot = await generate(game, { events: [event] }, now);
      const pick = snapshot.bestBets.anytimeTdModelPick;
      assert.equal(snapshot.predictionPayload.externalFactors2026.active, true, matchup);
      assert.ok(Number.isFinite(snapshot.predictionPayload.externalFactors2026.totalExternalAdjustment), matchup);
      assert.ok(Math.abs(snapshot.predictionPayload.externalFactors2026.totalExternalAdjustment) <= 2, matchup);
      assert.ok(completePrediction(snapshot), matchup);
      assert.equal(snapshot.playerProjections.available, true, matchup);
      assert.equal(snapshot.bestBets.marketDiagnostics.bookmakerCount, 2, matchup);
      assert.ok(snapshot.bestBets.assessed > 0, matchup);
      assert.equal(pick.modelPickEligible, true, `${matchup}: ${pick.primaryReason}`);
      assert.ok(pick.playerName && pick.personnelId && pick.team && pick.statisticalProjection && pick.explanation && pick.risk);
      assert.equal(pick.price, null);
      const ranked = [...snapshot.playerProjections.away.players, ...snapshot.playerProjections.home.players]
        .sort((a, b) => b.anytimeTouchdownProbability - a.anytimeTouchdownProbability);
      assert.equal(pick.modelProbability, ranked[0].anytimeTouchdownProbability, matchup);
      for (const oddsEvent of [null, { ...event, bookmakers: [] },
        { ...event, bookmakers: event.bookmakers.map((book) => ({ ...book, markets: book.markets.map((market) =>
          ({ ...market, outcomes: market.outcomes.map((outcome) => ({ ...outcome, price: -900 })) })) })) }]) {
        const independent = selectTdModelPick({ game, playerProjections: snapshot.playerProjections,
          personnelViews: snapshot.personnelViews, oddsEvent, quoteAsOf: now });
        assert.equal(independent.personnelId, pick.personnelId, matchup);
        assert.equal(independent.modelProbability, pick.modelProbability, matchup);
      }
      await saveAuthoritativePrediction(db, snapshot, now);
      const saved = databaseToSnapshot(db.tables.prediction_snapshots.find((row) =>
        row.away_code === away && row.home_code === home));
      assert.deepEqual(saved.bestBets.anytimeTdModelPick, pick, matchup);
    }
    assert.equal(db.tables.prediction_snapshots.length, 14);
    t.diagnostic(`14 complete generated and persisted Week 10 fixtures: ${(performance.now() - began).toFixed(1)}ms`);
  });

test("actual shared model handoff remains complete using fixtures only and preserves named model-only TD", async () => {
  const now = new Date("2026-10-15T00:00Z");
  const game = { season: 2026, week: 6, away: "SEA", home: "DEN", sourceDate: "2026-10-16T00:15Z", weather: { dome: true } };
  const away = dataset.metricsByWeek[6].SEA, home = dataset.metricsByWeek[6].DEN;
  const roster = (team, metrics) => ({ team,
    sourceAsOf: new Date(now.getTime() - 1000).toISOString(),
    groups: { players: metrics.expectedLineup.roster.map((player) => ({
      id: `live-${player.gsisId}`, gsisId: player.gsisId, fullName: player.name, team,
      position: player.position, depthChartPosition: player.position, depthChartOrder: player.rank,
      status: "Active", injuryStatus: "Active",
    })) },
  });
  const odds = { events: [{ away_team: "SEA", home_team: "DEN", bookmakers: [{ title: "Book", last_update: now.toISOString(),
    markets: [{ key: "h2h", outcomes: [{ name: "SEA", price: 100 }, { name: "DEN", price: 100 }] }],
  }] }] };
  const generate = createServerPredictionGenerator({ loadInputs: () => ({
    playByPlay: Promise.resolve({ season: 2026, week: 6, away, home, modelLayers: compareTeams(away, home, 6) }),
    opponentNetwork: Promise.resolve({ available: true,
      modelLayer: { available: true, awayPoints: .3, homePoints: -.3, confidence: .6 } }),
    playerMetrics: Promise.resolve(playerMetricsResponse(players, { season: 2026, week: 6, away: "SEA", home: "DEN" })),
    awayRoster: Promise.resolve(roster("SEA", away)), homeRoster: Promise.resolve(roster("DEN", home)),
  }) });
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("External provider forbidden"); };
  try {
    const snapshot = await generate(game, odds, now);
    assert.ok(completePrediction(snapshot));
    assert.equal(snapshot.modelVersion, CURRENT_MODEL_VERSION);
    assert.equal(snapshot.modelKey, CURRENT_MODEL_KEY);
    assert.equal(snapshot.bestBets.anytimeTdScorer.source, "unavailable");
    assert.ok(snapshot.bestBets.anytimeTdScorer.statisticalProjection);
    assert.ok(snapshot.bestBets.anytimeTdScorer.selection);
    assert.equal(predictionFeatureStatus(snapshot).personnel, true);
    assert.equal(predictionFeatureStatus(snapshot).network, true);
    assert.deepEqual(snapshot.generationMarketDependencies, []);
    const stored = databaseToSnapshot(snapshotToDatabase(snapshot));
    assert.deepEqual(stored.predictionPayload.specialTeams, snapshot.predictionPayload.specialTeams);
  } finally { globalThis.fetch = original; }
});

test("explicit pre-lock administrative preparation saves verified provenance and complete immutable schedule only before cutoff", async () => {
  const fixture = lockFixture(), previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "fixture-prelock-secret";
  try {
    for (const [dryRun, atLock] of [[true, false], [false, false], [false, true]]) {
      const db = database({ weekly_multi_lock_plans: [] }), res = lockResponse();
      const now = new Date(atLock ? FUTURE_LOCK : PREPARED_AT);
      const context = { season: 2026, week: 8, cutoff: fixture.plan.games[0].kickoff,
        games: fixture.plan.games.map((game) => ({ ...game, season: 2026, week: 8, sourceDate: game.kickoff })) };
      await createPredictionRefreshHandler({
        batchLimit: 5,
        getNow: () => now, createClient: () => db, readSchedule: async () => [],
        resolveContext: () => context, readOdds: async () => fixture.odds,
        loadNetwork: async () => {
          assert.equal(atLock, false, "Post-cutoff preparation must not acquire model inputs");
          return { season: 2026, week: 8, games: [{ season: 2026, week: 7 }],
            ratings: Object.fromEntries(NFL_TEAMS.map((team, i) => [team, {
              offense: i / 10, defense: -i / 10, overall: i / 5, scheduleStrength: i / 20, games: 4,
            }])) };
        },
        createGenerator: () => async (game) => {
          const snapshot = structuredClone(fixture.predictions.find((row) => row.awayCode === game.away));
          snapshot.predictionPayload = { ...snapshot.predictionPayload,
            externalFactors2026: { active: true, totalExternalAdjustment: 2 },
            away: { score: 24 }, home: { score: 20 }, total: 44, continuousMargin: -4,
            awayWinProbability: .7, homeWinProbability: .3 };
          snapshot.playerProjections = { available: true, away: { players: [{ position: "QB" }] },
            home: { players: [{ position: "QB" }] } };
          snapshot.bestBets.candidateVersion = BEST_BETS_CANDIDATE_VERSION;
          snapshot.dataQuality.sources.opponentNetwork = { available: true };
          return snapshot;
        },
      })({ method: "POST", headers: { authorization: "Bearer fixture-prelock-secret" },
        body: { dryRun, prepareWeeklyLock: true } }, res);
      assert.equal(res.statusCode, atLock ? 502 : 200, JSON.stringify(res.body));
      assert.equal(db.tables.prediction_snapshots.length, dryRun || atLock ? 0 : 5);
      assert.equal(db.tables.weekly_multi_lock_plans.length, dryRun || atLock ? 0 : 1);
      if (!dryRun && !atLock) {
        for (const row of db.tables.prediction_snapshots) assert.deepEqual(
          lockPredictionRejections(databaseToSnapshot(row), { season: 2026, week: 8, lockAt: FUTURE_LOCK }, now), []);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous;
  }
});
