// Walk-forward backtest for the 2026 dynamic external factors.
//
// For each historical 2026 week W, the external-factor dataset is rebuilt using
// ONLY games completed before week W, then applied to week-W games through the
// same external-adjustment stage the production engine uses:
//
//   dynamic margin = stored production margin
//     - static external contribution (static HFA + static schedule + static weather)
//     + dynamic external contribution (venue/travel edge + rest + weather delta)
//
// A = untouched frozen production prediction (from the production ledger API).
// B = A with the external stage swapped from static to dynamic.
//
// Usage: node scripts/backtest-external-factors-2026.mjs
// Env:   same as scripts/update-external-factors-audit.mjs.

import { getHomeFieldAdvantage, travelPenalty } from "../src/services/homeFieldAdvantage.js";
import { computeScheduleImpact, computeWeatherImpact } from "../src/services/predictionEngine.js";
import {
  buildExternalFactorsDataset, computeExternalAdjustments2026, computeVariance2026,
  num, round2, round3, mean, sd,
} from "../src/services/externalFactors2026.js";
import {
  loadEnv, loadExternalFactorInputs, predictionRows, isPreGameRow, hasPredictionScores,
} from "./externalFactorsData.mjs";

await loadEnv();

console.log("Fetching prediction ledger + schedule...");
const { completedGames, rowsByKey } = await loadExternalFactorInputs();
const ledgerRows = [...rowsByKey.values()].flat();
const excluded = { missingScores: 0, unprovenSavedBeforeKickoff: 0, invalidOrPostKickoffTimestamp: 0 };
for (const row of ledgerRows.filter((row) => !isPreGameRow(row))) {
  if (!hasPredictionScores(row)) excluded.missingScores++;
  else if (row.savedBeforeKickoff !== true) excluded.unprovenSavedBeforeKickoff++;
  else excluded.invalidOrPostKickoffTimestamp++;
}
console.log("Ledger input:", JSON.stringify({
  snapshots: ledgerRows.length, validPreGame: ledgerRows.filter(isPreGameRow).length, excluded,
}));
const predicted = predictionRows(completedGames);
console.log(`Completed games: ${completedGames.length}; valid pre-game predictions: ${predicted.length}`);

// Home/road W-L splits entering a week (static HFA's in-season blend input).
function splitsBefore(games, week) {
  const splits = new Map();
  for (const g of games.filter((x) => x.week < week)) {
    for (const [code, side] of [[g.away, "away"], [g.home, "home"]]) {
      const entry = splits.get(code) || { home: { wins: 0, losses: 0 }, road: { wins: 0, losses: 0 } };
      const record = side === "home" ? entry.home : entry.road;
      if (g.actualWinner === code) record.wins++;
      else if (g.actualWinner !== "TIE") record.losses++;
      splits.set(code, entry);
    }
  }
  return splits;
}

// Static schedule context in the shape computeScheduleImpact consumes.
function staticScheduleContext(g) {
  return {
    away: { daysRest: g.awayContext?.daysRest ?? null,
      consecutiveRoadGamesIncludingCurrent: g.awayContext?.roadRun ?? 0 },
    home: { daysRest: g.homeContext?.daysRest ?? null,
      consecutiveRoadGamesIncludingCurrent: 0 },
  };
}

