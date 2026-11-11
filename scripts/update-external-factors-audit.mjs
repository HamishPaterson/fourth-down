// Weekly 2026 external-factors + variance audit.
//
// Read-only analysis: recalculates season-to-date observed effects from
// completed 2026 games and writes them to data/external-factors-2026.json.
// The output is NOT imported by any production code; values are stored
// separately so they can be reviewed before anyone considers activating them.
//
// Sections: reconciled pre-game prediction sample, variance (all valid /
// current production model / by model version), team-specific home/away
// effects vs pre-game expectation (shrunk toward league baseline), league-wide
// external factors, and cumulative weekly history.
//
// Usage: node scripts/update-external-factors-audit.mjs
// Env:   BALLDONTLIE_API_KEY (schedule/results). Loaded from .env.local if present.
//
// Data sources (all existing): public production prediction ledger, BALLDONTLIE
// schedule, src/services/stadiums.js, src/services/homeFieldAdvantage.js,
// Open-Meteo archive (historical weather is not stored in the ledger).
//
// Also writes src/services/externalFactors2026Data.js, the generated module the
// production prediction engine consumes read-only for the next week's games.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import HFA_BASE from "../src/services/homeFieldAdvantage.js";
import { CURRENT_MODEL_VERSION } from "../src/services/modelIdentity.js";
import {
  loadEnv, loadExternalFactorInputs, predictionRows,
  hasPredictionScores, isPreGameRow,
} from "./externalFactorsData.mjs";
import {
  buildExternalFactorsDataset, normTeam as norm, num, round2, round3, mean, sd,
  shrink, shrinkTeam, zMeans, zRate, reliability,
  SHRINK_K, TEAM_K, SMALL_SAMPLE_N, MAX_DERIVED_ADJ,
} from "../src/services/externalFactors2026.js";

const SEASON = 2026;
const OUTPUT_PATH = path.resolve("data/external-factors-2026.json");
const DATA_MODULE_PATH = path.resolve("src/services/externalFactors2026Data.js");

function bucketStats(rows, valueFn, winFn) {
  const values = rows.map(valueFn).filter((v) => v != null);
  const wins = rows.filter(winFn).length;
  return { n: rows.length, wins, winPct: rows.length ? round3(wins / rows.length) : null,
    mean: values.length ? round2(mean(values)) : null, values };
}

function factorGroup(name, allRows, selector, valueFn, winFn, currentAdjustment, unit) {
  const inGroup = allRows.filter(selector);
  const outGroup = allRows.filter((r) => !selector(r));
  const inside = bucketStats(inGroup, valueFn, winFn);
  const outside = bucketStats(outGroup, valueFn, winFn);
  const effect = inside.mean != null && outside.mean != null ? inside.mean - outside.mean : null;
  const z = zMeans(inside.values, outside.values);
  const zw = zRate(inside.wins, inside.n, outside.wins, outside.n);
  delete inside.values; delete outside.values;
  return {
    factor: name, unit, n: inside.n, winPct: inside.winPct,
    meanEffect: inside.mean, baselineMean: outside.mean, baselineN: outside.n,
    observedEffect: effect != null ? round2(effect) : null,
    zMean: z != null ? round2(z) : null, zWin: zw != null ? round2(zw) : null,
    reliability: reliability(Math.abs(z ?? 0) >= Math.abs(zw ?? 0) ? z : zw, inside.n),
    currentAdjustment, derivedAdjustment2026: shrink(effect, inside.n),
  };
}

// --- main --------------------------------------------------------------------
await loadEnv();

console.log("Fetching prediction ledger + schedule...");
const { rowsByKey, snapshots, games, completedGames, weatherUnavailable } =
  await loadExternalFactorInputs();

// Reconcile every completed game against the prediction ledger.
const reconciliation = [];
for (const g of completedGames) {
  const rows = rowsByKey.get(g.key) || [];
  const chosen = snapshots.get(g.key);
  let status;
  if (!rows.length) status = "no prediction snapshot stored";
  else if (!rows.some(hasPredictionScores)) status = "snapshot has no prediction scores (result-only backfill row)";
  else if (!rows.some(isPreGameRow)) status = "prediction created after kickoff (backfill) - excluded";
  else status = "valid pre-game prediction";
  g.preGame = status === "valid pre-game prediction";
  if (!g.preGame) {
    reconciliation.push({
      game: g.key, week: g.week, reason: status,
      modelVersion: chosen?.model_version ?? null,
      createdAt: chosen?.created_at ?? null, kickoff: g.kickoff,
    });
  }
}
const missingKickoff = games.filter((g) => !g.kickoff).length;
if (missingKickoff) console.warn(`Warning: ${missingKickoff} scheduled games have no kickoff time`);

