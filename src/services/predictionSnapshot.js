import { FULL_MODEL_VERSION, FULL_MODEL_KEY } from "./gamePredictionService.js";

export function buildPredictionSnapshot(game, fullResult, oddsEvent, now = new Date()) {
  const prediction = fullResult.prediction;
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
    oddsPick: marketAway === null || marketHome === null || marketAway === marketHome ? null
      : marketAway > marketHome ? game.away : game.home,
    marketAwayScore: marketAway, marketHomeScore: marketHome,
    marketGameTotal: prediction.market?.total ?? null, marketSpread: prediction.market?.homeSpread ?? null,
    projectedTie: Boolean(prediction.projectedTie), continuousMargin: prediction.continuousMargin ?? null,
    confidenceScore: prediction.confidenceScore, confidenceLabel: prediction.confidence,
    modelVersion: FULL_MODEL_VERSION, modelKey: FULL_MODEL_KEY,
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