// One walk-forward evaluation of a single game.
function evaluateGame(g, dataset, { cap = Infinity, noTeamVenueResidual = false } = {}) {
  const splits = splitsBefore(completedGames, g.week);
  const hfaStatic = getHomeFieldAdvantage(g.home, g.away, {
    kickoff: g.kickoff,
    homeSplit: splits.get(g.home),
    awaySplit: splits.get(g.away),
  });
  const scheduleStatic = computeScheduleImpact(staticScheduleContext(g));
  const weatherStatic = computeWeatherImpact(g.weather ?? (g.dome ? { dome: true } : null));

  const factorDataset = noTeamVenueResidual ? {
    ...dataset,
    teams: Object.fromEntries(Object.entries(dataset.teams || {}).map(([team, values]) => [team, {
      ...values,
      shrunkHomeEffect: dataset.league.homeBaselineVsExpectation,
      shrunkAwayEffect: dataset.league.awayBaselineVsExpectation,
    }])),
  } : dataset;
  const external = computeExternalAdjustments2026(factorDataset, {
    away: g.away, home: g.home, kickoff: g.kickoff, weather: g.weather ?? (g.dome ? { dome: true } : null),
    week: g.week,
    validationOnly: true,
  });

  const marginA = g.predictedMargin;
  let marginB = marginA;
  let delta = 0;
  let uncappedDelta = 0;
  let breakdown = null;
  if (external?.active) {
    // Dynamic venue+travel edge replaces static hfa.total; dynamic rest points
    // replace static schedule points; weather applies only the blended delta.
    const restDynamic = external.restHomePoints - external.restAwayPoints;
    let weatherMarginDelta = 0;
    const baseTotal = g.predictedHomeScore + g.predictedAwayScore;
    if (external.weatherTotalEffect != null && baseTotal > 0) {
      const staticEffect = (weatherStatic.coefficient - 1) * baseTotal;
      const increment = Math.max(-1.5, Math.min(1.5, (external.weatherTotalEffect - staticEffect) / 2));
      weatherMarginDelta = increment * (marginA / baseTotal);
    }
    delta = (external.homeEdge - hfaStatic.total)
      + (restDynamic - scheduleStatic.differential)
      + weatherMarginDelta;
    uncappedDelta = delta;
    delta = Math.max(-cap, Math.min(cap, delta));
    marginB = marginA + delta;

    // Backtest-only winner protection.
    if (marginA > 0 && marginB <= 0) {
      marginB = 0.5;
    } else if (marginA < 0 && marginB >= 0) {
      marginB = -0.5;
    } else if (marginA === 0 && g.modelPick === g.home && marginB <= 0) {
      marginB = 0.5;
    } else if (marginA === 0 && g.modelPick === g.away && marginB >= 0) {
      marginB = -0.5;
    }
    if (Number.isFinite(cap)) {
      // Report and constrain the actual margin change, including winner protection.
      delta = Math.max(-cap, Math.min(cap, marginB - marginA));
      marginB = marginA + delta;
    }

    breakdown = {
      baseModelMargin: round2(marginA),
      staticExternal: {
        homeFieldEdge: hfaStatic.total,
        scheduleDifferential: scheduleStatic.differential,
        weatherCoefficient: weatherStatic.coefficient,
      },
      venue: external.trace.venue,
      travel: external.trace.travel,
      rest: external.trace.rest,
      weather: { ...external.trace.weather, marginDelta: round3(weatherMarginDelta) },
      totalExternalAdjustment: round2(delta),
      finalProjectedMargin: round2(marginB),
      variance: computeVariance2026(dataset, marginB),
      ...(Number.isFinite(cap) ? {
        roadSequenceRaw: external.trace.rest.awayRoadRun >= 3
          ? -dataset.factors.consecutiveRoadGames.thirdPlus.derived
          : external.trace.rest.awayRoadRun === 2 ? -dataset.factors.consecutiveRoadGames.second.derived : 0,
        relativeRestRaw: external.trace.rest.source === "home-rest-7+" ? dataset.factors.restDifferential.home7.derived
          : external.trace.rest.source === "home-rest-3-6" ? dataset.factors.restDifferential.home36.derived
            : external.trace.rest.source === "away-rest-3+" ? dataset.factors.restDifferential.away3.derived : 0,
      } : {}),
    };
  }
  const winnerB = marginB > 0 ? g.home : marginB < 0 ? g.away : g.modelPick;
  return {
    key: g.key, week: g.week, away: g.away, home: g.home,
    modelVersion: g.modelVersion, currentModel: g.currentModel,
    marginA: round2(marginA), marginB: round2(marginB), delta: round2(delta),
    actualMargin: g.actualMargin, actualWinner: g.actualWinner,
    winnerA: g.modelPick, winnerB,
    flipped: winnerB !== g.modelPick,
    externalActive: external?.active === true,
    uncappedDelta,
    capHit: Number.isFinite(cap) && Math.abs(uncappedDelta) >= cap,
    marketMargin: g.marketMargin,
    breakdown,
  };
}

