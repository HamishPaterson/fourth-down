// services/externalFactors2026.js
// 2026 season-to-date external-factor calculations and their production application.
//
// Pure, browser-safe module: no fetches, no node APIs. The weekly audit script
// (scripts/update-external-factors-audit.mjs) rebuilds the dataset from completed
// 2026 games and writes src/services/externalFactors2026Data.js; the prediction
// engine applies it read-only. Walk-forward backtests build the same dataset
// in-memory per week using only games completed before the target week.
//
// Double-counting rules enforced here:
// - Team venue effects are measured relative to the pre-game expectation
//   (market margin preferred), which already prices travel/rest/weather, so the
//   venue term is net of separately modelled factors.
// - Rest uses the relative rest differential only; absolute post-bye/extended
//   rest effects are tracked in the dataset but not added on top (same games).
// - Weather applies only the delta between the blended static+dynamic total
//   effect and the static effect already applied by the scoring simulation.

import { getStadium, resolveStadium } from "./stadiums.js";
import { travelPenalty } from "./homeFieldAdvantage.js";
import { isCurrentModelIdentity } from "./modelIdentity.js";

// Enabled with the reviewed final combined margin cap; individual factors are unchanged.
export const EXTERNAL_FACTORS_2026_ENABLED = true;
export const MAX_COMBINED_EXTERNAL_MARGIN_ADJUSTMENT = 2;

export function capExternalMarginAdjustment(adjustment) {
  if (!Number.isFinite(adjustment)) throw new Error("Non-finite combined external-factor margin adjustment");
  return Math.max(-MAX_COMBINED_EXTERNAL_MARGIN_ADJUSTMENT,
    Math.min(MAX_COMBINED_EXTERNAL_MARGIN_ADJUSTMENT, adjustment));
}

export const SHRINK_K = 25;        // league/factor shrinkage prior weight
export const TEAM_K = 8;           // team venue shrinkage prior weight
export const MAX_DERIVED_ADJ = 2;  // hard cap on any derived adjustment
export const SMALL_SAMPLE_N = 30;

// Mirrors TEAM_TZ in homeFieldAdvantage.js (not exported there).
const TEAM_TZ = {
  ARI: -2, ATL: 0, BAL: 0, BUF: 0, CAR: 0, CHI: -1, CIN: 0, CLE: 0,
  DAL: -1, DEN: -2, DET: 0, GB: -1, HOU: -1, IND: 0, JAX: 0, KC: -1,
  LV: -3, LAC: -3, LAR: -3, MIA: 0, MIN: -1, NE: 0, NO: -1, NYG: 0,
  NYJ: 0, PHI: 0, PIT: 0, SF: -3, SEA: -3, TB: 0, TEN: -1, WSH: 0,
};

export const normTeam = (code) => ({ WAS: "WSH", LA: "LAR", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LAR" }[
  String(code || "").trim().toUpperCase()] || String(code || "").trim().toUpperCase());
export const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
export const round1 = (v) => Math.round(v * 10) / 10;
export const round2 = (v) => Math.round(v * 100) / 100;
export const round3 = (v) => Math.round(v * 1000) / 1000;
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
export const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((t, v) => t + (v - m) ** 2, 0) / (a.length - 1));
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function haversineMiles(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}

// Shrink an observed point effect toward 0 and cap; small samples collapse to ~0.
export const shrink = (effect, n, K = SHRINK_K, cap = MAX_DERIVED_ADJ) => {
  if (effect == null || !n) return 0;
  return round1(clamp(effect * (n / (n + K)), -cap, cap));
};
// Shrink a team venue effect toward the league baseline (never toward zero alone).
export const shrinkTeam = (effect, n, baseline) =>
  effect == null ? null : round2(baseline + (effect - baseline) * (n / (n + TEAM_K)));

