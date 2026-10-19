import { isCurrentModelIdentity } from "../src/services/modelIdentity.js";
import { BEST_BETS_CANDIDATE_VERSION } from "../src/services/bestBetsService.js";
import { predictionFeatureStatus } from "../src/services/predictionFeatures.js";

const number = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));

export function completePrediction(snapshot) {
  const bets = snapshot?.bestBets || snapshot?.dataQuality?.bestBetsPayload;
  return Boolean(snapshot && isCurrentModelIdentity(snapshot.modelVersion, snapshot.modelKey) && snapshot.predictionPayload &&
    [snapshot.awayCode, snapshot.homeCode].includes(snapshot.fourthDownPick) &&
    [snapshot.fourthDownAwayScore, snapshot.fourthDownHomeScore,
      snapshot.fourthDownAwayWinProbability, snapshot.fourthDownHomeWinProbability,
      snapshot.confidenceScore].every(number) &&
    [snapshot.fourthDownAwayWinProbability, snapshot.fourthDownHomeWinProbability].every((value) => value >= 0 && value <= 1) &&
    snapshot.fourthDownAwayScore >= 0 && snapshot.fourthDownHomeScore >= 0 &&
    snapshot.dataQuality?.sources?.odds?.available === true &&
    bets && Array.isArray(bets.recommendations) && number(bets.assessed) && bets.assessed > 0 &&
    snapshot.playerProjections?.available === true && predictionFeatureStatus(snapshot).personnel);
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
    const existingFeatures = predictionFeatureStatus(existing);
    const currentFeatures = existingFeatures.complete;
    const incomingFeatures = predictionFeatureStatus(incoming).complete;
    const candidateUpgrade = incoming.bestBets?.candidateVersion === BEST_BETS_CANDIDATE_VERSION &&
      (existing.bestBets?.candidateVersion !== BEST_BETS_CANDIDATE_VERSION || !Array.isArray(existing.bestBets?.candidates)) &&
      Array.isArray(incoming.bestBets.candidates) &&
      ["season", "week", "awayCode", "homeCode", "kickoff", "generatedAt", "modelVersion", "modelKey",
        "fourthDownPick", "fourthDownAwayScore", "fourthDownHomeScore",
        "fourthDownAwayWinProbability", "fourthDownHomeWinProbability", "confidenceScore",
        "predictionPayload", "playerProjections", "personnelVersion", "personnelViews"]
        .every((key) => key === "modelVersion" ? Number(existing[key]) === Number(incoming[key])
          : JSON.stringify(existing[key]) === JSON.stringify(incoming[key]));
    if (existing.authoritative && currentFeatures && incomingFeatures &&
        personnelSignature(existing) !== personnelSignature(incoming)) return false;
    if (existing.authoritative && currentFeatures) return true;
    if (!currentFeatures && incomingFeatures) {
      const onlyCandidatesMissing = existingFeatures.version && existingFeatures.phase1 &&
        existingFeatures.phase2a && existingFeatures.network && existingFeatures.personnel &&
        !existingFeatures.candidates;
      return onlyCandidatesMissing && !candidateUpgrade;
    }
    return !candidateUpgrade && existing.authoritative === true && age >= 0 && age <= 24 * 60 * 60 * 1000;
  }
  return true;
}

export function personnelSignature(snapshot) {
  return JSON.stringify(["away", "home"].map((side) => {
      const view = snapshot.personnelViews?.[side];
      return {
        team: view?.team,
        cutoff: view?.cutoff,
        quarterback: {
          resolved: view?.quarterback?.resolved,
          conflict: view?.quarterback?.conflict,
          player: view?.quarterback?.player?.canonicalId ?? null,
          replacementFor: view?.quarterback?.player?.replacementFor ?? null,
        },
        players: (view?.players || []).map((player) => ({
          id: player.canonicalId, team: player.team, position: player.position,
          rank: player.rank, status: player.status, statusKnown: player.statusKnown,
          projectedAvailable: player.projectedAvailable, propEligible: player.propEligible,
          replacementId: player.replacementId, replacementFor: player.replacementFor,
          identityConflict: player.identityConflict, sourceConflict: player.sourceConflict,
        })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      };
  }));
}
