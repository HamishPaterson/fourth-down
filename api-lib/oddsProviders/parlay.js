import process from "node:process";
import {
  COMPLETENESS,
  canonicalTeamIdentity,
  normalizeEventIdentity,
} from "./contracts.js";
import { assessCompleteness, isCompleteResponse } from "./completeness.js";
import {
  canSpendCredits,
  createCreditLedgerEntry,
  estimateProviderCredits,
  readCreditConfiguration,
} from "./creditLedger.js";
import { PLAYER_MATCH, resolvePlayerIdentity } from "./playerResolver.js";

export const PARLAY_API_BASE_URL = "https://parlay-api.com/v1";
export const PARLAY_SPORT_KEY = "americanfootball_nfl";
export const DEFAULT_PROPS_LIMIT = 10000;
export const MAX_PROPS_LIMIT = 10000;
export const DEFAULT_MAX_PROPS_PAGES = 1;
export const MAX_PROPS_PAGES = 10;
export const DEFAULT_CORE_MARKETS = Object.freeze(["h2h", "spreads", "totals"]);
export const PARLAY_MARKET_MAP = Object.freeze({
  player_anytime_td: "anytime_td",
  player_receiving_yards: "receiving_yards",
  player_rush_yds: "rushing_yards",
  player_rushing_and_receiving_yards: "rushing_receiving_yards",
  player_pass_yds: "passing_yards",
  player_receptions: "receptions",
  player_pass_tds: "passing_tds",
  player_pass_attempts: "pass_attempts",
  player_rush_attempts: "rush_attempts",
});

export function createParlayProvider({
  fetchImpl = fetch,
  repository = null,
  playerResolver = resolvePlayerIdentity,
  aliases = {},
  now = () => new Date(),
  timeoutMs = 15000,
  creditConfiguration = readCreditConfiguration(),
} = {}) {
  const marketMap = new Map(Object.entries(PARLAY_MARKET_MAP));
  for (const [rawKey, canonicalKey] of Object.entries(aliases)) {
    if (!rawKey || !canonicalKey) throw new Error("Provider market aliases require non-empty keys");
    marketMap.set(rawKey, canonicalKey);
  }

  return {
    id: "parlay",
    primary: true,
    capabilities: Object.freeze({
      listEvents: true,
      fetchCoreOdds: true,
      fetchPlayerProps: true,
      normalizeCoreOdds: true,
      normalizePlayerProps: true,
      reportCreditCost: true,
    }),
    listEvents: (options = {}) => listEvents({ ...options, fetchImpl, timeoutMs, repository, now }),
    fetchCoreOdds: (options = {}) => fetchCoreOdds({
      ...options, fetchImpl, timeoutMs, repository, creditConfiguration, now,
    }),
    fetchPlayerProps: (options = {}) => fetchPlayerProps({
      ...options, fetchImpl, timeoutMs, repository, creditConfiguration, now,
    }),
    normalizeCoreOdds: (result, options = {}) => normalizeCoreOdds(result, {
      ...options, marketMap, playerResolver, now,
    }),
    normalizePlayerProps: (result, options = {}) => normalizePlayerProps(result, {
      ...options, marketMap, playerResolver, now,
    }),
    normalizeEvents: (result, options = {}) => normalizeEvents(result, { ...options, now }),
    reportCreditCost: ({ endpoint, markets, regions }) =>
      estimateProviderCredits({ provider: "parlay", endpoint, markets, regions }),
  };
}

function requireCreditRepository(repository) {
  if (!repository ||
      typeof repository.readCreditLedger !== "function" ||
      typeof repository.appendCreditEntry !== "function") {
    throw new Error("Parlay paid requests require a credit ledger repository");
  }
  if (repository.paidRequestsRequireReservation && typeof repository.reserveCredits !== "function") {
    throw new Error("Persistent paid requests require a refresh-bound reservation repository");
  }
}