console.log(`Completed games: ${completedGames.length}; excluded from prediction sample: ${reconciliation.length}; ` +
  `outdoor weather unavailable: ${weatherUnavailable}`);

// --- 1. Variance -------------------------------------------------------------
const predicted = predictionRows(completedGames);

for (const g of predicted) {
  g.residual = g.actualMargin - g.predictedMargin; // + = home outperformed model
  g.absError = Math.abs(g.residual);
  g.modelCorrect = g.actualWinner !== "TIE" && g.modelPick === g.actualWinner;
  g.marketCorrect = g.actualWinner !== "TIE" && g.marketPick && g.marketPick === g.actualWinner;
  g.marketResidual = g.marketMargin != null ? g.actualMargin - g.marketMargin : null;
  g.modelVsMarket = g.marketMargin != null ? g.predictedMargin - g.marketMargin : null;
}

function computeVariance(rows, { rolling = false } = {}) {
  const decided = rows.filter((g) => g.actualWinner !== "TIE");
  const correct = decided.filter((g) => g.modelCorrect);
  const incorrect = decided.filter((g) => !g.modelCorrect);
  const marketRows = decided.filter((g) => g.marketPick);
  const marketResiduals = rows.filter((g) => g.marketResidual != null);
  const vsMarket = rows.filter((g) => g.modelVsMarket != null);
  const result = {
    games: rows.length,
    weeksCovered: [...new Set(rows.map((g) => g.week))].sort((a, b) => a - b),
    winnerAccuracy: decided.length ? round3(correct.length / decided.length) : null,
    marketWinnerAccuracy: marketRows.length
      ? round3(marketRows.filter((g) => g.marketCorrect).length / marketRows.length) : null,
    meanAbsMarginError: rows.length ? round2(mean(rows.map((g) => g.absError))) : null,
    residualSd: rows.length > 1 ? round2(sd(rows.map((g) => g.residual))) : null,
    residualMean: rows.length ? round2(mean(rows.map((g) => g.residual))) : null,
    marketMeanAbsMarginError: marketResiduals.length
      ? round2(mean(marketResiduals.map((g) => Math.abs(g.marketResidual)))) : null,
    marketResidualSd: marketResiduals.length > 1
      ? round2(sd(marketResiduals.map((g) => g.marketResidual))) : null,
    meanAbsModelVsMarket: vsMarket.length
      ? round2(mean(vsMarket.map((g) => Math.abs(g.modelVsMarket)))) : null,
    correctWinnerMarginError: correct.length ? round2(mean(correct.map((g) => g.absError))) : null,
    incorrectWinnerMarginError: incorrect.length ? round2(mean(incorrect.map((g) => g.absError))) : null,
    correctWinnerBigErrorShare: correct.length
      ? round3(correct.filter((g) => g.absError >= 10).length / correct.length) : null,
    marginBuckets: [[0, 3], [3, 6], [6, 9], [9, 99]].map(([lo, hi]) => {
      const band = rows.filter((g) => Math.abs(g.predictedMargin) >= lo && Math.abs(g.predictedMargin) < hi);
      const bandDecided = band.filter((g) => g.actualWinner !== "TIE");
      return {
        predictedMarginBand: `${lo}-${hi === 99 ? "+" : hi}`, n: band.length,
        winnerAccuracy: bandDecided.length
          ? round3(bandDecided.filter((g) => g.modelCorrect).length / bandDecided.length) : null,
        meanAbsMarginError: band.length ? round2(mean(band.map((g) => g.absError))) : null,
        meanWinnerProb: band.length ? round3(mean(band.map((g) => g.winnerProb))) : null,
      };
    }),
    calibration: [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]].map(([lo, hi]) => {
      const band = rows.filter((g) => g.winnerProb >= lo && g.winnerProb < hi && g.actualWinner !== "TIE");
      return { probBand: `${lo}-${hi === 1.01 ? "1.0" : hi}`, n: band.length,
        meanPredicted: band.length ? round3(mean(band.map((g) => g.winnerProb))) : null,
        actualWinRate: band.length ? round3(band.filter((g) => g.modelCorrect).length / band.length) : null };
    }),
  };
  if (rolling) {
    const ROLLING_WINDOW = 16;
    const series = rows.map((g, i) => {
      const window = rows.slice(Math.max(0, i - ROLLING_WINDOW + 1), i + 1).map((x) => x.residual);
      return { week: g.week, rollingSd: window.length >= 5 ? round2(sd(window)) : null };
    });
    result.rollingResidualSdLatest = series.filter((r) => r.rollingSd != null).at(-1)?.rollingSd ?? null;
    result.rollingResidualSdByWeek = [...new Set(series.map((r) => r.week))].map((week) => {
      const w = series.filter((r) => r.week === week && r.rollingSd != null);
      return { week, rollingSd: w.length ? w.at(-1).rollingSd : null };
    });
  }
  return result;
}