export const zMeans = (a, b) => {
  if (a.length < 2 || b.length < 2) return null;
  const s1 = sd(a); const s2 = sd(b);
  const se = Math.sqrt((s1 ** 2) / a.length + (s2 ** 2) / b.length);
  return se > 0 ? (mean(a) - mean(b)) / se : null;
};
export const zRate = (wins, n, winsRest, nRest) => {
  if (!n || !nRest) return null;
  const p = (wins + winsRest) / (n + nRest);
  const se = Math.sqrt(p * (1 - p) * (1 / n + 1 / nRest));
  return se > 0 ? (wins / n - winsRest / nRest) / se : null;
};
export const reliability = (z, n) =>
  n < SMALL_SAMPLE_N ? "small-sample" : Math.abs(z ?? 0) >= 2 ? "significant" : "not-significant";

// --- Game context enrichment (pure; games passed in chronological order) ------

// Rest days and consecutive-road-game run for every game, from prior games only.
export function computeScheduleContexts(games) {
  const priorByTeam = new Map();
  for (const g of games) {
    for (const [side, code] of [["away", g.away], ["home", g.home]]) {
      const prior = priorByTeam.get(code) || [];
      const prev = prior[prior.length - 1];
      const daysRest = prev?.kickoff && g.kickoff
        ? Math.round((new Date(g.kickoff) - new Date(prev.kickoff)) / 86400000)
        : null;
      let roadRun = 0;
      if (side === "away") {
        roadRun = 1;
        for (let i = prior.length - 1; i >= 0 && prior[i].side === "away"; i--) roadRun++;
      }
      g[`${side}Context`] = { daysRest, roadRun };
      prior.push({ kickoff: g.kickoff, side });
      priorByTeam.set(code, prior);
    }
  }
  return games;
}

// Venue resolution, neutral-site detection, travel distance and timezone shift.
export function resolveGameVenue(g) {
  const resolution = resolveStadium(g.home, g.venue);
  const stadium = resolution.stadium || getStadium(g.home);
  const homeDefault = getStadium(g.home);
  const neutralSite = resolution.source === "scheduled-venue" && stadium != null &&
    homeDefault != null && homeDefault.name !== stadium.name;
  const awayHome = getStadium(g.away);
  const travelMiles = stadium && awayHome ? Math.round(haversineMiles(awayHome, stadium)) : null;
  const awayTz = TEAM_TZ[g.away]; const homeTz = TEAM_TZ[g.home];
  const zonesEast = awayTz != null && homeTz != null ? homeTz - awayTz : null;
  return { stadium, dome: stadium?.dome === true, neutralSite, travelMiles, zonesEast };
}