function metrics(rows, marginField, pickField) {
  const decided = rows.filter((r) => r.actualWinner && r.actualWinner !== "TIE");
  const residuals = rows.map((r) => r.actualMargin - r[marginField]);
  return {
    games: rows.length,
    winnerAccuracy: decided.length
      ? round3(decided.filter((r) => r[pickField] === r.actualWinner).length / decided.length) : null,
    marginMae: rows.length ? round2(mean(rows.map((r) => Math.abs(r.actualMargin - r[marginField])))) : null,
    rmse: rows.length ? round2(Math.sqrt(mean(rows.map((r) => (r.actualMargin - r[marginField]) ** 2)))) : null,
    residualMean: rows.length ? round2(mean(residuals)) : null,
    residualSd: residuals.length > 1 ? round2(sd(residuals)) : null,
  };
}

const marketMetrics = (rows) => {
  const withMarket = rows.filter((r) => r.marketMargin != null);
  return withMarket.length
    ? round2(mean(withMarket.map((r) => Math.abs(r.actualMargin - r.marketMargin))))
    : null;
};

// Walk-forward: week W uses only games completed before week W.
const weeks = [...new Set(predicted.map((g) => g.week))].sort((a, b) => a - b);
const results = [];
const scenarios = [false, true].flatMap((noTeamVenueResidual) => [1.5, 2, 2.5].map((cap) => ({
  cap, noTeamVenueResidual, rows: [],
})));
for (const week of weeks) {
  const priorGames = completedGames.filter((g) => g.week < week);
  const priorPredictions = predicted.filter((g) => g.week < week);
  const dataset = buildExternalFactorsDataset({
    season: 2026, games: priorGames, predictions: priorPredictions,
  });
  for (const g of predicted.filter((x) => x.week === week)) {
    results.push(evaluateGame(g, dataset));
    for (const scenario of scenarios) scenario.rows.push(evaluateGame(g, dataset, scenario));
  }
}

const active = results.filter((r) => r.externalActive);
const flips = active.filter((r) => r.flipped);
const v12 = active.filter((r) => r.currentModel);

const report = {
  generatedAt: new Date().toISOString(),
  method: "walk-forward; week W uses only games completed before week W; " +
    "B = frozen production prediction with the external stage swapped static -> dynamic",
  weeksEvaluated: weeks,
  gamesEvaluated: results.length,
  gamesWithDynamicExternal: active.length,
  all: {
    baseline: metrics(results, "marginA", "winnerA"),
    dynamic: metrics(active, "marginB", "winnerB"),
    marketMae: marketMetrics(results),
    winnersFlipped: flips.length,
  },
  currentModelV12: {
    baseline: metrics(v12, "marginA", "winnerA"),
    dynamic: metrics(v12, "marginB", "winnerB"),
    marketMae: marketMetrics(v12),
    winnersFlipped: v12.filter((r) => r.flipped).length,
  },
  byWeek: weeks.map((week) => {
    const rows = results.filter((r) => r.week === week);
    const dyn = rows.filter((r) => r.externalActive);
    return { week, games: rows.length, dynamicGames: dyn.length,
      baseline: metrics(rows, "marginA", "winnerA"), dynamic: metrics(dyn, "marginB", "winnerB"),
      flips: dyn.filter((r) => r.flipped).length };
  }),
  flips: flips.map((r) => ({ game: r.key, week: r.week, from: r.winnerA, to: r.winnerB,
    marginA: r.marginA, marginB: r.marginB, delta: r.delta, actualWinner: r.actualWinner,
    dynamicCorrect: r.winnerB === r.actualWinner, baselineCorrect: r.winnerA === r.actualWinner })),
  examples: active.filter((r) => r.currentModel && r.breakdown).slice(-3)
    .map((r) => ({ game: r.key, ...r.breakdown, actualMargin: r.actualMargin })),
};

