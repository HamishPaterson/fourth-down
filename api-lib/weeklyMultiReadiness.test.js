import test from "node:test";
import assert from "node:assert/strict";
import { evaluateWeeklyMultiReadiness, validLockPlan, READINESS_MARKETS } from "./weeklyMultiReadiness.js";
import { lockFixture, FUTURE_LOCK, PREPARED_AT } from "./weeklyLockTestHelpers.js";
import { lockPredictionRejections, snapshotAuthority } from "./weeklyLockProvenance.js";
import { predictionFeatureFixture } from "./personnelTestHelpers.js";
import { CURRENT_MODEL_KEY, CURRENT_MODEL_VERSION } from "../src/services/modelIdentity.js";

test("current moneyline and spread remain ready while stale totals and missing props are explicitly degraded", () => {
  const fixture = lockFixture(), before = structuredClone(fixture);
  const result = evaluateWeeklyMultiReadiness(fixture);
  assert.equal(result.status, "DEGRADED_NON_BLOCKING");
  assert.equal(result.canSatisfyLegCount, true);
  assert.equal(result.selection.legs.length, 5);
  assert.equal(result.markets.h2h.freshGames, 5);
  assert.equal(result.markets.spreads.freshGames, 5);
  assert.equal(result.markets.totals.staleOrRejectedGames, 5);
  assert.equal(result.markets.player_anytime_td.missingGames, 5);
  assert.deepEqual(Object.keys(result.markets), READINESS_MARKETS);
  assert.deepEqual(fixture, before);
  assert.ok(result.selection.legs.every((leg) => leg.updatedAt === PREPARED_AT && leg.oddsUpdatedAt === PREPARED_AT));
});

test("current spreads can form five core-only legs, but stale totals cannot outrank them", () => {
  const fixture = lockFixture();
  for (const [index, prediction] of fixture.predictions.entries()) {
    prediction.bestBets.candidates = [
      { ...prediction.bestBets.candidates[0], market: "Spread", selection: prediction.awayCode,
        price: -110, decimalOdds: 1 + 100 / 110, line: -2.5, quoteId: `spread${index}` },
      { market: "Total", selection: "Over", price: -110, decimalOdds: 1 + 100 / 110,
        sportsbook: "Book", modelProbability: .99, line: 44.5, updatedAt: "2026-10-27T10:00:00Z" },
    ];
  }
  const result = evaluateWeeklyMultiReadiness(fixture);
  assert.equal(result.canSatisfyLegCount, true);
  assert.ok(result.selection.legs.every((leg) => leg.market === "Spread"));
  assert.equal(result.selection.candidateDiagnostics.filter((row) =>
    row.market === "totals" && row.reasons.includes("QUOTE_STALE_OR_MISSING_TIME")).length, 5);
});

test("all stale core quotes produce no selected legs", () => {
  const fixture = lockFixture();
  for (const prediction of fixture.predictions) prediction.bestBets.candidates[0].updatedAt = "2026-10-27T10:00:00Z";
  const result = evaluateWeeklyMultiReadiness(fixture);
  assert.equal(result.canSatisfyLegCount, false);
  assert.equal(result.selection.legs.length, 0);
  assert.ok(result.blockingReasons.includes("INSUFFICIENT_ELIGIBLE_MATCHUPS"));
});

test("four eligible matchups never pad to five", () => {
  const fixture = lockFixture();
  fixture.predictions[0].bestBets.candidates = [];
  const result = evaluateWeeklyMultiReadiness(fixture);
  assert.equal(result.selection.legs.length, 4);
  assert.equal(result.selection.threshold, .55);
  assert.equal(result.canSatisfyLegCount, false);
});

test("mixed current and stale books retain only the exact current quote", () => {
  const fixture = lockFixture();
  const prediction = fixture.predictions[0];
  const old = { ...prediction.bestBets.candidates[0], sportsbook: "OldBook",
    modelProbability: .99, quoteId: "old", updatedAt: "2026-10-27T10:00:00Z" };
  prediction.bestBets.candidates.unshift(old);
  fixture.odds.events[0].bookmakers.push({ key: "old", title: "OldBook", last_update: old.updatedAt,
    markets: [{ key: "h2h", outcomes: [{ name: prediction.awayCode, price: 100, updatedAt: old.updatedAt }] }] });
  const result = evaluateWeeklyMultiReadiness(fixture);
  assert.equal(result.selection.legs.find((row) => row.awayCode === "NE").sportsbook, "Book");
  assert.equal(result.selection.legs.find((row) => row.awayCode === "NE").updatedAt, PREPARED_AT);
});

