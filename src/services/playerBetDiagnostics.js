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

function unavailableTd(reason) {
  return { source: "unavailable", title: "Anytime TD scorer", selection: "No eligible TD betting recommendation",
    modelProbability: null, decimalOdds: null, primaryReason: reason, explanation: playerReasonMessage(reason),
    risk: "No eligible priced player candidate remains after filtering." };
}

function savedTdPlayers(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(savedTdPlayers);
  const probability = value.anytimeTouchdownProbability ?? value.anytime_touchdown_probability;
  if (Number.isFinite(probability) && probability >= 0 && probability <= 1 &&
      (value.playerName || value.name || value.fullName)) return [value];
  return Object.values(value).flatMap(savedTdPlayers);
}

const suppliedPrice = (price) => price !== null && price !== undefined && price !== "";
const playerNameKey = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function savedTdPlayerReason(player, snapshot) {
  const id = player.personnelId || player.gsisId;
  const view = Object.values(snapshot.personnelViews || {}).find((row) => row?.team === player.team);
  const record = id && view?.players?.find((row) => row.canonicalId === id);
  const personnel = record || player.personnel;
  if (record?.identityConflict || record?.sourceConflict ||
      player.personnel?.confidence === "unmatched") return "PLAYER_IDENTITY_MISMATCH";
  if (!id || !player.team || !personnel) return "NO_ELIGIBLE_CANDIDATE";
  if (personnel.statusKnown === false && personnel.status === "Unknown") return "PLAYER_AVAILABILITY_UNKNOWN";
  if (personnel.eligibleBeforeCutoff === false) return "AVAILABILITY_STALE";
  if (["Doubtful", "Out", "Inactive", "IR", "PUP", "Suspended", "NFI"].includes(personnel.status))
    return personnel.status === "Doubtful" ? "PLAYER_DOUBTFUL" : "PLAYER_UNAVAILABLE";
  const eligible = record ? record.statusKnown === true && record.propEligible === true &&
    record.eligibleBeforeCutoff === true && record.projectedAvailable !== false
    : personnel.statusKnown === true && personnel.eligible === true;
  if (!eligible) return "NO_ELIGIBLE_CANDIDATE";
  if (Number.isFinite(player.roleConfidence) && player.roleConfidence < .55) return "ROLE_CONFIDENCE_INSUFFICIENT";
  if (!Number.isFinite(player.roleConfidence)) return "NO_ELIGIBLE_CANDIDATE";

  const odds = snapshot.game?.oddsEvent;
  const name = playerNameKey(player.playerName || player.name || player.fullName);
  const quotes = (odds?.bookmakers || []).flatMap((book) => (book.markets || [])
    .filter((market) => market.key === "player_anytime_td")
    .flatMap((market) => (market.outcomes || []).filter((quote) =>
      playerNameKey(quote.playerName || quote.description || quote.name) === name)
      .map((quote) => ({ ...quote, updatedAt: quote.quoteSource?.timestamp || quote.last_update ||
        market.last_update || book.last_update }))));
  const quarantined = (snapshot.bestBets?.quarantinedOffers || []).filter((quote) =>
    quote.market === "player_anytime_td" && playerNameKey(quote.playerName) === name);
  const offers = [...quotes, ...quarantined];
  if (!offers.length) return Array.isArray(odds?.bookmakers) ? "PRICE_UNAVAILABLE" : "NO_ELIGIBLE_CANDIDATE";
  const reasons = offers.map((quote) => {
    if (!suppliedPrice(quote.price)) return "PRICE_UNAVAILABLE";
    if (!Number.isFinite(Number(quote.price)) || Math.abs(Number(quote.price)) < 100 ||
        quote.decimalOdds !== undefined && (!Number.isFinite(quote.decimalOdds) || quote.decimalOdds <= 1) ||
        quote.quoteValidation?.reasons?.includes("malformed_price")) return "INVALID_PRICE";
    const at = Date.parse(snapshot.generatedAt || snapshot.snapshotAt);
    const quoted = Date.parse(quote.updatedAt);
    if (quote.stale === true || quote.quoteValidation?.reasons?.includes("stale_offer") ||
        Number.isFinite(at) && Number.isFinite(quoted) && (quoted > at || at - quoted > 30 * 3600000)) return "PRICE_STALE";
    if (!Number.isFinite(quoted) || !Number.isFinite(at)) return "NO_ELIGIBLE_CANDIDATE";
    if (Number.isFinite(quote.edge) && quote.edge <= 0) return "NON_POSITIVE_EDGE";
    const probability = player.anytimeTouchdownProbability ?? player.anytime_touchdown_probability;
    if (probability < .55) return "PROBABILITY_BELOW_THRESHOLD";
    return "NO_ELIGIBLE_CANDIDATE";
  });
  return reasons.every((reason) => reason === reasons[0]) ? reasons[0] : "NO_ELIGIBLE_CANDIDATE";
}

export function normalizeSavedTdEmptyState(scorer, snapshot) {
  if (scorer?.source !== "unavailable") return scorer;
  const structuredReason = canonicalReason(scorer.primaryReason);
  if (PLAYER_REASON_PRIORITY.includes(structuredReason)) return scorer;
  const diagnostics = snapshot?.bestBets?.marketDiagnostics?.playerDiagnostics?.filter((row) =>
    row.market === "player_anytime_td" && PLAYER_REASON_PRIORITY.includes(canonicalReason(row.rejectionCode)));
  if (diagnostics?.length) {
    const reasons = diagnostics.map((row) => canonicalReason(row.rejectionCode));
    return unavailableTd(reasons.every((reason) => reason === reasons[0]) ? reasons[0] : "NO_ELIGIBLE_CANDIDATE");
  }
  if (!snapshot || !Object.hasOwn(snapshot, "playerProjections")) return unavailableTd("NO_ELIGIBLE_CANDIDATE");
  const players = savedTdPlayers(snapshot.playerProjections);
  if (!players.length) return unavailableTd("PLAYER_PROJECTION_UNAVAILABLE");
  const reasons = players.map((player) => savedTdPlayerReason(player, snapshot));
  return unavailableTd(reasons.every((reason) => reason === reasons[0]) ? reasons[0] : "NO_ELIGIBLE_CANDIDATE");
}

export function tdBettingDisplay(scorer, now = new Date(), savedPrediction) {
  if (!scorer || scorer.source === "unavailable") return normalizeSavedTdEmptyState(scorer, savedPrediction);
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
