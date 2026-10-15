import standings from "../api/nfl/standings.js";
import personnel from "../api/nfl/qb-roster-health.js";
import kicker from "../api/nfl/kicker-stats.js";
import teamForm, { databaseToSnapshot, writePredictionVersion } from "../api/nfl/game-stats.js";
import opponentNetwork, { createOpponentNetworkHandler, validateWeeklyOpponentNetwork } from "../api/nfl/opponent-network.js";
import playByPlay from "../api/nfl/play-by-play.js";
import roster from "../api/nfl/sleeper-players.js";
import { handleOddsRequest, getCurrentWeekWindow } from "../api/nfl/odds.js";
import { getFullGamePrediction } from "../src/services/gamePredictionService.js";
import { buildPredictionSnapshot } from "../src/services/predictionSnapshot.js";
import { findOddsForGame } from "../src/services/oddsApi.js";
import { completePrediction, retainPrediction } from "./predictionEligibility.js";
import { mergeStoredOdds, isFreshOddsPayload } from "./weeklyMulti.js";
import dataset from "../api/nfl/nflverse-team-metrics.js";
import { buildBestBets, BEST_BETS_CANDIDATE_VERSION } from "../src/services/bestBetsService.js";

export function refreshSavedBestBets(snapshot, odds, now) {
  if (snapshot.bestBets?.candidateVersion === BEST_BETS_CANDIDATE_VERSION &&
      Array.isArray(snapshot.bestBets.candidates)) return snapshot;
  if (!completePrediction(snapshot) || Date.parse(snapshot.kickoff) <= now.getTime()) {
    throw new Error("Candidate repair requires a complete pre-kickoff prediction");
  }
  const event = findOddsForGame(odds.events, snapshot);
  if (!event?.bookmakers?.length) throw new Error(`Stored odds missing for ${snapshot.awayCode} at ${snapshot.homeCode}`);
  const game = { ...snapshot.game, season: snapshot.season, week: snapshot.week, away: snapshot.awayCode, home: snapshot.homeCode };
  const teamMetrics = Number(dataset.season) === snapshot.season ? {
    away: { team: snapshot.awayCode, ...dataset.metricsByWeek?.[snapshot.week]?.[snapshot.awayCode] },
    home: { team: snapshot.homeCode, ...dataset.metricsByWeek?.[snapshot.week]?.[snapshot.homeCode] },
  } : null;
  const bestBets = buildBestBets({
    game, prediction: snapshot.predictionPayload, playerProjections: snapshot.playerProjections,
    oddsEvent: event, dataQuality: snapshot.dataQuality, teamMetrics, asOf: snapshot.generatedAt, quoteAsOf: now,
  });
  return { ...snapshot, bestBets,
    dataQuality: { ...snapshot.dataQuality, bestBets, bestBetsPayload: bestBets } };
}

export async function invoke(handler, query = {}, options = {}) {
  let status = 200, body;
  const response = {
    setHeader() {}, status(code) { status = code; return this; },
    json(value) { body = value; return this; },
  };
  await handler({ method: "GET", query, ...options }, response);
  if (status >= 400) throw new Error(`Prediction input request failed (${status}): ${body?.error || "unavailable"}`);
  return body;
}

export async function readPredictionOdds(client, now, context) {
  if (context && (context.season !== 2026 || getCurrentWeekWindow(now.getTime()).week !== context.week)) {
    throw new Error("Stored odds season/week does not match the schedule lock week");
  }
  const payloads = [];
  for (const url of ["/api/nfl/odds", "/api/nfl/odds?props=1&source=snapshot"]) {
    payloads.push(await invoke((req, res) => handleOddsRequest(req, res, { client, now: now.getTime() }), {}, { url }));
  }
  const merged = mergeStoredOdds(...payloads);
  if (!isFreshOddsPayload(merged)) throw new Error(`Fresh core and stored player odds are required (${merged.cacheStatus})`);
  return merged;
}

export function createServerPredictionInputLoader({ weeklyNetwork, sourceGames, weeklyCutoff } = {}) {
  if (weeklyNetwork) validateWeeklyOpponentNetwork(weeklyNetwork, weeklyNetwork.season, weeklyNetwork.week);
  const networkHandler = weeklyNetwork ? createOpponentNetworkHandler({
    loadNetwork: async (season, week) => {
      validateWeeklyOpponentNetwork(weeklyNetwork, season, week);
      return weeklyNetwork;
    },
  }) : opponentNetwork;
  const shared = new Map();
  const once = (key, load) => {
    if (!shared.has(key)) shared.set(key, load());
    return shared.get(key);
  };
  return ({ away, home, season, week }) => {
    const query = { away, home, season, week };
    return {
      standings: once(`standings:${season}`, () => invoke(standings, { season }).then((body) => body.data)),
      personnel: invoke(personnel, query, weeklyCutoff ? { predictionCutoff: weeklyCutoff } : {}),
      kicker: invoke(kicker, { ...query, season: season - 1 }),
      teamForm: invoke(teamForm, query, sourceGames ? { predictionSeasonGames: sourceGames } : {}),
      opponentNetwork: invoke(networkHandler, query),
      playByPlay: invoke(playByPlay, query),
      playerMetrics: invoke(teamForm, { ...query, action: "player-metrics" }),
      awayRoster: once(`roster:${away}`, () => invoke(roster, { team: away })),
      homeRoster: once(`roster:${home}`, () => invoke(roster, { team: home })),
    };
  };
}

export function createServerPredictionGenerator(options = {}) {
  const loadInputs = options.loadInputs || createServerPredictionInputLoader(options);
  return async (game, odds, now) => {
    const oddsEvent = findOddsForGame(odds.events, game);
    if (!oddsEvent?.bookmakers?.length) throw new Error(`Stored odds missing for ${game.away} at ${game.home}`);
    const result = await getFullGamePrediction(game, oddsEvent, {
      season: game.season, forceRefresh: true,
      loadInputs,
    });
    const snapshot = buildPredictionSnapshot(game, result, oddsEvent, now);
    if (!completePrediction(snapshot) || !result.dataQuality.playByPlay) {
      throw new Error(`Incomplete current-model prediction for ${game.away} at ${game.home}`);
    }
    return snapshot;
  };
}

export async function saveAuthoritativePrediction(client, snapshot, now) {
  if (!completePrediction(snapshot) || new Date(snapshot.kickoff).getTime() <= now.getTime()) {
    throw new Error("Only complete pre-kickoff predictions may be saved by the refresh");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: existing, error } = await client.from("prediction_snapshots").select("*")
      .eq("season", snapshot.season).eq("week", snapshot.week)
      .eq("away_code", snapshot.awayCode).eq("home_code", snapshot.homeCode).maybeSingle();
    if (error) throw new Error("Reading shared prediction failed");
    if (retainPrediction(existing ? databaseToSnapshot(existing) : null, snapshot, now, true)) return existing;
    const written = await writePredictionVersion(client, { ...snapshot, authoritative: true }, existing);
    if (!written.error) return written.data;
    if (!["23505", "CONCURRENT_WRITE"].includes(written.error.code)) throw new Error("Saving shared prediction failed");
  }
  throw new Error("Concurrent prediction persistence did not settle; lock aborted");
}
