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
import { AVAILABILITY_ABSENCE_PROBABILITY, buildPersonnelView, normalizeAvailability, PERSONNEL_VIEW_VERSION } from "../../api-lib/personnelView.js";
import { buildSpecialTeamsModel } from "./specialTeams.js";
import PLAYER_RATINGS from "../../data/player-ratings-2026.js";
import { ABSENCE_COSTS, STARTER_SHARE, absenceCost, nameKey, teamUnitRatings } from "./fourthDownRatings.js";
import { reportedDeparture } from "./rosterChanges.js";
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
    playerRatings: buildPlayerRatingsLayer({ away, home, season, week }),
    opponentNetwork:
      values.opponentNetwork?.modelLayer ||
      values.opponentNetwork?.modelLayers?.opponentNetwork ||
      neutralLayer(),
    quarterback: buildQuarterbackLayer(
      personnel?.away?.quarterback,
      personnel?.home?.quarterback,
      qbrAvailable ? getQuarterbackQbr(selectedStartingQuarterback(personnelViews.away)) : null,
      qbrAvailable ? getQuarterbackQbr(selectedStartingQuarterback(personnelViews.home)) : null,
      week,
      {
        away: quarterbackChange({ team: away, season, week, starter: selectedStartingQuarterback(personnelViews.away) }),
        home: quarterbackChange({ team: home, season, week, starter: selectedStartingQuarterback(personnelViews.home) }),
      }
    ),
    // Missing players priced by their rating gap to the next man up (replaces the fixed
    // position weights of the personnel route's roster-health estimate).
    rosterHealth: buildInjuryLayer({ away, home, season, week, awayRoster, homeRoster, personnelViews }),
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

// A team's stats this season were built with its usual starter. When someone else starts,
// the measured cost of losing that starter applies (ABSENCE_COSTS: 3.2 points for an
// average starter, 3.8 more per standard deviation of quality; from 2,318 past games, which
// were mostly backups stepping in). If the replacement has a real season of his own, he is
// compared on quality with the team's season mix of quarterbacks (weighted by dropbacks),
// because the team's season stats already include his own games.
const QB_CHANGE_MAX_POINTS = 10;

function seasonQuarterbackQuality(list) {
  const measured = list.filter((player) => Number.isFinite(player.quality) && player.dropbacks > 0);
  const dropbacks = measured.reduce((sum, player) => sum + player.dropbacks, 0);
  return dropbacks ? measured.reduce((sum, player) => sum + player.quality * player.dropbacks, 0) / dropbacks : null;
}

export function quarterbackChange({ team, season, week, starter: selected, ratings = PLAYER_RATINGS }) {
  if (ratings?.season !== Number(season) || ratings?.predictionWeek !== Number(week)) return null;
  const list = ratings.teams?.[team]?.qb || [];
  const usual = list[0];
  if (!usual) return null;
  // A starter who has left the team cannot start: the next quarterback still on it does.
  const next = list.find((rated) => rated !== usual && !leftTeam(team, rated));
  const starter = selected && !leftTeam(team, { ...selected, gsisId: selected.canonicalId })
    ? selected
    : leftTeam(team, usual) && next ? { name: next.name, canonicalId: next.gsisId } : null;
  if (!starter) return null;
  const same = (rated) => (starter.canonicalId && rated.gsisId && String(starter.canonicalId) === String(rated.gsisId)) ||
    (nameKey(starter.name) && nameKey(starter.name) === nameKey(rated.name));
  if (same(usual)) return null;
  const replacement = list.find(same);
  const established = Number.isFinite(replacement?.quality) && replacement.share >= STARTER_SHARE.qb / 2;
  const baseline = seasonQuarterbackQuality(list) ?? usual.quality ?? 0;
  const cost = established
    ? ABSENCE_COSTS.qb.quality * (baseline - replacement.quality)
    : absenceCost("qb", usual.quality);
  const points = clamp(-cost, -QB_CHANGE_MAX_POINTS, QB_CHANGE_MAX_POINTS);
  return {
    points,
    usual: { name: usual.name, rating: usual.rating, quality: usual.quality ?? null },
    starter: { name: starter.name, rating: replacement?.rating ?? null, quality: replacement?.quality ?? null, established },
    reason: `Quarterback change: ${starter.name} starts instead of ${usual.name}` +
      (established
        ? ` (${starter.name} ${replacement.quality.toFixed(2)} SD against the team's season quarterback play ${baseline.toFixed(2)} SD)`
        : ` (backup for a ${(usual.quality ?? 0).toFixed(2)} SD starter)`) +
      `; ${points >= 0 ? "+" : ""}${points.toFixed(2)} model points`,
  };
}

