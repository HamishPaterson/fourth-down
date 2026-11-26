import { apiFetch as fetch } from "./supabaseAuth.js";
import { predictMatchup } from "./predictionEngine.js";
import { buildPlayerProjections } from "./playerProjectionService.js";
import * as nflApi from "./nflApi.js";
import { getQuarterbackQbr, getTeamRatingsHealth } from "./teamRatings.js";
import { getStadiumWeather } from "./weatherApi.js";
import { resolveStadium } from "./stadiums.js";
import { buildBestBets } from "./bestBetsService.js";
import { personnelAvailableAt, validDepthLineup, validDepthRoster } from "../../api-lib/depthCharts.js";
import { PLAYER_PROPS_HELD } from "./playerPropPolicy.js";
import { buildPersonnelView, PERSONNEL_VIEW_VERSION } from "../../api-lib/personnelView.js";
import { buildSpecialTeamsModel } from "./specialTeams.js";
import PLAYER_RATINGS from "../../data/player-ratings-2026.js";
import { nameKey, teamUnitRatings } from "./fourthDownRatings.js";
import { CURRENT_MODEL_VERSION as FULL_MODEL_VERSION, CURRENT_MODEL_KEY as FULL_MODEL_KEY } from "./modelIdentity.js";

export { FULL_MODEL_VERSION, FULL_MODEL_KEY };
const cache = new Map();
const pending = new Map();
const CACHE_MS = 5 * 60 * 1000;

export async function getFullGamePrediction(game, oddsEvent, options = {}) {
  const season = Number(options.season || 2026);
  const week = Number(game.week || options.week || 1);
  const away = normalizeCode(game.away);
  const home = normalizeCode(game.home);
  const oddsFingerprint = createOddsFingerprint(oddsEvent);
  const kickoffKey = game.sourceDate || game.date || game.time || "no-kickoff";
  const venueKey = typeof game.venue === "string"
    ? game.venue.trim().toLowerCase()
    : String(game.venue?.fullName || game.venue?.name || "").trim().toLowerCase();
  const key = `${options.loadInputs ? "server:" : ""}${season}:${week}:${away}:${home}:${kickoffKey}:${venueKey}:${FULL_MODEL_KEY}:${oddsFingerprint}`;
  const cached = cache.get(key);

  if (!options.forceRefresh && cached && Date.now() - cached.savedAt < CACHE_MS) {
    return cached.value;
  }

  if (pending.has(key)) return pending.get(key);

  const request = createPrediction({
    game,
    oddsEvent,
    season,
    week,
    away,
    home,
    signal: options.signal,
    loadInputs: options.loadInputs,
  })
    .then((value) => {
      cache.set(key, { value, savedAt: Date.now() });
      return value;
    })
    .finally(() => pending.delete(key));

  pending.set(key, request);
  return request;
}

export function clearFullGamePredictionCache() {
  cache.clear();
}

function createOddsFingerprint(event) {
  const books = Array.isArray(event?.bookmakers) ? event.bookmakers : [];
  const marketCount = books.reduce(
    (total, book) => total + (Array.isArray(book?.markets) ? book.markets.length : 0),
    0
  );
  const outcomeCount = books.reduce(
    (total, book) =>
      total +
      (book?.markets || []).reduce(
        (sum, market) => sum + (Array.isArray(market?.outcomes) ? market.outcomes.length : 0),
        0
      ),
    0
  );
  return `${event?.id || "no-event"}:${books.length}:${marketCount}:${outcomeCount}`;
}

