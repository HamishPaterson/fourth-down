import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import dataset from "../api/nfl/nflverse-team-metrics.js";
import players from "../data/nflverse-player-metrics.js";
import { compareTeams } from "../api/nfl/play-by-play.js";
import { playerMetricsResponse } from "./playerMetrics.js";
import { buildMatchupIntelligence, buildExpectedPlayMix } from "../src/services/matchupIntelligence.js";
import { predictMatchup, createModelLayers } from "../src/services/predictionEngine.js";
import { getFullGamePrediction, clearFullGamePredictionCache } from "../src/services/gamePredictionService.js";
import { buildPlayerProjections } from "../src/services/playerProjectionService.js";
import { explainMatchupSignal } from "../src/services/matchupIntelligence.js";
import { normaliseLayers } from "../src/services/dataHealth.js";

const close = (a, b, tolerance = .00001) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const metric = (team) => ({
  team, games: 5, offensivePlays: 350, defensivePlays: 350, playsPerGame: 65,
  passingEpaPerPlay: .1, passingEpaAllowedPerPlay: .05,
  rushingEpaPerPlay: .02, rushingEpaAllowedPerPlay: -.01,
  successRate: .45, defensiveSuccessRate: .45,
  explosivePlayRate: .1, explosivePlayRateAllowed: .1,
  pressureAllowedRate: .15, pressureGeneratedRate: .15,
  opponentAdjusted: { opponents: ["DAL"], passingEpaPerPlay: .1, rushingEpaPerPlay: .02,
    successRate: 0, explosivePlayRate: 0 },
});
function fixture() {
  return { away: "BUF", home: "KC",
    teamMetrics: { season: 2026, week: 6, away: metric("BUF"), home: metric("KC") } };
}
const model = (input = fixture()) => buildMatchupIntelligence(input);
const signal = (input, layer) => model(input).signals.find((entry) => entry.layer === layer);
const baseline = { active: true, awayExpected: 24, homeExpected: 24, gamesUsed: { away: 5, home: 5 }, confidence: .8 };
function predict(input = fixture(), extra = {}) {
  return predictMatchup(input.away, input.home, { season: 2026, week: 6,
    kickoff: "2026-10-18T20:25:00Z", weather: { dome: true },
    teamMetrics: input.teamMetrics, modelLayers: { scoringBaseline: baseline }, ...extra });
}
function real(week = 6, away = "BUF", home = "KC") {
  const teamMetrics = { season: 2026, week, dataStatus: "available",
    away: dataset.metricsByWeek[week][away], home: dataset.metricsByWeek[week][home] };
  return { away, home, teamMetrics,
    playerMetrics: playerMetricsResponse(players, { season: 2026, week, away, home }) };
}
function finiteNumbers(value) {
  if (typeof value === "number") assert.ok(Number.isFinite(value));
  else if (value && typeof value === "object") Object.values(value).forEach(finiteNumbers);
}

for (const [layer, ownField, defenseField] of [
  ["rushMatchup", "rushingEpaPerPlay", "rushingEpaAllowedPerPlay"],
  ["passMatchup", "passingEpaPerPlay", "passingEpaAllowedPerPlay"],
  ["successMatchup", "successRate", "defensiveSuccessRate"],
  ["explosiveMatchup", "explosivePlayRate", "explosivePlayRateAllowed"],
]) {
  test(`${layer}: stronger home attack, weaker BUF allowance and stronger BUF denial have correct signs`, () => {
    const input = fixture();
    close(signal(input, layer).homePoints, 0);
    input.teamMetrics.home[ownField] += .08;
    assert.ok(signal(input, layer).homePoints > 0);
    const increased = signal(input, layer).homePoints;
    input.teamMetrics.away[defenseField] += .05;
    assert.ok(signal(input, layer).homePoints > increased);
    input.teamMetrics.away[defenseField] -= .15;
    assert.ok(signal(input, layer).homePoints < increased);
  });
  test(`${layer}: swapping named teams exactly reverses the comparative points`, () => {
    const input = fixture();
    input.teamMetrics.home[ownField] += .1;
    const first = signal(input, layer);
    const swapped = { away: input.home, home: input.away, teamMetrics: {
      ...input.teamMetrics, away: input.teamMetrics.home, home: input.teamMetrics.away } };
    close(signal(swapped, layer).homePoints, -first.homePoints);
  });
  test(`${layer}: removing the layer exposes its actual final-margin contribution`, () => {
    const input = fixture();
    input.teamMetrics.home[ownField] += .2;
    const withLayer = predict(input);
    const output = withLayer.matchupIntelligence.signals.find((s) => s.layer === layer);
    const without = predictMatchup("BUF", "KC", { season: 2026, week: 6,
      kickoff: "2026-10-18T20:25:00Z", weather: { dome: true },
      modelLayers: { ...withLayer.modelLayers, [layer]: { homePoints: 0, awayPoints: 0 } } });
    close(output.modelMarginContribution, withLayer.continuousMargin - without.continuousMargin, .00011);
    assert.ok(output.modelMarginContribution > 0);
    assert.ok(output.explanationSafe);
    assert.match(output.explanation, /Buffalo Bills/);
    assert.match(output.explanation, /Kansas City Chiefs/);
    assert.doesNotMatch(output.explanation, /\bthe opponent\b|\bthe offense\b|\bthe defense\b|blitz|deep passing|play-action/i);
  });
}