async function listEvents({ season, week, fetchImpl, timeoutMs, repository, now }) {
  requireSeasonWeek(season, week);
  try {
    const result = await requestJSON({
      url: `${PARLAY_API_BASE_URL}/sports/${PARLAY_SPORT_KEY}/events`,
      endpoint: "events",
      fetchImpl,
      timeoutMs,
    });
    await recordFreeRequest(repository, { endpoint: "events", season, week, success: true, now });
    const rows = listRows(result.body, ["events"]);
    return {
      provider: "parlay",
      season: Number(season),
      week: Number(week),
      fetchedAt: now().toISOString(),
      events: rows,
      completeness: { status: COMPLETENESS.UNKNOWN, reason: "event endpoint completeness headers are not part of this contract" },
      requestId: result.requestId,
    };
  } catch (error) {
    await recordFreeRequest(repository, { endpoint: "events", season, week, success: false, now });
    throw error;
  }
}

async function fetchCoreOdds({
  season,
  week,
  markets = [...DEFAULT_CORE_MARKETS],
  regions = ["us"],
  automatic = true,
  reason = "controlled core odds refresh",
  repository,
  fetchImpl,
  timeoutMs,
  creditConfiguration,
  now,
}) {
  requireSeasonWeek(season, week);
  requireCreditRepository(repository);
  if (!Array.isArray(markets) || !markets.length || !Array.isArray(regions) || !regions.length) {
    throw new Error("Core odds refresh requires at least one market and region");
  }
  const expectedCredits = estimateProviderCredits({ provider: "parlay", endpoint: "odds", markets, regions });
  const budget = await authorizePaidCall({
    repository, creditConfiguration, expectedCredits, automatic, now,
    endpoint: "odds", season, week, reason,
  });
  if (!budget.allowed) {
    await recordLedger(repository, {
      endpoint: "odds", season, week, reason, automatic, expectedCredits,
      actualCredits: 0, budgetCredits: 0, success: false, now,
    });
    return blockedResult("odds", season, week, expectedCredits, budget, now);
  }

  const url = new URL(`${PARLAY_API_BASE_URL}/sports/${PARLAY_SPORT_KEY}/odds`);
  url.searchParams.set("markets", [...new Set(markets)].join(","));
  url.searchParams.set("regions", [...new Set(regions)].join(","));
  try {
    const response = await requestJSON({
      url: url.toString(), endpoint: "odds", fetchImpl, timeoutMs,
      beforeRequest: repository.beforePaidRequest ? () => repository.beforePaidRequest(budget.reservationId) : undefined,
    });
    await recordLedger(repository, {
      endpoint: "odds", season, week, reason, automatic, expectedCredits,
      actualCredits: response.observedCredits,
      budgetCredits: Math.max(response.observedCredits ?? expectedCredits, expectedCredits),
      success: true, now, budget, httpStatus: response.httpStatus,
    });
    return {
      provider: "parlay",
      endpoint: "odds",
      season: Number(season),
      week: Number(week),
      fetchedAt: now().toISOString(),
      rows: listRows(response.body, ["odds", "events"]),
      completeness: assessCompleteness(response.headers),
      requestId: response.requestId,
      expectedCredits,
      actualCredits: response.observedCredits,
      budgetCredits: Math.max(response.observedCredits ?? expectedCredits, expectedCredits),
    };
  } catch (error) {
    await recordLedger(repository, {
      endpoint: "odds", season, week, reason, automatic, expectedCredits, success: false, now,
      budget, requestAttempted: error.requestAttempted !== false,
      actualCredits: error.observedCredits ?? null, httpStatus: error.httpStatus ?? null,
    });
    throw error;
  }
}