async function createPrediction({ game, oddsEvent, season, week, away, home, signal, loadInputs }) {
  const weather = await resolveGameWeather(game, home, signal);
  const gameWithWeather = {
    ...game,
    weather,
  };
  const tasks = loadInputs ? loadInputs({ away, home, season, week, signal }) : {
    standings: optionalCall("getStandings", [signal]),
    personnel: optionalCall("getQbRosterHealth", [away, home, season, signal, week]),
    teamForm: week > 1
      ? optionalCall("getTeamForm", [away, home, season, week, signal])
      : Promise.resolve(null),
    opponentNetwork: week > 1
      ? optionalCall("getOpponentNetwork", [away, home, season, week, signal])
      : Promise.resolve(null),
    playByPlay: week > 1
      ? firstAvailableCall(
          ["getPlayByPlayMetrics", "getNflverseMetrics", "getTeamMetrics"],
          [away, home, season, week, signal]
        )
      : Promise.resolve(null),
    playerMetrics: week > 1
      ? fetchPlayerMetrics(away, home, season, week, signal)
      : Promise.resolve(null),
    awayRoster: fetchRoster(away, signal),
    homeRoster: fetchRoster(home, signal),
  };

  const names = Object.keys(tasks);
  const settled = await Promise.allSettled(Object.values(tasks));
  const values = {};
  const dataQuality = {};

  settled.forEach((result, index) => {
    const name = names[index];
    dataQuality[name] = result.status === "fulfilled" && result.value !== null &&
      !(name === "playByPlay" && result.value.dataStatus === "context-only");
    values[name] = result.status === "fulfilled" ? result.value : null;
    if (name === "opponentNetwork" && result.status === "rejected") {
      const reason = result.reason instanceof Error ? result.reason.message : "Opponent network unavailable";
      values[name] = { available: false, dataStatus: "unavailable", reason,
        modelLayer: { ...neutralLayer(), reasons: [reason] } };
    }
  });

  const standingsByCode = Object.fromEntries(
    toArray(values.standings)
      .map((row) => [normalizeCode(row?.abbreviation), row])
      .filter(([code]) => code)
  );

  const homeStanding = standingsByCode[home];
  const awayStanding = standingsByCode[away];
  const depthLineup = values.playByPlay?.away?.expectedLineup;
  const personnelCutoff = values.personnel?.cutoff ||
    (validDepthRoster(depthLineup, week, season) ? depthLineup.cutoff : null);
  const personnel = personnelAvailableAt(values.personnel, personnelCutoff) ? values.personnel : null;
  const awayRoster = personnelAvailableAt(values.awayRoster, personnelCutoff) ? values.awayRoster : null;
  const homeRoster = personnelAvailableAt(values.homeRoster, personnelCutoff) ? values.homeRoster : null;
  const qbrAvailable = personnelAvailableAt(getTeamRatingsHealth(), personnelCutoff);
  const personnelViews = {
    away: personnel?.away?.personnelView || buildPersonnelView({
      team: away,
      lineup: values.playByPlay?.away?.expectedLineup,
      roster: awayRoster,
      cutoff: personnelCutoff,
      season,
      week,
    }),
    home: personnel?.home?.personnelView || buildPersonnelView({
      team: home,
      lineup: values.playByPlay?.home?.expectedLineup,
      roster: homeRoster,
      cutoff: personnelCutoff,
      season,
      week,
    }),
  };
  const specialTeams = buildSpecialTeamsModel({
    away,
    home,
    personnelViews,
    kickerProfiles: values.playByPlay?.kickerProfiles,
    season,
    week,
    cutoff: personnelCutoff,
    weather,
    venue: gameWithWeather.venue,
  });
  dataQuality.kicker = [specialTeams.away, specialTeams.home]
    .some((kicker) => kicker.profileAvailable);
  dataQuality.personnel = Boolean(personnel);
  dataQuality.awayRoster = Boolean(awayRoster);
  dataQuality.homeRoster = Boolean(homeRoster);
  dataQuality.personnelTiming = {
    cutoff: personnelCutoff,
    personnel: Boolean(personnel), awayRoster: Boolean(awayRoster), homeRoster: Boolean(homeRoster),
    qbr: qbrAvailable,
    rule: "Exclude personnel sources without proven availability at or before the weekly cutoff",
  };

  const modelLayers = {
    ...extractLayers(values.teamForm),
    ...extractLayers(values.playByPlay),
    playerRatings: buildPlayerRatingsLayer({ away, home, season, week, awayRoster, homeRoster }),
    opponentNetwork:
      values.opponentNetwork?.modelLayer ||
      values.opponentNetwork?.modelLayers?.opponentNetwork ||
      neutralLayer(),
    quarterback: buildQuarterbackLayer(
      personnel?.away?.quarterback,
      personnel?.home?.quarterback,
      qbrAvailable ? getQuarterbackQbr(selectedStartingQuarterback(personnelViews.away)) : null,
      qbrAvailable ? getQuarterbackQbr(selectedStartingQuarterback(personnelViews.home)) : null,
      week
    ),
    rosterHealth: buildPersonnelLayer(
      personnel?.away?.rosterHealth,
      personnel?.home?.rosterHealth
    ),
  };

  const prediction = predictMatchup(away, home, {
    season,
    opponentNetwork: values.opponentNetwork,
    personnelViews,
    teamMetrics: values.playByPlay,
    playerMetrics: values.playerMetrics,
    kickoff: gameWithWeather.sourceDate,
    weather: gameWithWeather.weather || null,
    market: oddsEvent,
    week,
    homeSplit: homeStanding
      ? { home: homeStanding.home, road: homeStanding.road }
      : undefined,
    awaySplit: awayStanding
      ? { home: awayStanding.home, road: awayStanding.road }
      : undefined,
    scheduleContext: gameWithWeather.scheduleContext,
    modelLayers,
    specialTeams,
    rivalry: gameWithWeather.scheduleContext
      ? {
          meetingNumber: gameWithWeather.scheduleContext.meetingNumber,
          previousMargin: gameWithWeather.scheduleContext.previousMeetingMargin,
        }
      : undefined,
  });

  const playerDepth = [values.playByPlay?.away?.expectedLineup, values.playByPlay?.home?.expectedLineup]
    .find((lineup) => validDepthRoster(lineup, week, season));
  const playerProjections = buildPlayerProjections({
    away,
    home,
    prediction,
    playerMetrics: values.playerMetrics,
    personnelViews,
    teamMetrics: values.playByPlay,
    season, week, cutoff: personnelCutoff || playerDepth?.cutoff,
  });
  dataQuality.playerProjections = playerProjections.available === true;
  const bestBets = buildBestBets({
    holdPlayerProps: PLAYER_PROPS_HELD,
    game: { ...gameWithWeather, season, week, away, home },
    prediction,
    playerProjections,
    personnelViews,
    oddsEvent,
    dataQuality,
    teamMetrics: values.playByPlay,
    asOf: new Date().toISOString(),
  });
  dataQuality.bestBets = bestBets.available === true;
  return {
    prediction,
    playerProjections,
    personnelViews,
    bestBets,
    dataQuality: {
      ...dataQuality,
      weather,
      sources: buildSourceDiagnostics({ ...values, personnel, specialTeams }, weather, oddsEvent),
    },
    weather,
    modelVersion: FULL_MODEL_VERSION,
    modelKey: FULL_MODEL_KEY,
    personnelVersion: PERSONNEL_VIEW_VERSION,
    generatedAt: new Date().toISOString(),
  };
}