// --- Dataset build -------------------------------------------------------------
// games: enriched completed games (week, away, home, kickoff, actualAwayScore,
//   actualHomeScore, actualWinner, dome, neutralSite, travelMiles, zonesEast,
//   awayContext/homeContext {daysRest, roadRun}, weather|null,
//   expectationMargin|null, expectationSource, snapshot|null)
// predictions: valid pre-game prediction rows joined to those games
//   (predictedMargin, marketMargin, winnerProb, modelPick, marketPick,
//   modelVersion, modelKey, currentModel)
export function buildExternalFactorsDataset({ season = 2026, games, predictions }) {
  const completed = games.filter((g) => g.completed);
  const homeWin = (g) => g.actualWinner === g.home;
  const awayWin = (g) => g.actualWinner === g.away;
  const hfaRows = completed.filter((g) => !g.neutralSite);

  // Team venue effects vs pre-game expectation (market margin preferred).
  const homeResiduals = [];
  const awayResiduals = [];
  for (const g of hfaRows) {
    if (g.expectationMargin == null) continue;
    homeResiduals.push(g.actualMargin - g.expectationMargin);
    awayResiduals.push(-(g.actualMargin - g.expectationMargin));
  }
  const leagueHomeBaseline = mean(homeResiduals) ?? 0;
  const leagueAwayBaseline = mean(awayResiduals) ?? 0;

  const teamConfidence = (n) =>
    n === 0 ? "no-data" : n < 4 ? "very-low" : n <= 5 ? "low" : n <= 7 ? "moderate" : "good";
  const teams = {};
  for (const code of Object.keys(TEAM_TZ)) {
    const homeGames = hfaRows.filter((g) => g.home === code);
    const awayGames = hfaRows.filter((g) => g.away === code);
    const homeExp = homeGames.filter((g) => g.expectationMargin != null);
    const awayExp = awayGames.filter((g) => g.expectationMargin != null);
    const split = (rows, sign, source) => {
      const subset = rows.filter((g) => g.expectationSource === source);
      return subset.length ? round2(mean(subset.map((g) => sign * (g.actualMargin - g.expectationMargin)))) : null;
    };
    const homeEffect = homeExp.length ? mean(homeExp.map((g) => g.actualMargin - g.expectationMargin)) : null;
    const awayEffect = awayExp.length ? mean(awayExp.map((g) => -(g.actualMargin - g.expectationMargin))) : null;
    teams[code] = {
      homeGames: homeGames.length,
      homeWinPct: homeGames.length ? round3(homeGames.filter(homeWin).length / homeGames.length) : null,
      meanHomeMargin: homeGames.length ? round2(mean(homeGames.map((g) => g.actualMargin))) : null,
      awayGames: awayGames.length,
      awayWinPct: awayGames.length ? round3(awayGames.filter(awayWin).length / awayGames.length) : null,
      meanAwayMargin: awayGames.length ? round2(mean(awayGames.map((g) => -g.actualMargin))) : null,
      homeN: homeExp.length,
      homeEffect: homeEffect != null ? round2(homeEffect) : null,
      homeVsMarket: split(homeExp, 1, "market"),
      homeVsFourthDown: split(homeExp, 1, "fourth-down"),
      awayN: awayExp.length,
      awayEffect: awayEffect != null ? round2(awayEffect) : null,
      awayVsMarket: split(awayExp, -1, "market"),
      awayVsFourthDown: split(awayExp, -1, "fourth-down"),
      confidence: `${teamConfidence(homeExp.length)}/${teamConfidence(awayExp.length)}`,
      shrunkHomeEffect: shrinkTeam(homeEffect, homeExp.length, leagueHomeBaseline),
      shrunkAwayEffect: shrinkTeam(awayEffect, awayExp.length, leagueAwayBaseline),
    };
  }

  // Team-game rows for rest factors (margin from that team's perspective).
  const teamGames = completed.flatMap((g) => [
    { game: g, code: g.away, daysRest: g.awayContext?.daysRest ?? null, roadRun: g.awayContext?.roadRun ?? 0,
      margin: -g.actualMargin, won: g.actualWinner === g.away },
    { game: g, code: g.home, daysRest: g.homeContext?.daysRest ?? null, roadRun: 0,
      margin: g.actualMargin, won: g.actualWinner === g.home },
  ]);
  const restDiff = (g) =>
    g.homeContext?.daysRest == null || g.awayContext?.daysRest == null
      ? null : g.homeContext.daysRest - g.awayContext.daysRest;

  // Generic "group vs complement" factor on game rows.
  const gameFactor = (rows, test, valueFn, winFn, currentAdjustment) => {
    const inside = rows.filter(test);
    const outside = rows.filter((r) => !test(r));
    const inValues = inside.map(valueFn).filter((v) => v != null);
    const outValues = outside.map(valueFn).filter((v) => v != null);
    const wins = inside.filter(winFn).length;
    const winsOut = outside.filter(winFn).length;
    const effect = inValues.length && outValues.length ? mean(inValues) - mean(outValues) : null;
    const z = zMeans(inValues, outValues);
    const zw = zRate(wins, inside.length, winsOut, outside.length);
    return {
      n: inside.length,
      winPct: inside.length ? round3(wins / inside.length) : null,
      mean: inValues.length ? round2(mean(inValues)) : null,
      baselineMean: outValues.length ? round2(mean(outValues)) : null,
      baselineN: outside.length,
      observedEffect: effect != null ? round2(effect) : null,
      zMean: z != null ? round2(z) : null,
      zWin: zw != null ? round2(zw) : null,
      reliability: reliability(Math.abs(z ?? 0) >= Math.abs(zw ?? 0) ? z : zw, inside.length),
      currentAdjustment,
      derived: shrink(effect, inside.length),
    };
  };
  const teamFactor = (test, currentAdjustment) =>
    gameFactor(teamGames, test, (t) => t.margin, (t) => t.won, currentAdjustment);
  const awayMarginFactor = (test, currentAdjustment) =>
    gameFactor(completed.filter((g) => g.travelMiles != null || g.zonesEast != null), test,
      (g) => -g.actualMargin, awayWin, currentAdjustment);
  const homeMarginFactor = (test, currentAdjustment) =>
    gameFactor(completed, test, (g) => g.actualMargin, homeWin, currentAdjustment);

  const outdoor = completed.filter((g) => !g.dome && g.weather);
  const windMph = (g) => g.weather.windSpeed * 0.621371;
  const tempF = (g) => (g.weather.temperature * 9) / 5 + 32;
  const totalFactor = (test, currentAdjustment) =>
    gameFactor(outdoor, test, (g) => g.actualTotal, homeWin, currentAdjustment);

  const dome = completed.filter((g) => g.dome);
  const outAll = completed.filter((g) => !g.dome);
  const domeZ = zMeans(dome.map((g) => g.actualTotal), outAll.map((g) => g.actualTotal));

  const factors = {
    homeFieldAdvantage: {
      n: hfaRows.length,
      neutralSiteExcluded: completed.length - hfaRows.length,
      homeWinPct: hfaRows.length ? round3(hfaRows.filter(homeWin).length / hfaRows.length) : null,
      observedHomeMargin: hfaRows.length ? round2(mean(hfaRows.map((g) => g.actualMargin))) : null,
      zWin: hfaRows.length ? round2(zRate(hfaRows.filter(homeWin).length, hfaRows.length,
        hfaRows.filter(awayWin).length, hfaRows.length)) : null,
      currentAdjustment: "venue base 0.35-2.50 (league mean ~1.6) + travel penalty",
      derived: shrink(hfaRows.length ? mean(hfaRows.map((g) => g.actualMargin)) : null, hfaRows.length),
    },
    domeVsOutdoor: {
      domeN: dome.length, outdoorN: outAll.length,
      domeMeanTotal: dome.length ? round2(mean(dome.map((g) => g.actualTotal))) : null,
      outdoorMeanTotal: outAll.length ? round2(mean(outAll.map((g) => g.actualTotal))) : null,
      domeHomeWinPct: dome.length ? round3(dome.filter(homeWin).length / dome.length) : null,
      outdoorHomeWinPct: outAll.length ? round3(outAll.filter(homeWin).length / outAll.length) : null,
      observedTotalEffect: dome.length && outAll.length
        ? round2(mean(dome.map((g) => g.actualTotal)) - mean(outAll.map((g) => g.actualTotal))) : null,
      zMean: domeZ != null ? round2(domeZ) : null,
      reliability: reliability(domeZ, Math.min(dome.length, outAll.length)),
      currentAdjustment: "dome = neutral (no weather adjustment)",
      derived: 0, // total effect only; never applied until significant
    },
    wind: {
      calm: totalFactor((g) => windMph(g) < 10, "none below 10 mph"),
      breezy: totalFactor((g) => windMph(g) >= 10 && windMph(g) < 15, "windLoad ramps from 10 mph (small)"),
      windy: totalFactor((g) => windMph(g) >= 15 && windMph(g) < 20, "moderate scoring reduction"),
      veryWindy: totalFactor((g) => windMph(g) >= 20, "strong scoring reduction"),
    },
    temperature: {
      cold: totalFactor((g) => tempF(g) < 40, "extreme cold load only below -7C"),
      cool: totalFactor((g) => tempF(g) >= 40 && tempF(g) < 60, "none"),
      mild: totalFactor((g) => tempF(g) >= 60 && tempF(g) < 75, "none"),
      hot: totalFactor((g) => tempF(g) >= 75, "extreme heat load only above 32C"),
    },
    rain: totalFactor((g) => Math.max(g.weather.rain, g.weather.precipitation) >= 1,
      "rainLoad reduces passingTD/FG/XP, raises turnovers"),
    snow: totalFactor((g) => g.weather.snowfall > 0,
      "snowLoad reduces passingTD/FG/XP, raises turnovers"),
    travelDistance: {
      short: awayMarginFactor((g) => g.travelMiles != null && g.travelMiles < 500, "none (distance itself not modeled)"),
      medium: awayMarginFactor((g) => g.travelMiles >= 500 && g.travelMiles < 1000, "none (distance itself not modeled)"),
      long: awayMarginFactor((g) => g.travelMiles >= 1000 && g.travelMiles < 2000, "none (distance itself not modeled)"),
      crossCountry: awayMarginFactor((g) => g.travelMiles >= 2000, "none (distance itself not modeled)"),
      applied: false,
      note: "Non-monotonic 2026 evidence; tracked but not applied to predictions",
    },
    timezone: {
      awayEast2: awayMarginFactor((g) => g.zonesEast != null && g.zonesEast >= 2, "travel penalty 0.25-1.0 pts to home"),
      awayWest2: awayMarginFactor((g) => g.zonesEast != null && g.zonesEast <= -2, "none"),
    },
    rest: {
      veryShortWeek: teamFactor((t) => t.daysRest != null && t.daysRest <= 4, "-0.7 pts"),
      shortWeek: teamFactor((t) => t.daysRest === 5, "-0.4 pts"),
      extendedRest: teamFactor((t) => t.daysRest != null && t.daysRest >= 9 && t.daysRest < 12, "+0.3 pts"),
      postBye: teamFactor((t) => t.daysRest != null && t.daysRest >= 12, "+0.6 pts"),
    },
    restDifferential: {
      home36: homeMarginFactor((g) => restDiff(g) != null && restDiff(g) >= 3 && restDiff(g) < 7, "+0.4 pts home"),
      home7: homeMarginFactor((g) => restDiff(g) != null && restDiff(g) >= 7, "+0.8 pts home"),
      away3: homeMarginFactor((g) => restDiff(g) != null && restDiff(g) <= -3, "-0.4/-0.8 pts home"),
    },
    consecutiveRoadGames: {
      second: awayMarginFactor((g) => (g.awayContext?.roadRun ?? 0) === 2, "-0.2 pts away"),
      thirdPlus: awayMarginFactor((g) => (g.awayContext?.roadRun ?? 0) >= 3, "-0.4 pts away"),
    },
  };

  return {
    season,
    gamesUsed: completed.length,
    maxCompletedWeek: completed.length ? Math.max(...completed.map((g) => g.week)) : 0,
    league: {
      homeBaselineVsExpectation: round2(leagueHomeBaseline),
      awayBaselineVsExpectation: round2(leagueAwayBaseline),
    },
    teams,
    factors,
    variance: buildVariance(predictions),
    // Compact completed-game list so rest/road-run for upcoming games can be
    // derived at prediction time without any schedule-context input.
    completedSchedule: completed.map((g) => ({ week: g.week, away: g.away, home: g.home, kickoff: g.kickoff })),
  };
}

