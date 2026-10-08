import { predictMatchup } from "./predictionEngine.js";
import { buildPlayerProjections } from "./playerProjectionService.js";
import * as nflApi from "./nflApi.js";
import { getTeamQbr } from "./teamRatings.js";
import { getStadiumWeather } from "./weatherApi.js";
import { buildBestBets } from "./bestBetsService.js";

export const FULL_MODEL_VERSION = 11;
export const FULL_MODEL_KEY = "full-v11-week5-data-gap-audit";
const cache = new Map();
const pending = new Map();
const CACHE_MS = 5 * 60 * 1000;

export async function getFullGamePrediction(game, oddsEvent, options = {}) {
  const season = Number(options.season || 2026);
  const week = Number(game.week || options.week || 1);
  const away = normalizeCode(game.away);
  const home = normalizeCode(game.home);
  const oddsFingerprint = createOddsFingerprint(oddsEvent);
  const key = `${season}:${week}:${away}:${home}:${FULL_MODEL_KEY}:${oddsFingerprint}`;
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

async function createPrediction({ game, oddsEvent, season, week, away, home, signal }) {
  const weather = await resolveGameWeather(game, home, signal);
  const gameWithWeather = {
    ...game,
    weather,
  };
  const tasks = {
    standings: optionalCall("getStandings", [signal]),
    personnel: optionalCall("getQbRosterHealth", [away, home, season, signal]),
    kicker: optionalCall("getKickerStats", [away, home, season - 1, signal]),
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
    dataQuality[name] = result.status === "fulfilled" && result.value !== null;
    values[name] = result.status === "fulfilled" ? result.value : null;
  });

  const standingsByCode = Object.fromEntries(
    toArray(values.standings)
      .map((row) => [normalizeCode(row?.abbreviation), row])
      .filter(([code]) => code)
  );

  const homeStanding = standingsByCode[home];
  const awayStanding = standingsByCode[away];
  const personnel = values.personnel;

  const modelLayers = {
    ...extractLayers(values.teamForm),
    ...extractLayers(values.playByPlay),
    playerRatings: buildPlayerRatingsLayer(values.awayRoster, values.homeRoster),
    opponentNetwork:
      values.opponentNetwork?.modelLayer ||
      values.opponentNetwork?.modelLayers?.opponentNetwork ||
      neutralLayer(),
    quarterback: buildQuarterbackLayer(
      personnel?.away?.quarterback,
      personnel?.home?.quarterback,
      getTeamQbr(away),
      getTeamQbr(home),
      week
    ),
    rosterHealth: buildPersonnelLayer(
      personnel?.away?.rosterHealth,
      personnel?.home?.rosterHealth
    ),
    specialTeams: buildKickerLayer(values.kicker),
  };

  const prediction = predictMatchup(away, home, {
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
    rivalry: gameWithWeather.scheduleContext
      ? {
          meetingNumber: gameWithWeather.scheduleContext.meetingNumber,
          previousMargin: gameWithWeather.scheduleContext.previousMeetingMargin,
        }
      : undefined,
  });

  const playerProjections = buildPlayerProjections({
    away,
    home,
    prediction,
    playerMetrics: values.playerMetrics,
    teamMetrics: values.playByPlay,
  });
  dataQuality.playerProjections = playerProjections.available === true;
  const bestBets = buildBestBets({
    game: gameWithWeather,
    prediction,
    playerProjections,
    oddsEvent,
    dataQuality,
  });
  dataQuality.bestBets = bestBets.available === true;
  return {
    prediction,
    playerProjections,
    bestBets,
    dataQuality: {
      ...dataQuality,
      weather,
      sources: buildSourceDiagnostics(values, weather, oddsEvent),
    },
    weather,
    modelVersion: FULL_MODEL_VERSION,
    modelKey: FULL_MODEL_KEY,
    generatedAt: new Date().toISOString(),
  };
}