function buildSourceDiagnostics(values, weather, oddsEvent) {
  return {
    playByPlay: sourceDiagnostic(values.playByPlay, "nflverse play-by-play"),
    teamForm: sourceDiagnostic(values.teamForm, "team form"),
    opponentNetwork: sourceDiagnostic(values.opponentNetwork, "opponent network"),
    personnel: sourceDiagnostic(values.personnel, "QB and roster health"),
    kicker: {
      label: "NFLverse kicker performance",
      available: values.specialTeams?.artifactAvailable === true,
      updatedAt: values.specialTeams?.artifactAvailable
        ? values.playByPlay?.kickerProfiles?.generatedAt || null
        : null,
      source: values.specialTeams?.source || null,
      warning: values.specialTeams?.artifactAvailable
        ? null
        : "Point-in-time kicker artifact unavailable; league simulation fallback active",
    },
    playerMetrics: sourceDiagnostic(values.playerMetrics, "nflverse player metrics"),
    weather: { label: "weather", available: Boolean(weather), updatedAt: weather?.generatedAt || null },
    odds: { label: "odds", available: Boolean(oddsEvent), updatedAt: oddsEvent?.last_update || oddsEvent?.updatedAt || null },
  };
}
function sourceDiagnostic(value, label) {
  return {
    label,
    available: Boolean(value) && value?.dataStatus !== "neutral" &&
      value?.dataStatus !== "context-only" && value?.available !== false,
    updatedAt: value?.generatedAt || value?.refreshedAt || null,
    source: value?.source || null,
    warning: value?.warning || value?.reason ||
      (value?.dataStatus === "context-only"
        ? "Eligible PBP performance is unavailable; independent lineup and personnel context remains available"
        : null),
  };
}
async function resolveGameWeather(game, homeCode, signal) {
  const resolution = resolveStadium(homeCode, game?.venue);
  const explicitScheduledVenue = resolution.source.startsWith("scheduled-");
  if (game?.weather && !explicitScheduledVenue && resolution.stadium) {
    return {
      ...game.weather,
      venue: game.weather.venue || game.weather.stadium || resolution.stadium.name,
      venueConfidence: game.weather.venueConfidence ?? resolution.confidence,
      venueSource: game.weather.venueSource || resolution.source,
      weatherAvailable: game.weather.weatherAvailable ?? true,
      weatherSource: game.weather.weatherSource || "provided-home-default",
    };
  }
  const providedVenue = game?.weather?.venue || game?.weather?.stadium;
  if (game?.weather && resolution.stadium &&
      providedVenue === resolution.stadium.name) {
    return {
      ...game.weather,
      venue: resolution.stadium.name,
      venueConfidence: resolution.confidence,
      venueSource: resolution.source,
      weatherAvailable: game.weather.weatherAvailable ?? true,
    };
  }
  const kickoff = game?.sourceDate || game?.date || game?.time || null;
  if (!homeCode || !kickoff) return null;
  try {
    return await getStadiumWeather(homeCode, kickoff, signal, game?.venue);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    console.warn(`Weather unavailable for ${homeCode}`, error);
    return null;
  }
}