async function fetchPlayerProps({
  season,
  week,
  markets = Object.keys(PARLAY_MARKET_MAP),
  limit = DEFAULT_PROPS_LIMIT,
  maxPages = DEFAULT_MAX_PROPS_PAGES,
  automatic = true,
  reason = "controlled player props refresh",
  repository,
  fetchImpl,
  timeoutMs,
  creditConfiguration,
  now,
}) {
  requireSeasonWeek(season, week);
  requireCreditRepository(repository);
  validatePaginationOptions(limit, maxPages, markets);
  const rows = [];
  const seenOffsets = new Set();
  const pageMetadata = [];
  let offset = 0;
  let completeness = { status: COMPLETENESS.UNKNOWN };

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    if (seenOffsets.has(offset)) {
      return pagedResult({
        season, week, rows, completeness, pageMetadata, now,
        error: `Repeated pagination offset detected: ${offset}`,
      });
    }
    seenOffsets.add(offset);
    const expectedCredits = estimateProviderCredits({ provider: "parlay", endpoint: "props" });
    const budget = await authorizePaidCall({
      repository, creditConfiguration, expectedCredits, automatic, now,
      endpoint: "props", season, week, reason,
    });
    if (!budget.allowed) {
      await recordLedger(repository, {
        endpoint: "props", season, week, reason, automatic, expectedCredits,
        actualCredits: 0, budgetCredits: 0, success: false, now,
      });
      return pagedResult({
        season, week, rows, completeness, pageMetadata, now,
        error: `Credit budget blocked props page ${pageNumber}: ${budget.reason}`,
        budgetBlocked: true,
      });
    }

    const url = new URL(`${PARLAY_API_BASE_URL}/sports/${PARLAY_SPORT_KEY}/props`);
    url.searchParams.set("markets", markets.join(","));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    let response;
    try {
      response = await requestJSON({
        url: url.toString(), endpoint: "props", fetchImpl, timeoutMs,
        beforeRequest: repository.beforePaidRequest ? () => repository.beforePaidRequest(budget.reservationId) : undefined,
      });
      await recordLedger(repository, {
        endpoint: "props", season, week, reason, automatic, expectedCredits,
        actualCredits: response.observedCredits,
        budgetCredits: Math.max(response.observedCredits ?? expectedCredits, expectedCredits),
        success: true, now, budget, httpStatus: response.httpStatus,
      });
    } catch (error) {
      await recordLedger(repository, {
        endpoint: "props", season, week, reason, automatic, expectedCredits, success: false, now,
        budget, requestAttempted: error.requestAttempted !== false,
        actualCredits: error.observedCredits ?? null, httpStatus: error.httpStatus ?? null,
      });
      pageMetadata.push({
        pageNumber,
        offset,
        rowCount: 0,
        error: error instanceof Error ? error.message : "Parlay request failed",
        expectedCredits,
        actualCredits: null,
      });
      return pagedResult({
        season, week, rows, completeness, pageMetadata, now,
        error: error instanceof Error ? error.message : "Parlay request failed",
      });
    }

    const pageRows = listRows(response.body, ["props"]);
    rows.push(...pageRows);
    completeness = assessCompleteness(response.headers);
    pageMetadata.push({
      pageNumber,
      offset,
      rowCount: pageRows.length,
      requestId: response.requestId,
      completeness,
      expectedCredits,
      actualCredits: response.observedCredits,
      budgetCredits: Math.max(response.observedCredits ?? expectedCredits, expectedCredits),
    });
    if (completeness.status !== COMPLETENESS.MORE_PAGES_AVAILABLE) {
      return pagedResult({ season, week, rows, completeness, pageMetadata, now });
    }
    const nextOffset = parseNextOffset(response.headers);
    if (nextOffset === null || nextOffset <= offset || seenOffsets.has(nextOffset)) {
      return pagedResult({
        season, week, rows, completeness, pageMetadata, now,
        error: "Malformed or repeated x-next-offset pagination cursor",
      });
    }
    if (pageNumber === maxPages) {
      return pagedResult({
        season, week, rows, completeness, pageMetadata, now,
        error: `Maximum props page count reached (${maxPages})`,
      });
    }
    offset = nextOffset;
  }

  return pagedResult({ season, week, rows, completeness, pageMetadata, now });
}

function normalizeCoreOdds(result, { events = [], fetchedAt, now, playerResolver }) {
  const stamp = fetchedAt || result?.fetchedAt || now().toISOString();
  const allRows = flattenCoreRows(result?.rows || result?.events || []);
  const eventIndex = buildEventIndex(events, stamp);
  const quotes = [];
  let unmappedEventRows = 0;
  for (const row of allRows) {
    const providerEventId = String(row.canonical_event_id ?? row.id ?? row.event_id ?? "");
    let indexed = eventIndex.get(providerEventId);
    if (!indexed && hasExplicitSeasonWeek(row)) {
      indexed = normalizeEvent(row, { season: row.season, week: row.week, fetchedAt: stamp });
      eventIndex.set(indexed.providerEventId, indexed);
    }
    if (!indexed) {
      unmappedEventRows += 1;
      continue;
    }
    const rawMarket = rawMarketKey(row);
    const market = normalizeCoreMarket(rawMarket);
    if (!market) continue;
    for (const outcome of coreOutcomes(row)) {
      const quote = normalizeQuote({
        row,
        event: indexed,
        market,
        rawMarket,
        selection: outcome.selection,
        side: outcome.side,
        line: outcome.line,
        price: outcome.price,
        priceField: outcome.priceField,
        fetchedAt: stamp,
        playerResolver,
        eventTeams: [indexed.homeTeam, indexed.awayTeam],
      });
      if (quote) quotes.push(quote);
    }
  }
  return {
    events: [...eventIndex.values()],
    quotes,
    diagnostics: { unmappedEventRows },
  };
}

