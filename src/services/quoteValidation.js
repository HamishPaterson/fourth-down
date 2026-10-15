const MAX_AGE_MS = 30 * 60 * 60 * 1000;
const present = (value) => value !== null && value !== undefined && value !== "";
const numeric = (value) => present(value) && Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const identity = (value) => text(String(value || "").replace(/\b(jr|sr|ii|iii|iv)\b/gi, ""));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const QUOTE_VALIDATION_VERSION = 1;

export function canonicalQuoteMarket(value) {
  const key = text(value);
  const groups = {
    h2h: ["h2h", "moneyline", "ml"],
    spreads: ["spreads", "spread", "pointspread"],
    totals: ["totals", "total", "totalpoints", "gametotal", "overunder"],
    player_pass_yds: ["playerpassyds", "playerpassingyards", "passingyards"],
    player_pass_tds: ["playerpasstds", "playerpassingtouchdowns", "passingtouchdowns"],
    player_pass_attempts: ["playerpassattempts", "playerpassingattempts", "passingattempts"],
    player_completions: ["playercompletions", "playerpassingcompletions", "completions", "passingcompletions"],
    player_rush_yds: ["playerrushyds", "playerrushingyards", "rushingyards"],
    player_rush_attempts: ["playerrushattempts", "playerrushingattempts", "rushingattempts"],
    player_reception_yds: ["playerreceptionyds", "playerreceivingyds", "playerreceivingyards", "receivingyards"],
    player_receptions: ["playerreceptions", "receptions"],
    player_rush_reception_yds: ["playerrushreceptionyds", "playerrushingreceivingyards", "rushreceivingyards", "rushingreceivingyards"],
    player_anytime_td: ["playeranytimetd", "anytimetd", "anytimetouchdown", "anytimetouchdowns", "anytimetdscorer"],
  };
  return Object.entries(groups).find(([, aliases]) => aliases.includes(key))?.[0] || null;
}

function decimalFromAmerican(value) {
  const price = numeric(value);
  return price !== null && Math.abs(price) >= 100
    ? price > 0 ? 1 + price / 100 : 1 + 100 / -price : null;
}

function periodKey(value) {
  const key = text(value || "full_game");
  return ["fullgame", "fulltime", "game", "match"].includes(key) ? "full_game" : key;
}