// All valid 2026 pre-game predictions.
const variance = computeVariance(predicted, { rolling: true });
// Current production model version only.
const currentModelPredictions = predicted.filter((g) => g.currentModel);
const varianceCurrentModel = computeVariance(currentModelPredictions);
// Split by model version.
const versionGroups = new Map();
for (const g of predicted) {
  const label = g.modelVersion == null ? "null" : String(g.modelVersion);
  if (!versionGroups.has(label)) versionGroups.set(label, []);
  versionGroups.get(label).push(g);
}
const varianceByVersion = [...versionGroups.entries()].map(([version, rows]) => ({
  modelVersion: version,
  modelKey: rows[0].modelKey,
  currentProduction: rows[0].currentModel === true,
  ...computeVariance(rows),
}));

// --- 2. External factors -------------------------------------------------------
// Team-game rows for rest/road-run factors (margin from that team's perspective).
const teamGames = completedGames.flatMap((g) => [
  { game: g, side: "away", code: g.away, daysRest: g.awayContext.daysRest, roadRun: g.awayContext.roadRun,
    margin: -g.actualMargin, won: g.actualWinner === g.away, total: g.actualTotal },
  { game: g, side: "home", code: g.home, daysRest: g.homeContext.daysRest, roadRun: 0,
    margin: g.actualMargin, won: g.actualWinner === g.home, total: g.actualTotal },
]);

const hfaRows = completedGames.filter((g) => !g.neutralSite);
const homeWin = (g) => g.actualWinner === g.home;
const awayWin = (g) => g.actualWinner === g.away;

const venueHfa = Object.keys(HFA_BASE).map((code) => {
  const rows = hfaRows.filter((g) => g.home === code);
  if (!rows.length) return null;
  return { venue: code, n: rows.length,
    homeWinPct: round3(rows.filter(homeWin).length / rows.length),
    observedHomeMargin: round2(mean(rows.map((g) => g.actualMargin))),
    currentHfaBase: HFA_BASE[code],
    reliability: rows.length < 8 ? "small-sample" : "moderate" };
}).filter(Boolean);

const outdoor = completedGames.filter((g) => !g.dome && g.weather);
const windMph = (g) => g.weather.windSpeed * 0.621371;
const tempF = (g) => (g.weather.temperature * 9) / 5 + 32;