for (const [layer, adjusted] of [["passMatchup", "passingEpaPerPlay"], ["rushMatchup", "rushingEpaPerPlay"],
  ["successMatchup", "successRate"], ["explosiveMatchup", "explosivePlayRate"]]) {
  test(`${layer}: metric-specific opponent adjustment can strengthen or weaken the signal`, () => {
    const input = fixture(), base = signal(input, layer).homePoints;
    input.teamMetrics.home.opponentAdjusted[adjusted] += .1;
    const stronger = signal(input, layer);
    assert.ok(stronger.homePoints > base);
    assert.ok(stronger.metricAdjustmentHomePoints > 0);
    input.teamMetrics.home.opponentAdjusted[adjusted] -= .2;
    assert.ok(signal(input, layer).homePoints < base);
  });
}

test("success and combined explosives are separate evidence, not renamed EPA", () => {
  const input = fixture();
  input.teamMetrics.home.passingEpaPerPlay = 1;
  input.teamMetrics.home.rushingEpaPerPlay = 1;
  close(signal(input, "successMatchup").homePoints, 0);
  close(signal(input, "explosiveMatchup").homePoints, 0);
  assert.equal(signal(input, "explosiveMatchup").category, "Explosive-play matchup");
});

test("unsupported defense, zero sample and nonfinite metrics never produce safe explanations", () => {
  const input = fixture();
  delete input.teamMetrics.away.defensiveSuccessRate;
  input.teamMetrics.home.rushingEpaPerPlay = Infinity;
  input.teamMetrics.away.explosivePlayRateAllowed = null;
  const result = predict(input);
  for (const layer of ["rushMatchup", "successMatchup", "explosiveMatchup"]) {
    const output = result.matchupIntelligence.signals.find((s) => s.layer === layer);
    assert.equal(output.available, false);
    assert.equal(output.explanationSafe, false);
    assert.equal(output.explanation, null);
  }
  input.teamMetrics.home.games = 0;
  assert.ok(model(input).signals.every((s) => !s.available));
  finiteNumbers(result.matchupIntelligence);
});

test("missing opponent adjustment is reported, not invented", () => {
  const input = fixture();
  delete input.teamMetrics.home.opponentAdjusted;
  assert.equal(signal(input, "passMatchup").matchups.home.opponentAdjustedMetric, null);
  assert.ok(signal(input, "passMatchup").available);
});

test("new correlated layers share a <= one-point margin budget even for extreme inputs", () => {
  const input = fixture();
  for (const key of ["passingEpaPerPlay", "rushingEpaPerPlay"]) input.teamMetrics.home[key] = 10;
  input.teamMetrics.home.successRate = 1;
  input.teamMetrics.home.explosivePlayRate = 1;
  const built = model(input);
  const normalized = createModelLayers(built.layers);
  const points = built.signals.reduce((sum, s) => sum + Math.abs(normalized[s.layer].homePoints), 0);
  assert.ok(points * 2 <= 1);
  assert.ok(built.signals.every((s) => s.correlationScale < 1));
});