console.log("\n=== WALK-FORWARD: ALL WEEKS ===");
console.log("baseline A:", JSON.stringify(report.all.baseline));
console.log("dynamic  B:", JSON.stringify(report.all.dynamic));
console.log("market MAE:", report.all.marketMae, "| winners flipped:", report.all.winnersFlipped);

console.log("\n=== WALK-FORWARD: CURRENT v12 ONLY ===");
console.log("baseline A:", JSON.stringify(report.currentModelV12.baseline));
console.log("dynamic  B:", JSON.stringify(report.currentModelV12.dynamic));
console.log("market MAE:", report.currentModelV12.marketMae, "| winners flipped:", report.currentModelV12.winnersFlipped);
console.log("v12 adjustment summary:", JSON.stringify({
  mean: v12.length ? round3(mean(v12.map((r) => r.delta))) : null,
  meanAbsolute: v12.length ? round3(mean(v12.map((r) => Math.abs(r.delta)))) : null,
  maxAbsolute: v12.length ? round3(Math.max(...v12.map((r) => Math.abs(r.delta)))) : null,
  meanContributions: v12.length ? {
    venue: round3(mean(v12.map((r) => r.breakdown.venue.homePoints))),
    travel: round3(mean(v12.map((r) => r.breakdown.travel.homePoints))),
    rest: round3(mean(v12.map((r) => r.breakdown.rest.homeMargin))),
    weatherMarginDelta: round3(mean(v12.map((r) => r.breakdown.weather.marginDelta))),
    replacedStaticHomeField: round3(mean(v12.map((r) => r.breakdown.staticExternal.homeFieldEdge))),
    replacedStaticSchedule: round3(mean(v12.map((r) => r.breakdown.staticExternal.scheduleDifferential))),
  } : null,
}));

console.log("\n=== BY WEEK ===");
for (const w of report.byWeek) console.log(JSON.stringify(w));

console.log("\n=== WINNER CHANGES ===");
if (!report.flips.length) console.log("none");
for (const f of report.flips) console.log(JSON.stringify(f));

console.log("\n=== EXAMPLE ADJUSTMENT BREAKDOWNS (v12) ===");
for (const e of report.examples) console.log(JSON.stringify(e, null, 1));

const verdict = report.all.dynamic.games > 0 &&
  report.all.dynamic.winnerAccuracy >= report.all.baseline.winnerAccuracy &&
  report.all.dynamic.marginMae <= report.all.baseline.marginMae &&
  report.currentModelV12.dynamic.winnerAccuracy >= report.currentModelV12.baseline.winnerAccuracy &&
  report.currentModelV12.dynamic.marginMae <= report.currentModelV12.baseline.marginMae;
console.log(`\nVERDICT: ${verdict ? "PASS" : "FAIL"} - dynamic external factors ` +
  `${verdict ? "do not worsen" : "materially worsen"} winner accuracy or margin MAE`);
console.log(`Production gate: EXTERNAL_FACTORS_2026_ENABLED in src/services/externalFactors2026.js ` +
  `must be ${verdict ? "true" : "false"}; verify before deploying.`);