function normalizeEvents(result, { fetchedAt, now }) {
  const stamp = fetchedAt || result?.fetchedAt || now().toISOString();
  const events = [];
  const unmappedEvents = [];
  for (const row of result?.events || []) {
    if (!hasExplicitSeasonWeek(row)) {
      unmappedEvents.push(String(row.canonical_event_id ?? row.id ?? row.event_id ?? "unknown"));
      continue;
    }
    events.push(normalizeEvent(row, { season: row.season, week: row.week, fetchedAt: stamp }));
  }
  return {
    events: [...new Map(events.map((event) => [event.providerEventId, event])).values()],
    quotes: [],
    diagnostics: { unmappedEvents },
  };
}

function normalizePlayerProps(result, { events = [], players = [], fetchedAt, now, playerResolver, marketMap }) {
  const stamp = fetchedAt || result?.fetchedAt || now().toISOString();
  const eventIndex = buildEventIndex(events, stamp);
  const quotes = [];
  const unmappedMarkets = new Map();
  const unmappedEvents = new Map();
  const rejectedRows = new Map();
  const rejectRow = (reason) => rejectedRows.set(reason, (rejectedRows.get(reason) || 0) + 1);
  for (const row of result?.rows || []) {
    const rawMarket = rawMarketKey(row);
    const market = marketMap.get(rawMarket);
    if (!market) {
      unmappedMarkets.set(rawMarket, (unmappedMarkets.get(rawMarket) || 0) + 1);
      continue;
    }
    const playerName = row.player || row.player_name || null;
    if (!playerName) {
      rejectRow("missing_player_name");
      continue;
    }
    if (isUnsupportedDfsPrice(row)) {
      rejectRow("unsupported_dfs_pricing");
      continue;
    }
    const isAnytime = market === "anytime_td";
    if (isAnytime && Number(row.line) !== 0.5) {
      rejectRow("unsupported_anytime_td_line");
      continue;
    }
    if (!row.bookmaker && !row.source) {
      rejectRow("missing_bookmaker");
      continue;
    }
    if (row.line === null || row.line === undefined || !Number.isFinite(Number(row.line))) {
      rejectRow("invalid_or_missing_line");
      continue;
    }
    const providerEventId = String(row.canonical_event_id ?? row.id ?? row.event_id ?? "");
    let indexed = eventIndex.get(providerEventId);
    if (!indexed && hasExplicitSeasonWeek(row)) {
      indexed = normalizeEvent(row, { season: row.season, week: row.week, fetchedAt: stamp });
      eventIndex.set(indexed.providerEventId, indexed);
    }
    if (!indexed) {
      const key = providerEventId || "unknown";
      unmappedEvents.set(key, (unmappedEvents.get(key) || 0) + 1);
      continue;
    }
    const resolution = playerName
      ? playerResolver({
        providerPlayerId: row.player_reference,
        providerIdType: row.player_reference_type,
        playerName,
        eventTeams: [indexed.homeTeam, indexed.awayTeam],
        playerTeam: row.player_team || row.team || null,
        players,
      })
      : { status: PLAYER_MATCH.UNRESOLVED, playerId: null, playerName: null, team: null };
    const sides = [
      { side: isAnytime ? "yes" : "over", priceField: "over_price", price: row.over_price },
      { side: isAnytime ? "no" : "under", priceField: "under_price", price: row.under_price },
    ];
    if (sides.some(({ price }) => price !== null && price !== undefined && !normalizeAmericanPrice(price))) {
      rejectRow("invalid_supplied_price");
    }
    for (const side of sides) {
      const quote = normalizeQuote({
        row,
        event: indexed,
        market,
        rawMarket,
        selection: isAnytime ? (side.side === "yes" ? "Yes" : "No") : side.side,
        side: side.side,
        line: row.line,
        price: side.price,
        priceField: side.priceField,
        fetchedAt: stamp,
        playerResolver,
        eventTeams: [indexed.homeTeam, indexed.awayTeam],
        resolution,
      });
      if (quote) quotes.push(quote);
      else rejectRow(`invalid_or_missing_${side.priceField}`);
    }
  }
  const normalizedEvents = new Map();
  for (const quote of quotes) {
    if (!normalizedEvents.has(quote.providerEventId)) {
      normalizedEvents.set(quote.providerEventId, eventIndex.get(quote.providerEventId));
    }
  }
  return {
    events: [...normalizedEvents.values()],
    quotes,
    diagnostics: {
      unmappedMarkets: [...unmappedMarkets].map(([rawProviderMarket, rowCount]) => ({
        rawProviderMarket,
        rowCount,
      })),
      unmappedEvents: [...unmappedEvents].map(([providerEventId, rowCount]) => ({
        providerEventId,
        rowCount,
      })),
      rejectedRows: [...rejectedRows].map(([reason, rowCount]) => ({ reason, rowCount })),
    },
  };
}

