import test from "node:test";
import assert from "node:assert/strict";
import { buildScoringBaseline, calculateWeightedAverage, compareForms } from "../api/nfl/game-stats.js";
import { compareTeams } from "../api/nfl/play-by-play.js";
import { buildQuarterbackLayer } from "../src/services/gamePredictionService.js";
import { createModelLayers, predictMatchup } from "../src/services/predictionEngine.js";

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const games = (count, score = 24) => Array.from({ length: count }, (_, index) => ({
  id: index + 1,
  week: index + 1,
  visitor_team: { abbreviation: "SF" },
  home_team: { abbreviation: "KC" },
  visitor_team_score: score,
  home_team_score: score,
}));
const average = (rows) => calculateWeightedAverage(rows, "SF", true, 0, 100);
const baselineLayer = {
  active: true, awayExpected: 24, homeExpected: 25,
  gamesUsed: { away: 4, home: 4 }, confidence: 0.6,
};
function predict(layers = {}) {
  return predictMatchup("SF", "KC", {
    week: 6,
    kickoff: "2026-10-18T20:25:00.000Z",
    modelLayers: { scoringBaseline: baselineLayer, ...layers },
  });
}
function finitePrediction(prediction) {
  for (const value of [
    prediction.away.score, prediction.home.score,
    prediction.away.expectedPoints, prediction.home.expectedPoints,
    prediction.continuousMargin, prediction.margin, prediction.total,
    prediction.homeWinProbability, prediction.awayWinProbability, prediction.confidenceScore,
  ]) {
    assert.equal(typeof value, "number");
    assert.ok(Number.isFinite(value));
  }
}
function improves(before, after, direction) {
  finitePrediction(before);
  finitePrediction(after);
  assert.ok((after.continuousMargin - before.continuousMargin) * direction > 0,
    `margin ${before.continuousMargin} -> ${after.continuousMargin}, direction ${direction}`);
  assert.ok((after.homeWinProbability - before.homeWinProbability) * direction > 0,
    `probability ${before.homeWinProbability} -> ${after.homeWinProbability}, direction ${direction}`);
}

test("empty scoring history uses the existing 22-point league prior", () => {
  assert.equal(average([]), 22);
  const layer = buildScoringBaseline("SF", "KC", [], [], [], 22);
  assert.equal(layer.awayExpected, 22);
  assert.equal(layer.homeExpected, 22);
  const prediction = predict({ scoringBaseline: layer });
  finitePrediction(prediction);
  assert.equal(prediction.formBlend.source, "team-rating scoring fallback");
});

for (let count = 1; count <= 18; count += 1) {
  test(`${count} identical scoring games retain their value and generate finite predictions`, () => {
    const rows = games(count);
    close(average(rows), 24);
    const layer = buildScoringBaseline("SF", "KC", rows, rows, rows, 24);
    close(layer.awayExpected, 24, 0.001);
    close(layer.homeExpected, 24, 0.001);
    assert.ok(!JSON.stringify(layer).includes("null"));
    const prediction = predict({ scoringBaseline: layer });
    finitePrediction(prediction);
    assert.equal(prediction.formBlend.source, "current-season team scoring");
  });
}

test("last-four recency weights are preserved; older games retain the oldest weight", () => {
  const rows = games(6);
  rows.forEach((row, index) => { row.visitor_team_score = index * 10; });
  close(average(rows), (0 * .75 + 10 * .75 + 20 * .75 + 30 * .85 + 40 * .95 + 50) / 5.05);
  close(average(rows.slice(-4)), (20 * .75 + 30 * .85 + 40 * .95 + 50) / 3.55);
  assert.ok(average(rows) > average([...rows].reverse()));
});

