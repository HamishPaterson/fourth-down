// Script-side data loading for the 2026 external-factors audit and backtest.
// Node-only: reads env, fetches the production prediction ledger and BALLDONTLIE
// schedule, enriches games with schedule/venue/weather context. Production code
// never imports this; it consumes the generated data module instead.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fetchSchedule } from "./balldontlie-schedule.mjs";
import {
  computeScheduleContexts, resolveGameVenue, normTeam, num,
} from "../src/services/externalFactors2026.js";
import { isCurrentModelIdentity } from "../src/services/modelIdentity.js";

const SEASON = 2026;
const SEASON_START = "2026-09-01";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const GAME_HOURS = 5; // kickoff hour through kickoff + 4 (mirrors weatherApi.js)

export async function loadEnv() {
  try {
    const text = await readFile(path.resolve(".env.local"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.*)\s*$/);
      if (match && process.env[match[1]] === undefined) {
        process.env[match[1]] = match[2].trim().replace(/^"|"$/g, "");
      }
    }
  } catch { /* .env.local optional */ }
}

export async function fetchPredictionSnapshots() {
  const rows = [];
  // The supported week filter keeps the large season ledger below its read timeout.
  for (let week = 1; week <= 18; week++) {
    const response = await fetch(
      `https://fourth-down-coral.vercel.app/api/nfl/game-stats?action=predictions&season=${SEASON}&week=${week}`,
      { headers: { Accept: "application/json" } },
    );
    if (!response.ok) throw new Error(`Prediction ledger week ${week} fetch failed (${response.status})`);
    const body = await response.json();
    if (!Array.isArray(body.snapshots) || body.count !== body.snapshots.length ||
        body.snapshots.some((s) => Number(s.season) !== SEASON || Number(s.week) !== week)) {
      throw new Error(`Invalid prediction ledger response for week ${week}`);
    }
    rows.push(...body.snapshots.map(predictionSnapshotRow));
  }
  return rows;
}

export function predictionSnapshotRow(snapshot) {
  // API snapshots omit created_at. Only explicit persisted pre-game evidence plus
  // a pre-kickoff snapshot timestamp can substitute; generatedAt alone cannot.
  const savedBeforeKickoff = snapshot.savedBeforeKickoff === true;
  return {
    season: snapshot.season, week: snapshot.week, kickoff: snapshot.kickoff,
    away_code: snapshot.awayCode, home_code: snapshot.homeCode,
    predicted_away_score: snapshot.fourthDownAwayScore,
    predicted_home_score: snapshot.fourthDownHomeScore,
    away_win_probability: snapshot.fourthDownAwayWinProbability,
    home_win_probability: snapshot.fourthDownHomeWinProbability,
    fourth_down_pick: snapshot.fourthDownPick,
    model_version: snapshot.modelVersion,
    created_at: savedBeforeKickoff ? snapshot.snapshotAt : null,
    updated_at: snapshot.updatedAt,
    market_pick: snapshot.oddsPick,
    market_spread: snapshot.marketSpread,
    market_away_score: snapshot.marketAwayScore,
    market_home_score: snapshot.marketHomeScore,
    market_total: snapshot.marketGameTotal,
    data_quality: {
      quality: { ...snapshot.dataQuality, modelKey: snapshot.modelKey ?? snapshot.dataQuality?.modelKey ?? null },
      snapshot: {
        game: snapshot.game, modelKey: snapshot.modelKey,
        generatedAt: snapshot.generatedAt, snapshotAt: snapshot.snapshotAt,
        savedBeforeKickoff, predictionPayload: snapshot.predictionPayload,
      },
    },
  };
}