test("correlated metric views do not inflate independent model confidence", () => {
  const input = fixture();
  const unchanged = predictMatchup("BUF", "KC", { week: 6,
    kickoff: "2026-10-18T20:25:00Z", weather: { dome: true }, modelLayers: { scoringBaseline: baseline } });
  const result = predict(input);
  assert.equal(result.continuousMargin, unchanged.continuousMargin);
  assert.equal(result.confidenceScore, unchanged.confidenceScore);
  assert.equal(result.homeWinProbability, unchanged.homeWinProbability);
  assert.equal(result.matchupIntelligence.phase, 1);
  const diagnosed = normaliseLayers(result.modelLayers);
  for (const layer of ["rushMatchup", "passMatchup", "successMatchup", "explosiveMatchup"]) {
    assert.equal(diagnosed.find((s) => s.name === layer)?.status, "measured-neutral");
  }
});

test("pressure reuses exactly one existing layer, never a new duplicate adjustment", () => {
  const input = real();
  const oldLayers = compareTeams(input.teamMetrics.away, input.teamMetrics.home, 6);
  const result = predict(input, { playerMetrics: input.playerMetrics, modelLayers: oldLayers });
  close(result.modelLayers.pressureMatchup.homePoints, oldLayers.pressureMatchup.homePoints);
  assert.equal(result.matchupIntelligence.signals.filter((s) => s.category === "Pressure").length, 1);
  assert.equal(result.matchupIntelligence.signals.find((s) => s.category === "Pressure").reusedExistingLayer, true);
});

test("pressure generated and allowance retain corrected directions", () => {
  const input = real(), teams = structuredClone(input.teamMetrics);
  const before = compareTeams(teams.away, teams.home, 6).pressureMatchup.homePoints;
  teams.home.pressureGeneratedRate += .1;
  assert.ok(compareTeams(teams.away, teams.home, 6).pressureMatchup.homePoints > before);
  teams.home.pressureGeneratedRate -= .1;
  teams.home.pressureAllowedRate += .1;
  assert.ok(compareTeams(teams.away, teams.home, 6).pressureMatchup.homePoints < before);
});

test("pressure ablation reports its existing final-margin effect without another pressure score", () => {
  const input = fixture();
  input.teamMetrics.home.pressureGeneratedRate = .4;
  const pressureMatchup = { active: true, available: true, homePoints: .2, awayPoints: -.2, confidence: .8 };
  const result = predict(input, { modelLayers: { scoringBaseline: baseline, pressureMatchup } });
  const output = result.matchupIntelligence.signals.find((s) => s.category === "Pressure");
  const without = predict(input);
  close(output.modelMarginContribution, result.continuousMargin - without.continuousMargin, .0001);
  assert.ok(output.modelMarginContribution > 0);
  assert.ok(output.explanationSafe);
  assert.match(output.explanation, /hit\/sack proxy/);
});

for (const [layer, field] of [["passMatchup", "passingEpaPerPlay"], ["rushMatchup", "rushingEpaPerPlay"],
  ["successMatchup", "successRate"], ["explosiveMatchup", "explosivePlayRate"]]) {
  test(`${layer}: opponent-adjustment-only ablation changes the actual prediction`, () => {
    const input = fixture(), original = predict(input);
    input.teamMetrics.home.opponentAdjusted[field] += .2;
    const adjusted = predict(input);
    assert.ok(adjusted.continuousMargin > original.continuousMargin);
    assert.ok(adjusted.matchupIntelligence.signals.find((s) => s.layer === layer).metricAdjustmentHomePoints > 0);
  });
}

test("a locally reversed simulation effect is not explained as the intended matchup advantage", () => {
  const input = fixture();
  input.teamMetrics.home.rushingEpaPerPlay += .1;
  const raw = signal(input, "rushMatchup");
  const reversed = explainMatchupSignal(raw, -.05);
  assert.equal(reversed.explanationSafe, false);
  assert.equal(reversed.explanation, null);
});