function buildVariance(predictions) {
  const rows = (predictions || []).filter((p) => Number.isFinite(p.predictedMargin) && Number.isFinite(p.actualMargin));
  const metrics = (list) => {
    const decided = list.filter((g) => g.actualWinner && g.actualWinner !== "TIE");
    const correct = decided.filter((g) => g.modelPick === g.actualWinner);
    const marketRows = list.filter((g) => g.marketMargin != null);
    const residuals = list.map((g) => g.actualMargin - g.predictedMargin);
    return {
      games: list.length,
      winnerAccuracy: decided.length ? round3(correct.length / decided.length) : null,
      marginMae: list.length ? round2(mean(list.map((g) => Math.abs(g.actualMargin - g.predictedMargin)))) : null,
      rmse: list.length ? round2(Math.sqrt(mean(list.map((g) => (g.actualMargin - g.predictedMargin) ** 2)))) : null,
      residualMean: list.length ? round2(mean(residuals)) : null,
      residualSd: residuals.length > 1 ? round2(sd(residuals)) : null,
      marketMae: marketRows.length
        ? round2(mean(marketRows.map((g) => Math.abs(g.actualMargin - g.marketMargin)))) : null,
    };
  };
  const buckets = [[0, 3], [3, 6], [6, 9], [9, 99]].map(([lo, hi]) => {
    const band = rows.filter((g) => Math.abs(g.predictedMargin) >= lo && Math.abs(g.predictedMargin) < hi);
    const residuals = band.map((g) => g.actualMargin - g.predictedMargin);
    return { band: `${lo}-${hi === 99 ? "+" : hi}`, n: band.length,
      residualSd: residuals.length > 1 ? round2(sd(residuals)) : null,
      marginMae: band.length ? round2(mean(band.map((g) => Math.abs(g.actualMargin - g.predictedMargin)))) : null };
  });
  const ROLLING_WINDOW = 16;
  const ordered = [...rows].sort((a, b) => new Date(a.kickoff || 0) - new Date(b.kickoff || 0));
  const rolling = ordered.map((g, i) => {
    const window = ordered.slice(Math.max(0, i - ROLLING_WINDOW + 1), i + 1)
      .map((x) => x.actualMargin - x.predictedMargin);
    return { week: g.week, rollingSd: window.length >= 5 ? round2(sd(window)) : null };
  });
  return {
    ...metrics(rows),
    currentModel: metrics(rows.filter((g) => g.currentModel)),
    marginBuckets: buckets,
    rollingSdLatest: rolling.filter((r) => r.rollingSd != null).at(-1)?.rollingSd ?? null,
    rollingSdByWeek: [...new Set(rolling.map((r) => r.week))].sort((a, b) => a - b).map((week) => {
      const w = rolling.filter((r) => r.week === week && r.rollingSd != null);
      return { week, rollingSd: w.length ? w.at(-1).rollingSd : null };
    }),
  };
}