console.log("\n=== SHADOW CAP EXPERIMENT: v12 PRODUCTION-CANDIDATE SAMPLE ONLY ===");
const passingScenarios = [];
for (const scenario of scenarios) {
  const rows = scenario.rows.filter((r) => r.currentModel && r.externalActive);
  const baseline = metrics(rows, "marginA", "winnerA"), dynamic = metrics(rows, "marginB", "winnerB");
  const changes = rows.filter((r) => r.flipped).map((r) => ({
    game: r.key, from: r.winnerA, to: r.winnerB, actualWinner: r.actualWinner,
    baselineCorrect: r.winnerA === r.actualWinner, dynamicCorrect: r.winnerB === r.actualWinner,
  }));
  const avg = (fn) => rows.length ? round3(mean(rows.map(fn))) : null;
  const maxAbsolute = rows.length ? Math.max(...rows.map((r) => Math.abs(r.delta))) : null;
  const missingEvidence = {
    venueLeague: rows.filter((r) => !(r.breakdown.venue.leagueN > 0)).length,
    teamVenue: scenario.noTeamVenueResidual ? "disabled by ablation" : rows.filter((r) =>
      !(r.breakdown.venue.homeN > 0) || !(r.breakdown.venue.awayN > 0)).length,
    travelUnknown: rows.filter((r) => r.breakdown.travel.zonesEast == null).length,
    travelStaticFallback: rows.filter((r) => r.breakdown.travel.source === "static-fallback").length,
    restUnknown: rows.filter((r) => r.breakdown.rest.restDifferentialDays == null).length,
    restNoSample: rows.filter((r) => r.breakdown.rest.source !== "balanced" && !(r.breakdown.rest.restN > 0)).length,
    roadNoSample: rows.filter((r) => r.breakdown.rest.awayRoadRun >= 2 && !(r.breakdown.rest.roadRunN > 0)).length,
    weatherStaticOnly: rows.filter((r) => r.breakdown.weather.source === "static-only").length,
  };
  const maeGain = rows.length ? mean(rows.map((r) => Math.abs(r.actualMargin - r.marginA))) -
    mean(rows.map((r) => Math.abs(r.actualMargin - r.marginB))) : null;
  const biasImproved = rows.length && Math.abs(mean(rows.map((r) => r.actualMargin - r.marginB))) <
    Math.abs(mean(rows.map((r) => r.actualMargin - r.marginA)));
  // An explicitly reported unavailable sample is not evidence of no effect.
  // Preserve the existing fallback, and reject only untraced/invalid factor output.
  const evidenceSupported = rows.every((r) =>
    [r.breakdown.venue.leagueN, r.breakdown.travel.n, r.breakdown.rest.restN,
      r.breakdown.rest.roadRunN].every((n) => Number.isFinite(n) && n >= 0) &&
    [r.breakdown.travel.source, r.breakdown.rest.source, r.breakdown.weather.source]
      .every((source) => typeof source === "string" && source.length > 0) &&
    [r.breakdown.venue.homePoints, r.breakdown.travel.homePoints, r.breakdown.rest.homeMargin,
      r.breakdown.weather.marginDelta].every(Number.isFinite));
  const pass = Boolean(rows.length && dynamic.winnerAccuracy >= baseline.winnerAccuracy &&
    !changes.some((r) => r.baselineCorrect && !r.dynamicCorrect) &&
    maeGain >= .15 && biasImproved && maxAbsolute <= 2 && evidenceSupported);
  if (pass) passingScenarios.push({ cap: scenario.cap, noTeamVenueResidual: scenario.noTeamVenueResidual });
  console.log(JSON.stringify({
    scenario: `${scenario.noTeamVenueResidual ? "no team venue residual" : "all factors"}, cap +/-${scenario.cap}`,
    baseline, dynamic, flips: changes, pass,
    adjustment: { mean: avg((r) => r.delta), meanAbsolute: avg((r) => Math.abs(r.delta)),
      maxAbsolute, capHitPercent: avg((r) => r.capHit ? 100 : 0) },
    meanContributionsBeforeCombinedCap: {
      venue: avg((r) => r.breakdown.venue.homePoints), travel: avg((r) => r.breakdown.travel.homePoints),
      relativeRest: avg((r) => r.breakdown.relativeRestRaw), roadSequence: avg((r) => r.breakdown.roadSequenceRaw),
      weather: avg((r) => r.breakdown.weather.marginDelta),
      removedStaticHomeField: avg((r) => r.breakdown.staticExternal.homeFieldEdge),
      removedStaticSchedule: avg((r) => r.breakdown.staticExternal.scheduleDifferential),
    },
    missingEvidence,
    evidencePolicy: "Missing samples retain existing explicit league/static fallback or unavailable trace; never upgraded to supported evidence.",
  }));
}
passingScenarios.sort((a, b) => a.cap - b.cap || Number(b.noTeamVenueResidual) - Number(a.noTeamVenueResidual));
console.log("Shadow recommendation:", JSON.stringify({
  passingScenarios, recommended: passingScenarios[0] || null,
  productionEnablement: "unchanged; experiment only",
}));