test("zero contributions cannot support an explanation, including a saturated scoring stack", () => {
  assert.ok(predict().matchupIntelligence.signals.every((s) => !s.explanationSafe));
  const input = fixture();
  input.teamMetrics.home.passingEpaPerPlay = 1;
  const strong = Object.fromEntries(["quarterback", "rosterHealth", "playerRatings", "opponentNetwork"]
    .map((key) => [key, { active: true, awayPoints: -2.5, homePoints: 2.5, confidence: 1 }]));
  const saturated = predict(input, { modelLayers: { ...strong, scoringBaseline: baseline }   });
  const passing = saturated.matchupIntelligence.signals.find((s) => s.layer === "passMatchup");
  assert.equal(passing.modelMarginContribution, 0);
  assert.equal(passing.explanationSafe, false);
});

test("current personnel score changes leave raw model evidence unchanged", () => {
  const input = real(6, "HOU", "JAX");
  const shared = {
    scoringBaseline: { active: true, awayExpected: 22.8, homeExpected: 21.6,
      gamesUsed: { away: 5, home: 5 }, confidence: .65 },
    opponentNetwork: { active: true, available: true, awayPoints: .18, homePoints: -.18, confidence: .5 },
  };
  const evaluate = (personnelLayers) => predictMatchup(input.away, input.home, {
    season: 2026, week: 6, kickoff: "2026-10-18T20:25:00Z", weather: { dome: true },
    teamMetrics: input.teamMetrics, playerMetrics: input.playerMetrics,
    modelLayers: { ...shared, ...personnelLayers },
  });
  const healthy = evaluate({
    quarterback: { active: false, awayPoints: 0, homePoints: 0 },
    rosterHealth: { active: false, awayPoints: 0, homePoints: 0 },
  });
  const personnelChanged = evaluate({
    quarterback: { active: true, awayPoints: -1.5, homePoints: 0, confidence: .7 },
    rosterHealth: { active: true, awayPoints: -.4, homePoints: 0, confidence: .78 },
  });

  assert.notEqual(personnelChanged.continuousMargin, healthy.continuousMargin);
  assert.notDeepEqual(personnelChanged.home.expectedPlayMix, healthy.home.expectedPlayMix);
  for (const layer of ["rushMatchup", "passMatchup", "successMatchup", "explosiveMatchup", "pressureMatchup",
    "thirdDownMatchup", "redZoneMatchup", "opponentNetwork"]) {
    assert.deepEqual(personnelChanged.modelLayers[layer], healthy.modelLayers[layer], layer);
  }
});

test("expected mix preserves observed style, shares and possession/pace context", () => {
  const input = real();
  const prediction = predict(input);
  const mix = buildExpectedPlayMix({ ...input, prediction, season: 2026, week: 6 });
  for (const side of ["away", "home"]) {
    const m = mix[side];
    assert.ok(m.available);
    close(m.passRate + m.rushRate, 1);
    close(m.expectedDropbacks + m.expectedRushes, m.expectedPlays, .0002);
    assert.ok(Math.abs(m.matchupShift) <= .015);
    assert.ok(Math.abs(m.scriptShift) <= .035);
    assert.ok(m.expectedPlays >= 48 && m.expectedPlays <= 82);
    const totals = input.playerMetrics[side].teamTotals;
    close(m.basePassRate, (totals.passAttempts + totals.sacksAllowed) /
      (totals.passAttempts + totals.sacksAllowed + totals.rushingAttempts), .0001);
  }
});

test("observed run-heavy identity is retained even against a much weaker pass allowance", () => {
  const input = real(), prediction = predict(input);
  input.playerMetrics = structuredClone(input.playerMetrics);
  input.teamMetrics = structuredClone(input.teamMetrics);
  input.playerMetrics.away.teamTotals.passAttempts = 35;
  input.playerMetrics.away.teamTotals.sacksAllowed = 5;
  input.playerMetrics.away.teamTotals.rushingAttempts = 60;
  input.teamMetrics.home.passingEpaAllowedPerPlay = 5;
  prediction.away.expectedPoints = prediction.home.expectedPoints;
  const mix = buildExpectedPlayMix({ ...input, prediction, season: 2026, week: 6 }).away;
  assert.ok(mix.available);
  close(mix.basePassRate, .4);
  assert.ok(mix.passRate < .42);
  assert.ok(mix.rushRate > mix.passRate);
});