for (const [name, mutate, code] of [
  ["client-generated", (row) => { row.authoritative = false; }, "MISSING_AUTHORITY"],
  ["missing provenance", (row) => { delete row.lockProvenance; }, "MISSING_AUTHORITY"],
  ["wrong prediction ID", (row) => { row.lockProvenance.predictionId = "another"; }, "MISSING_AUTHORITY"],
  ["post-lock", (row) => { row.generatedAt = "2026-10-29T00:01:00Z"; }, "POST_LOCK_PREDICTION"],
  ["at cutoff", (row) => { row.generatedAt = FUTURE_LOCK; }, "POST_LOCK_PREDICTION"],
  ["wrong model", (row) => { row.modelKey = "old"; }, "WRONG_MODEL"],
  ["incomplete", (row) => { row.playerProjections.available = false; }, "INCOMPLETE_PREDICTION"],
  ["stale", (row) => { row.generatedAt = "2026-10-27T00:00:00Z"; }, "STALE_PREDICTION"],
  ["missing inputs", (row) => { row.lockProvenance.inputs = []; }, "MISSING_AUTHORITY"],
  ["wrong cutoff", (row) => { row.lockProvenance.generationCutoff = PREPARED_AT; }, "MISSING_AUTHORITY"],
  ["stale model total dependency", (row) => { row.lockProvenance.marketDependencies = [
    { market: "totals", timestamp: "2026-10-27T10:00:00Z" }]; }, "MODEL_MARKET_DEPENDENCY_STALE"],
]) {
  test(`authoritative readiness rejects ${name} saved predictions`, () => {
    const fixture = lockFixture();
    mutate(fixture.predictions[0]);
    const result = evaluateWeeklyMultiReadiness(fixture);
    assert.equal(result.canSatisfyLegCount, false);
    assert.ok(result.predictionRejections[0].reasons.includes(code));
    assert.equal(result.selection.legs.length, 4);
  });
}

for (const [name, mutate] of [
  ["missing plan", (fixture) => { fixture.plan = null; }],
  ["late plan", (fixture) => { fixture.plan.prepared_at = FUTURE_LOCK; }],
  ["duplicate matchup/team", (fixture) => { fixture.plan.games[1] = fixture.plan.games[0]; }],
  ["missing game", (fixture) => { fixture.plan.games.pop(); }],
  ["historical Week 7", (fixture) => { fixture.plan.lock_at = "2026-10-22T00:00:00Z"; fixture.plan.week = 7; }],
]) {
  test(`readiness is UNKNOWN, never fabricated, for ${name}`, () => {
    const fixture = lockFixture(); mutate(fixture);
    const result = evaluateWeeklyMultiReadiness(fixture);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.canSatisfyLegCount, false);
    assert.equal(validLockPlan(fixture.plan, fixture.now), false);
  });
}

for (const timestamp of ["2026-10-29T00:01:00Z", "", "not-time"]) {
  test(`a replacement quote timestamp ${timestamp || "missing"} cannot substitute for the saved quote`, () => {
    const fixture = lockFixture();
    fixture.odds.events[0].bookmakers[0].markets[0].outcomes[0].quoteSource.timestamp = timestamp;
    fixture.odds.events[0].bookmakers[0].markets[0].outcomes[0].updatedAt = timestamp;
    if (!timestamp) fixture.odds.events[0].bookmakers[0].last_update = "";
    const result = evaluateWeeklyMultiReadiness(fixture);
    assert.equal(result.canSatisfyLegCount, false);
  });
}

test("snapshot fetched after lock cannot replace a missing lock-time snapshot even with an old provider time", () => {
  const fixture = lockFixture();
  fixture.odds.events[0].bookmakers[0].markets[0].outcomes[0].quoteSource.fetchedAt = "2026-10-29T00:02:00Z";
  assert.equal(evaluateWeeklyMultiReadiness(fixture).canSatisfyLegCount, false);
});