async function fetchArchiveWeather(stadium, endDate) {
  const params = new URLSearchParams({
    latitude: String(stadium.lat),
    longitude: String(stadium.lon),
    start_date: SEASON_START,
    end_date: endDate,
    hourly: ["temperature_2m", "precipitation", "rain", "snowfall", "weather_code",
      "wind_speed_10m", "wind_gusts_10m"].join(","),
    wind_speed_unit: "kmh",
    precipitation_unit: "mm",
    timeformat: "unixtime",
    timezone: "GMT",
  });
  const response = await fetch(`${ARCHIVE_URL}?${params.toString()}`);
  if (!response.ok) return null;
  const hourly = (await response.json())?.hourly;
  return Array.isArray(hourly?.time) && hourly.time.length ? hourly : null;
}

// Aggregate one game's weather window exactly like weatherApi.js does.
function gameWindowWeather(hourly, kickoff) {
  const times = hourly.time.map(Number);
  const kickoffSeconds = Math.floor(new Date(kickoff).getTime() / 1000);
  let start = 0;
  let best = Infinity;
  for (let i = 0; i < times.length; i++) {
    const diff = Math.abs(times[i] - kickoffSeconds);
    if (diff < best) { best = diff; start = i; }
  }
  if (Math.abs(times[start] - kickoffSeconds) > 90 * 60) return null;
  const indexes = Array.from({ length: GAME_HOURS }, (_, o) => start + o)
    .filter((i) => i < times.length);
  const values = (key) => indexes
    .map((i) => (Number.isFinite(Number(hourly[key]?.[i])) ? Number(hourly[key][i]) : null))
    .filter((v) => v != null);
  const avg = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  const sum = (v) => (v.length ? v.reduce((a, b) => a + b, 0) : null);
  const temperature = avg(values("temperature_2m"));
  const windSpeed = avg(values("wind_speed_10m"));
  if (temperature == null || windSpeed == null) return null; // archive gap
  return {
    temperature,
    windSpeed,
    windGust: Math.max(...values("wind_gusts_10m"), windSpeed),
    rain: sum(values("rain")) ?? 0,
    precipitation: sum(values("precipitation")) ?? 0,
    snowfall: sum(values("snowfall")) ?? 0,
  };
}

export const hasPredictionScores = (row) =>
  num(row?.predicted_home_score) != null && num(row?.predicted_away_score) != null;

// A prediction only counts if it existed before kickoff: stored pre-game flag,
// row created before kickoff, and snapshot taken before kickoff.
export const isPreGameRow = (row) => hasPredictionScores(row) &&
  row.savedBeforeKickoff !== false &&
  new Date(row.created_at) <= new Date(row.kickoff) &&
  (!row.snapshotAt || new Date(row.snapshotAt) <= new Date(row.kickoff));