test("weak pass defense moves tendency by no more than 1.5 points; script and pace remain separate", () => {
  const input = real();
  input.teamMetrics = structuredClone(input.teamMetrics);
  const prediction = predict(input);
  const run = () => buildExpectedPlayMix({ ...input, prediction, season: 2026, week: 6 }).away;
  const initial = run();
  input.teamMetrics.home.passingEpaAllowedPerPlay = 10;
  const weak = run();
  assert.ok(weak.matchupShift <= .015);
  assert.ok(weak.passRate - initial.passRate <= .0301);
  prediction.away.expectedPoints = prediction.home.expectedPoints - 20;
  assert.ok(run().scriptShift > initial.scriptShift);
  const plays = run().expectedPlays;
  prediction.away.expectedPossessions += 1;
  assert.ok(run().expectedPlays > plays);
});

test("earlier empty profiles, mismatched season/week and unproven timing cannot create a play mix", () => {
  for (const week of [2, 3, 4, 5]) {
    const input = real(week), prediction = predict(input, { week });
    const mix = buildExpectedPlayMix({ ...input, prediction, season: 2026, week });
    assert.equal(mix.away.available, false);
    assert.equal(mix.home.available, false);
  }
  const input = real();
  assert.equal(predict(input, { season: 2025 }).matchupIntelligence.available, false);
  assert.equal(predict(input, { week: 5 }).matchupIntelligence.available, false);
  input.playerMetrics = structuredClone(input.playerMetrics);
  input.playerMetrics.away.gameProvenance[0].completedAsOf = "2027-01-01T00:00:00Z";
  const mix = buildExpectedPlayMix({ ...input, prediction: predict(input), season: 2026, week: 6 });
  assert.equal(mix.away.available, false);
});

test("structured output is deterministic and uses no network or generated prose service", () => {
  const input = real();
  assert.deepEqual(predict(input, { playerMetrics: input.playerMetrics }), predict(input, { playerMetrics: input.playerMetrics }));
});