test("zero is a real score, but missing and nonfinite scores are explicitly rejected", () => {
  assert.equal(average(games(5, 0)), 0);
  for (const score of [null, undefined, "", " ", false, NaN, Infinity, -Infinity, "invalid"]) {
    assert.throws(() => average(games(5, score).map((row) => ({ ...row, visitor_team_score: score }))), /Invalid away score/);
  }
  assert.throws(() => buildScoringBaseline("SF", "KC", [
    { ...games(1)[0], visitor_team_score: null },
  ], games(5), games(5), 24), /Invalid away score/);
});

test("scoring baseline preserves home/away scoring and points-allowed orientation", () => {
  const rows = games(5).map((row) => ({ ...row, visitor_team_score: 30, home_team_score: 10 }));
  close(calculateWeightedAverage(rows, "SF", true, 0, 100), 30);
  close(calculateWeightedAverage(rows, "SF", false, 0, 100), 10);
  close(calculateWeightedAverage(rows, "KC", true, 0, 100), 10);
  close(calculateWeightedAverage(rows, "KC", false, 0, 100), 30);
});

const metricTeam = () => ({
  games: 6, offensivePlays: 400, defensivePlays: 400,
  epaPerPlay: 0, defensiveEpaPerPlay: 0, earlyDownEpaPerPlay: 0,
  successRate: .45, defensiveSuccessRate: .45,
  explosivePlayRate: .1, explosivePlayRateAllowed: .1,
  scoringDriveRate: .4, threeAndOutRate: .2,
  thirdDownRate: .4, redZoneTouchdownRate: .5,
  pressureGeneratedRate: .2, pressureAllowedRate: .2,
  passingEpaPerPlay: 0, passingEpaAllowedPerPlay: 0,
  playsPerGame: 63,
});
function pbpLayers(side, field, change) {
  const away = metricTeam();
  const home = metricTeam();
  const team = side === "home" ? home : away;
  team[field] += change;
  return compareTeams(away, home, 6);
}

for (const side of ["home", "away"]) {
  for (const change of [-.8, .8]) {
    test(`${side} passing EPA ${change} moves coverage, margin and probability correctly`, () => {
      const before = pbpLayers(side, "passingEpaPerPlay", 0).coverageMatchup;
      const after = pbpLayers(side, "passingEpaPerPlay", change).coverageMatchup;
      const direction = (side === "home" ? 1 : -1) * Math.sign(change);
      assert.ok((after.homePoints - before.homePoints) * direction > 0);
      improves(predict({ coverageMatchup: before }), predict({ coverageMatchup: after }), direction);
    });
    test(`${side} passing EPA allowed ${change} helps the opposing offense in both directions`, () => {
      const before = pbpLayers(side, "passingEpaAllowedPerPlay", 0).coverageMatchup;
      const after = pbpLayers(side, "passingEpaAllowedPerPlay", change).coverageMatchup;
      const direction = (side === "home" ? -1 : 1) * Math.sign(change);
      assert.ok((after.homePoints - before.homePoints) * direction > 0);
      improves(predict({ coverageMatchup: before }), predict({ coverageMatchup: after }), direction);
    });
  }
  for (const field of ["pressureGeneratedRate", "pressureAllowedRate"]) {
    for (const change of [-.2, .3]) {
      test(`${side} ${field} ${change}: both pressure layers agree and final predictions follow`, () => {
        const direction = (side === "home" ? 1 : -1) *
          (field === "pressureGeneratedRate" ? 1 : -1) * Math.sign(change);
        const before = pbpLayers(side, field, 0);
        const after = pbpLayers(side, field, change);
        for (const name of ["passProtection", "pressureMatchup"]) {
          assert.ok((after[name].homePoints - before[name].homePoints) * direction > 0);
          improves(predict({ [name]: before[name] }), predict({ [name]: after[name] }), direction);
        }
        const selected = (layers) => ({
          passProtection: layers.passProtection, pressureMatchup: layers.pressureMatchup,
        });
        improves(predict(selected(before)), predict(selected(after)), direction);
      });
    }
  }
}