// --- Production application ------------------------------------------------------

function datasetUsable(dataset, week, validationOnly = false) {
  return (EXTERNAL_FACTORS_2026_ENABLED || validationOnly) && dataset?.season === 2026 &&
    dataset.gamesUsed > 0 && Number.isInteger(Number(week)) && Number(week) >= 2 &&
    dataset.maxCompletedWeek < Number(week);
}

// Rest/road-run for the game being predicted, from completed games only.
function upcomingScheduleContext(dataset, away, home, kickoff) {
  const result = {};
  for (const [side, code] of [["away", away], ["home", home]]) {
    const prior = (dataset.completedSchedule || [])
      .filter((g) => (g.away === code || g.home === code) &&
        new Date(g.kickoff) < new Date(kickoff))
      .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    const prev = prior[prior.length - 1];
    const daysRest = prev && kickoff
      ? Math.round((new Date(kickoff) - new Date(prev.kickoff)) / 86400000)
      : null;
    let roadRun = 0;
    if (side === "away") {
      roadRun = 1;
      for (let i = prior.length - 1; i >= 0 && prior[i].away === code; i--) roadRun++;
    }
    result[side] = { daysRest, roadRun, priorGames: prior.length };
  }
  return result;
}

// Dynamic weather total-points effect for the observed conditions, or null when
// no 2026 evidence exists for them (caller then keeps the static fallback only).
function dynamicWeatherTotalEffect(factors, weather) {
  if (!weather || weather.dome) return factors.domeVsOutdoor.domeN ? 0 : null;
  if (weather.weatherAvailable === false) return null;
  const windMph = num(weather.windSpeed);
  const tempC = num(weather.temperature);
  if (windMph == null || tempC == null) return null;
  const parts = [];
  const mph = windMph * 0.621371;
  const wind = mph >= 20 ? factors.wind.veryWindy : mph >= 15 ? factors.wind.windy
    : mph >= 10 ? factors.wind.breezy : null;
  if (wind) parts.push(wind);
  const rainMm = Math.max(0, num(weather.rain, num(weather.precipitation, 0)));
  if (rainMm >= 1) parts.push(factors.rain);
  if (Math.max(0, num(weather.snowfall, 0)) > 0) parts.push(factors.snow);
  const f = (tempC * 9) / 5 + 32;
  const temp = f < 40 ? factors.temperature.cold : f >= 75 ? factors.temperature.hot : null;
  if (temp) parts.push(temp);
  const evidenced = parts.filter((p) => p.n > 0);
  if (!evidenced.length) return null;
  return clamp(evidenced.reduce((total, p) => total + p.derived, 0), -MAX_DERIVED_ADJ, MAX_DERIVED_ADJ);
}

