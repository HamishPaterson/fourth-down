import process from "node:process";
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createPredictionRefreshHandler, predictionRefreshContext, validatePredictionRefreshBatch } from "./predictionRefresh.js";
import { validateWeeklyOpponentNetwork, loadWeeklyOpponentNetwork, NFL_TEAMS, createOpponentNetworkHandler } from "../api/nfl/opponent-network.js";
import { completePrediction, personnelSignature, retainPrediction } from "./predictionEligibility.js";
import { predictionFeatureStatus, PREDICTION_FEATURE_VERSION, MATCHUP_INTELLIGENCE_SCHEMA_VERSION } from "../src/services/predictionFeatures.js";
import { applyPredictionSnapshot } from "../src/services/predictionSnapshot.js";
import gameStats, { snapshotToDatabase, databaseToSnapshot } from "../api/nfl/game-stats.js";
import { FULL_MODEL_VERSION, FULL_MODEL_KEY } from "../src/services/gamePredictionService.js";
import { BEST_BETS_CANDIDATE_VERSION } from "../src/services/bestBetsService.js";
import { createServerPredictionInputLoader } from "./serverPredictions.js";
import { PERSONNEL_VIEW_VERSION } from "./personnelView.js";

const NOW = new Date("2026-10-15T05:00:00Z"), KICKOFF = "2026-10-18T17:00:00Z";
const games = Array.from({ length: 14 }, (_, i) => ({
  season: 2026, week: 6, away: NFL_TEAMS[2 * i], home: NFL_TEAMS[2 * i + 1], sourceDate: KICKOFF,
}));
const context = { season: 2026, week: 6, cutoff: KICKOFF, games };
const network = { season: 2026, week: 6, games: [{ season: 2026, week: 5 }],
  ratings: Object.fromEntries(NFL_TEAMS.map((team, i) => [team, {
    offense: i / 10, defense: -i / 10, overall: i / 5, scheduleStrength: i / 20, games: 4,
  }])) };
const response = () => ({ statusCode: 200, calls: 0, setHeader() {},
  status(n) { this.statusCode = n; return this; }, json(b) { this.calls++; this.body = b; return this; } });