function normalizeQuote({
  row,
  event,
  market,
  rawMarket,
  selection,
  side,
  line,
  price,
  priceField,
  fetchedAt,
  playerResolver,
  eventTeams,
  resolution = null,
}) {
  const parsed = normalizeAmericanPrice(price);
  if (!parsed) return null;
  const playerName = row.player || row.player_name || resolution?.playerName || null;
  const bookmaker = row.bookmaker || row.source;
  if (!bookmaker || !selection) return null;
  if (market !== "h2h" && (line === null || line === undefined || !Number.isFinite(Number(line)))) return null;
  if (line !== null && line !== undefined && !Number.isFinite(Number(line))) return null;
  const player = resolution || (playerName
    ? playerResolver({
      playerName,
      eventTeams,
      playerTeam: row.player_team || row.team || null,
      players: [],
    })
    : null);
  const ageSeconds = finiteNonNegative(row.age_seconds);
  const providerTimestamp = row.last_update || row.updated_at || null;
  const timestampAge = providerTimestamp
    ? (Date.parse(fetchedAt) - Date.parse(providerTimestamp)) / 1000
    : null;
  const age = ageSeconds ?? (Number.isFinite(timestampAge) ? Math.max(0, timestampAge) : null);
  const identityMatched = !playerName || player?.status === PLAYER_MATCH.MATCHED_STABLE_ID ||
    player?.status === PLAYER_MATCH.MATCHED_EXACT_NAME_EVENT ||
    player?.status === PLAYER_MATCH.MATCHED_NORMALIZED_NAME_EVENT;
  return {
    provider: "parlay",
    providerEventId: event.providerEventId,
    season: event.season,
    week: event.week,
    matchup: event.matchup,
    canonicalMatchupIdentity: event.canonicalMatchupIdentity,
    bookmaker: String(bookmaker),
    market,
    rawProviderMarket: rawMarket,
    playerId: player?.status?.startsWith("MATCHED_") ? player.playerId : null,
    playerName,
    providerPlayerReference: row.player_reference ?? null,
    playerIdentityStatus: player?.status || null,
    playerIdentityReason: player?.reason || null,
    eligibleForBetting: identityMatched,
    team: player?.status?.startsWith("MATCHED_")
      ? canonicalTeamIdentity(player.team)
      : eventTeams.map((team) => canonicalTeamIdentity(team))
        .find((team) => team && team === canonicalTeamIdentity(selection)) || null,
    selection: String(selection ?? ""),
    side,
    line: line === null || line === undefined ? null : Number(line),
    americanOdds: parsed.americanOdds,
    decimalOdds: parsed.decimalOdds,
    impliedProbability: parsed.impliedProbability,
    providerTimestamp,
    fetchedAt,
    ageSeconds: age,
    freshnessStatus: age === null ? "unknown" : age <= 5400 ? "fresh" : "stale",
    rawPrice: {
      field: priceField,
      value: price,
      oddsType: row.odds_type ?? null,
      projectionType: row.projection_type ?? null,
      dfsNormalized: row.dfs_normalized === true,
    },
  };
}

