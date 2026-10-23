export const PLAYER_REJECTION_CODES = Object.freeze({
  unmatched_player: "PLAYER_IDENTITY_MISMATCH", ambiguous_player: "IDENTITY_AMBIGUOUS",
  player_team_mismatch: "TEAM_MISMATCH", missing_personnel_identity: "IDENTITY_UNRESOLVED",
  unknown_availability: "PLAYER_AVAILABILITY_UNKNOWN", doubtful: "PLAYER_DOUBTFUL",
  unavailable_or_conflicted_personnel: "PLAYER_UNAVAILABLE", availability_stale: "AVAILABILITY_STALE",
  unsupported_market: "UNSUPPORTED_MARKET", missing_player_identity: "IDENTITY_UNRESOLVED",
  implausible_line: "INVALID_LINE", "role_confidence_below_0.55": "ROLE_CONFIDENCE_INSUFFICIENT",
  "data_quality_below_0.50": "PROJECTION_QUALITY_INSUFFICIENT", missing_projection: "PLAYER_PROJECTION_UNAVAILABLE",
  non_positive_edge: "NON_POSITIVE_EDGE", probability_below_threshold: "PROBABILITY_BELOW_THRESHOLD",
  edge_below_threshold: "EDGE_BELOW_THRESHOLD", ev_below_threshold: "EV_BELOW_THRESHOLD",
  price_stale: "PRICE_STALE",
});
// Specific input failures precede pricing/value failures; the aggregate is last.
export const PLAYER_REASON_PRIORITY = Object.freeze([
  "PLAYER_PROJECTION_UNAVAILABLE", "PLAYER_IDENTITY_MISMATCH", "IDENTITY_AMBIGUOUS", "TEAM_MISMATCH",
  "IDENTITY_UNRESOLVED", "PLAYER_AVAILABILITY_UNKNOWN", "AVAILABILITY_STALE",
  "PLAYER_UNAVAILABLE", "PLAYER_DOUBTFUL", "ROLE_CONFIDENCE_INSUFFICIENT", "PROJECTION_QUALITY_INSUFFICIENT",
  "INVALID_PRICE", "PRICE_STALE", "PRICE_UNAVAILABLE", "NON_POSITIVE_EDGE",
  "PROBABILITY_BELOW_THRESHOLD", "EDGE_BELOW_THRESHOLD", "EV_BELOW_THRESHOLD", "NO_ELIGIBLE_CANDIDATE",
]);
export function primaryPlayerReason(codes) {
  return PLAYER_REASON_PRIORITY.find((code) => codes.includes(code)) || "NO_ELIGIBLE_CANDIDATE";
}
const messages = {
  PLAYER_AVAILABILITY_UNKNOWN: "Player availability is unknown; scorer eligibility cannot be confirmed.",
  AVAILABILITY_STALE: "Player availability is out of date.",
  PLAYER_IDENTITY_MISMATCH: "Priced players could not be matched to projections.",
  IDENTITY_AMBIGUOUS: "Player identity is ambiguous.",
  IDENTITY_UNRESOLVED: "Player identity could not be verified.",
  PLAYER_PROJECTION_UNAVAILABLE: "Player projections are unavailable.",
  PRICE_UNAVAILABLE: "Player prices are unavailable.",
  PRICE_STALE: "Player prices are out of date.",
  INVALID_PRICE: "The supplied player price is invalid.",
  TEAM_MISMATCH: "Priced players do not match this game's teams.",
  PROJECTION_QUALITY_INSUFFICIENT: "Player projection quality is insufficient.",
  EDGE_BELOW_THRESHOLD: "Model edge is below the required threshold.",
  EV_BELOW_THRESHOLD: "Expected value is below the required threshold.",
  NON_POSITIVE_EDGE: "Valid prices offer no positive model edge.",
  PROBABILITY_BELOW_THRESHOLD: "Model probability is below the required threshold.",
  ROLE_CONFIDENCE_INSUFFICIENT: "Player role confidence is insufficient.",
  PLAYER_UNAVAILABLE: "Projected players are unavailable.",
  PLAYER_DOUBTFUL: "Projected players are doubtful.",
  NO_ELIGIBLE_CANDIDATE: "No player candidate qualifies after filtering.",
};
export function playerReasonMessage(code) {
  return messages[canonicalReason(code)] || messages.NO_ELIGIBLE_CANDIDATE;
}
const legacyReasons = { AVAILABILITY_UNKNOWN: "PLAYER_AVAILABILITY_UNKNOWN", IDENTITY_MISMATCH: "PLAYER_IDENTITY_MISMATCH",
  PROJECTION_UNAVAILABLE: "PLAYER_PROJECTION_UNAVAILABLE", ROLE_INSUFFICIENT: "ROLE_CONFIDENCE_INSUFFICIENT" };