const form = () => ({
  games: 4, offensivePlaysPerGame: 63,
  defensiveSacksPerGame: 1, sackRateAllowed: 1 / 30,
  passingYardsPerAttempt: 6.7, rushingYardsPerAttempt: 4.2, completionRate: .64,
  offensiveTouchdownsPerGame: 2.5, explosivePlayProxyPerGame: 2, pointsForPerGame: 22,
  fumbleRecoveryRate: .5, turnoverMarginPerGame: 0,
  raw: { passingAttempts: 116, sacksAllowed: 4, interceptionsThrown: 3 },
});
function sackLayers(side, field, change) {
  const away = form();
  const home = form();
  (side === "home" ? home : away)[field] += change;
  return compareForms(away, home);
}
for (const side of ["home", "away"]) {
  for (const [field, change] of [
    ["defensiveSacksPerGame", 2], ["defensiveSacksPerGame", -1],
    ["sackRateAllowed", .08], ["sackRateAllowed", -.03],
  ]) {
    test(`${side} ${field} ${change} preserves defensive/offensive sack direction`, () => {
      const direction = (side === "home" ? 1 : -1) *
        (field === "defensiveSacksPerGame" ? 1 : -1) * Math.sign(change);
      const before = sackLayers(side, field, 0);
      const after = sackLayers(side, field, change);
      for (const name of ["schemeMatchup", "passProtection"]) {
        assert.ok((after[name].homePoints - before[name].homePoints) * direction > 0);
        improves(predict({ [name]: before[name] }), predict({ [name]: after[name] }), direction);
      }
    });
  }
}

test("sack-rate conversion uses passing attempts plus sacks, not rush volume", () => {
  const away = form(), home = form();
  const before = compareForms(away, home).schemeMatchup;
  const after = compareForms({ ...away, offensivePlaysPerGame: 100 }, home).schemeMatchup;
  assert.deepEqual(before, after);
  const layers = compareForms(away, { ...home, sackRateAllowed: .1 });
  close(layers.schemeMatchup.homePoints, -.12);
});

test("empty box-score samples retain neutral layers without dividing by zero", () => {
  const empty = { ...form(), games: 0, raw: { passingAttempts: 0, sacksAllowed: 0 } };
  const layers = compareForms(empty, empty);
  for (const layer of Object.values(layers)) {
    assert.ok(Number.isFinite(layer.homePoints));
    assert.ok(Number.isFinite(layer.awayPoints));
  }
  finitePrediction(predict(layers));
});