test("readiness counts saved, authoritative, model, completeness, projections and availability separately", () => {
  const fixture = lockFixture();
  fixture.predictions[0].authoritative = false;
  fixture.predictions[1].modelVersion = 11;
  fixture.predictions[2].playerProjections.available = false;
  fixture.predictions[3].personnelViews.away.players = [
    { statusKnown: false, propEligible: false },
    { status: "Active", statusKnown: true, propEligible: true, eligibleBeforeCutoff: true },
  ];
  const result = evaluateWeeklyMultiReadiness(fixture);
  assert.equal(result.savedPredictionCount, 5);
  assert.equal(result.authoritativePredictionCount, 4);
  assert.equal(result.currentModelIdentityCount, 4);
  assert.equal(result.playerProjectionCoverage, 4);
  assert.deepEqual(result.playerAvailabilityCoverage, { total: 2, eligible: 1 });
});

test("late evaluation never promotes current-model post-lock predictions to lock-time authority", () => {
  const fixture = lockFixture();
  fixture.now = new Date("2026-10-29T00:10:00Z");
  for (const row of fixture.predictions) row.generatedAt = "2026-10-29T00:05:00Z";
  assert.equal(evaluateWeeklyMultiReadiness(fixture).selection.legs.length, 0);
  assert.ok(lockPredictionRejections(fixture.predictions[0], { season: 2026, week: 8, lockAt: FUTURE_LOCK },
    fixture.now).includes("POST_LOCK_PREDICTION"));
});

test("freshness coverage never labels quotes current without pre-lock persisted snapshot evidence", () => {
  const fixture = lockFixture();
  delete fixture.odds.events[0].bookmakers[0].markets[0].outcomes[0].quoteSource.fetchedAt;
  const result = evaluateWeeklyMultiReadiness(fixture);
  assert.equal(result.markets.h2h.freshGames, 4);
  assert.equal(result.canSatisfyLegCount, false);
});

// Week 8 production-shaped state: 14 authoritative snapshots persisted by the
// atomic replacement carry batchProvenance (not lockProvenance) and top-level
// generationMarketDependencies, with saved Best Bet quotes from before the lock.
const WEEK8_LOCK = "2026-10-29T00:00:00.000Z";
const WEEK8_GENERATED = "2026-10-28T05:36:59.000Z";
const WEEK8_QUOTE = "2026-10-27T12:34:16.012515305Z";
const WEEK8_PAIRS = [["ARI", "DAL"], ["ATL", "TB"], ["BAL", "BUF"], ["CAR", "GB"], ["CHI", "SEA"],
  ["CLE", "PIT"], ["IND", "JAX"], ["KC", "DEN"], ["LAC", "LAR"], ["LV", "NYJ"], ["MIN", "DET"],
  ["NE", "MIA"], ["PHI", "WSH"], ["TEN", "CIN"]];

function week8Fixture({ candidateCount = 2, matchups = WEEK8_PAIRS } = {}) {
  const games = matchups.map(([away, home], index) => ({
    away, home, kickoff: index === 3 ? "2026-10-30T00:15:00Z" : "2026-11-01T18:00:00Z",
  }));
  const plan = { id: "00000000-0000-4000-8000-000000000008", season: 2026, week: 8,
    lock_at: WEEK8_LOCK, source: "server-prepared", prepared_at: "2026-10-28T23:00:00.000Z",
    expected_game_count: games.length, games };
  const predictions = games.map((game, index) => {
    const features = predictionFeatureFixture(game.away, game.home, 2026, 8, game.kickoff);
    const bets = Array.from({ length: candidateCount }, (_, betIndex) => ({
      market: "Moneyline", category: "Game", selection: game.away, sportsbook: "Book",
      price: 100, decimalOdds: 2, modelProbability: .7 - betIndex * .05,
      updatedAt: WEEK8_QUOTE, quoteId: `q${index}-${betIndex}` }));
    return {
      id: `8:${game.away}:${game.home}`, season: 2026, week: 8, awayCode: game.away, homeCode: game.home,
      kickoff: game.kickoff, generatedAt: WEEK8_GENERATED, authoritative: true,
      batchProvenance: { version: 1, source: "server-week-replacement", operationId: "23b1c421-93c5-4e3c-b820-8d1a3b647e8e" },
      generationMarketDependencies: [],
      modelKey: CURRENT_MODEL_KEY, modelVersion: CURRENT_MODEL_VERSION, ...features,
      fourthDownPick: game.away, fourthDownAwayScore: 24, fourthDownHomeScore: 20,
      fourthDownAwayWinProbability: .7, fourthDownHomeWinProbability: .3, confidenceScore: .7,
      predictionPayload: { modelLayers: { opponentNetwork: features.predictionPayloadFeatures.opponentNetwork },
        matchupIntelligence: features.predictionPayloadFeatures },
      playerProjections: { available: true, away: { players: [] }, home: { players: [] } },
      dataQuality: { sources: { odds: { available: true } }, personnelTiming: { cutoff: game.kickoff } },
      bestBets: { assessed: candidateCount, recommendations: bets.slice(0, 1), candidates: bets },
    };
  });
  const odds = { cacheStatus: "fresh", refreshedAt: WEEK8_QUOTE,
    events: games.map((game, index) => ({
      id: `game${index}`, away_team: game.away, home_team: game.home, commence_time: game.kickoff,
      bookmakers: [{ key: "book", title: "Book", last_update: WEEK8_QUOTE, markets: [
        { key: "h2h", outcomes: Array.from({ length: candidateCount }, (_, betIndex) => ({
          name: game.away, price: 100, updatedAt: WEEK8_QUOTE,
          quoteValidation: { status: "validated" },
          quoteSource: { id: `q${index}-${betIndex}`, provider: "SharpAPI", timestamp: WEEK8_QUOTE, fetchedAt: WEEK8_QUOTE } })) },
      ] }],
    })) };
  return { plan, predictions, odds, now: new Date(WEEK8_LOCK) };
}

