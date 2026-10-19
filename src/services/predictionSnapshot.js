import { CURRENT_MODEL_VERSION as FULL_MODEL_VERSION, CURRENT_MODEL_KEY as FULL_MODEL_KEY } from "./modelIdentity.js";
import { getCoreMarket } from "./oddsApi.js";
import { PREDICTION_FEATURE_VERSION, MATCHUP_INTELLIGENCE_SCHEMA_VERSION } from "./predictionFeatures.js";
import { PERSONNEL_VIEW_VERSION } from "../../api-lib/personnelView.js";

export function applyPredictionSnapshot(snapshot) {
  const payload = snapshot?.predictionPayload ?? snapshot?.dataQuality?.predictionPayload;
  if (!payload) return null;
  const awayScore = Number(snapshot.fourthDownAwayScore);
  const homeScore = Number(snapshot.fourthDownHomeScore);
  return {
    ...payload,
    away: { ...payload.away, code: snapshot.awayCode, score: awayScore },
    home: { ...payload.home, code: snapshot.homeCode, score: homeScore },
    winner: snapshot.fourthDownPick,
    margin: Math.abs(awayScore - homeScore),
    total: awayScore + homeScore,
    awayWinProbability: Number(snapshot.fourthDownAwayWinProbability),
    homeWinProbability: Number(snapshot.fourthDownHomeWinProbability),
    winnerWinProbability: Number(snapshot.fourthDownWinnerProbability),
  };
}

export function buildPredictionSnapshot(game, fullResult, oddsEvent, now = new Date()) {
  const prediction = { ...fullResult.prediction,
    matchupIntelligence: fullResult.prediction.matchupIntelligence ? {
      ...fullResult.prediction.matchupIntelligence, schemaVersion: MATCHUP_INTELLIGENCE_SCHEMA_VERSION,
    } : undefined };
  const marketAway = prediction.market?.awayExpected ?? null;
  const marketHome = prediction.market?.homeExpected ?? null;
  return {
    id: `${Number(game.week)}:${game.away}:${game.home}:${game.sourceDate}`,
    season: Number(game.season || 2026), week: Number(game.week),
    source: "shared-full-model",
    awayCode: game.away, homeCode: game.home, kickoff: game.sourceDate,
    fourthDownPick: prediction.winner,
    fourthDownAwayScore: prediction.away.score, fourthDownHomeScore: prediction.home.score,
    fourthDownAwayWinProbability: prediction.awayWinProbability,
    fourthDownHomeWinProbability: prediction.homeWinProbability,
    fourthDownWinnerProbability: prediction.winnerWinProbability,
    oddsPick: getCoreMarket(oddsEvent).pick,
    marketAwayScore: marketAway, marketHomeScore: marketHome,
    marketGameTotal: prediction.market?.total ?? null, marketSpread: prediction.market?.homeSpread ?? null,
    projectedTie: Boolean(prediction.projectedTie), continuousMargin: prediction.continuousMargin ?? null,
    confidenceScore: prediction.confidenceScore, confidenceLabel: prediction.confidence,
    modelVersion: FULL_MODEL_VERSION, modelKey: FULL_MODEL_KEY,
    predictionFeatureVersion: PREDICTION_FEATURE_VERSION,
    personnelVersion: fullResult.personnelVersion || PERSONNEL_VIEW_VERSION,
    personnelViews: fullResult.personnelViews || null,
    opponentNetworkStatus: prediction.modelLayers?.opponentNetwork?.available === true &&
      fullResult.dataQuality?.sources?.opponentNetwork?.available === true ? "available" : "unavailable",
    predictionPayload: prediction, playerProjections: fullResult.playerProjections,
    bestBets: fullResult.bestBets,
    dataQuality: {
      ...fullResult.dataQuality, modelVersion: FULL_MODEL_VERSION, modelKey: FULL_MODEL_KEY,
      predictionPayload: prediction, weather: fullResult.weather || game.weather || null,
      bestBets: fullResult.bestBets, bestBetsPayload: fullResult.bestBets,
    },
    game: { ...game, weather: fullResult.weather || game.weather || null, oddsEvent },
    generatedAt: fullResult.generatedAt, snapshotAt: now.toISOString(),
    savedBeforeKickoff: now.getTime() < new Date(game.sourceDate).getTime(),
    actualAwayScore: null, actualHomeScore: null, actualWinner: null,
  };
}