async function fetchPlayerMetrics(away, home, season, week, signal) {
  const params = new URLSearchParams({
    action: "player-metrics",
    away,
    home,
    season: String(season),
    week: String(week),
  });
  const response = await fetch(`/api/nfl/game-stats?${params.toString()}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Player metrics endpoint returned invalid JSON");
  }
  if (!response.ok) {
    throw new Error(body?.error || `Player metrics request failed (${response.status})`);
  }
  return body;
}

async function optionalCall(name, args) {
  return typeof nflApi[name] === "function" ? nflApi[name](...args) : null;
}

async function firstAvailableCall(names, args) {
  const name = names.find((candidate) => typeof nflApi[candidate] === "function");
  return name ? nflApi[name](...args) : null;
}

async function fetchRoster(team, signal) {
  const response = await fetch(
    `/api/nfl/sleeper-players?team=${encodeURIComponent(team)}`,
    { signal, headers: { Accept: "application/json" } }
  );
  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Roster endpoint returned invalid JSON for ${team}`);
  }

  if (!response.ok) {
    throw new Error(body?.details || body?.error || `Roster request failed (${response.status})`);
  }

  return body;
}

function extractLayers(payload) {
  return payload?.modelLayers && typeof payload.modelLayers === "object"
    ? payload.modelLayers
    : {};
}

// QBR identity source: the quarterback already selected by the personnel view.
// No team- or roster-based fallback: an unresolved decision or missing starter
// yields null so the QBR layer receives zero weight for that side.
function selectedStartingQuarterback(personnelView) {
  const decision = personnelView?.quarterback;
  return decision?.resolved ? decision.player || null : null;
}

