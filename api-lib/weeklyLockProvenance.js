import { completePrediction } from "./predictionEligibility.js";
import { isCurrentModelIdentity } from "../src/services/modelIdentity.js";

export const LOCK_PROVENANCE_VERSION = 1;
export const PRESERVED_LOCK_THROUGH = "2026-10-22T00:00:00.000Z";
// The atomic Week 8 replacement persisted server authority as batchProvenance
// (source "server-week-replacement") with generation market dependencies at the
// snapshot top level, rather than as a per-prediction lockProvenance object.
const ATOMIC_BATCH_SOURCE = "server-week-replacement";

// Recognizes the established saved-snapshot authority contract. The table has no
// physical authoritative column; authority lives inside the persisted snapshot
// JSON as either pre-lock lockProvenance or the atomic batchProvenance marker.
export function snapshotAuthority(snapshot, context) {
  const provenance = snapshot?.lockProvenance;
  if (snapshot?.authoritative && provenance?.source === "server-prepared" &&
      provenance?.version === LOCK_PROVENANCE_VERSION && provenance?.predictionId === snapshot?.id &&
      snapshot?.id && provenance?.generationCutoff === context.lockAt &&
      Array.isArray(provenance?.inputs) && provenance.inputs.length &&
      Array.isArray(provenance?.marketDependencies)) {
    return { authoritative: true, marketDependencies: provenance.marketDependencies };
  }
  if (snapshot?.authoritative && snapshot?.id &&
      snapshot?.batchProvenance?.source === ATOMIC_BATCH_SOURCE &&
      Array.isArray(snapshot?.generationMarketDependencies)) {
    return { authoritative: true, marketDependencies: snapshot.generationMarketDependencies };
  }
  return { authoritative: false, marketDependencies: null };
}

export function lockPredictionRejections(snapshot, context, now) {
  const reasons = [];
  const lock = Date.parse(context.lockAt);
  const generated = Date.parse(snapshot?.generatedAt);
  const authority = snapshotAuthority(snapshot, context);
  if (snapshot?.season !== context.season || snapshot?.week !== context.week) reasons.push("WRONG_WEEK");
  if (!isCurrentModelIdentity(snapshot?.modelVersion, snapshot?.modelKey)) reasons.push("WRONG_MODEL");
  if (!authority.authoritative) reasons.push("MISSING_AUTHORITY");
  // Market dependencies are generation-time evidence. They must predate the lock
  // and the generation moment; the 30-hour freshness bound applies only while the
  // scheduled pre-lock pipeline runs. The post-lock relaxations below apply only
  // to the persisted atomic batch (batchProvenance), never to arbitrary rows.
  const atomicBatch = snapshot?.batchProvenance?.source === ATOMIC_BATCH_SOURCE;
  const catchUp = atomicBatch && now.getTime() > lock;
  if (Array.isArray(authority.marketDependencies) && authority.marketDependencies.some((input) => {
    const time = Date.parse(input.timestamp);
    return !Number.isFinite(time) || time > generated || time > lock ||
      (!catchUp && now.getTime() - time > 30 * 3600000);
  })) reasons.push("MODEL_MARKET_DEPENDENCY_STALE");
  if (["away", "home"].some((side) => (snapshot?.personnelViews?.[side]?.players || []).some((player) => {
    const time = typeof player.observationTimestamp === "number" ? player.observationTimestamp : Date.parse(player.observationTimestamp);
    return Number.isFinite(time) && time > Math.min(generated, lock);
  }))) reasons.push("FUTURE_PERSONNEL_EVIDENCE");
  if (!Number.isFinite(generated) || generated >= lock) reasons.push("POST_LOCK_PREDICTION");
  // The 24-hour prediction-age and future-kickoff bounds apply only while the
  // scheduled pre-lock pipeline runs. A post-lock catch-up re-reads the persisted
  // pre-lock batch, whose games legitimately kicked off after the lock moment.
  if (!Number.isFinite(generated) || (!catchUp &&
      (now.getTime() - generated > 24 * 3600000 || generated > now.getTime()))) reasons.push("STALE_PREDICTION");
  if (!completePrediction(snapshot)) reasons.push("INCOMPLETE_PREDICTION");
  if (!Number.isFinite(Date.parse(snapshot?.kickoff)) ||
      (!catchUp && Date.parse(snapshot.kickoff) <= now.getTime()) ||
      Date.parse(snapshot.kickoff) <= lock) {
    reasons.push("KICKOFF_PASSED");
  }
  return reasons;
}