// The margins below identify gross contradictions, not normal book movement:
// 3x payout plus 20 probability points, with two agreeing peers for same-line
// outliers. No maximum price is imposed, including on legitimate longshots.
export function validateOddsEvents(events, { now = new Date() } = {}) {
  const offers = [];
  for (const event of events || []) for (const book of event.bookmakers || []) {
    for (const market of book.markets || []) for (const outcome of market.outcomes || []) {
      const source = outcome.quoteSource;
      const american = numeric(outcome.price);
      const decimal = decimalFromAmerican(american);
      const key = canonicalQuoteMarket(market.key);
      const period = periodKey(outcome.period || market.period || source?.period);
      const classification = source?.isAlternateLine === true || source?.isMainLine === false ? "alternate" : "main";
      const side = text(outcome.name);
      const offer = {
        event, book, market, outcome, source, key, period, classification, side, decimal,
        probability: decimal ? 1 / decimal : null,
        player: identity(outcome.playerName || outcome.description),
        line: numeric(outcome.point ?? outcome.line),
        reasons: [], evidence: [],
      };
      const reject = (reason) => { if (!offer.reasons.includes(reason)) offer.reasons.push(reason); };
      if (!decimal || !Number.isFinite(decimal) || decimal <= 1) reject("malformed_price");
      if (!key || period !== "full_game") reject("unsupported_market_metadata");
      if (present(market.period) && periodKey(market.period) !== period) reject("mismatched_period");
      if (classification === "alternate") reject("alternate_offer");
      if (source?.isLive === true) reject("live_offer");
      if (source?.isActive === false) reject("inactive_offer");
      if (source?.isStale === true) reject("stale_offer");
      const updatedAt = source?.timestamp || outcome.updatedAt || source?.fetchedAt || market.last_update || book.last_update;
      if (present(updatedAt)) {
        const age = now.getTime() - Date.parse(updatedAt);
        if (!Number.isFinite(age) || age > MAX_AGE_MS || age < -60000) reject("stale_offer");
      }
      if (source) {
        if (present(source.eventId) && String(source.eventId) !== String(event.id)) reject("mismatched_event");
        if (present(source.playerName) && identity(source.playerName) !== offer.player) reject("mismatched_player");
        if (present(source.playerId) && String(source.playerId) !== String(outcome.playerId)) reject("mismatched_player");
        if (present(source.market) && canonicalQuoteMarket(source.market) !== key) reject("mismatched_market");
        if (present(source.side) && ["over", "under"].includes(side) && text(source.side) !== side) reject("mismatched_side");
        if (present(source.line) && numeric(source.line) !== offer.line) reject("mismatched_line");
        if (present(source.period) && periodKey(source.period) !== period) reject("mismatched_period");
        const suppliedDecimal = numeric(source.decimalOdds);
        const suppliedAmerican = decimalFromAmerican(source.americanOdds);
        if ((present(source.decimalOdds) && (suppliedDecimal === null || suppliedDecimal <= 1)) ||
            (present(source.americanOdds) && suppliedAmerican === null)) reject("malformed_price");
        if (suppliedDecimal !== null && suppliedAmerican !== null &&
            Math.abs(suppliedDecimal - suppliedAmerican) > .0051) reject("inconsistent_price_conversion");
        if (decimal && suppliedAmerican !== null && Math.abs(decimal - suppliedAmerican) > .0051) reject("inconsistent_price_conversion");
        if (decimal && suppliedDecimal !== null && Math.abs(decimal - suppliedDecimal) > .0051) reject("inconsistent_price_conversion");
      }
      const twoSided = key === "totals" || key?.startsWith("player_") && key !== "player_anytime_td";
      offer.twoSided = twoSided;
      if (twoSided && (!["over", "under"].includes(side) || offer.line === null ||
          key.startsWith("player_") && !offer.player)) reject("unsupported_market_metadata");
      offers.push(offer);
    }
  }

  const group = (rows, keyOf) => {
    const result = new Map();
    for (const row of rows) {
      const key = keyOf(row);
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(row);
    }
    return result;
  };
  const scope = (offer) => [offer.event.id, offer.player, offer.key, offer.period, offer.classification].join("|");
  const bookKey = (offer) => text(offer.book.key || offer.book.title);
  const pairSourceKey = (offer) => [bookKey(offer), offer.key, offer.period, offer.classification].join("|");
  const pairGroups = group(offers.filter(o => o.twoSided), o => `${scope(o)}|${bookKey(o)}|${o.line}`);
  const sourceGroups = group([...pairGroups.values()], rows => pairSourceKey(rows[0]));
  const normallyPaired = new Map();
  for (const [key, groups] of sourceGroups) {
    const paired = groups.filter(rows => rows.some(o => o.side === "over") && rows.some(o => o.side === "under")).length;
    if (paired >= 2 && paired / groups.length >= .8) normallyPaired.set(key, {
      pairedGroups: paired, totalGroups: groups.length,
    });
  }
  const initiallyUsable = new Set(offers.filter(o => !o.reasons.length));
  for (const rows of pairGroups.values()) for (const offer of rows) {
    const opposite = rows.filter(o => o.side !== offer.side && ["over", "under"].includes(o.side));
    const usable = opposite.filter(o => initiallyUsable.has(o));
    if (!usable.length && (normallyPaired.has(pairSourceKey(offer)) ||
        offer.source?.requiresPair === true || opposite.length)) {
      offer.reasons.push("missing_market_pair");
      offer.evidence.push({ reason: "missing_market_pair",
        observedSourceCoverage: normallyPaired.get(pairSourceKey(offer)) || null,
        explicitPairContract: offer.source?.requiresPair === true,
        oppositeQuotes: opposite.map(other => ({ quoteId: other.source?.id || null, reasons: [...other.reasons] })),
      });
    }
    for (const other of usable) {
      if (present(offer.source?.eventUuid) && present(other.source?.eventUuid) &&
          offer.source.eventUuid !== other.source.eventUuid) {
        if (!offer.reasons.includes("mismatched_event")) offer.reasons.push("mismatched_event");
      }
      if (present(offer.source?.marketId) && present(other.source?.marketId) &&
          offer.source.marketId !== other.source.marketId) {
        if (!offer.reasons.includes("mismatched_market")) offer.reasons.push("mismatched_market");
      }
      if (present(offer.outcome.playerId) && present(other.outcome.playerId) &&
          String(offer.outcome.playerId) !== String(other.outcome.playerId)) {
        if (!offer.reasons.includes("mismatched_player")) offer.reasons.push("mismatched_player");
      }
      const sum = offer.probability + other.probability;
      // A >10-point underround or >25-point overround is not an ordinary
      // two-sided full-game prop pair (observed stored pairs: 5.6-6.6% vig).
      if (offer.probability !== null && (sum < .9 || sum > 1.25)) {
        if (!offer.reasons.includes("malformed_market_pair")) offer.reasons.push("malformed_market_pair");
        offer.evidence.push({ reason: "malformed_market_pair", pairedQuoteId: other.source?.id || null, impliedSum: sum });
      }
    }
  }
  const identifiedMarkets = group(offers.filter(o => o.twoSided && present(o.source?.marketId)),
    o => `${scope(o)}|${bookKey(o)}|${o.source.marketId}`);
  for (const rows of identifiedMarkets.values()) for (const offer of rows) {
    if (rows.some(other => other.side !== offer.side && other.line !== offer.line)) {
      if (!offer.reasons.includes("mismatched_line")) offer.reasons.push("mismatched_line");
    }
  }
  const comparable = offers.filter(o => o.decimal && !o.reasons.some(r =>
    ["malformed_price", "inconsistent_price_conversion", "mismatched_event", "mismatched_player",
      "mismatched_market", "mismatched_side", "mismatched_line", "mismatched_period",
      "unsupported_market_metadata", "stale_offer", "inactive_offer", "live_offer"].includes(r)));
  const usableReferences = new Set(comparable.filter(o => !o.reasons.length));
  const sameLine = group(comparable.filter(o => o.twoSided), o => `${scope(o)}|${o.side}|${o.line}`);
  for (const rows of sameLine.values()) for (const offer of rows) {
    const peersByBook = group(rows.filter(o => bookKey(o) !== bookKey(offer) && usableReferences.has(o)), bookKey);
    const peers = [...peersByBook.values()].map(rows => median(rows.map(o => o.probability)));
    if (peers.length < 2 || Math.max(...peers) - Math.min(...peers) > .05) continue;
    const consensus = median(peers);
    if (Math.abs(offer.probability - consensus) > .2 &&
        Math.max(offer.probability, consensus) / Math.min(offer.probability, consensus) >= 3) {
      offer.reasons.push("cross_book_outlier");
      offer.evidence.push({ reason: "cross_book_outlier", peerBooks: [...peersByBook.keys()], consensusImpliedProbability: consensus });
    }
  }
  const ladders = group(comparable.filter(o => o.twoSided), o => `${scope(o)}|${o.side}`);
  for (const rows of ladders.values()) for (const offer of rows) {
    const contradictions = rows.filter(other => other !== offer && usableReferences.has(other) &&
      !other.reasons.includes("cross_book_outlier") &&
      (offer.side === "over" ? offer.line < other.line : offer.line > other.line) &&
      offer.probability + .2 < other.probability && offer.decimal >= other.decimal * 3);
    if (contradictions.length) {
      offer.reasons.push("inconsistent_market_ladder");
      offer.evidence.push({ reason: "inconsistent_market_ladder", comparisons: contradictions.map(other => ({
        quoteId: other.source?.id || null, book: other.book.title || other.book.key,
        side: other.side, line: other.line, decimalOdds: other.decimal,
      })) });
    }
  }
  const validation = (offer) => ({
    version: QUOTE_VALIDATION_VERSION,
    status: offer.reasons.length ? "quarantined" : "validated",
    reasons: [...new Set(offer.reasons)], evidence: offer.evidence,
    sourceMetadata: Boolean(offer.source),
  });
  const byOutcome = new Map(offers.map(o => [o.outcome, validation(o)]));
  return {
    events: (events || []).map(event => ({ ...event, bookmakers: (event.bookmakers || []).map(book => ({
      ...book, markets: (book.markets || []).map(market => ({ ...market,
        outcomes: (market.outcomes || []).map(outcome => ({ ...outcome, quoteValidation: byOutcome.get(outcome) })),
      })),
    })) })),
    quarantined: offers.filter(o => o.reasons.length).map(o => ({
      eventId: o.event.id, playerName: o.outcome.playerName || o.outcome.description || null,
      playerId: o.outcome.playerId || null, market: o.key, side: o.side, line: o.line,
      price: o.outcome.price, decimalOdds: o.decimal, sportsbook: o.book.title || o.book.key,
      period: o.period, classification: o.classification, source: o.source || null,
      quoteValidation: validation(o),
    })),
  };
}