export function normalizeAmericanPrice(value) {
  if (value === null || value === undefined || value === "") return null;
  const americanOdds = Number(value);
  if (!Number.isFinite(americanOdds) || !Number.isInteger(americanOdds) ||
      (americanOdds > -100 && americanOdds < 100) || americanOdds === 0) return null;
  const decimalOdds = americanOdds > 0
    ? 1 + americanOdds / 100
    : 1 + 100 / Math.abs(americanOdds);
  if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;
  const impliedProbability = 1 / decimalOdds;
  if (!Number.isFinite(impliedProbability) || impliedProbability <= 0 || impliedProbability >= 1) return null;
  return { americanOdds, decimalOdds, impliedProbability };
}

function normalizeEvent(row, { season, week, fetchedAt }) {
  if (!row || typeof row !== "object") throw new Error("Parlay event row is invalid");
  const providerEventId = row.canonical_event_id ?? row.id ?? row.event_id ?? row.providerEventId;
  const kickoff = row.commence_time ?? row.kickoff ?? row.start_time;
  const homeTeam = row.home_team ?? row.homeTeam ?? row.home;
  const awayTeam = row.away_team ?? row.awayTeam ?? row.away;
  if (!providerEventId) throw new Error("Parlay event is missing canonical_event_id");
  const matchup = {
    season: Number(row.season ?? season),
    week: Number(row.week ?? week),
    kickoff: new Date(kickoff).toISOString(),
    homeTeam: String(homeTeam || ""),
    awayTeam: String(awayTeam || ""),
  };
  const canonicalMatchupIdentity = normalizeEventIdentity(matchup);
  return {
    provider: "parlay",
    providerEventId: String(providerEventId),
    canonicalMatchupIdentity,
    matchup: {
      identity: canonicalMatchupIdentity,
      season: matchup.season,
      week: matchup.week,
      kickoff: matchup.kickoff,
      homeTeam: matchup.homeTeam,
      awayTeam: matchup.awayTeam,
    },
    ...matchup,
    fetchedAt,
    providerTimestamp: row.last_update ?? row.updated_at ?? null,
  };
}

function buildEventIndex(events, fetchedAt) {
  const index = new Map();
  for (const event of events || []) {
    if (!hasExplicitSeasonWeek(event)) continue;
    const normalized = normalizeEvent(event, {
      season: Number(event.season),
      week: Number(event.week),
      fetchedAt,
    });
    index.set(normalized.providerEventId, normalized);
  }
  return index;
}

function hasExplicitSeasonWeek(row) {
  if (!row || row.season === null || row.season === undefined || row.season === "" ||
      row.week === null || row.week === undefined || row.week === "") return false;
  const season = Number(row.season);
  const week = Number(row.week);
  return Number.isInteger(season) && season >= 1900 &&
    Number.isInteger(week) && week >= 1 && week <= 18;
}

function flattenCoreRows(rows) {
  const flattened = [];
  for (const row of rows || []) {
    if (Array.isArray(row?.bookmakers)) {
      for (const bookmaker of row.bookmakers) {
        for (const market of bookmaker.markets || []) {
          flattened.push({
            ...row,
            bookmaker: bookmaker.key || bookmaker.title,
            market_key: market.key || market.market_key,
            ...market,
            outcomes: market.outcomes,
          });
        }
      }
    } else {
      flattened.push(row);
    }
  }
  return flattened;
}

function coreOutcomes(row) {
  if (Array.isArray(row.outcomes)) {
    return row.outcomes.map((outcome) => ({
      selection: outcome.name ?? outcome.selection ?? "",
      side: normalizeCoreSide(row.market_key || row.market, outcome.name),
      line: outcome.point ?? outcome.line ?? row.line ?? null,
      price: outcome.price ?? outcome.american_odds,
      priceField: outcome.price !== undefined ? "outcomes[].price" : "outcomes[].american_odds",
    }));
  }
  const market = normalizeCoreMarket(rawMarketKey(row));
  const line = row.line ?? row.point ?? null;
  const sides = [
    { side: market === "totals" ? "over" : "selection", field: "over_price", selection: row.over_selection || row.over_team || "Over" },
    { side: market === "totals" ? "under" : "selection", field: "under_price", selection: row.under_selection || row.under_team || "Under" },
  ];
  if (market === "h2h" || market === "spreads") {
    sides[0].selection = row.away_team || row.away || sides[0].selection;
    sides[1].selection = row.home_team || row.home || sides[1].selection;
  }
  return sides.map(({ side, field, selection }) => ({
    side, selection, line, price: row[field], priceField: field,
  }));
}

