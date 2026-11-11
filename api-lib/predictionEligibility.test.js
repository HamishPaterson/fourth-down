import test from "node:test";
import assert from "node:assert/strict";
import { CURRENT_MODEL_VERSION, CURRENT_MODEL_KEY } from "../src/services/modelIdentity.js";
import { FULL_MODEL_VERSION, FULL_MODEL_KEY } from "../src/services/gamePredictionService.js";
import * as ledger from "../src/services/predictionLedger.js";
import { completePrediction, predictionCompletenessStatus, retainPrediction } from "./predictionEligibility.js";
import { predictionFeatureFixture } from "./personnelTestHelpers.js";
import { BEST_BETS_CANDIDATE_VERSION } from "../src/services/bestBetsService.js";
import { fixedTestNow, useFixedTestClock } from "./testClock.js";

useFixedTestClock();
const cutoff = "2026-10-16T00:15:00Z";
function fixture() {
  const feature = predictionFeatureFixture("SEA", "DEN", 2026, 6, cutoff);
  return {
    ...feature, season: 2026, week: 6, awayCode: "SEA", homeCode: "DEN", kickoff: cutoff,
    modelVersion: CURRENT_MODEL_VERSION, modelKey: CURRENT_MODEL_KEY,
    fourthDownPick: "SEA", fourthDownAwayScore: 24, fourthDownHomeScore: 20,
    fourthDownAwayWinProbability: .6, fourthDownHomeWinProbability: .4, confidenceScore: .7,
    predictionPayload: {
      matchupIntelligence: feature.predictionPayloadFeatures,
      modelLayers: { opponentNetwork: feature.predictionPayloadFeatures.opponentNetwork },
    },
    playerProjections: { available: true },
    bestBets: { candidateVersion: BEST_BETS_CANDIDATE_VERSION, candidates: [], recommendations: [], assessed: 1 },
    dataQuality: { personnelTiming: { cutoff }, sources: {
      odds: { available: true }, opponentNetwork: { available: true },
    } },
    generatedAt: fixedTestNow().toISOString(), authoritative: true,
  };
}

test("completeness diagnostics name failed requirements without including snapshot values", () => {
  const mutations = {
    modelIdentity: (s) => { s.modelKey = "wrong"; },
    predictionPayload: (s) => { s.predictionPayload = null; },
    pick: (s) => { s.fourthDownPick = "OTHER"; },
    finiteValues: (s) => { s.confidenceScore = NaN; },
    probabilities: (s) => { s.fourthDownAwayWinProbability = 2; },
    scores: (s) => { s.fourthDownAwayScore = -1; },
    odds: (s) => { s.dataQuality.sources.odds.available = false; },
    bestBets: (s) => { delete s.bestBets; },
    recommendations: (s) => { delete s.bestBets.recommendations; },
    assessed: (s) => { s.bestBets.assessed = 0; },
    playerProjections: (s) => { s.playerProjections.available = false; },
    personnel: (s) => { s.personnelVersion = 0; },
  };
  assert.ok(Object.values(predictionCompletenessStatus(fixture())).every((value) => value === true));
  for (const [name, mutate] of Object.entries(mutations)) {
    const snapshot = fixture();
    mutate(snapshot);
    const status = predictionCompletenessStatus(snapshot);
    assert.equal(status[name], false, name);
    assert.equal(status.complete, false, name);
    assert.equal(completePrediction(snapshot), false, name);
    assert.ok(Object.values(status).every((value) => typeof value === "boolean"));
  }
  const snapshot = fixture();
  snapshot.dataQuality.sources.odds.available = false;
  snapshot.bestBets.assessed = 0;
  const status = predictionCompletenessStatus(snapshot);
  assert.deepEqual(Object.keys(status).filter((key) => key !== "complete" && !status[key]), ["odds", "assessed"]);
  assert.equal(completePrediction(null), false);
  assert.equal(completePrediction(undefined), false);
});

test("completeness preserves numeric coercion and fallback Best Bets payload behaviour", () => {
  const snapshot = fixture();
  for (const field of ["fourthDownAwayScore", "fourthDownHomeScore",
    "fourthDownAwayWinProbability", "fourthDownHomeWinProbability", "confidenceScore"]) {
    snapshot[field] = String(snapshot[field]);
  }
  snapshot.bestBets.assessed = "1";
  snapshot.dataQuality.bestBetsPayload = snapshot.bestBets;
  delete snapshot.bestBets;
  assert.equal(predictionCompletenessStatus(snapshot).complete, true);
  assert.equal(completePrediction(snapshot), true);
});

test("generation, eligibility and ledger share one current model identity", () => {
  assert.equal(FULL_MODEL_VERSION, CURRENT_MODEL_VERSION);
  assert.equal(FULL_MODEL_KEY, CURRENT_MODEL_KEY);
  assert.equal(ledger.CURRENT_MODEL_VERSION, CURRENT_MODEL_VERSION);
  assert.equal(ledger.CURRENT_MODEL_KEY, CURRENT_MODEL_KEY);
  assert.equal(completePrediction(fixture()), true);
  for (const [modelVersion, modelKey, expected] of [
    [String(CURRENT_MODEL_VERSION), CURRENT_MODEL_KEY, true],
    [11, "full-v11-week5-data-gap-audit", false],
    [11, CURRENT_MODEL_KEY, false],
    [CURRENT_MODEL_VERSION, "wrong", false],
    [undefined, CURRENT_MODEL_KEY, false],
    [CURRENT_MODEL_VERSION, undefined, false],
    ["12garbage", CURRENT_MODEL_KEY, false],
    [[CURRENT_MODEL_VERSION], CURRENT_MODEL_KEY, false],
    [CURRENT_MODEL_VERSION + 1, CURRENT_MODEL_KEY, false],
  ]) {
    assert.equal(completePrediction({ ...fixture(), modelVersion, modelKey }), expected);
  }
});

test("legacy scores require a complete replacement and current authoritative scores resist partial browser writes", () => {
  const current = fixture();
  const old = { ...current, modelVersion: 11, modelKey: "full-v11-week5-data-gap-audit" };
  const partial = { ...current, predictionPayload: null, fourthDownAwayScore: 99 };
  assert.equal(retainPrediction(old, current, fixedTestNow(), true), false);
  assert.equal(retainPrediction(old, partial, fixedTestNow(), true), true);
  assert.equal(retainPrediction(current, partial, fixedTestNow(), false), true);
  assert.equal(retainPrediction(current, partial, fixedTestNow(), true), true);
});