export function groupSnapshotRows(snapshotsRaw) {
  const rowsByKey = new Map();
  for (const row of snapshotsRaw) {
    const key = `${row.season}:${row.week}:${normTeam(row.away_code)}:${normTeam(row.home_code)}`;
    const normalised = {
      ...row,
      away_code: normTeam(row.away_code),
      home_code: normTeam(row.home_code),
      modelKey: row.data_quality?.quality?.modelKey ?? row.data_quality?.snapshot?.modelKey ?? null,
      snapshotAt: row.data_quality?.snapshot?.snapshotAt ?? null,
      savedBeforeKickoff: row.data_quality?.snapshot?.savedBeforeKickoff ?? null,
    };
    if (!rowsByKey.has(key)) rowsByKey.set(key, []);
    rowsByKey.get(key).push(normalised);
  }
  // Pick one row per game: latest-updated valid pre-game prediction, else latest row.
  const snapshots = new Map();
  for (const [key, rows] of rowsByKey) {
    const preGame = rows.filter(isPreGameRow)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const fallback = [...rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    snapshots.set(key, preGame[0] || fallback[0] || null);
  }
  return { rowsByKey, snapshots };
}

// Full input load: ledger + schedule + enrichment (schedule context, venue,
// travel, timezone, archive weather for outdoor completed games).
export async function loadExternalFactorInputs({ weather = true } = {}) {
  const [snapshotsRaw, schedule] = await Promise.all([
    fetchPredictionSnapshots(),
    fetchSchedule(SEASON),
  ]);
  const { rowsByKey, snapshots } = groupSnapshotRows(snapshotsRaw);

  const games = [];
  for (const g of schedule) {
    const away = normTeam(g.visitor_team?.abbreviation);
    const home = normTeam(g.home_team?.abbreviation);
    const awayScore = num(g.visitor_team_score);
    const homeScore = num(g.home_team_score);
    const status = String(g.status || "").toLowerCase();
    const completed = status.includes("final") && awayScore != null && homeScore != null;
    const week = Number(g.week);
    if (!away || !home || !Number.isInteger(week)) continue;
    const key = `${SEASON}:${week}:${away}:${home}`;
    const snap = snapshots.get(key) || null;
    games.push({
      key, week, away, home,
      kickoff: snap?.kickoff || g.date || g.datetime || null,
      venue: snap?.data_quality?.snapshot?.game?.venue ?? g.venue ?? null,
      completed,
      actualAwayScore: awayScore, actualHomeScore: homeScore,
      actualMargin: completed ? homeScore - awayScore : null,
      actualTotal: completed ? homeScore + awayScore : null,
      actualWinner: completed ? (homeScore > awayScore ? home : awayScore > homeScore ? away : "TIE") : null,
      snapshot: snap,
    });
  }
  games.sort((a, b) => new Date(a.kickoff || 0) - new Date(b.kickoff || 0));
  computeScheduleContexts(games);

  const completedGames = games.filter((g) => g.completed);
  const weatherCache = new Map();
  const today = new Date().toISOString().slice(0, 10);
  let weatherUnavailable = 0;
  for (const g of completedGames) {
    const venue = resolveGameVenue(g);
    Object.assign(g, venue);
    if (weather && !g.dome && venue.stadium && g.kickoff) {
      if (!weatherCache.has(venue.stadium.name)) {
        weatherCache.set(venue.stadium.name, await fetchArchiveWeather(venue.stadium, today));
        await new Promise((r) => setTimeout(r, 250));
      }
      const hourly = weatherCache.get(venue.stadium.name);
      g.weather = hourly ? gameWindowWeather(hourly, g.kickoff) : null;
      if (!g.weather) weatherUnavailable++;
    }
  }

  // Pre-game expectation: market margin preferred, else valid pre-game model margin.
  for (const g of completedGames) {
    const spread = num(g.snapshot?.market_spread);
    if (spread != null) {
      g.expectationMargin = -spread;
      g.expectationSource = "market";
    } else if (g.snapshot && isPreGameRow(g.snapshot)) {
      g.expectationMargin = num(g.snapshot.predicted_home_score) - num(g.snapshot.predicted_away_score);
      g.expectationSource = "fourth-down";
    } else {
      g.expectationMargin = null;
      g.expectationSource = null;
    }
    g.preGame = Boolean(g.snapshot && isPreGameRow(g.snapshot));
  }

  return { rowsByKey, snapshots, games, completedGames, weatherUnavailable };
}

// Valid pre-game prediction rows joined to completed games, in the shape the
// dataset builder and variance calculations consume.
export function predictionRows(completedGames) {
  return completedGames
    .map((g) => {
      const s = g.snapshot;
      if (!s || !g.preGame) return null;
      const pHome = num(s.predicted_home_score); const pAway = num(s.predicted_away_score);
      if (pHome == null || pAway == null) return null;
      const spread = num(s.market_spread);
      return {
        ...g,
        predictedMargin: pHome - pAway,
        predictedHomeScore: pHome,
        predictedAwayScore: pAway,
        marketMargin: spread != null ? -spread : null,
        winnerProb: Math.max(num(s.away_win_probability) ?? 0, num(s.home_win_probability) ?? 0),
        modelPick: s.fourth_down_pick,
        marketPick: s.market_pick,
        modelVersion: s.model_version ?? null,
        modelKey: s.modelKey ?? null,
        currentModel: isCurrentModelIdentity(s.model_version, s.modelKey),
      };
    })
    .filter(Boolean);
}