function normalizeCoreMarket(rawMarket) {
  const key = String(rawMarket || "").toLowerCase();
  if (["h2h", "moneyline", "money_line"].includes(key)) return "h2h";
  if (["spreads", "spread", "point_spread"].includes(key)) return "spreads";
  if (["totals", "total", "total_points"].includes(key)) return "totals";
  return null;
}

function normalizeCoreSide(market, selection) {
  if (normalizeCoreMarket(market) === "totals") {
    return String(selection || "").toLowerCase() === "under" ? "under" : "over";
  }
  return "selection";
}

function rawMarketKey(row) {
  return String(row?.market_key ?? row?.market ?? row?.key ?? "");
}

function isUnsupportedDfsPrice(row) {
  return row?.dfs_normalized === true ||
    (row?.selection_by_side && typeof row.selection_by_side === "object" &&
      row.over_price == null && row.under_price == null);
}

function listRows(body, keys) {
  if (Array.isArray(body)) return body;
  for (const key of keys) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
}

function parseNextOffset(headers) {
  const value = getHeader(headers, "x-next-offset");
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
}

function getHeader(headers, name) {
  if (headers && typeof headers.get === "function") return headers.get(name);
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1] ?? null;
}

function parseObservedCredits(headers) {
  for (const name of ["x-request-credit-cost", "x-credit-cost", "x-credits-charged"]) {
    const value = getHeader(headers, name);
    if (value === null || value === undefined || String(value).trim() === "") continue;
    const amount = Number(value);
    if (Number.isFinite(amount) && amount >= 0) return amount;
  }
  return null;
}

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function validatePaginationOptions(limit, maxPages, markets) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROPS_LIMIT) {
    throw new Error(`Parlay props limit must be between 1 and ${MAX_PROPS_LIMIT}`);
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PROPS_PAGES) {
    throw new Error(`Parlay props maximum pages must be between 1 and ${MAX_PROPS_PAGES}`);
  }
  if (!Array.isArray(markets) || !markets.length || markets.some((market) => typeof market !== "string")) {
    throw new Error("Parlay props refresh requires a non-empty market list");
  }
}

function pagedResult({ season, week, rows, completeness, pageMetadata, now, error = null, budgetBlocked = false }) {
  return {
    provider: "parlay",
    endpoint: "props",
    season: Number(season),
    week: Number(week),
    fetchedAt: now().toISOString(),
    rows,
    completeness,
    pageCount: pageMetadata.length,
    pages: pageMetadata,
    error,
    budgetBlocked,
    complete: isCompleteResponse(completeness),
  };
}

function blockedResult(endpoint, season, week, expectedCredits, budget, now) {
  return {
    provider: "parlay",
    endpoint,
    season: Number(season),
    week: Number(week),
    fetchedAt: now().toISOString(),
    rows: [],
    completeness: { status: COMPLETENESS.UNKNOWN },
    expectedCredits,
    actualCredits: 0,
    budgetBlocked: true,
    error: `Credit budget blocked ${endpoint} request: ${budget.reason}`,
  };
}

async function authorizePaidCall({
  repository, creditConfiguration, expectedCredits, automatic, now, endpoint, season, week, reason,
}) {
  if (typeof repository.reserveCredits === "function") {
    return repository.reserveCredits({
      configuration: creditConfiguration, expectedCredits, automatic, endpoint, season, week, reason,
    });
  }
  const current = now();
  const ledger = repository
    ? await repository.readCreditLedger({ provider: "parlay", since: current.toISOString().slice(0, 7) })
    : [];
  return canSpendCredits({
    ledger,
    expectedCredits,
    automatic,
    configuration: creditConfiguration,
    now: current,
  });
}