export function buildQuarterbackLayer(awayPersonnel, homePersonnel, awayQbr, homeQbr, week, changes = {}) {
  const qbrWeight = Number(week) >= 5 ? 0.65 : Number(week) >= 4 ? 0.55 : 0.4;
  const blend = (personnel, qbr, change) => {
    // Season QBR describes the usual starter, so it gives way to the rating gap.
    if (change) {
      return { available: true, points: change.points, confidence: 0.8, qbrWeight: 0, reasons: [change.reason] };
    }
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
  const away = blend(awayPersonnel, awayQbr, changes.away);
  const home = blend(homePersonnel, homeQbr, changes.home);
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
    quarterbackChange: { away: changes.away || null, home: changes.home || null },
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

// Fourth Down's own player ratings (data/player-ratings-2026.js), rebuilt every week from
// NFLverse play-by-play and snap counts. The ratings layer measures each team at full
// strength (starters by recent snap share); missing players are priced by the injury layer
// and a changed quarterback by the quarterback layer, so nothing is counted twice.

// Chance each player misses the game, from the live roster and the point-in-time personnel
// view (the live roster is dropped once it is newer than the weekly cutoff). The higher of
// the two counts.
function absenceLookup(roster, personnelView, team) {
  const byId = new Map(), byName = new Map();
  const note = (id, name, status, absence) => {
    if (!(absence > 0)) return;
    const entry = { status, absence };
    for (const [map, key] of [[byId, id && String(id)], [byName, nameKey(name)]]) {
      if (key && !(map.get(key)?.absence >= absence)) map.set(key, entry);
    }
  };
  for (const player of Object.values(roster?.groups || {}).flat()) {
    if (!player) continue;
    const availability = normalizeAvailability({ injuryStatus: player.injuryStatus, rosterStatus: player.status });
    note(player.gsisId, player.fullName || [player.firstName, player.lastName].filter(Boolean).join(" "),
      availability.status, availability.absenceProbability);
  }
  for (const player of personnelView?.players || []) {
    if (!player || player.statusKnown === false) continue;
    const absence = AVAILABILITY_ABSENCE_PROBABILITY[player.status];
    note(player.canonicalId || player.gsisId, player.name, player.status, absence);
  }
  // A player who has left the team (released, cut, traded, retired) is out for good: the
  // team's stats were built with him, so his loss is priced like any absence.
  const gone = (rated) => leftTeam(team, rated);
  return (rated) => (gone(rated) ? { status: "Left team", absence: 1 } : null) ||
    (rated.gsisId && byId.get(String(rated.gsisId))) || byName.get(nameKey(rated.name)) || null;
}

// Left the team: flagged by the weekly ratings build from the official roster, or a move
// reported before the feeds show it (data/roster-changes.js).
function leftTeam(team, rated) {
  return Boolean(rated?.departed || reportedDeparture(team, rated));
}

// Most a team's non-quarterback absences can cost together. Past games rarely had more than
// a few starters out at once, so the measured costs are not proven beyond that.
const INJURY_MAX_POINTS = 8;
const OUT_THRESHOLD = 0.75; // Doubtful and worse count in full

// Expected points a team loses to missing non-quarterback regular starters: each costs the
// measured ABSENCE_COSTS for his unit and quality, times the chance he misses the game.
export function teamInjuryCost(teamRatings, absenceOf) {
  let points = 0;
  const players = [];
  for (const unit of Object.keys(ABSENCE_COSTS)) {
    if (unit === "qb") continue;
    for (const player of (teamRatings?.[unit] || []).filter((p) => p.share >= STARTER_SHARE[unit])) {
      const absence = absenceOf(player);
      if (!absence) continue;
      const cost = absenceCost(unit, player.quality) * (absence.absence >= OUT_THRESHOLD ? 1 : absence.absence);
      if (cost <= 0) continue;
      points += cost;
      players.push({ name: player.name, unit, status: absence.status, quality: player.quality ?? null, points: Math.round(cost * 100) / 100 });
    }
  }
  return { points: Math.min(points, INJURY_MAX_POINTS), players: players.sort((a, b) => b.points - a.points) };
}

export function buildInjuryLayer({ away, home, season, week, awayRoster, homeRoster, personnelViews, ratings = PLAYER_RATINGS }) {
  if (ratings?.season !== Number(season) || ratings?.predictionWeek !== Number(week) ||
      !ratings.teams?.[away] || !ratings.teams?.[home]) {
    return { ...neutralLayer(), reasons: [`Injury pricing needs Fourth Down player ratings for Week ${week}`] };
  }
  const awayCost = teamInjuryCost(ratings.teams[away], absenceLookup(awayRoster, personnelViews?.away, away));
  const homeCost = teamInjuryCost(ratings.teams[home], absenceLookup(homeRoster, personnelViews?.home, home));
  const describe = (code, cost) => cost.players.length
    ? `${code} missing ${cost.players.map((p) => `${p.name} (${p.unit}, ${p.status}, -${p.points})`).join(", ")}`
    : `${code}: no priced injuries`;
  return {
    active: awayCost.points > 0.01 || homeCost.points > 0.01,
    available: true,
    awayPoints: round3(-awayCost.points) || 0,
    homePoints: round3(-homeCost.points) || 0,
    confidence: 0.8,
    injuries: { away: awayCost.players, home: homeCost.players },
    reasons: [describe(away, awayCost), describe(home, homeCost)],
  };
}

function unitStrength(units) {
  return {
    passingOffense: units.qb * 0.35 + units.wr * 0.25 + units.te * 0.1 + units.ol * 0.3,
    rushingOffense: units.rb * 0.35 + units.ol * 0.65,
    passDefense: units.front * 0.4 + units.lb * 0.15 + units.db * 0.45,
    runDefense: units.front * 0.6 + units.lb * 0.4,
  };
}

export function buildPlayerRatingsLayer({ away, home, season, week, ratings = PLAYER_RATINGS }) {
  if (ratings?.season !== Number(season) || ratings?.predictionWeek !== Number(week) ||
      !ratings.teams?.[away] || !ratings.teams?.[home]) {
    return { ...neutralLayer(), reasons: [`Fourth Down player ratings for Week ${week} are not available`] };
  }
  const awayRated = teamUnitRatings(ratings.teams[away]);
  const homeRated = teamUnitRatings(ratings.teams[home]);
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