function fixture(game, now = NOW) {
  const personnelView = (team) => ({
    version: PERSONNEL_VIEW_VERSION, team, season: game.season, week: game.week,
    cutoff: KICKOFF, chart: { available: true, observedAt: "2026-10-14T00:00:00Z" },
    live: { available: false, observedAt: null }, players: [],
    quarterback: { resolved: true, conflict: false }, units: {
      front: { available: false }, LB: { available: false }, DB: { available: false },
    },
  });
  const signals = ["rushMatchup", "passMatchup", "successMatchup", "explosiveMatchup", "pressureMatchup",
    "thirdDownMatchup", "redZoneMatchup"].map((layer) => ({
    layer, available: true, matchups: { away: { confidence: .6 }, home: { confidence: .6 } },
  }));
  const situational = { available: true, signals: [
    { key: "thirdDown", available: true }, { key: "redZone", available: true },
  ] };
  const candidates = [{ market: "Moneyline", selection: game.away, modelProbability: .65, decimalOdds: 2 }];
  return {
    season: game.season, week: game.week, kickoff: game.sourceDate, awayCode: game.away, homeCode: game.home,
    fourthDownPick: game.away, fourthDownAwayScore: 24, fourthDownHomeScore: 20,
    fourthDownAwayWinProbability: .65, fourthDownHomeWinProbability: .35, confidenceScore: .7,
    modelVersion: FULL_MODEL_VERSION, modelKey: FULL_MODEL_KEY,
    predictionFeatureVersion: PREDICTION_FEATURE_VERSION, opponentNetworkStatus: "available",
    personnelVersion: PERSONNEL_VIEW_VERSION,
    personnelViews: { away: personnelView(game.away), home: personnelView(game.home) },
    predictionPayload: { winner: game.away, away: { score: 24 }, home: { score: 20 }, total: 44, continuousMargin: -4,
      awayWinProbability: .65, homeWinProbability: .35,
      modelLayers: { opponentNetwork: { available: true, homePoints: -.5, awayPoints: .5, confidence: .6 } },
      matchupIntelligence: { schemaVersion: MATCHUP_INTELLIGENCE_SCHEMA_VERSION, signals, situational } },
    playerProjections: { available: true, away: { players: [{ position: "QB" }] }, home: { players: [{ position: "QB" }] } },
    dataQuality: {
      personnelTiming: { cutoff: KICKOFF },
      sources: { odds: { available: true }, opponentNetwork: { available: true } },
    },
    bestBets: { candidateVersion: BEST_BETS_CANDIDATE_VERSION, candidates, recommendations: candidates, assessed: 1 },
    generatedAt: now.toISOString(), snapshotAt: now.toISOString(),
  };
}
function database(snapshots = []) {
  const rows = snapshots.map((s, i) => ({ ...snapshotToDatabase(s), id: `p${i}`, updated_at: `v${i}` }));
  const writes = [], reads = [], locked = JSON.stringify({
    id: "bb998fce-9992-423a-8581-e14ce4e2a8b7", status: "locked", odds: 3.4,
    legs: [
      { playerId: "locked-player", market: "Moneyline", selection: "HOU", decimalOdds: 1.8 },
      { playerId: "locked-player-2", market: "Receiving yards", selection: "Over 45.5", decimalOdds: 1.9 },
    ],
  });
  let version = 100;
  return { rows, writes, reads, locked, from(table) {
    reads.push(table);
    assert.equal(table, "prediction_snapshots", "Prediction refresh must never query or write Weekly Multi or provider odds");
    const filters = []; let operation, payload;
    const execute = async (single = false) => {
      let selected = rows.filter((row) => filters.every((f) => f(row)));
      if (operation === "insert") {
        selected = [{ ...payload, id: `new${version++}`, updated_at: `v${version}` }];
        rows.push(...selected); writes.push(table);
      } else if (operation === "update") {
        selected.forEach((row) => Object.assign(row, payload, { updated_at: `v${version++}` }));
        writes.push(...selected.map(() => table));
      }
      return { data: single ? selected[0] || null : selected, error: null };
    };
    return { select() { return this; }, eq(k, v) { filters.push((r) => r[k] === v); return this; },
      is(k, v) { filters.push((r) => (r[k] ?? null) === v); return this; },
      insert(row) { operation = "insert"; payload = row; return this; },
      update(row) { operation = "update"; payload = row; return this; },
      maybeSingle() { return execute(true); }, single() { return execute(true); },
      then(resolve, reject) { return execute().then(resolve, reject); } };
  } };
}
let secret, key;
beforeEach(() => {
  secret = process.env.CRON_SECRET; key = process.env.BALLDONTLIE_API_KEY;
  process.env.CRON_SECRET = "mock-refresh-secret"; process.env.BALLDONTLIE_API_KEY = "mock-provider-secret";
});
afterEach(() => {
  if (secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret;
  if (key === undefined) delete process.env.BALLDONTLIE_API_KEY; else process.env.BALLDONTLIE_API_KEY = key;
});
async function run({ db = database(), dryRun = true, method = "POST", authorization = "Bearer mock-refresh-secret",
  build = fixture, ...overrides } = {}) {
  let loads = 0, generators = 0, generated = 0;
  const dependencies = {
    getNow: () => NOW, createClient: () => db, readSchedule: async () => [],
    resolveContext: () => context, readOdds: async () => ({ stored: true }),
    loadNetwork: async () => { loads++; return structuredClone(network); },
    createGenerator: ({ weeklyNetwork }) => {
      generators++; assert.equal(weeklyNetwork.week, 6);
      return async (game) => { generated++; return build(game, NOW); };
    }, ...overrides,
  };
  const handler = createPredictionRefreshHandler(dependencies);
  const res = response();
  await handler({ method, headers: { authorization }, body: { dryRun } }, res);
  return { db, res, loads, generators, generated };
}

test("protected refresh authenticates before any input, rejects wrong method and defaults GET to no writes", async () => {
  const bad = await run({ authorization: "Bearer incorrect", readSchedule: () => assert.fail("unauthorized read") });
  assert.equal(bad.res.statusCode, 401);
  assert.equal((await run({ method: "DELETE" })).res.statusCode, 405);
  const get = await run({ method: "GET", dryRun: false });
  assert.equal(get.res.body.dryRun, true); assert.deepEqual(get.db.writes, []);
});
test("one validated network is reused across 14 games; dry run writes nothing and keeps locked Multi unchanged", async () => {
  const { res, db, loads, generators, generated } = await run();
  const lockedBefore = db.locked;
  assert.equal(res.statusCode, 200, res.body.reason);
  assert.equal(res.calls, 1); assert.equal(loads, 1); assert.equal(generators, 1); assert.equal(generated, 14);
  assert.equal(res.body.predictions.length, 14);
  assert.ok(res.body.predictions.every((p) => p.network && p.phase1 && p.phase2a && p.thirdDown && p.redZone && p.complete));
  assert.deepEqual(db.writes, []);
  assert.ok(db.locked.includes("bb998fce"));
  assert.equal(db.locked, lockedBefore);
});
test("all 14 predictions validated before first write; successful refresh only writes prediction_snapshots", async () => {
  let built = 0;
  const result = await run({ dryRun: false, build: (game) => { built++; return fixture(game); },
    savePrediction: async (client, snapshot) => {
      assert.equal(built, 14);
      const { saveAuthoritativePrediction } = await import("./serverPredictions.js");
      return saveAuthoritativePrediction(client, snapshot, NOW);
    } });
  assert.equal(result.res.statusCode, 200, result.res.body.reason);
  assert.equal(result.db.writes.length, 14);
  assert.deepEqual(new Set(result.db.writes), new Set(["prediction_snapshots"]));
  assert.ok(result.db.rows.map(databaseToSnapshot).every((s) => predictionFeatureStatus(s).complete));
});
for (const missing of ["thirdDown", "redZone", "network", "phase1", "candidate", "nonfinite", "margin", "total", "probability", "players"]) {
  test(`failed ${missing} batch performs zero prediction/Multi writes and returns one error`, async () => {
    const result = await run({ dryRun: false, build(game) {
      const s = fixture(game);
      if (game !== games[13]) return s;
      if (missing === "thirdDown" || missing === "redZone") {
        s.predictionPayload.matchupIntelligence.signals = s.predictionPayload.matchupIntelligence.signals
          .filter((signal) => signal.layer !== `${missing}Matchup`);
      }
      if (missing === "network") s.opponentNetworkStatus = "unavailable";
      if (missing === "phase1") s.predictionPayload.matchupIntelligence.signals.shift();
      if (missing === "candidate") delete s.bestBets.candidates;
      if (missing === "nonfinite") s.predictionPayload.continuousMargin = Infinity;
      if (missing === "margin") delete s.predictionPayload.continuousMargin;
      if (missing === "total") s.predictionPayload.total++;
      if (missing === "probability") s.fourthDownAwayWinProbability = .99;
      if (missing === "players") s.playerProjections.home.players = [];
      return s;
    } });
    assert.equal(result.res.statusCode, 502); assert.equal(result.res.calls, 1);
    assert.deepEqual(result.db.writes, []);
  });
}
test("Phase2A-missing v11 records upgrade, complete current schema is reused irrespective of age", async () => {
  assert.equal(predictionFeatureStatus(fixture(games[0])).complete, true,
    JSON.stringify(predictionFeatureStatus(fixture(games[0]))));
  assert.doesNotThrow(() => validatePredictionRefreshBatch(games.map((game) => fixture(game)), context, NOW));
  const old = games.map((g) => ({ ...fixture(g), authoritative: true, predictionFeatureVersion: undefined }));
  const updated = await run({ db: database(old), dryRun: false });
  assert.equal(updated.res.statusCode, 200, updated.res.body.reason); assert.equal(updated.db.writes.length, 14);
  const current = games.map((g) => ({ ...fixture(g, new Date("2026-10-12T00:00Z")), authoritative: true }));
  const reused = await run({ db: database(current), dryRun: false, build: () => assert.fail("must reuse") });
  assert.equal(reused.res.statusCode, 200, reused.res.body.reason);
  assert.equal(reused.res.body.reused, 14); assert.deepEqual(reused.db.writes, []);
});
test("partial browser predictions neither block complete server refresh nor overwrite authoritative current records", async () => {
  const incoming = fixture(games[0]);
  assert.ok(completePrediction(incoming));
  const existing = { ...incoming, authoritative: true };
  assert.equal(retainPrediction(existing, { ...incoming, predictionPayload: null }, NOW, false), true);
  assert.equal(retainPrediction({ ...existing, predictionFeatureVersion: 0 }, incoming, NOW, true), false);
  const local = games.map((g) => ({ ...fixture(g), authoritative: false, predictionPayload: null }));
  const result = await run({ db: database(local), dryRun: false });
  assert.equal(result.res.statusCode, 200, result.res.body.reason); assert.equal(result.db.writes.length, 14);
});

test("personnel view version/freshness is required and a newer status change makes the prediction refresh-eligible", () => {
  const game = games[0];
  const existing = fixture(game);
  existing.authoritative = true;
  assert.equal(predictionFeatureStatus(existing).personnel, true);
  assert.equal(completePrediction(existing), true);
  assert.equal(predictionFeatureStatus({
    ...existing, personnelVersion: 0,
  }).personnel, false);

  const incoming = structuredClone(existing);
  incoming.personnelViews.away.players.push({
    canonicalId: "00-0000001", team: game.away, position: "WR", rank: 1,
    status: "Out", statusKnown: true, projectedAvailable: false, propEligible: false,
    replacementId: null, identityConflict: false, sourceConflict: false,
  });
  assert.equal(retainPrediction(existing, incoming, NOW, true), false);
});

test("material personnel signatures refresh only for identity/status changes, not observation timestamps", () => {
  const game = games[0];
  const existing = fixture(game);
  existing.authoritative = true;
  existing.personnelViews.away.players.push({
    canonicalId: "player-1", team: game.away, position: "WR", rank: 1,
    status: "Active", statusKnown: true, projectedAvailable: true, propEligible: true,
    replacementId: null, replacementFor: null, identityConflict: false, sourceConflict: false,
  });
  existing.personnelViews.away.quarterback = {
    resolved: true, conflict: false, player: { canonicalId: "player-1" },
  };
  existing.personnelViews.away.live = { available: true, observedAt: "2026-10-14T00:00:00Z" };
  const same = structuredClone(existing);
  assert.equal(personnelSignature(existing), personnelSignature(same));
  assert.equal(retainPrediction(existing, same, NOW, true), true);

  const timestampOnly = structuredClone(existing);
  timestampOnly.personnelViews.away.chart.observedAt = "2026-10-14T01:00:00Z";
  timestampOnly.personnelViews.away.live.observedAt = "2026-10-15T04:59:00Z";
  assert.equal(personnelSignature(existing), personnelSignature(timestampOnly));
  assert.equal(retainPrediction(existing, timestampOnly, NOW, true), true);

  const statusChanged = structuredClone(existing);
  Object.assign(statusChanged.personnelViews.away.players[0], {
    status: "Out", projectedAvailable: false, propEligible: false,
  });
  assert.notEqual(personnelSignature(existing), personnelSignature(statusChanged));
  assert.equal(retainPrediction(existing, statusChanged, NOW, true), false);

  const starterChanged = structuredClone(existing);
  starterChanged.personnelViews.away.quarterback.player.canonicalId = "player-2";
  assert.notEqual(personnelSignature(existing), personnelSignature(starterChanged));
  assert.equal(retainPrediction(existing, starterChanged, NOW, true), false);
});
test("current feature upgrade never overwrites frozen or graded records", () => {
  const incoming = fixture(games[0]);
  for (const fields of [{ frozenAt: NOW.toISOString() }, { actualWinner: incoming.awayCode }, { kickoff: "2026-10-14T00:00Z" }]) {
    assert.equal(retainPrediction({ ...incoming, predictionFeatureVersion: 0, ...fields }, incoming, NOW, true), true);
  }
});
test("wrong week, missing team, nonfinite or constant weekly network fail before predictions or writes", async () => {
  for (const mutate of [
    (n) => { n.week = 5; }, (n) => { delete n.ratings.NYJ; },
    (n) => { n.ratings.NYJ.offense = NaN; },
    (n) => { Object.values(n.ratings).forEach((r) => { r.overall = 0; }); },
  ]) {
    const n = structuredClone(network); mutate(n);
    assert.throws(() => validateWeeklyOpponentNetwork(n, 2026, 6));
    const r = await run({ loadNetwork: async () => n });
    assert.equal(r.res.statusCode, 502); assert.equal(r.generated, 0); assert.deepEqual(r.db.writes, []);
  }
});
test("refresh is deterministic and Predictions/Matchup consume identical scores, total and probabilities", async () => {
  const first = await run(), second = await run();
  assert.deepEqual(first.res.body, second.res.body);
  const s = fixture(games[0]);
  validatePredictionRefreshBatch([s], { ...context, games: [games[0]] }, NOW);
  const fromDB = databaseToSnapshot(snapshotToDatabase(s));
  const predictions = applyPredictionSnapshot(fromDB), matchup = applyPredictionSnapshot(fromDB);
  assert.deepEqual(predictions, matchup);
  assert.equal(predictions.total, s.fourthDownAwayScore + s.fourthDownHomeScore);
  assert.equal(predictions.homeWinProbability, s.fourthDownHomeWinProbability);
});
test("weekly loader excludes future completions and computes matchups from the same unchanged algorithm", async () => {
  const sourceGames = Array.from({ length: 4 }, (_, week) => NFL_TEAMS.flatMap((team, i) => {
    const home = NFL_TEAMS[(i + week + 1) % 32];
    return [{ id: `${week}-${i}`, season: 2026, week: week + 1, season_type: "REG", status: "Final",
      visitor_team: { abbreviation: team }, home_team: { abbreviation: home },
      visitor_team_score: 16 + i % 9, home_team_score: 20 + i % 5,
      date: "2026-09-10T17:00:00Z", updated_at: "2026-09-11T00:00:00Z" }];
  })).flat();
  sourceGames.push({ ...sourceGames[0], id: "future", updated_at: "2026-10-20T00:00:00Z" });
  const n = validateWeeklyOpponentNetwork(await loadWeeklyOpponentNetwork(2026, 6, { sourceGames, cutoff: KICKOFF, now: NOW }), 2026, 6);
  assert.equal(n.games.length, 128);
  let loads = 0;
  const handler = createOpponentNetworkHandler({ loadNetwork: async () => { loads++; return n; } });
  const res = response();
  await handler({ method: "GET", query: { season: "2026", week: "6", away: "ARI", home: "ATL" } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.modelLayer.available, true); assert.equal(loads, 1);
  assert.equal(res.body.modelLayer.awayPoints, -res.body.modelLayer.homePoints);
});
test("schedule validation refuses conflicting duplicate identities, repeated teams and post-kickoff writes", () => {
  const raw = games.map((g) => ({ season: 2026, week: 6, date: g.sourceDate,
    visitor_team: { abbreviation: g.away }, home_team: { abbreviation: g.home } }));
  assert.throws(() => predictionRefreshContext([...raw, { ...raw[0], date: "2026-10-19T00:00Z" }], NOW), /Conflicting/);
  assert.throws(() => predictionRefreshContext([...raw, { ...raw[0], home_team: { abbreviation: "TB" } }], NOW), /more than once/);
  assert.throws(() => predictionRefreshContext(raw, new Date("2026-10-18T18:00Z")), /after the weekly first kickoff/);
});

test("actual server input loader reuses weekly network, season schedule and personnel cutoff across all 14 games", async () => {
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (url) => {
    const path = String(url);
    assert.ok(!path.includes("/nfl/v1/games"), "no duplicate network/team-form/personnel schedule requests");
    assert.ok(!/sharp/i.test(path), "stored inputs must never invoke SharpAPI");
    requests.push(path);
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };
  try {
    const loader = createServerPredictionInputLoader({ weeklyNetwork: network, sourceGames: [], weeklyCutoff: KICKOFF });
    for (const game of games) {
      const tasks = loader(game);
      const values = await Promise.allSettled(Object.values(tasks));
      const result = values[Object.keys(tasks).indexOf("opponentNetwork")];
      assert.equal(result.status, "fulfilled");
      assert.equal(result.value.modelLayer.available, true);
      assert.equal(result.value.ratings, network.ratings);
    }
    assert.equal(requests.filter((url) => url.includes("/standings")).length, 1);
  } finally { globalThis.fetch = original; }
});

test("the deployed action dispatch reaches CRON protection without touching storage or providers", async () => {
  const res = response();
  await gameStats({ method: "POST", query: { action: "refresh-predictions" }, headers: {}, body: { dryRun: false } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.calls, 1);
});

test("anonymous GET/POST cannot save via public refresh or removed administrative action", async () => {
  for (const action of ["refresh-predictions", "admin-prediction-refresh"]) {
    for (const method of ["GET", "POST"]) {
      const res = response();
      await gameStats({ method, query: { action, save: "true" }, headers: {}, body: { dryRun: false } }, res);
      assert.ok(res.statusCode >= 400); assert.equal(res.calls, 1);
    }
  }
});
