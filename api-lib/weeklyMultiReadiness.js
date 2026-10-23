import { buildWeeklyMultiSelection, candidateIdentity } from "./weeklyMulti.js";
import { lockPredictionRejections, PRESERVED_LOCK_THROUGH } from "./weeklyLockProvenance.js";
import { completePrediction } from "./predictionEligibility.js";
import { isCurrentModelIdentity } from "../src/services/modelIdentity.js";
import { canonicalQuoteMarket, validateOddsEvents } from "../src/services/quoteValidation.js";
import { findOddsForGame } from "../src/services/oddsApi.js";
import { availableForPlayerBet } from "./personnelView.js";

export const READINESS_MARKETS = Object.freeze(["h2h", "spreads", "totals", "player_anytime_td",
  "player_pass_yds", "player_pass_tds", "player_pass_attempts", "player_completions",
  "player_rush_yds", "player_rush_attempts", "player_reception_yds", "player_receptions",
  "player_rush_reception_yds"]);

export function savedPredictionRows(rows) {
  return (rows || []).map((row) => ({ ...(row.data_quality?.snapshot || row),
    id: row.data_quality?.snapshot?.id || row.id, databaseId: row.id }));
}

export function validLockPlan(plan, now) {
  const lock = Date.parse(plan?.lock_at);
  const created = Date.parse(plan?.prepared_at);
  const games = plan?.games;
  return Number.isFinite(lock) && lock > Date.parse(PRESERVED_LOCK_THROUGH) &&
    new Date(lock).getUTCDay() === 4 && new Date(lock).getUTCHours() === 0 &&
    new Date(lock).getUTCMinutes() === 0 && new Date(lock).getUTCSeconds() === 0 &&
    Number.isFinite(created) && created < lock && created <= now.getTime() &&
    plan.source === "server-prepared" && Number.isInteger(plan.season) && plan.season >= 2026 &&
    Number.isInteger(plan.week) && plan.week >= 1 && plan.week <= 18 &&
    !(plan.season === 2026 && plan.week <= 7) &&
    Array.isArray(games) && games.length > 0 && games.length <= 16 &&
    plan.expected_game_count === games.length &&
    games.every((game) => /^[A-Z]{2,3}$/.test(game.away) && /^[A-Z]{2,3}$/.test(game.home) &&
      game.away !== game.home && Number.isFinite(Date.parse(game.kickoff)) &&
      Date.parse(game.kickoff) > lock && Date.parse(game.kickoff) < lock + 7 * 86400000) &&
    new Set(games.flatMap((game) => [game.away, game.home])).size === games.length * 2;
}