const factors = {
  homeFieldAdvantage: {
    n: hfaRows.length,
    neutralSiteExcluded: completedGames.length - hfaRows.length,
    homeWinPct: round3(hfaRows.filter(homeWin).length / hfaRows.length),
    observedHomeMargin: round2(mean(hfaRows.map((g) => g.actualMargin))),
    zWin: round2(zRate(hfaRows.filter(homeWin).length, hfaRows.length, hfaRows.filter(awayWin).length, hfaRows.length)),
    currentAdjustment: "venue base 0.35-2.50 (league mean ~1.6) + travel penalty",
    leagueMeanCurrent: round2(mean(Object.values(HFA_BASE))),
    derivedAdjustment2026: shrink(mean(hfaRows.map((g) => g.actualMargin)), hfaRows.length),
    byVenue: venueHfa,
  },
  domeVsOutdoor: (() => {
    const dome = completedGames.filter((g) => g.dome);
    const out = completedGames.filter((g) => !g.dome);
    const z = zMeans(dome.map((g) => g.actualTotal), out.map((g) => g.actualTotal));
    return {
      domeN: dome.length, outdoorN: out.length,
      domeMeanTotal: round2(mean(dome.map((g) => g.actualTotal))),
      outdoorMeanTotal: round2(mean(out.map((g) => g.actualTotal))),
      domeHomeWinPct: dome.length ? round3(dome.filter(homeWin).length / dome.length) : null,
      outdoorHomeWinPct: out.length ? round3(out.filter(homeWin).length / out.length) : null,
      observedTotalEffect: round2(mean(dome.map((g) => g.actualTotal)) - mean(out.map((g) => g.actualTotal))),
      zMean: round2(z), reliability: reliability(z, Math.min(dome.length, out.length)),
      currentAdjustment: "dome = neutral (no weather adjustment)",
      derivedAdjustment2026: 0,
    };
  })(),
  wind: [
    { label: "calm (<10 mph)", test: (g) => windMph(g) < 10, current: "none below 10 mph" },
    { label: "breezy (10-15 mph)", test: (g) => windMph(g) >= 10 && windMph(g) < 15, current: "windLoad ramps from 10 mph (small)" },
    { label: "windy (15-20 mph)", test: (g) => windMph(g) >= 15 && windMph(g) < 20, current: "moderate scoring reduction" },
    { label: "very windy (20+ mph)", test: (g) => windMph(g) >= 20, current: "strong scoring reduction" },
  ].map(({ label, test, current }) =>
    factorGroup(label, outdoor, test, (g) => g.actualTotal, homeWin, current, "total-points")),
  temperature: [
    { label: "cold (<40F)", test: (g) => tempF(g) < 40, current: "extreme cold load only below -7C" },
    { label: "cool (40-60F)", test: (g) => tempF(g) >= 40 && tempF(g) < 60, current: "none" },
    { label: "mild (60-75F)", test: (g) => tempF(g) >= 60 && tempF(g) < 75, current: "none" },
    { label: "hot (75F+)", test: (g) => tempF(g) >= 75, current: "extreme heat load only above 32C" },
  ].map(({ label, test, current }) =>
    factorGroup(label, outdoor, test, (g) => g.actualTotal, homeWin, current, "total-points")),
  rain: factorGroup("rain >= 1mm in game window", outdoor,
    (g) => Math.max(g.weather.rain, g.weather.precipitation) >= 1,
    (g) => g.actualTotal, homeWin,
    "rainLoad reduces passingTD/FG/XP, raises turnovers", "total-points"),
  snow: factorGroup("any snowfall in game window", outdoor,
    (g) => g.weather.snowfall > 0,
    (g) => g.actualTotal, homeWin,
    "snowLoad reduces passingTD/FG/XP, raises turnovers", "total-points"),
  travelDistance: [
    { label: "short (<500 mi)", test: (g) => g.travelMiles < 500 },
    { label: "medium (500-1000 mi)", test: (g) => g.travelMiles >= 500 && g.travelMiles < 1000 },
    { label: "long (1000-2000 mi)", test: (g) => g.travelMiles >= 1000 && g.travelMiles < 2000 },
    { label: "cross-country (2000+ mi)", test: (g) => g.travelMiles >= 2000 },
  ].map(({ label, test }) =>
    factorGroup(label, completedGames.filter((g) => g.travelMiles != null), test,
      (g) => -g.actualMargin, awayWin, "none (distance itself not modeled)", "away-margin")),
  timezone: [
    { label: "away travels east 2+ zones", test: (g) => g.zonesEast >= 2, current: "travel penalty 0.25-1.0 pts to home" },
    { label: "away travels west 2+ zones", test: (g) => g.zonesEast <= -2, current: "none" },
  ].map(({ label, test, current }) => {
    const rows = completedGames.filter((g) => g.zonesEast != null && test(g));
    const rest = completedGames.filter((g) => g.zonesEast != null && !test(g));
    const effect = rows.length && rest.length
      ? mean(rows.map((g) => -g.actualMargin)) - mean(rest.map((g) => -g.actualMargin)) : null;
    const z = zMeans(rows.map((g) => -g.actualMargin), rest.map((g) => -g.actualMargin));
    const zw = zRate(rows.filter(awayWin).length, rows.length, rest.filter(awayWin).length, rest.length);
    return { factor: label, n: rows.length,
      awayWinPct: rows.length ? round3(rows.filter(awayWin).length / rows.length) : null,
      baselineAwayWinPct: rest.length ? round3(rest.filter(awayWin).length / rest.length) : null,
      meanAwayMargin: rows.length ? round2(mean(rows.map((g) => -g.actualMargin))) : null,
      observedAwayMarginEffect: effect != null ? round2(effect) : null,
      zMean: z != null ? round2(z) : null, zWin: zw != null ? round2(zw) : null,
      reliability: reliability(z, rows.length), currentAdjustment: current,
      derivedAdjustment2026: shrink(effect, rows.length) };
  }),
  rest: [
    { label: "very short week (<=4 days)", test: (t) => t.daysRest != null && t.daysRest <= 4, current: "-0.7 pts" },
    { label: "short week (5 days)", test: (t) => t.daysRest === 5, current: "-0.4 pts" },
    { label: "extended rest (9-11 days)", test: (t) => t.daysRest != null && t.daysRest >= 9 && t.daysRest < 12, current: "+0.3 pts" },
    { label: "post-bye (12+ days)", test: (t) => t.daysRest != null && t.daysRest >= 12, current: "+0.6 pts" },
  ].map(({ label, test, current }) => {
    const rows = teamGames.filter(test);
    const restRows = teamGames.filter((t) => !test(t) && t.daysRest != null);
    const effect = rows.length && restRows.length
      ? mean(rows.map((t) => t.margin)) - mean(restRows.map((t) => t.margin)) : null;
    const z = zMeans(rows.map((t) => t.margin), restRows.map((t) => t.margin));
    const zw = zRate(rows.filter((t) => t.won).length, rows.length,
      restRows.filter((t) => t.won).length, restRows.length);
    return { factor: label, n: rows.length,
      winPct: rows.length ? round3(rows.filter((t) => t.won).length / rows.length) : null,
      meanMargin: rows.length ? round2(mean(rows.map((t) => t.margin))) : null,
      observedMarginEffect: effect != null ? round2(effect) : null,
      zMean: z != null ? round2(z) : null, zWin: zw != null ? round2(zw) : null,
      reliability: reliability(z, rows.length), currentAdjustment: current,
      derivedAdjustment2026: shrink(effect, rows.length) };
  }),
  restDifferential: [
    { label: "home rest edge 3-6 days", test: (g) => restDiff(g) >= 3 && restDiff(g) < 7, current: "+0.4 pts home" },
    { label: "home rest edge 7+ days", test: (g) => restDiff(g) >= 7, current: "+0.8 pts home" },
    { label: "away rest edge 3+ days", test: (g) => restDiff(g) <= -3, current: "-0.4/-0.8 pts home" },
  ].map(({ label, test, current }) => {
    const rows = completedGames.filter((g) => restDiff(g) != null && test(g));
    const base = completedGames.filter((g) => restDiff(g) != null && Math.abs(restDiff(g)) < 3);
    const effect = rows.length && base.length
      ? mean(rows.map((g) => g.actualMargin)) - mean(base.map((g) => g.actualMargin)) : null;
    const z = zMeans(rows.map((g) => g.actualMargin), base.map((g) => g.actualMargin));
    return { factor: label, n: rows.length,
      homeWinPct: rows.length ? round3(rows.filter(homeWin).length / rows.length) : null,
      meanHomeMargin: rows.length ? round2(mean(rows.map((g) => g.actualMargin))) : null,
      observedHomeMarginEffect: effect != null ? round2(effect) : null,
      zMean: z != null ? round2(z) : null, reliability: reliability(z, rows.length),
      currentAdjustment: current, derivedAdjustment2026: shrink(effect, rows.length) };
  }),
  consecutiveRoadGames: [
    { label: "2nd consecutive road game", test: (g) => g.awayContext.roadRun === 2, current: "-0.2 pts away" },
    { label: "3rd+ consecutive road game", test: (g) => g.awayContext.roadRun >= 3, current: "-0.4 pts away" },
  ].map(({ label, test, current }) => {
    const rows = completedGames.filter(test);
    const base = completedGames.filter((g) => g.awayContext.roadRun <= 1);
    const effect = rows.length && base.length
      ? mean(rows.map((g) => -g.actualMargin)) - mean(base.map((g) => -g.actualMargin)) : null;
    const z = zMeans(rows.map((g) => -g.actualMargin), base.map((g) => -g.actualMargin));
    const zw = zRate(rows.filter(awayWin).length, rows.length, base.filter(awayWin).length, base.length);
    return { factor: label, n: rows.length,
      awayWinPct: rows.length ? round3(rows.filter(awayWin).length / rows.length) : null,
      meanAwayMargin: rows.length ? round2(mean(rows.map((g) => -g.actualMargin))) : null,
      observedAwayMarginEffect: effect != null ? round2(effect) : null,
      zMean: z != null ? round2(z) : null, zWin: zw != null ? round2(zw) : null,
      reliability: reliability(z, rows.length), currentAdjustment: current,
      derivedAdjustment2026: shrink(effect, rows.length) };
  }),
};
function restDiff(g) {
  return g.homeContext.daysRest == null || g.awayContext.daysRest == null
    ? null : g.homeContext.daysRest - g.awayContext.daysRest;
}

