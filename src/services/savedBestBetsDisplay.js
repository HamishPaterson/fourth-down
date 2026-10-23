import { findOddsForGame, resolveTeamCode } from "./oddsApi.js";
import { canonicalQuoteMarket, validateOddsEvents } from "./quoteValidation.js";
import { BEST_BETS_CANDIDATE_VERSION, isQualifiedBestBet, selectTdModelPick } from "./bestBetsService.js";
import { tdBettingDisplay } from "./playerBetDiagnostics.js";

const key = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const marketKey = (bet) => canonicalQuoteMarket(bet.rawMarketType || (bet.market === "Game total" ? "totals" : bet.market));

function rejection(bet, snapshot, event, now) {
  if (snapshot.bestBets?.candidateVersion !== BEST_BETS_CANDIDATE_VERSION) return { code: "CURRENT_ASSESSMENT_REQUIRED" };
  if (!isQualifiedBestBet(bet)) return { code: "BELOW_QUALIFICATION_THRESHOLD" };
  const validation = validateOddsEvents(event ? [event] : [], { now });
  const quotes = (validation.events[0]?.bookmakers || []).filter((book) =>
    [book.key, book.title, book.name].some((name) => key(name) === key(bet.sportsbook)))
    .flatMap((book) => (book.markets || []).filter((market) => canonicalQuoteMarket(market.key) === marketKey(bet))
      .flatMap((market) => (market.outcomes || []).filter((quote) => {
        if (bet.category === "Game" && ["h2h", "spreads"].includes(market.key))
          return resolveTeamCode(quote.name) === resolveTeamCode(bet.teamCode || bet.selection.split(" ")[0]) &&
            (bet.line == null || Number(quote.point) === Number(bet.line));
        const selection = key(`${quote.playerName || quote.description || ""}${quote.name}${quote.point ?? ""}`);
        return key(bet.selection).startsWith(selection) &&
          (bet.line == null || Number(quote.point) === Number(bet.line));
      }).map((quote) => ({ ...quote, timestamp: quote.quoteSource?.timestamp || quote.updatedAt ||
        market.last_update || book.last_update }))));
  if (!quotes.length) return { code: "PRICE_UNAVAILABLE" };
  const exact = quotes.find((quote) => Number(quote.price) === Number(bet.price) &&
    quote.quoteValidation?.status === "validated") || quotes.find((quote) => Number(quote.price) === Number(bet.price));
  if (!exact) return { code: "PRICE_CHANGED" };
  if (exact.quoteValidation?.status !== "validated" || exact.quoteSource?.rolloverFallback) {
    const reasons = exact.quoteValidation?.reasons || [];
    return { code: reasons.includes("malformed_price") ? "INVALID_PRICE"
      : reasons.includes("stale_offer") ? "PRICE_STALE" : "QUOTE_REJECTED" };
  }
  if (!Number.isFinite(Date.parse(exact.timestamp))) return { code: "PRICE_UNAVAILABLE" };
  return { code: null, quote: exact };
}

// The read-only server assessment uses saved model output, not a new prediction.
// Its candidates must still match the client's current validated quote snapshot.
export function savedBestBetsDisplay(snapshot, events, now = new Date()) {
  const saved = snapshot.bestBets || snapshot.dataQuality?.bestBetsPayload;
  if (!saved) return null;
  const event = findOddsForGame(events || [], { away: snapshot.awayCode, home: snapshot.homeCode,
    kickoff: snapshot.kickoff });
  const pool = [...(saved.candidates || []), ...(saved.recommendations || [])];
  const unique = new Map(pool.map((bet) => [[bet.market, bet.selection, bet.sportsbook, bet.line].join(":"), bet]));
  const candidateDiagnostics = [];
  const candidates = [...unique.values()].flatMap((bet) => {
    const result = rejection(bet, snapshot, event, now);
    candidateDiagnostics.push({ market: bet.market, selection: bet.selection, sportsbook: bet.sportsbook,
      price: bet.price, line: bet.line, modelProbability: bet.modelProbability,
      marketProbability: bet.marketProbability, edge: bet.edge, expectedValue: bet.expectedValue,
      savedQuoteTimestamp: bet.updatedAt, quoteTimestamp: result.quote?.timestamp || null,
      rejectionCode: result.code, eligible: !result.code });
    if (result.code) return [];
    return [{ ...bet, updatedAt: result.quote.timestamp, quoteId: result.quote.quoteSource?.id || bet.quoteId,
      quoteValidation: result.quote.quoteValidation }];
  });
  const scorer = tdBettingDisplay(saved.anytimeTdScorer, now, { ...snapshot, bestBets: saved });
  const recommendations = candidates.map((bet, index) => ({ ...bet, rank: index + 1 }));
  return { ...saved, candidates, recommendations,
    qualified: candidates.length, highlights: null, anytimeTdScorer: scorer, displayDiagnostics: candidateDiagnostics,
    anytimeTdModelPick: selectTdModelPick({ game: snapshot, playerProjections: snapshot.playerProjections,
      personnelViews: snapshot.personnelViews, oddsEvent: event, quoteAsOf: now }),
    message: candidates.length ? null : "No saved candidate has a matching current eligible quote.",
  };
}