test("full orchestration passes real artifact matchups through predictions, roles and TD output", async () => {
  const original = global.fetch, input = real(6, "CHI", "KC");
  const teamPayload = { ...input.teamMetrics,
    modelLayers: compareTeams(input.teamMetrics.away, input.teamMetrics.home, 6) };
  global.fetch = async (url) => {
    const text = String(url);
    assert.ok(text.startsWith("/api/"), "No external requests permitted");
    let body = {};
    if (text.startsWith("/api/nfl/play-by-play")) body = teamPayload;
    if (text.includes("action=player-metrics")) body = input.playerMetrics;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  try {
    clearFullGamePredictionCache();
    const result = await getFullGamePrediction({ away: "CHI", home: "KC", week: 6,
      sourceDate: "2026-10-18T20:25:00Z", weather: { dome: true } }, null, { season: 2026, forceRefresh: true });
    assert.ok(result.prediction.matchupIntelligence.available);
    assert.ok(result.prediction.away.expectedPlayMix.available);
    assert.ok(result.prediction.matchupIntelligence.signals.some((s) => s.explanationSafe));
    close(result.playerProjections.away.passRate, result.prediction.away.expectedPlayMix.passRate);
    const qb = result.playerProjections.away.players.find((p) => p.position === "QB");
    assert.equal(qb.playerId, input.teamMetrics.away.expectedLineup.startingQuarterback.gsisId);
    assert.ok(result.bestBets.anytimeTdScorer);
    finiteNumbers(result.prediction);
    finiteNumbers(result.playerProjections);
  } finally { global.fetch = original; clearFullGamePredictionCache(); }
});

test("all 32 real teams have finite named matchups without changing existing coarse roster or network layers", () => {
  const codes = Object.keys(dataset.metricsByWeek[6]).sort();
  const phase1Layers = ["rushMatchup", "passMatchup", "successMatchup", "explosiveMatchup", "pressureMatchup"];
  for (let i = 0; i < codes.length; i += 2) {
    const input = real(6, codes[i], codes[i + 1]);
    const network = { active: true, homePoints: .3, awayPoints: -.3, confidence: .8 };
    const roster = { active: true, homePoints: .2, awayPoints: -.2, confidence: .7 };
    const options = { playerMetrics: input.playerMetrics,
      modelLayers: { ...compareTeams(input.teamMetrics.away, input.teamMetrics.home, 6),
        scoringBaseline: baseline, opponentNetwork: network, playerRatings: roster } };
    const result = predict(input, options);
    finiteNumbers(result);
    assert.equal(result.modelLayers.opponentNetwork.homePoints, .3);
    assert.equal(result.modelLayers.playerRatings.homePoints, .2);
    const signals = result.matchupIntelligence.signals;
    assert.equal(signals.length, 7);
    assert.deepEqual(signals.map((s) => s.layer), [...phase1Layers, "thirdDownMatchup", "redZoneMatchup"]);
    assert.equal(new Set(signals.map((s) => s.category)).size, 7);
    assert.ok(signals.slice(5).every((s) => s.available && s.phase === "2A" && s.matchups));
    const withoutSituational = structuredClone(input);
    delete withoutSituational.teamMetrics.away.situational;
    delete withoutSituational.teamMetrics.home.situational;
    const phase1 = predict(withoutSituational, options);
    assert.deepEqual(signals.slice(0, 5), phase1.matchupIntelligence.signals);
    assert.deepEqual(phase1.matchupIntelligence.signals.map((s) => s.layer), phase1Layers);
    assert.ok(phase1.matchupIntelligence.situational.signals.every((s) => !s.available && !s.explanationSafe));
    for (const key of ["thirdDown", "redZone"]) {
      const unsupported = structuredClone(input);
      delete unsupported.teamMetrics.home.situational[key];
      const output = predict(unsupported, options);
      assert.deepEqual(output.matchupIntelligence.signals, phase1.matchupIntelligence.signals);
      assert.equal(output.matchupIntelligence.situational.available, false);
      assert.equal(output.matchupIntelligence.situational.finalMarginAblation, 0);
    }
    const projected = buildPlayerProjections({ ...input, prediction: result, season: 2026, week: 6,
      cutoff: players.cutoffs[6] });
    assert.ok(projected.available);
    finiteNumbers(projected);
  }
});

test("earlier real weeks keep exactly the five ordered Phase 1 signals when situational provenance is unavailable", () => {
  const phase1Layers = ["rushMatchup", "passMatchup", "successMatchup", "explosiveMatchup", "pressureMatchup"];
  for (const week of [2, 3, 4, 5]) {
    const input = real(week);
    const result = predict(input, { week, playerMetrics: input.playerMetrics });
    const signals = result.matchupIntelligence.signals;
    assert.equal(signals.length, 5);
    assert.deepEqual(signals.map((s) => s.layer), phase1Layers);
    assert.equal(new Set(signals.map((s) => s.category)).size, 5);
    const situational = result.matchupIntelligence.situational;
    assert.equal(situational.available, false);
    assert.equal(situational.finalMarginAblation, 0);
    assert.equal(situational.sharedPreSimulationMargin, 0);
    assert.ok(situational.signals.every((s) =>
      !s.available && !s.explanationSafe && s.homePoints === 0 && s.awayPoints === 0 && s.reason));
    const withoutSituational = structuredClone(input);
    delete withoutSituational.teamMetrics.away.situational;
    delete withoutSituational.teamMetrics.home.situational;
    const without = predict(withoutSituational, { week, playerMetrics: input.playerMetrics });
    assert.deepEqual(signals, without.matchupIntelligence.signals);
    assert.equal(result.continuousMargin, without.continuousMargin);
    assert.equal(result.homeWinProbability, without.homeWinProbability);
    assert.equal(result.awayWinProbability, without.awayWinProbability);
  }
});

test("both Matchup prediction paths receive context without rewriting saved snapshots", () => {
  const source = readFileSync(new URL("../src/components/MatchupPrediction.jsx", import.meta.url), "utf8");
  assert.match(source, /teamMetrics: playByPlayData/);
  assert.match(source, /<MatchupIntelligencePanel prediction=\{prediction\}/);
  assert.match(source, /const prediction = applyPredictionSnapshot\(officialSnapshot\) \|\| localPrediction/);
  assert.doesNotMatch(source, /getFullGamePrediction|createOfficialSnapshot/);
});