test("Week 8 atomic batchProvenance snapshots are recognized as authoritative without a physical column", () => {
  const context = { season: 2026, week: 8, lockAt: WEEK8_LOCK };
  const fixture = week8Fixture();
  assert.equal(fixture.predictions.every((row) => row.lockProvenance === undefined), true);
  assert.equal(fixture.predictions.every((row) => snapshotAuthority(row, context).authoritative), true);
  assert.equal(fixture.predictions.every((row) =>
    lockPredictionRejections(row, context, new Date(WEEK8_LOCK)).length === 0), true);
  const result = evaluateWeeklyMultiReadiness(fixture);
  assert.equal(result.authoritativePredictionCount, 14);
  assert.equal(result.eligiblePredictionCount, 14);
  assert.equal(result.blockingReasons.includes("AUTHORITATIVE_PREDICTIONS_NOT_READY"), false);
});

test("Week 8 catch-up after the lock consumes saved Best Bets without reassessment or fresh quotes", () => {
  const fixture = week8Fixture();
  fixture.now = new Date("2026-11-02T06:00:00Z"); // after the lock and after the 30h quote window
  const result = evaluateWeeklyMultiReadiness(fixture);
  assert.equal(result.canSatisfyLegCount, true);
  assert.equal(result.selection.legs.length, 5);
  assert.equal(result.selection.complete, true);
  assert.equal(new Set(result.selection.legs.map((leg) => leg.matchupKey)).size, 5);
  assert.ok(result.selection.legs.every((leg) => leg.updatedAt === WEEK8_QUOTE));
  assert.equal(result.selection.reasonCounts.staleOdds, 0);
});

test("Week 8 catch-up still rejects post-lock and future quotes", () => {
  const fixture = week8Fixture();
  fixture.now = new Date("2026-11-02T06:00:00Z");
  fixture.predictions[0].bestBets.candidates[0].updatedAt = "2026-10-29T00:01:00Z";
  const result = evaluateWeeklyMultiReadiness(fixture);
  const rejected = result.selection.candidateDiagnostics.find((row) => row.predictionId === fixture.predictions[0].id);
  assert.ok(rejected.reasons.includes("POST_LOCK_QUOTE"));
});

test("Week 8 catch-up keeps the 30h dependency freshness bound off but still rejects post-lock dependencies", () => {
  const fixture = week8Fixture();
  fixture.now = new Date("2026-11-02T06:00:00Z");
  fixture.predictions[0].generationMarketDependencies = [{ market: "totals", timestamp: "2026-10-27T10:00:00Z" }];
  assert.equal(lockPredictionRejections(fixture.predictions[0], { season: 2026, week: 8, lockAt: WEEK8_LOCK },
    fixture.now).includes("MODEL_MARKET_DEPENDENCY_STALE"), false);
  fixture.predictions[0].generationMarketDependencies = [{ market: "totals", timestamp: "2026-10-29T00:01:00Z" }];
  assert.ok(lockPredictionRejections(fixture.predictions[0], { season: 2026, week: 8, lockAt: WEEK8_LOCK },
    fixture.now).includes("MODEL_MARKET_DEPENDENCY_STALE"));
});