export function computeExternalAdjustments2026(dataset, { away, home, kickoff, weather, week, validationOnly = false } = {}) {
  const awayCode = normTeam(away);
  const homeCode = normTeam(home);
  const varianceNote = "Uncertainty estimate only; winner, probability, margin and score are unchanged by this measurement";

  if (!dataset || dataset.season !== 2026 || !dataset.gamesUsed) {
    return { active: false, reason: "2026 external-factor dataset unavailable", variance: null };
  }
  const variance = computeVariance2026(dataset, null);
  if (!datasetUsable(dataset, week, validationOnly)) {
    return { active: false,
      reason: !EXTERNAL_FACTORS_2026_ENABLED
        ? "Disabled pending walk-forward validation"
        : "Insufficient completed 2026 games before this week",
      variance: { ...variance, note: varianceNote } };
  }

  const league = dataset.league;
  const factors = dataset.factors;
  const homeTeam = dataset.teams?.[homeCode];
  const awayTeam = dataset.teams?.[awayCode];

  // Venue: shrunk league home margin + each team's shrunk deviation from the
  // league vs-expectation baseline. Negative venue effects are allowed.
  const leagueHfa = factors.homeFieldAdvantage.derived;
  const homeDev = (homeTeam?.shrunkHomeEffect ?? league.homeBaselineVsExpectation) - league.homeBaselineVsExpectation;
  const awayDev = (awayTeam?.shrunkAwayEffect ?? league.awayBaselineVsExpectation) - league.awayBaselineVsExpectation;
  const venueHomeEdge = leagueHfa + homeDev - awayDev;

  // Timezone travel (away team crossing 2+ zones). Distance itself is not
  // applied: 2026 evidence is non-monotonic. Falls back to the static travel
  // penalty only when a direction has no 2026 sample at all.
  const awayTz = TEAM_TZ[awayCode]; const homeTz = TEAM_TZ[homeCode];
  const zonesEast = awayTz != null && homeTz != null ? homeTz - awayTz : null;
  let travelHomeEdge = 0;
  let travelSource = "none";
  if (zonesEast != null && zonesEast >= 2) {
    if (factors.timezone.awayEast2.n > 0) {
      travelHomeEdge = -factors.timezone.awayEast2.derived;
      travelSource = "2026-east-travel";
    } else {
      travelHomeEdge = travelPenalty(homeCode, awayCode, kickoff);
      travelSource = "static-fallback";
    }
  } else if (zonesEast != null && zonesEast <= -2) {
    if (factors.timezone.awayWest2.n > 0) {
      travelHomeEdge = -factors.timezone.awayWest2.derived;
      travelSource = "2026-west-travel";
    }
  }
  const homeEdge = round2(clamp(venueHomeEdge + travelHomeEdge, -3.25, 3.25));

  // Rest: relative rest differential plus consecutive-road-game effect. Absolute
  // post-bye/extended-rest factors are tracked in the dataset but not added here
  // (same games drive both; the differential is the relative measure).
  const schedule = upcomingScheduleContext(dataset, awayCode, homeCode, kickoff);
  const restDiff = schedule.home.daysRest == null || schedule.away.daysRest == null
    ? null : schedule.home.daysRest - schedule.away.daysRest;
  let restHomeMargin = 0;
  let restSource = "balanced";
  if (restDiff != null) {
    if (restDiff >= 7) { restHomeMargin = factors.restDifferential.home7.derived; restSource = "home-rest-7+"; }
    else if (restDiff >= 3) { restHomeMargin = factors.restDifferential.home36.derived; restSource = "home-rest-3-6"; }
    else if (restDiff <= -3) { restHomeMargin = factors.restDifferential.away3.derived; restSource = "away-rest-3+"; }
  }
  let roadHomeMargin = 0;
  if (schedule.away.roadRun >= 3) roadHomeMargin = -factors.consecutiveRoadGames.thirdPlus.derived;
  else if (schedule.away.roadRun === 2) roadHomeMargin = -factors.consecutiveRoadGames.second.derived;
  const totalRestHome = clamp(restHomeMargin + roadHomeMargin, -MAX_DERIVED_ADJ, MAX_DERIVED_ADJ);

  const weatherTotalEffect = dynamicWeatherTotalEffect(factors, weather);

  return {
    active: true,
    homeEdge,
    restHomePoints: round2(totalRestHome / 2),
    restAwayPoints: round2(-totalRestHome / 2),
    weatherTotalEffect: weatherTotalEffect != null ? round2(weatherTotalEffect) : null,
    variance: { ...variance, note: varianceNote },
    trace: {
      venue: {
        homePoints: round2(venueHomeEdge),
        leagueHfa,
        leagueN: factors.homeFieldAdvantage.n,
        homeTeamEffect: homeTeam?.shrunkHomeEffect ?? null,
        homeN: homeTeam?.homeN ?? 0,
        awayTeamEffect: awayTeam?.shrunkAwayEffect ?? null,
        awayN: awayTeam?.awayN ?? 0,
        homeConfidence: homeTeam?.confidence ?? "no-data",
        awayConfidence: awayTeam?.confidence ?? "no-data",
      },
      travel: {
        homePoints: round2(travelHomeEdge), zonesEast, source: travelSource,
        n: travelSource === "2026-east-travel" ? factors.timezone.awayEast2.n
          : travelSource === "2026-west-travel" ? factors.timezone.awayWest2.n : 0,
      },
      rest: {
        homeMargin: round2(totalRestHome), restDifferentialDays: restDiff,
        awayDaysRest: schedule.away.daysRest, homeDaysRest: schedule.home.daysRest,
        awayRoadRun: schedule.away.roadRun, source: restSource,
        restN: restSource === "home-rest-7+" ? factors.restDifferential.home7.n
          : restSource === "home-rest-3-6" ? factors.restDifferential.home36.n
          : restSource === "away-rest-3+" ? factors.restDifferential.away3.n : 0,
        roadRunN: schedule.away.roadRun >= 3 ? factors.consecutiveRoadGames.thirdPlus.n
          : schedule.away.roadRun === 2 ? factors.consecutiveRoadGames.second.n : 0,
      },
      weather: {
        totalEffect: weatherTotalEffect != null ? round2(weatherTotalEffect) : null,
        source: weatherTotalEffect != null ? "2026-observed-blended-with-static" : "static-only",
      },
    },
  };
}