// --- Team-specific home/away effects ------------------------------------------
// Effects are measured relative to the pre-game expectation (market margin when
// available, else the valid pre-game Fourth Down predicted margin), so opponent
// strength and already-priced travel/rest/weather do not dominate the venue
// estimate. Market quotes are usable from any snapshot row; model predictions
// only from valid pre-game rows. Neutral-site games are excluded.
const TEAM_CODES = Object.keys(HFA_BASE);
const expectationMargin = (g) => {
  const spread = num(g.snapshot?.market_spread);
  if (spread != null) return -spread;
  if (g.preGame && num(g.snapshot?.predicted_home_score) != null) {
    return num(g.snapshot.predicted_home_score) - num(g.snapshot.predicted_away_score);
  }
  return null;
};
const homeResidualPool = [];
const awayResidualPool = [];
for (const g of completedGames) {
  if (g.neutralSite) continue;
  const expectation = expectationMargin(g);
  if (expectation == null) continue;
  g.expectationMargin = expectation;
  g.expectationSource = num(g.snapshot?.market_spread) != null ? "market" : "fourth-down";
  homeResidualPool.push(g.actualMargin - expectation);
  awayResidualPool.push(-(g.actualMargin - expectation));
}
const leagueHomeBaseline = mean(homeResidualPool) ?? 0;
const leagueAwayBaseline = mean(awayResidualPool) ?? 0;