export function buildQuarterbackLayer(awayPersonnel, homePersonnel, awayQbr, homeQbr, week) {
  const qbrWeight = Number(week) >= 5 ? 0.65 : Number(week) >= 4 ? 0.55 : 0.4;
  const blend = (personnel, qbr) => {
    const performance = qbrPointAdjustment(qbr, week);
    const personnelPoints = nullableFinite(personnel?.points);
    const personnelAvailable = personnelPoints !== null && personnel?.available !== false;
    const performanceWeight = performance.available ? qbrWeight : 0;
    const personnelWeight = personnelAvailable ? 1 - qbrWeight : 0;
    const totalWeight = performanceWeight + personnelWeight;
    return {
      available: totalWeight > 0,
      points: totalWeight
        ? clamp((performance.points * performanceWeight + (personnelPoints ?? 0) * personnelWeight) / totalWeight, -3.5, 3.5)
        : 0,
      confidence: totalWeight
        ? (performance.confidence * performanceWeight + clamp(finite(personnel?.confidence), 0, 1) * personnelWeight) / totalWeight
        : 0,
      qbrWeight: totalWeight ? performanceWeight / totalWeight : 0,
      reasons: performance.reasons,
    };
  };
  const away = blend(awayPersonnel, awayQbr);
  const home = blend(homePersonnel, homeQbr);
  return {
    active: Math.abs(away.points) >= 0.05 || Math.abs(home.points) >= 0.05,
    available: away.available || home.available,
    awayPoints: round3(away.points),
    homePoints: round3(home.points),
    confidence: Math.min(away.confidence, home.confidence),
    reasons: [
      ...toArray(awayPersonnel?.reasons),
      ...toArray(homePersonnel?.reasons),
      ...away.reasons,
      ...home.reasons,
    ],
    qbr: {
      away: awayQbr,
      home: homeQbr,
      weight: qbrWeight,
      effectiveWeights: { away: away.qbrWeight, home: home.qbrWeight },
    },
  };
}

function qbrPointAdjustment(qbr, week) {
  const seasonQbr = nullableFinite(qbr?.seasonQbr);
  const weeklyQbr = nullableFinite(qbr?.weeklyQbr);
  if (qbr?.available === false || (seasonQbr === null && weeklyQbr === null)) {
    return { available: false, points: 0, confidence: 0, reasons: [] };
  }
  const plays = Number(qbr.plays) || 0;
  const sampleReliability = clamp(plays / 120, 0.35, 1);
  const seasonSignal = seasonQbr !== null ? (seasonQbr - 50) / 18 : 0;
  const weeklySignal = weeklyQbr !== null ? (weeklyQbr - 50) / 28 : 0;
  const recentWeight = Number(week) >= 5 ? 0.45 : Number(week) >= 4 ? 0.35 : 0.2;
  const seasonWeight = seasonQbr !== null ? 1 - recentWeight : 0;
  const weeklyWeight = weeklyQbr !== null ? recentWeight : 0;
  const points = clamp(
    (seasonSignal * seasonWeight + weeklySignal * weeklyWeight) / (seasonWeight + weeklyWeight) * sampleReliability,
    -2.5,
    2.5
  );
  return {
    available: true,
    points,
    confidence: sampleReliability,
    reasons: [
      `ESPN QBR: ${qbr.playerName} season ${Number.isFinite(seasonQbr) ? seasonQbr.toFixed(1) : "N/A"}, Week ${qbr.week} ${Number.isFinite(weeklyQbr) ? weeklyQbr.toFixed(1) : "N/A"}; ${points >= 0 ? "+" : ""}${points.toFixed(2)} model points`,
    ],
  };
}

function buildPersonnelLayer(away, home) {
  const awayAvailable = away?.available !== false && nullableFinite(away?.points) !== null;
  const homeAvailable = home?.available !== false && nullableFinite(home?.points) !== null;
  const awayPoints = awayAvailable ? finite(away.points) : 0;
  const homePoints = homeAvailable ? finite(home.points) : 0;
  return {
    available: awayAvailable || homeAvailable,
    active: Boolean(awayPoints || homePoints),
    awayPoints,
    homePoints,
    confidence: Math.min(awayAvailable ? finite(away.confidence) : 0, homeAvailable ? finite(home.confidence) : 0),
    reasons: [...toArray(away?.reasons), ...toArray(home?.reasons)],
  };
}

// Fourth Down's own player ratings (data/player-ratings-2026.js), rebuilt every week from
// NFLverse play-by-play and snap counts. Starters come from recent snap share; anyone the
// live roster lists as out is replaced by the next player in the unit.
const UNAVAILABLE_STATUS = /^(out|doubtful|ir|injured reserve|pup|physically unable|suspended|nfi|non-football|inactive)/i;

