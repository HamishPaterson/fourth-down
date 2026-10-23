import { completePrediction } from "./predictionEligibility.js";
import { isCurrentModelIdentity } from "../src/services/modelIdentity.js";

export const LOCK_PROVENANCE_VERSION = 1;
export const PRESERVED_LOCK_THROUGH = "2026-10-22T00:00:00.000Z";

export function lockPredictionRejections(snapshot, context, now) {
  const reasons = [];
  const lock = Date.parse(context.lockAt);
  const generated = Date.parse(snapshot?.generatedAt);
  const provenance = snapshot?.lockProvenance;
  if (snapshot?.season !== context.season || snapshot?.week !== context.week) reasons.push("WRONG_WEEK");
  if (!isCurrentModelIdentity(snapshot?.modelVersion, snapshot?.modelKey)) reasons.push("WRONG_MODEL");
  if (!snapshot?.authoritative || provenance?.source !== "server-prepared" ||
      provenance?.version !== LOCK_PROVENANCE_VERSION || provenance?.predictionId !== snapshot?.id ||
      !snapshot?.id || provenance?.generationCutoff !== context.lockAt ||
      !Array.isArray(provenance?.inputs) || !provenance.inputs.length ||
      !Array.isArray(provenance?.marketDependencies)) reasons.push("MISSING_AUTHORITY");
  if (Array.isArray(provenance?.marketDependencies) && provenance.marketDependencies.some((input) => {
    const time = Date.parse(input.timestamp);
    return !Number.isFinite(time) || time > generated || time > lock || now.getTime() - time > 30 * 3600000;
  })) reasons.push("MODEL_MARKET_DEPENDENCY_STALE");
  if (["away", "home"].some((side) => (snapshot?.personnelViews?.[side]?.players || []).some((player) => {
    const time = typeof player.observationTimestamp === "number" ? player.observationTimestamp : Date.parse(player.observationTimestamp);
    return Number.isFinite(time) && time > Math.min(generated, lock);
  }))) reasons.push("FUTURE_PERSONNEL_EVIDENCE");
  if (!Number.isFinite(generated) || generated >= lock) reasons.push("POST_LOCK_PREDICTION");
  if (!Number.isFinite(generated) || now.getTime() - generated > 24 * 3600000 ||
      generated > now.getTime()) reasons.push("STALE_PREDICTION");
  if (!completePrediction(snapshot)) reasons.push("INCOMPLETE_PREDICTION");
  if (!Number.isFinite(Date.parse(snapshot?.kickoff)) || Date.parse(snapshot.kickoff) <= now.getTime()) {
    reasons.push("KICKOFF_PASSED");
  }
  return reasons;
}