const teamConfidence = (n) =>
  n === 0 ? "no-data" : n < 4 ? "very-low" : n <= 5 ? "low" : n <= 7 ? "moderate" : "good";

const teamVenueEffects = TEAM_CODES.map((code) => {
  const homeGames = completedGames.filter((g) => g.home === code && !g.neutralSite);
  const awayGames = completedGames.filter((g) => g.away === code && !g.neutralSite);
  const homeExp = homeGames.filter((g) => g.expectationMargin != null);
  const awayExp = awayGames.filter((g) => g.expectationMargin != null);
  const vsMarket = (rows, sign) => {
    const subset = rows.filter((g) => g.expectationSource === "market");
    return subset.length ? round2(mean(subset.map((g) => sign * (g.actualMargin - g.expectationMargin)))) : null;
  };
  const vsModel = (rows, sign) => {
    const subset = rows.filter((g) => g.expectationSource === "fourth-down");
    return subset.length ? round2(mean(subset.map((g) => sign * (g.actualMargin - g.expectationMargin)))) : null;
  };
  const homeEffect = homeExp.length ? mean(homeExp.map((g) => g.actualMargin - g.expectationMargin)) : null;
  const awayEffect = awayExp.length ? mean(awayExp.map((g) => -(g.actualMargin - g.expectationMargin))) : null;
  return {
    team: code,
    homeGames: homeGames.length,
    homeWinPct: homeGames.length ? round3(homeGames.filter(homeWin).length / homeGames.length) : null,
    meanHomeMargin: homeGames.length ? round2(mean(homeGames.map((g) => g.actualMargin))) : null,
    awayGames: awayGames.length,
    awayWinPct: awayGames.length ? round3(awayGames.filter(awayWin).length / awayGames.length) : null,
    meanAwayMargin: awayGames.length ? round2(mean(awayGames.map((g) => -g.actualMargin))) : null,
    homeN: homeExp.length,
    homeEffect: homeEffect != null ? round2(homeEffect) : null,
    homeVsMarket: vsMarket(homeExp, 1),
    homeVsFourthDown: vsModel(homeExp, 1),
    awayN: awayExp.length,
    awayEffect: awayEffect != null ? round2(awayEffect) : null,
    awayVsMarket: vsMarket(awayExp, -1),
    awayVsFourthDown: vsModel(awayExp, -1),
    confidence: `${teamConfidence(homeExp.length)}/${teamConfidence(awayExp.length)}`,
    shrunkHomeEffect: shrinkTeam(homeEffect, homeExp.length, leagueHomeBaseline),
    shrunkAwayEffect: shrinkTeam(awayEffect, awayExp.length, leagueAwayBaseline),
  };
});

