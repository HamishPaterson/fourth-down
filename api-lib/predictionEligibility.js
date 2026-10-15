import { FULL_MODEL_VERSION, FULL_MODEL_KEY } from "../src/services/gamePredictionService.js";
import { BEST_BETS_CANDIDATE_VERSION } from "../src/services/bestBetsService.js";

const number = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));

export function completePrediction(snapshot) {
  const bets = snapshot?.bestBets || snapshot?.dataQuality?.bestBetsPayload;
  return Boolean(snapshot && Number(snapshot.modelVersion) === FULL_MODEL_VERSION &&
    snapshot.modelKey === FULL_MODEL_KEY && snapshot.predictionPayload &&
    [snapshot.awayCode, snapshot.homeCode].includes(snapshot.fourthDownPick) &&
    [snapshot.fourthDownAwayScore, snapshot.fourthDownHomeScore,
      snapshot.fourthDownAwayWinProbability, snapshot.fourthDownHomeWinProbability,
      snapshot.confidenceScore].every(number) &&
    [snapshot.fourthDownAwayWinProbability, snapshot.fourthDownHomeWinProbability].every((value) => value >= 0 && value <= 1) &&
    snapshot.fourthDownAwayScore >= 0 && snapshot.fourthDownHomeScore >= 0 &&
    snapshot.dataQuality?.sources?.odds?.available === true &&
    bets && Array.isArray(bets.recommendations) && number(bets.assessed) && bets.assessed > 0 &&
    snapshot.playerProjections?.available === true);
}

export function retainPrediction(existing, incoming, now, authoritative = false) {
  if (!existing) return false;
  if (existing.frozenAt || existing.actualWinner || now.getTime() >= new Date(existing.kickoff).getTime()) return true;
  // Browser saves cannot replace the pre-lock server's authoritative candidates.
  if (existing.authoritative && !authoritative) return true;
  if (!completePrediction(existing)) return !completePrediction(incoming);
  if (!completePrediction(incoming)) return true;
  const age = now.getTime() - new Date(existing.generatedAt).getTime();
  if (authoritative) {
    const candidateUpgrade = incoming.bestBets?.candidateVersion === BEST_BETS_CANDIDATE_VERSION &&
      (existing.bestBets?.candidateVersion !== BEST_BETS_CANDIDATE_VERSION || !Array.isArray(existing.bestBets?.candidates)) &&
      Array.isArray(incoming.bestBets.candidates) &&
      ["season", "week", "awayCode", "homeCode", "kickoff", "generatedAt", "modelVersion", "modelKey",
        "fourthDownPick", "fourthDownAwayScore", "fourthDownHomeScore",
        "fourthDownAwayWinProbability", "fourthDownHomeWinProbability", "confidenceScore",
        "predictionPayload", "playerProjections"]
        .every((key) => key === "modelVersion" ? Number(existing[key]) === Number(incoming[key])
          : JSON.stringify(existing[key]) === JSON.stringify(incoming[key]));
    return !candidateUpgrade && existing.authoritative === true && age >= 0 && age <= 24 * 60 * 60 * 1000;
  }
  return true;
}