const canonicalReason = (code) => legacyReasons[code] || code;
export function playerDiagnosticSummary(bestBets) {
  const diagnostics = bestBets?.marketDiagnostics;
  if (!diagnostics) return null;
  if (diagnostics.playerFailureCounts) {
    const counts = Object.entries(diagnostics.playerFailureCounts).filter(([, count]) => count > 0)
      .map(([code]) => canonicalReason(code));
    const code = PLAYER_REASON_PRIORITY.find((key) => counts.includes(key));
    if (code) return playerReasonMessage(code);
  }
  if (diagnostics.playerMarkets === 0) return playerReasonMessage("PRICE_UNAVAILABLE");
  if (diagnostics.matchedPlayerMarkets === 0) return "No player candidate qualifies; saved rejection details are unavailable.";
  return null;
}
export function scorerProbabilityLabel(scorer) {
  return scorer?.source === "unavailable" || !Number.isFinite(scorer?.modelProbability)
    ? "Unavailable" : `${(scorer.modelProbability * 100).toFixed(1)}%`;
}

export function tdBettingDisplay(scorer, now = new Date()) {
  if (!scorer || scorer.source === "unavailable") return scorer;
  const supplied = scorer.price !== null && scorer.price !== undefined && scorer.price !== "";
  const price = Number(scorer.price);
  const timestamp = Date.parse(scorer.updatedAt);
  const reason = !supplied ? "PRICE_UNAVAILABLE"
      : !Number.isFinite(price) || Math.abs(price) < 100 ||
        !Number.isFinite(scorer.decimalOdds) || scorer.decimalOdds <= 1 ? "INVALID_PRICE"
        : scorer.source !== "priced-market" ? "PRICE_UNAVAILABLE"
        : !scorer.personnelId || !scorer.playerTeam ? "IDENTITY_UNRESOLVED"
          : !Number.isFinite(scorer.roleConfidence) || scorer.roleConfidence < .55 ? "ROLE_CONFIDENCE_INSUFFICIENT"
            : !Number.isFinite(timestamp) || timestamp > now.getTime() || now.getTime() - timestamp > 30 * 3600000 ? "PRICE_STALE"
              : !Number.isFinite(scorer.edge) || scorer.edge <= 0 ? "NON_POSITIVE_EDGE"
                : !Number.isFinite(scorer.modelProbability) || scorer.modelProbability < .55 ? "PROBABILITY_BELOW_THRESHOLD"
                  : scorer.edge < .045 ? "EDGE_BELOW_THRESHOLD"
                    : !Number.isFinite(scorer.expectedValue) || scorer.expectedValue < .03 ? "EV_BELOW_THRESHOLD"
                      : scorer.quoteValidation?.status !== "validated" ? "NO_ELIGIBLE_CANDIDATE"
                        : scorer.bettingEligible !== true ? "PLAYER_AVAILABILITY_UNKNOWN" : null;
  return reason ? { source: "unavailable", selection: "No eligible TD betting recommendation",
    modelProbability: null, decimalOdds: null, primaryReason: reason, explanation: playerReasonMessage(reason) } : scorer;
}