function unavailablePlayers(roster) {
  const ids = new Set(), names = new Set();
  for (const player of Object.values(roster?.groups || {}).flat()) {
    if (!player || !(UNAVAILABLE_STATUS.test(String(player.injuryStatus || "").trim()) ||
      UNAVAILABLE_STATUS.test(String(player.status || "").trim()))) continue;
    if (player.gsisId) ids.add(String(player.gsisId));
    const key = nameKey(player.fullName || [player.firstName, player.lastName].filter(Boolean).join(" "));
    if (key) names.add(key);
  }
  return (rated) => (rated.gsisId && ids.has(String(rated.gsisId))) || names.has(nameKey(rated.name));
}

function unitStrength(units) {
  return {
    passingOffense: units.qb * 0.35 + units.wr * 0.25 + units.te * 0.1 + units.ol * 0.3,
    rushingOffense: units.rb * 0.35 + units.ol * 0.65,
    passDefense: units.front * 0.4 + units.lb * 0.15 + units.db * 0.45,
    runDefense: units.front * 0.6 + units.lb * 0.4,
  };
}

export function buildPlayerRatingsLayer({ away, home, season, week, awayRoster, homeRoster, ratings = PLAYER_RATINGS }) {
  if (ratings?.season !== Number(season) || ratings?.predictionWeek !== Number(week) ||
      !ratings.teams?.[away] || !ratings.teams?.[home]) {
    return { ...neutralLayer(), reasons: [`Fourth Down player ratings for Week ${week} are not available`] };
  }
  const awayRated = teamUnitRatings(ratings.teams[away], { unavailable: unavailablePlayers(awayRoster) });
  const homeRated = teamUnitRatings(ratings.teams[home], { unavailable: unavailablePlayers(homeRoster) });
  if (awayRated.coverage < 0.45 || homeRated.coverage < 0.45) return neutralLayer();
  const awayUnits = unitStrength(awayRated.units), homeUnits = unitStrength(homeRated.units);

  const awayPass = awayUnits.passingOffense - homeUnits.passDefense;
  const homePass = homeUnits.passingOffense - awayUnits.passDefense;
  const awayRush = awayUnits.rushingOffense - homeUnits.runDefense;
  const homeRush = homeUnits.rushingOffense - awayUnits.runDefense;
  const awayRaw = clamp(awayPass * 0.04 + awayRush * 0.025, -2.5, 2.5);
  const homeRaw = clamp(homePass * 0.04 + homeRush * 0.025, -2.5, 2.5);
  const edge = clamp((homeRaw - awayRaw) / 2, -1.25, 1.25);
  const confidence = Math.min(awayRated.coverage, homeRated.coverage);

  return {
    active: Math.abs(edge) >= 0.01,
    available: true,
    awayPoints: -edge,
    homePoints: edge,
    confidence,
    awayPassingMultiplier: clamp(1 + awayPass * 0.004, 0.88, 1.12),
    homePassingMultiplier: clamp(1 + homePass * 0.004, 0.88, 1.12),
    awayRushingMultiplier: clamp(1 + awayRush * 0.004, 0.88, 1.12),
    homeRushingMultiplier: clamp(1 + homeRush * 0.004, 0.88, 1.12),
    awayFieldGoalOpportunityMultiplier: 1,
    homeFieldGoalOpportunityMultiplier: 1,
    units: { away: awayRated.units, home: homeRated.units },
    source: { predictionWeek: ratings.predictionWeek, latestCompletedWeek: ratings.latestCompletedWeek, generatedAt: ratings.generatedAt },
    reasons: [`Fourth Down player ratings through Week ${ratings.latestCompletedWeek}, ${Math.round(confidence * 100)}% of unit places rated`],
  };
}

function neutralLayer() {
  return {
    active: false,
    available: false,
    awayPoints: 0,
    homePoints: 0,
    confidence: 0,
    reasons: [],
  };
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableFinite(value) {
  if (!["number", "string"].includes(typeof value) || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeCode(code) {
  const value = String(code || "").trim().toUpperCase();
  return ({ WAS: "WSH", LA: "LAR", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LAR" })[value] || value;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