function buildSourceDiagnostics(values, weather, oddsEvent) {
  return {
    playByPlay: sourceDiagnostic(values.playByPlay, "nflverse play-by-play"),
    teamForm: sourceDiagnostic(values.teamForm, "team form"),
    opponentNetwork: sourceDiagnostic(values.opponentNetwork, "opponent network"),
    personnel: sourceDiagnostic(values.personnel, "QB and roster health"),
    kicker: sourceDiagnostic(values.kicker, "kicker data"),
    playerMetrics: sourceDiagnostic(values.playerMetrics, "nflverse player metrics"),
    weather: { label: "weather", available: Boolean(weather), updatedAt: weather?.generatedAt || null },
    odds: { label: "odds", available: Boolean(oddsEvent), updatedAt: oddsEvent?.last_update || oddsEvent?.updatedAt || null },
  };
}
function sourceDiagnostic(value, label) {
  return {
    label,
    available: Boolean(value) && value?.dataStatus !== "neutral" && value?.available !== false,
    updatedAt: value?.generatedAt || value?.refreshedAt || null,
    source: value?.source || null,
    warning: value?.warning || value?.reason || null,
  };
}
async function resolveGameWeather(game, homeCode, signal) {
  if (game?.weather) return game.weather;
  const kickoff = game?.sourceDate || game?.date || game?.time || null;
  if (!homeCode || !kickoff) return null;
  try {
    return await getStadiumWeather(homeCode, kickoff, signal);
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

function buildQuarterbackLayer(awayPersonnel, homePersonnel, awayQbr, homeQbr, week) {
  const away = qbrPointAdjustment(awayQbr, week);
  const home = qbrPointAdjustment(homeQbr, week);
  const awayPersonnelPoints = finite(awayPersonnel?.points);
  const homePersonnelPoints = finite(homePersonnel?.points);
  const qbrWeight = Number(week) >= 5 ? 0.65 : Number(week) >= 4 ? 0.55 : 0.4;
  const personnelWeight = 1 - qbrWeight;
  const awayPoints = clamp(away.points * qbrWeight + awayPersonnelPoints * personnelWeight, -3.5, 3.5);
  const homePoints = clamp(home.points * qbrWeight + homePersonnelPoints * personnelWeight, -3.5, 3.5);
  return {
    active: Math.abs(awayPoints) >= 0.05 || Math.abs(homePoints) >= 0.05,
    awayPoints: round3(awayPoints),
    homePoints: round3(homePoints),
    confidence: Math.min(away.confidence, home.confidence),
    reasons: [
      ...toArray(awayPersonnel?.reasons),
      ...toArray(homePersonnel?.reasons),
      ...away.reasons,
      ...home.reasons,
    ],
    qbr: { away: awayQbr, home: homeQbr, weight: qbrWeight },
  };
}

function qbrPointAdjustment(qbr, week) {
  if (!qbr) return { points: 0, confidence: 0, reasons: [] };
  const seasonQbr = Number(qbr.seasonQbr);
  const weeklyQbr = Number(qbr.weeklyQbr);
  const plays = Number(qbr.plays) || 0;
  const sampleReliability = clamp(plays / 120, 0.35, 1);
  const seasonSignal = Number.isFinite(seasonQbr) ? (seasonQbr - 50) / 18 : 0;
  const weeklySignal = Number.isFinite(weeklyQbr) ? (weeklyQbr - 50) / 28 : 0;
  const recentWeight = Number(week) >= 5 ? 0.45 : Number(week) >= 4 ? 0.35 : 0.2;
  const points = clamp(
    (seasonSignal * (1 - recentWeight) + weeklySignal * recentWeight) * sampleReliability,
    -2.5,
    2.5
  );
  return {
    points,
    confidence: sampleReliability,
    reasons: [
      `ESPN QBR: ${qbr.playerName} season ${Number.isFinite(seasonQbr) ? seasonQbr.toFixed(1) : "N/A"}, Week ${qbr.week} ${Number.isFinite(weeklyQbr) ? weeklyQbr.toFixed(1) : "N/A"}; ${points >= 0 ? "+" : ""}${points.toFixed(2)} model points`,
    ],
  };
}

function buildPersonnelLayer(away, home) {
  return {
    active: Boolean(away?.points || home?.points),
    awayPoints: finite(away?.points),
    homePoints: finite(home?.points),
    confidence: Math.min(finite(away?.confidence), finite(home?.confidence)),
    reasons: [...toArray(away?.reasons), ...toArray(home?.reasons)],
  };
}

function buildPlayerRatingsLayer(awayRoster, homeRoster) {
  const away = buildUnits(awayRoster);
  const home = buildUnits(homeRoster);

  if (away.coverage < 0.45 || home.coverage < 0.45) return neutralLayer();

  const awayPass = away.passingOffense - home.passDefense;
  const homePass = home.passingOffense - away.passDefense;
  const awayRush = away.rushingOffense - home.runDefense;
  const homeRush = home.rushingOffense - away.runDefense;
  const awayRaw = clamp(awayPass * 0.04 + awayRush * 0.025, -2.5, 2.5);
  const homeRaw = clamp(homePass * 0.04 + homeRush * 0.025, -2.5, 2.5);
  const edge = clamp((homeRaw - awayRaw) / 2, -1.25, 1.25);
  const confidence = Math.min(away.coverage, home.coverage);

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
    reasons: [`Player-rating coverage ${Math.round(confidence * 100)}%`],
  };
}

function buildUnits(roster) {
  const players = Object.values(roster?.groups || {}).flat();
  const rated = players.filter(
    (player) => player?.active !== false && Number.isFinite(Number(player?.playerRating))
  );
  const starters = rated.filter((player) => Number(player.depthChartOrder) === 1);
  const pool = starters.length >= 12 ? starters : rated;

  const unit = (positions, limit, fallback = 72) => {
    const matches = pool
      .filter((player) => positions.includes(String(player.position || "").toUpperCase()))
      .sort((a, b) => (a.depthChartOrder ?? 99) - (b.depthChartOrder ?? 99))
      .slice(0, limit);
    if (!matches.length) return fallback;
    return matches.reduce((sum, player) => sum + Number(player.playerRating), 0) / matches.length;
  };

  const qb = unit(["QB"], 1);
  const rb = unit(["RB", "HB", "FB"], 2);
  const wr = unit(["WR"], 3);
  const te = unit(["TE"], 2);
  const ol = unit(["LT", "LG", "C", "RG", "RT", "G", "OG", "T", "OT", "OL"], 5);
  const front = unit(["DE", "DT", "DL", "NT", "EDGE", "LEDG", "REDG", "OLB"], 5);
  const lb = unit(["LB", "ILB", "MLB", "OLB"], 3);
  const db = unit(["CB", "DB", "S", "FS", "SS"], 5);

  return {
    passingOffense: qb * 0.35 + wr * 0.25 + te * 0.1 + ol * 0.3,
    rushingOffense: rb * 0.35 + ol * 0.65,
    passDefense: front * 0.4 + lb * 0.15 + db * 0.45,
    runDefense: front * 0.6 + lb * 0.4,
    coverage: players.length ? rated.length / players.length : 0,
  };
}

function buildKickerLayer(data) {
  if (!data?.leaguePriors) return neutralLayer();
  const awayPoints = kickerPoints(data.away, data.leaguePriors);
  const homePoints = kickerPoints(data.home, data.leaguePriors);
  return {
    active: Boolean(awayPoints || homePoints),
    awayPoints,
    homePoints,
    confidence: 0.7,
    reasons: ["Kicker accuracy and distance profile"],
  };
}

const DISTANCE_MIX = {
  under30: 0.18,
  from30to39: 0.29,
  from40to49: 0.31,
  from50plus: 0.22,
};

function kickerPoints(kicker, priors) {
  if (!kicker) return 0;
  let kickerAccuracy = 0;
  let leagueAccuracy = 0;

  for (const [bucket, share] of Object.entries(DISTANCE_MIX)) {
    const prior = priors[bucket];
    if (!prior) continue;
    const actual = kicker[bucket] || { made: 0, attempts: 0 };
    const priorAccuracy = finite(prior.accuracy);
    const priorAttempts = finite(prior.priorAttempts);
    const regressed =
      (finite(actual.made) + priorAccuracy * priorAttempts) /
      Math.max(1, finite(actual.attempts) + priorAttempts);
    kickerAccuracy += share * regressed;
    leagueAccuracy += share * priorAccuracy;
  }

  return round3(clamp((kickerAccuracy - leagueAccuracy) * 6.3, -1.25, 1.25));
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