// --- Weekly history (cumulative season-to-date through each completed week) ----
const completedWeeks = [...new Set(completedGames.map((g) => g.week))].sort((a, b) => a - b);
const weeklyHistory = completedWeeks.map((week) => {
  const gc = completedGames.filter((g) => g.week <= week);
  const pr = predicted.filter((g) => g.week <= week);
  const tg = teamGames.filter((t) => t.game.week <= week);
  const hfa = gc.filter((g) => !g.neutralSite);
  const postBye = tg.filter((t) => t.daysRest != null && t.daysRest >= 12);
  const road2 = gc.filter((g) => g.awayContext.roadRun === 2);
  const tzEast = gc.filter((g) => g.zonesEast != null && g.zonesEast >= 2);
  const domeG = gc.filter((g) => g.dome);
  const outG = gc.filter((g) => !g.dome && g.weather);
  const rainG = outG.filter((g) => Math.max(g.weather.rain, g.weather.precipitation) >= 1);
  const v = computeVariance(pr);
  return {
    week,
    gamesCompleted: gc.length,
    gamesWithValidPredictions: pr.length,
    winnerAccuracy: v.winnerAccuracy,
    marginMae: v.meanAbsMarginError,
    residualMean: v.residualMean,
    residualSd: v.residualSd,
    leagueHomeWinPct: hfa.length ? round3(hfa.filter(homeWin).length / hfa.length) : null,
    leagueHomeMargin: hfa.length ? round2(mean(hfa.map((g) => g.actualMargin))) : null,
    domeMeanTotal: domeG.length ? round2(mean(domeG.map((g) => g.actualTotal))) : null,
    outdoorMeanTotal: outG.length ? round2(mean(outG.map((g) => g.actualTotal))) : null,
    rainMeanTotal: rainG.length ? round2(mean(rainG.map((g) => g.actualTotal))) : null,
    postByeN: postBye.length,
    postByeMeanMargin: postBye.length ? round2(mean(postBye.map((t) => t.margin))) : null,
    secondRoadGameN: road2.length,
    secondRoadGameAwayMargin: road2.length ? round2(mean(road2.map((g) => -g.actualMargin))) : null,
    tzEastN: tzEast.length,
    tzEastAwayMargin: tzEast.length ? round2(mean(tzEast.map((g) => -g.actualMargin))) : null,
  };
});

// --- Production dataset ------------------------------------------------------
// Same enriched completed games + valid pre-game predictions feed the generated
// module the prediction engine consumes read-only for future weeks.
const productionDataset = {
  ...buildExternalFactorsDataset({ season: SEASON, games: completedGames, predictions: predicted }),
  generatedAt: new Date().toISOString(),
};
const DATA_MODULE_banner =
  "// GENERATED by scripts/update-external-factors-audit.mjs - do not edit by hand.\n" +
  "// 2026 season-to-date external factors from completed games only. Consumed\n" +
  "// read-only by src/services/predictionEngine.js via externalFactors2026.js.\n";
await writeFile(
  DATA_MODULE_PATH,
  DATA_MODULE_banner +
    `const EXTERNAL_FACTORS_2026 = ${JSON.stringify(productionDataset, null, 2)};\n\n` +
    "export default EXTERNAL_FACTORS_2026;\n"
);

// --- 3. Output -------------------------------------------------------------------
const output = {
  generatedAt: new Date().toISOString(),
  season: SEASON,
  status: "review-only report; production consumes src/services/externalFactors2026Data.js read-only",
  productionDataset: "src/services/externalFactors2026Data.js",
  maxCompletedWeek: productionDataset.maxCompletedWeek,
  gamesCompleted: completedGames.length,
  gamesWithValidPreGamePredictions: predicted.length,
  gamesExcluded: reconciliation.length,
  outdoorGamesWithWeather: outdoor.length,
  currentProductionModelVersion: CURRENT_MODEL_VERSION,
  reconciliation,
  shrinkage: { K: SHRINK_K, teamK: TEAM_K, smallSampleN: SMALL_SAMPLE_N, maxDerivedAdjustment: MAX_DERIVED_ADJ,
    note: "derivedAdjustment2026 = observed * n/(n+K), capped; small samples collapse toward 0. " +
      "Team venue effects are shrunk toward the league baseline with K=8." },
  variance,
  varianceCurrentModel,
  varianceByVersion,
  teamVenueEffects: {
    note: "Effect = actual margin minus pre-game expectation (market margin preferred, " +
      "else valid pre-game Fourth Down margin); positive = beats expectation. " +
      "Neutral-site games excluded. Venue effects are net of priced-in travel/rest/weather.",
    leagueHomeBaseline: round2(leagueHomeBaseline),
    leagueAwayBaseline: round2(leagueAwayBaseline),
    teams: teamVenueEffects,
  },
  factors,
  weeklyHistory,
};
await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));