test("Week 8 catch-up enforces distinct matchups and never pads to five", () => {
  const fixture = week8Fixture({ matchups: WEEK8_PAIRS.slice(0, 4) });
  fixture.plan.expected_game_count = 4;
  fixture.now = new Date("2026-11-02T06:00:00Z");
  const result = evaluateWeeklyMultiReadiness(fixture);
  assert.equal(result.selection.legs.length, 4);
  assert.equal(result.selection.complete, false);
  assert.equal(result.canSatisfyLegCount, false);
  assert.ok(result.blockingReasons.includes("INSUFFICIENT_ELIGIBLE_MATCHUPS"));
});

test("Week 8 catch-up rejects contradictory same-matchup candidates and duplicate markets", () => {
  const fixture = week8Fixture({ matchups: WEEK8_PAIRS.slice(0, 5) });
  fixture.plan.expected_game_count = 5;
  fixture.now = new Date("2026-11-02T06:00:00Z");
  // Add a contradictory home moneyline to game 0; only one leg per matchup survives.
  fixture.predictions[0].bestBets.candidates.push({ market: "Moneyline", category: "Game",
    selection: fixture.predictions[0].homeCode, sportsbook: "Book", price: 100, decimalOdds: 2,
    modelProbability: .9, updatedAt: WEEK8_QUOTE, quoteId: "q0-home" });
  fixture.odds.events[0].bookmakers[0].markets[0].outcomes.push({ name: fixture.predictions[0].homeCode,
    price: 100, updatedAt: WEEK8_QUOTE, quoteValidation: { status: "validated" },
    quoteSource: { id: "q0-home", provider: "SharpAPI", timestamp: WEEK8_QUOTE, fetchedAt: WEEK8_QUOTE } });
  const result = evaluateWeeklyMultiReadiness(fixture);
  const game0Legs = result.selection.legs.filter((leg) => leg.matchupKey.includes("ARI") && leg.matchupKey.includes("DAL"));
  assert.equal(game0Legs.length, 1);
  assert.equal(new Set(result.selection.legs.map((leg) => leg.matchupKey)).size, result.selection.legs.length);
});

test("a rollover fallback remains ineligible even if its quote timestamp appears current", () => {
  const fixture = lockFixture();
  fixture.odds.events[0].bookmakers[0].markets[0].outcomes[0].quoteSource.rolloverFallback = true;
  const result = evaluateWeeklyMultiReadiness(fixture);
  assert.equal(result.markets.h2h.freshGames, 4);
  assert.equal(result.canSatisfyLegCount, false);
  assert.ok(result.selection.candidateDiagnostics[0].reasons.includes("EXACT_CURRENT_QUOTE_NOT_FOUND"));
});

test("strict lock selection requires the existing 55% player-role confidence floor", () => {
  const fixture = lockFixture(), prediction = fixture.predictions[0];
  Object.assign(prediction.bestBets.candidates[0], { market: "Passing yards", category: "Player",
    selection: "Example Player Over 200.5 passing yards", line: 200.5,
    playerId: "player", personnelId: "player", playerTeam: "NE", roleConfidence: .3 });
  prediction.personnelViews.away.players.push({ canonicalId: "player", team: "NE", position: "QB",
    status: "Active", statusKnown: true, projectedAvailable: true, propEligible: true, eligibleBeforeCutoff: true });
  const market = fixture.odds.events[0].bookmakers[0].markets[0];
  market.key = "player_pass_yds";
  Object.assign(market.outcomes[0], { name: "Over", playerName: "Example Player", point: 200.5 });
  const rejected = evaluateWeeklyMultiReadiness(fixture);
  assert.equal(rejected.canSatisfyLegCount, false);
  assert.ok(rejected.selection.candidateDiagnostics[0].reasons.includes("ROLE_CONFIDENCE_INSUFFICIENT"));
  prediction.bestBets.candidates[0].roleConfidence = .8;
  assert.equal(evaluateWeeklyMultiReadiness(fixture).canSatisfyLegCount, true);
});

test("future personnel observations cannot authorize an earlier prediction", () => {
  const fixture = lockFixture();
  fixture.predictions[0].personnelViews.away.players.push({
    canonicalId: "future-player", observationTimestamp: "2026-10-29T00:05:00Z",
  });
  const result = evaluateWeeklyMultiReadiness(fixture);
  assert.ok(result.predictionRejections[0].reasons.includes("FUTURE_PERSONNEL_EVIDENCE"));
  assert.equal(result.canSatisfyLegCount, false);
});