const personnel = (points = 0, confidence = .8) => ({ points, confidence, reasons: [] });
const qbr = (seasonQbr = 68, weeklyQbr = 78) => ({
  playerName: "Test QB", seasonQbr, weeklyQbr, plays: 120, week: 5,
});
test("absent QBR receives zero weight and does not dilute personnel or its confidence", () => {
  const layer = buildQuarterbackLayer(personnel(0), personnel(2), null, null, 6);
  assert.equal(layer.homePoints, 2);
  close(layer.confidence, .8);
  assert.deepEqual(layer.qbr.effectiveWeights, { away: 0, home: 0 });
  assert.equal(layer.available, true);
});
test("present QBR preserves intended full-source weighting", () => {
  for (const [week, weight, recent] of [[2, .4, .2], [4, .55, .35], [6, .65, .45]]) {
    const layer = buildQuarterbackLayer(personnel(1), personnel(1), qbr(86, 78), qbr(86, 78), week);
    const signal = (2 * (1 - recent) + 1 * recent);
    close(layer.homePoints, signal * weight + 1 * (1 - weight), .001);
    close(layer.confidence, weight + .8 * (1 - weight));
    assert.equal(layer.qbr.effectiveWeights.home, weight);
  }
});
test("partial source availability is renormalized independently for each team", () => {
  const layer = buildQuarterbackLayer(personnel(2), null, null, qbr(), 6);
  assert.equal(layer.awayPoints, 2);
  assert.equal(layer.homePoints, 1);
  close(layer.confidence, .8);
  assert.deepEqual(layer.qbr.effectiveWeights, { away: 0, home: 1 });
});
test("missing QBR fields are not zero ratings; partial QBR uses only valid components", () => {
  for (const invalid of [null, {}, { seasonQbr: null, weeklyQbr: "" }, qbr(NaN, Infinity)]) {
    const layer = buildQuarterbackLayer(personnel(2), personnel(2), invalid, invalid, 6);
    assert.equal(layer.homePoints, 2);
    assert.equal(layer.qbr.effectiveWeights.home, 0);
  }
  for (const partial of [qbr(68, null), qbr(null, 78)]) {
    const layer = buildQuarterbackLayer(null, null, partial, partial, 6);
    assert.equal(layer.homePoints, 1);
    assert.equal(layer.confidence, 1);
  }
  assert.ok(buildQuarterbackLayer(null, null, qbr(0, 0), qbr(0, 0), 6).homePoints < 0);
});
test("all absent QB/personnel data is explicitly unavailable with zero confidence", () => {
  const layer = buildQuarterbackLayer(null, undefined, null, {}, 6);
  assert.equal(layer.available, false);
  assert.equal(layer.confidence, 0);
  assert.equal(layer.homePoints, 0);
  assert.equal(layer.awayPoints, 0);
  finitePrediction(predict({ quarterback: layer }));
});
test("missing personnel cannot dilute QBR and missing one team's sources lowers coverage", () => {
  const onlyQbr = buildQuarterbackLayer(null, null, qbr(), qbr(), 6);
  assert.equal(onlyQbr.homePoints, 1);
  assert.equal(onlyQbr.confidence, 1);
  assert.deepEqual(onlyQbr.qbr.effectiveWeights, { away: 1, home: 1 });
  const oneSide = buildQuarterbackLayer(null, personnel(2), null, null, 6);
  assert.equal(oneSide.awayPoints, 0);
  assert.equal(oneSide.homePoints, 2);
  assert.equal(oneSide.confidence, 0);
});
for (const side of ["home", "away"]) {
  for (const change of [-2, 2]) {
    test(`${side} personnel ${change} moves margin/probability without missing-QBR dilution`, () => {
      const before = buildQuarterbackLayer(personnel(), personnel(), null, null, 6);
      const after = buildQuarterbackLayer(
        personnel(side === "away" ? change : 0),
        personnel(side === "home" ? change : 0), null, null, 6,
      );
      improves(predict({ quarterback: before }), predict({ quarterback: after }),
        (side === "home" ? 1 : -1) * Math.sign(change));
    });
  }
}

test("existing PBP, sack, QB and aggregate caps remain finite and bounded", () => {
  const metrics = compareTeams(metricTeam(), {
    ...metricTeam(), passingEpaPerPlay: 100, pressureGeneratedRate: 100,
  }, 6);
  assert.ok(Math.abs(metrics.coverageMatchup.homePoints) <= .5 * .8 / 2);
  assert.ok(Math.abs(metrics.passProtection.homePoints) <= .65 * .8 / 2);
  assert.ok(Math.abs(metrics.pressureMatchup.homePoints) <= .55 * .8 / 2);
  const sacks = compareForms(form(), { ...form(), defensiveSacksPerGame: 100 });
  assert.ok(Math.abs(sacks.schemeMatchup.homePoints) <= .8 / 2);
  const qb = buildQuarterbackLayer(personnel(-100), personnel(100), null, null, 6);
  assert.equal(qb.awayPoints, -3.5);
  assert.equal(qb.homePoints, 3.5);
  const all = createModelLayers({ ...metrics, ...sacks, quarterback: qb });
  assert.ok(Math.abs(all.awayPoints) <= 7.5);
  assert.ok(Math.abs(all.homePoints) <= 7.5);
  finitePrediction(predict({ ...metrics, ...sacks, quarterback: qb }));
});