// Compact console summary.
console.log("\n=== RECONCILIATION ===");
console.log(`completed=${completedGames.length} validPreGamePredictions=${predicted.length} excluded=${reconciliation.length}`);
for (const r of reconciliation) console.log(`  ${r.game} (W${r.week}): ${r.reason}`);

console.log("\n=== VARIANCE (all valid pre-game predictions) ===");
console.log(`games=${variance.games} winnerAcc=${variance.winnerAccuracy} marketAcc=${variance.marketWinnerAccuracy}`);
console.log(`marginMAE=${variance.meanAbsMarginError} residualMean=${variance.residualMean} residualSD=${variance.residualSd} marketMAE=${variance.marketMeanAbsMarginError} marketSD=${variance.marketResidualSd}`);
console.log(`correctWinnerMAE=${variance.correctWinnerMarginError} incorrectWinnerMAE=${variance.incorrectWinnerMarginError} correctBigErrShare=${variance.correctWinnerBigErrorShare}`);
console.log("marginBuckets:", JSON.stringify(variance.marginBuckets));
console.log("calibration:", JSON.stringify(variance.calibration));
console.log("rollingSDbyWeek:", JSON.stringify(variance.rollingResidualSdByWeek));

console.log(`\n=== VARIANCE (current production model v${CURRENT_MODEL_VERSION} only) ===`);
console.log(JSON.stringify({ ...varianceCurrentModel, marginBuckets: undefined, calibration: undefined }));

console.log("\n=== VARIANCE BY MODEL VERSION ===");
for (const v of varianceByVersion) {
  console.log(`v=${v.modelVersion} key=${v.modelKey ?? "none"} n=${v.games} weeks=${v.weeksCovered.join(",")} ` +
    `winnerAcc=${v.winnerAccuracy} MAE=${v.meanAbsMarginError} residualMean=${v.residualMean} residualSD=${v.residualSd}` +
    `${v.currentProduction ? " [CURRENT PRODUCTION]" : ""}`);
}

console.log("\n=== TEAM VENUE EFFECTS (vs pre-game expectation; + = beats expectation) ===");
console.log(`league baselines: home ${round2(leagueHomeBaseline)} / away ${round2(leagueAwayBaseline)}; shrinkage K=${TEAM_K}`);
console.log("Team | Home n | Home effect | Away n | Away effect | Confidence | Shrunk home effect | Shrunk away effect");
for (const t of teamVenueEffects) {
  console.log(`${t.team} | ${t.homeN} | ${t.homeEffect} | ${t.awayN} | ${t.awayEffect} | ${t.confidence} | ${t.shrunkHomeEffect} | ${t.shrunkAwayEffect}`);
}
console.log("\n=== FACTORS ===");
console.log("HFA:", JSON.stringify({ ...factors.homeFieldAdvantage, byVenue: undefined }));
console.log("dome:", JSON.stringify(factors.domeVsOutdoor));
console.log("wind:", JSON.stringify(factors.wind));
console.log("temp:", JSON.stringify(factors.temperature));
console.log("rain:", JSON.stringify(factors.rain));
console.log("snow:", JSON.stringify(factors.snow));
console.log("travel:", JSON.stringify(factors.travelDistance));
console.log("timezone:", JSON.stringify(factors.timezone));
console.log("rest:", JSON.stringify(factors.rest));
console.log("restDiff:", JSON.stringify(factors.restDifferential));
console.log("roadRun:", JSON.stringify(factors.consecutiveRoadGames));
console.log("\n=== WEEKLY HISTORY (cumulative through week) ===");
for (const w of weeklyHistory) console.log(JSON.stringify(w));
console.log(`\nWrote ${OUTPUT_PATH}`);
console.log(`Wrote ${DATA_MODULE_PATH} (production dataset through week ${productionDataset.maxCompletedWeek})`);