export function evaluateWeeklyMultiReadiness({ plan, predictions = [], odds, now = new Date() }) {
  const context = { season: plan?.season, week: plan?.week, lockAt: plan?.lock_at };
  const planValid = validLockPlan(plan, now);
  const expected = planValid ? plan.games : [];
  const considered = expected.map((game) => predictions.find((prediction) =>
    prediction.awayCode === game.away && prediction.homeCode === game.home &&
    Date.parse(prediction.kickoff) === Date.parse(game.kickoff))).filter(Boolean);
  const accepted = considered.filter((prediction) => !lockPredictionRejections(prediction, context, now).length);
  const validation = validateOddsEvents(odds?.events || [], { now });
  const coverage = Object.fromEntries(READINESS_MARKETS.map((market) => {
    let present = 0, fresh = 0, rejected = 0;
    for (const game of expected) {
      const event = findOddsForGame(validation.events, game);
      const outcomes = (event?.bookmakers || []).flatMap((book) => (book.markets || [])
        .filter((row) => canonicalQuoteMarket(row.key) === market)
        .flatMap((row) => (row.outcomes || []).map((outcome) => ({ outcome, book, row }))));
      if (outcomes.length) present++;
      const current = outcomes.some(({ outcome, book, row }) => {
        const time = Date.parse(outcome.quoteSource?.timestamp || outcome.updatedAt || row.last_update || book.last_update);
        const fetched = Date.parse(outcome.quoteSource?.fetchedAt);
        return outcome.quoteValidation?.status === "validated" && outcome.quoteSource?.rolloverFallback !== true && Number.isFinite(time) &&
          time <= Math.min(now.getTime(), Date.parse(plan.lock_at)) &&
          Boolean(outcome.quoteSource?.id) && Number.isFinite(fetched) &&
          fetched <= Math.min(now.getTime(), Date.parse(plan.lock_at));
      });
      if (current) fresh++;
      if (outcomes.length && !current) rejected++;
    }
    return [market, { presentGames: present, freshGames: fresh, staleOrRejectedGames: rejected,
      missingGames: expected.length - present,
      status: !planValid ? "UNKNOWN" : fresh === expected.length ? "READY" : "DEGRADED_NON_BLOCKING" }];
  }));
  const selection = buildWeeklyMultiSelection(accepted, odds, { ...context, requireSnapshotEvidence: true }, now);
  for (const prediction of considered.filter((row) => !accepted.includes(row))) {
    const reasons = lockPredictionRejections(prediction, context, now);
    const bets = [...(prediction.bestBets?.candidates || prediction.bestBets?.recommendations || []),
      prediction.bestBets?.anytimeTdScorer].filter(Boolean);
    for (const bet of bets) selection.candidateDiagnostics.push({
      predictionId: prediction.id, quoteId: bet.quoteId || null, market: canonicalQuoteMarket(bet.market),
      candidateId: candidateIdentity({ ...bet,
        matchupKey: `${context.season}:${context.week}:${prediction.awayCode}:${prediction.homeCode}` }),
      identityState: "NOT_EVALUATED", availabilityState: "NOT_EVALUATED", eligible: false, reasons,
    });
  }
  const blockingReasons = [];
  if (!planValid) blockingReasons.push("LOCK_PLAN_UNAVAILABLE_OR_INVALID");
  if (planValid && considered.length !== expected.length) blockingReasons.push("PREDICTIONS_MISSING");
  if (planValid && accepted.length !== expected.length) blockingReasons.push("AUTHORITATIVE_PREDICTIONS_NOT_READY");
  if (!selection.complete) blockingReasons.push("INSUFFICIENT_ELIGIBLE_MATCHUPS");
  const degraded = Object.values(coverage).some((market) => market.status === "DEGRADED_NON_BLOCKING");
  return {
    status: !planValid ? "UNKNOWN" : blockingReasons.length ? "NOT_READY" : degraded ? "DEGRADED_NON_BLOCKING" : "READY",
    scheduledLockAt: plan?.lock_at || null,
    expectedGameCount: planValid ? expected.length : null,
    savedPredictionCount: considered.length,
    authoritativePredictionCount: considered.filter((row) => row.authoritative &&
      row.lockProvenance?.source === "server-prepared").length,
    currentModelIdentityCount: considered.filter((row) => isCurrentModelIdentity(row.modelVersion, row.modelKey)).length,
    completePredictionCount: considered.filter(completePrediction).length,
    eligiblePredictionCount: accepted.length,
    playerProjectionCoverage: considered.filter((row) => row.playerProjections?.available === true).length,
    personnelContextCoverage: considered.filter((row) => row.personnelViews?.away && row.personnelViews?.home).length,
    playerAvailabilityCoverage: considered.reduce((counts, row) => {
      for (const side of ["away", "home"]) for (const player of row.personnelViews?.[side]?.players || []) {
        counts.total++;
        if (availableForPlayerBet(player, { observedAt: now.toISOString() })) counts.eligible++;
      }
      return counts;
    }, { total: 0, eligible: 0 }),
    markets: coverage,
    eligibleBestBetCount: selection.eligibleCandidates.length,
    validUniqueMatchupCount: new Set(selection.eligibleCandidates.map((row) => row.matchupKey)).size,
    canSatisfyLegCount: blockingReasons.length === 0,
    blockingReasons,
    predictionRejections: considered.map((row) => ({ predictionId: row.id,
      reasons: lockPredictionRejections(row, context, now) })),
    selection,
  };
}