async function recordLedger(repository, {
  endpoint,
  season,
  week,
  reason,
  automatic,
  expectedCredits,
  actualCredits = null,
  budgetCredits = null,
  success,
  now,
  budget,
  requestAttempted = true,
  httpStatus = null,
}) {
  if (!repository) throw new Error("Parlay paid requests require a credit ledger repository");
  if (typeof repository.reconcileReservation === "function") {
    if (!budget?.allowed) return;
    return repository.reconcileReservation({
      reservationId: budget.reservationId,
      observedCredits: actualCredits,
      requestAttempted,
      success,
      httpStatus,
      resultStatus: success ? "success" : !requestAttempted ? "released_pre_request" :
        actualCredits !== null ? "failed_charge_known" : "failed_charge_unknown",
    });
  }
  const timestamp = now().toISOString();
  const ledger = await repository.readCreditLedger({
    provider: "parlay",
    since: timestamp.slice(0, 7),
  });
  const reservedCredits = budgetCredits ?? expectedCredits;
  const monthlyRunningTotal = ledger.reduce((sum, entry) =>
    sum + Number(entry.budgetCredits ?? entry.actualCredits ?? 0), 0) + reservedCredits;
  await repository.appendCreditEntry(createCreditLedgerEntry({
    timestamp, endpoint, season, week, reason, automatic, expectedCredits, actualCredits,
    budgetCredits: reservedCredits, success, monthlyRunningTotal,
  }));
}

async function recordFreeRequest(repository, { endpoint, season, week, success, now }) {
  if (!repository) return;
  const timestamp = now().toISOString();
  const ledger = await repository.readCreditLedger({
    provider: "parlay",
    since: timestamp.slice(0, 7),
  });
  await repository.appendCreditEntry(createCreditLedgerEntry({
    timestamp,
    endpoint,
    season,
    week,
    reason: "SCHEDULED_REFRESH",
    automatic: true,
    expectedCredits: 0,
    actualCredits: 0,
    success,
    monthlyRunningTotal: ledger.reduce((sum, entry) =>
      sum + Number(entry.budgetCredits ?? entry.actualCredits ?? 0), 0),
  }));
}

async function requestJSON({ url, endpoint, fetchImpl, timeoutMs, beforeRequest }) {
  if (typeof window !== "undefined") {
    throw Object.assign(new Error("Parlay provider adapters are server-only"), { requestAttempted: false });
  }
  const apiKey = process.env.PARLAY_API_KEY;
  if (!apiKey) throw Object.assign(new Error("PARLAY_API_KEY is not configured"), { requestAttempted: false });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let attempted = false;
  try {
    await beforeRequest?.();
    if (controller.signal.aborted) throw new Error("Request timed out before dispatch");
    attempted = true;
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", "X-API-Key": apiKey },
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Parlay ${endpoint} returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Error(`Parlay ${endpoint} request failed (HTTP ${response.status})`);
    }
    return {
      body,
      headers: response.headers,
      requestId: getHeader(response.headers, "x-request-id"),
      observedCredits: parseObservedCredits(response.headers),
      httpStatus: response.status,
    };
  } catch (error) {
    const message = safeError(error, apiKey);
    const safeMessage = message.startsWith(`Parlay ${endpoint} `)
      ? message
      : `Parlay ${endpoint} request failed: ${message}`;
    if (error instanceof Error) {
      // Fetch errors can contain request headers; only preserve a sanitized cause.
      throw Object.assign(new Error(safeMessage, { cause: new Error(message) }), {
        requestAttempted: attempted,
        observedCredits: response ? parseObservedCredits(response.headers) : null,
        httpStatus: response?.status ?? null,
      });
    }
    // A primitive rejection may contain credentials, so do not attach it as a cause.
    throw Object.assign(new Error(safeMessage), { requestAttempted: attempted });
  } finally {
    clearTimeout(timer);
  }
}

function safeError(error, apiKey) {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = apiKey ? message.split(apiKey).join("[redacted]") : message;
  return redacted.replace(/(x-api-key|authorization|parlay_api_key)\s*[:=]\s*[^,;\r\n]+/gi, "$1=[redacted]").slice(0, 300);
}

function requireSeasonWeek(season, week) {
  if (!Number.isInteger(Number(season)) || !Number.isInteger(Number(week)) ||
      Number(season) < 1900 || Number(week) < 1 || Number(week) > 18) {
    throw new Error("Odds refresh requires a valid season and regular-season week");
  }
}