// Uncertainty around the point differential. Never changes the prediction.
export function computeVariance2026(dataset, expectedMargin) {
  const v = dataset?.variance;
  if (!v || !v.games) return null;
  const residualSd = v.currentModel?.residualSd ?? v.residualSd;
  let gameSpecificSd = null;
  if (Number.isFinite(expectedMargin)) {
    const band = (v.marginBuckets || []).find((b) => {
      const [lo, hi] = b.band.replace("+", "-99").split("-").map(Number);
      return Math.abs(expectedMargin) >= lo && Math.abs(expectedMargin) < (hi === 99 ? 99 : hi);
    });
    gameSpecificSd = band?.residualSd ?? null;
  }
  const effective = gameSpecificSd ?? residualSd;
  return {
    expectedMargin: Number.isFinite(expectedMargin) ? round3(Math.abs(expectedMargin)) : null,
    residualSd,
    rollingResidualSd: v.rollingSdLatest ?? null,
    gameSpecificSd,
    classification: effective == null ? "unknown" : effective < 10 ? "low" : effective <= 13 ? "medium" : "high",
    games: v.games,
  };
}

// Weather points split for predictCore: applies only the delta between the
// blended static+dynamic total effect and the static simulation effect.
export function weatherPointsSplit(external, weatherCoefficient, awayBase, homeBase) {
  const neutral = { away: 0, home: 0, increment: 0, staticEffect: 0 };
  if (!external?.active || external.weatherTotalEffect == null) return neutral;
  const baseTotal = awayBase + homeBase;
  if (!(baseTotal > 0)) return neutral;
  const staticEffect = (num(weatherCoefficient, 1) - 1) * baseTotal;
  const increment = clamp((external.weatherTotalEffect - staticEffect) / 2, -1.5, 1.5);
  return {
    away: round3(increment * (awayBase / baseTotal)),
    home: round3(increment * (homeBase / baseTotal)),
    increment: round3(increment),
    staticEffect: round3(staticEffect),
  };
}

export { isCurrentModelIdentity };
