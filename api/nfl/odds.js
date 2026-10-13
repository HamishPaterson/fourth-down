const SHARP_API_URL =
  "https://api.sharpapi.io/api/v1/odds";

const CORE_MARKETS = ["moneyline", "point_spread", "total_points"];
const OPTIONAL_PLAYER_MARKETS = [
  "player_anytime_td", "anytime_touchdown", "player_touchdowns",
  "player_pass_yds", "passing_yards", "player_passing_yards",
  "player_pass_tds", "passing_touchdowns", "player_passing_touchdowns",
  "player_pass_attempts", "passing_attempts", "player_passing_attempts",
  "player_completions", "passing_completions", "player_passing_completions",
  "player_rush_yds", "rushing_yards", "player_rushing_yards",
  "player_rush_attempts", "rushing_attempts", "player_rushing_attempts",
  "player_receptions", "receptions",
  "player_reception_yds", "player_receiving_yds", "receiving_yards",
  "player_rush_reception_yds", "rushing_receiving_yards",
];

const PAGE_SIZE = 500;
const MAX_CORE_PAGES_PER_MARKET = 4;
const MAX_PAGES_PER_MARKET = 10;
const ODDS_CACHE_MS = 5 * 60 * 1000;
const REFRESH_REUSE_MS = 60 * 1000;

// Shared Vercel CDN lifetimes. Core game odds change slowly before kickoff;
// player props are only needed for Best Bets so they use a shorter lifetime.
const CORE_CDN_SECONDS = 86400;
const CORE_STALE_SECONDS = 86400;
const PROPS_CDN_SECONDS = 21600;
const PROPS_STALE_SECONDS = 86400;

const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 3600;

// Per-instance caches only hold genuine, complete provider responses.
const memoryCache = { core: null, props: null, "core+props": null };
const inFlightRequests = new Map();
let rateLimitedUntil = 0;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const params = new URL(req.url || "/", "http://localhost").searchParams;
  // The Weekly Best Multi refresh needs live core and player-prop odds, so it
  // bypasses every shared cache. All other callers use the cached paths.
  const refresh = params.has("weeklyMultiRefresh");
  const scope = refresh ? "core+props" : params.get("props") === "1" ? "props" : "core";

  const cached = memoryCache[scope];
  const cacheMs = refresh ? REFRESH_REUSE_MS : ODDS_CACHE_MS;
  if (cached && Date.now() - cached.savedAt < cacheMs) {
    setCacheHeaders(res, scope, !refresh);
    return res.status(200).json({ ...cached.payload, cacheStatus: "memory-hit" });
  }

  const apiKey = process.env.SHARP_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "SHARP_API_KEY is not configured",
    });
  }

  const result = await shareInFlight(scope, () => loadOdds(scope, apiKey));
  setCacheHeaders(res, scope, result.cacheable && !refresh);
  return res.status(200).json(result.payload);
}

function shareInFlight(key, load) {
  if (inFlightRequests.has(key)) return inFlightRequests.get(key);
  const request = load().finally(() => inFlightRequests.delete(key));
  inFlightRequests.set(key, request);
  return request;
}

function setCacheHeaders(res, scope, cacheable) {
  if (!cacheable) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vercel-CDN-Cache-Control", "no-store");
    return;
  }
  const fresh = scope === "props" ? PROPS_CDN_SECONDS : CORE_CDN_SECONDS;
  const stale = scope === "props" ? PROPS_STALE_SECONDS : CORE_STALE_SECONDS;
  // Browsers revalidate against the CDN; only Vercel's shared cache holds the response.
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  res.setHeader(
    "Vercel-CDN-Cache-Control",
    `s-maxage=${fresh}, stale-while-revalidate=${stale}, stale-if-error=${stale}`
  );
}

async function loadOdds(scope, apiKey) {
  const state = {
    rows: [],
    marketRecordCounts: {},
    completedMarkets: new Set(),
    coreComplete: false,
    propsFailed: false,
    rateLimited: false,
    retryAfterSeconds: null,
    failureStatus: null,
  };

  const cooldownSeconds = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
  if (cooldownSeconds > 0) {
    state.rateLimited = true;
    state.retryAfterSeconds = cooldownSeconds;
  } else {
    if (scope !== "props") await fetchCoreOdds(apiKey, state);
    // Player props are optional: they never run after a core failure or 429.
    if (scope !== "core" && !state.rateLimited && (scope === "props" || state.coreComplete)) {
      await fetchPlayerProps(apiKey, state);
    }
  }

  if (state.rateLimited) {
    const seconds = state.retryAfterSeconds || DEFAULT_RETRY_AFTER_SECONDS;
    rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + seconds * 1000);
  }

  const eligibleRows = state.rows.filter(
    (row) => isEligibleOddsRow(row) && rowMatchesScope(row, scope)
  );
  const events = buildEvents(eligibleRows);
  const partialMarkets = [
    ...(scope === "props" ? [] : CORE_MARKETS),
    ...(scope === "core" ? [] : ["player_props"]),
  ].filter((market) =>
    market === "player_props"
      ? state.propsFailed || (state.rateLimited && scope !== "core" && !state.completedMarkets.has("player_props"))
      : !state.completedMarkets.has(market)
  );

  const success =
    events.length > 0 &&
    (scope === "props" ? !state.rateLimited && !state.propsFailed : state.coreComplete);

  const payload = {
    count: events.length,
    events,
    provider: "SharpAPI",
    scope,
    rawRecordCount: state.rows.length,
    eligibleRecordCount: eligibleRows.length,
    rejectedPeriodRecordCount: state.rows.length - eligibleRows.length,
    marketRecordCounts: state.marketRecordCounts,
    rawMarketTypes: [...new Set(state.rows.map((row) => String(row?.market_type || row?.market || row?.market_key || "").trim()).filter(Boolean))].sort(),
    playerPropRecordCount: eligibleRows.filter(isPlayerRow).length,
    playerPropSamples: eligibleRows
      .filter(isPlayerRow)
      .slice(0, 25)
      .map((row) => ({
        event_id: row.event_id,
        market_type: row.market_type || row.market || row.market_key,
        player_name: getPlayerName(row),
        selection: row.selection,
        selection_type: row.selection_type,
        line: getMarketPoint(row),
        odds_american: getAmericanPrice(row),
      })),
    rateLimited: state.rateLimited,
    partialMarkets,
    refreshedAt: new Date().toISOString(),
    cacheStatus: "fresh",
  };

  if (success) {
    memoryCache[scope] = { payload, savedAt: Date.now() };
    return { payload, cacheable: true };
  }

  const reason = state.rateLimited
    ? `SharpAPI rate limit reached. Retry after ${state.retryAfterSeconds || DEFAULT_RETRY_AFTER_SECONDS} seconds.`
    : state.failureStatus
      ? `SharpAPI request failed (HTTP ${state.failureStatus}).`
      : "SharpAPI returned no odds for the requested markets.";
  if (state.rateLimited) payload.retryAfterSeconds = state.retryAfterSeconds || DEFAULT_RETRY_AFTER_SECONDS;

  // A genuine earlier complete response is preferred over partial or empty data.
  const stale = memoryCache[scope]?.payload;
  if (stale?.events?.length) {
    return {
      payload: {
        ...stale,
        cacheStatus: "stale-fallback",
        rateLimited: state.rateLimited,
        partialMarkets,
        warning: `Live odds refresh failed. Showing cached odds. ${reason}`,
      },
      cacheable: false,
    };
  }

  if (events.length > 0) {
    return {
      payload: { ...payload, cacheStatus: "partial", warning: `Some odds markets are missing. ${reason}` },
      cacheable: false,
    };
  }

  return {
    payload: {
      count: 0,
      events: [],
      provider: "SharpAPI",
      scope,
      rateLimited: state.rateLimited,
      partialMarkets,
      retryAfterSeconds: payload.retryAfterSeconds,
      cacheStatus: "unavailable",
      warning: `Betting odds are temporarily unavailable. ${reason}`,
      refreshedAt: new Date().toISOString(),
    },
    cacheable: false,
  };
}

/*
 * Core game odds: one request per full-game market, fetched sequentially.
 * Do not use Promise.all here because the pre-game API may throttle
 * simultaneous requests. The first failure stops further requests.
 */
async function fetchCoreOdds(apiKey, state) {
  for (const market of CORE_MARKETS) {
    try {
      const marketRows = await fetchMarket(apiKey, market, MAX_CORE_PAGES_PER_MARKET);
      state.marketRecordCounts[market] = marketRows.length;
      state.rows.push(...marketRows);
      state.completedMarkets.add(market);
    } catch (error) {
      recordFailure(state, market, error);
      return;
    }
  }
  state.coreComplete = true;
}

/*
 * Optional player props. Failures here never discard core odds, and the
 * first HTTP 429 stops every remaining request.
 */
async function fetchPlayerProps(apiKey, state) {
  try {
    const discoveredRows = await fetchAllNflMarkets(apiKey);
    state.marketRecordCounts.__all_markets__ = discoveredRows.length;
    state.rows.push(...discoveredRows);
  } catch (error) {
    recordFailure(state, "__all_markets__", error);
    state.propsFailed = true;
    return;
  }

  for (const market of OPTIONAL_PLAYER_MARKETS) {
    try {
      const marketRows = await fetchMarket(apiKey, market, MAX_PAGES_PER_MARKET);
      state.marketRecordCounts[market] = marketRows.length;
      state.rows.push(...marketRows);
    } catch (error) {
      state.marketRecordCounts[market] = 0;
      if (error?.status === 429) {
        recordFailure(state, market, error);
        state.propsFailed = true;
        return;
      }
      console.warn(`Optional market ${market} unavailable`, error?.message || error);
    }
  }
  state.completedMarkets.add("player_props");
}

function recordFailure(state, market, error) {
  // Pages already received before the failure are genuine provider rows.
  if (Array.isArray(error?.records) && error.records.length) {
    state.marketRecordCounts[market] = error.records.length;
    state.rows.push(...error.records);
  }
  if (error?.status === 429) {
    state.rateLimited = true;
    state.retryAfterSeconds = error.retryAfterSeconds || DEFAULT_RETRY_AFTER_SECONDS;
  } else {
    state.failureStatus = error?.status || 500;
  }
  console.error(`SharpAPI odds request failed for ${market}:`, error?.message || error);
}

function isPlayerRow(row) {
  return Boolean(getMarketKey(row?.market_type || row?.market || row?.market_key)?.startsWith("player_"));
}

function rowMatchesScope(row, scope) {
  if (scope === "core+props") return true;
  return scope === "props" ? isPlayerRow(row) : !isPlayerRow(row);
}

function parseRetryAfter(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_RETRY_AFTER_SECONDS;
  const seconds = Number(value);
  const resolved = Number.isFinite(seconds)
    ? seconds
    : (new Date(value).getTime() - Date.now()) / 1000;
  if (!Number.isFinite(resolved) || resolved <= 0) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.ceil(resolved));
}

async function fetchAllNflMarkets(apiKey) {
  const records = [];
  const seen = new Set();
  let offset = 0;
  let pageNumber = 0;

  while (pageNumber < MAX_PAGES_PER_MARKET) {
    const params = new URLSearchParams({
      sport: "football",
      league: "nfl",
      live: "false",
      limit: String(PAGE_SIZE),
      offset: String(offset),
      sort: "event_start_time",
    });
    const response = await fetch(`${SHARP_API_URL}?${params.toString()}`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
    });
    const text = await response.text();
    const body = parseResponse(text, "all_markets");
    if (!response.ok) {
      if (response.status === 429) {
        const error = new Error(getApiErrorMessage(body, response.status, "all_markets"));
        error.status = 429;
        error.retryAfterSeconds = parseRetryAfter(response.headers?.get?.("retry-after"));
        error.records = records;
        throw error;
      }
      // Discovery is additive. Explicit market requests remain the fallback.
      console.warn("SharpAPI all-market discovery unavailable", getApiErrorMessage(body, response.status, "all_markets"));
      break;
    }
    const rows = getDataRows(body);
    if (!rows.length) break;
    for (const row of rows) {
      const key = rawRowIdentity(row);
      if (!seen.has(key)) { seen.add(key); records.push(row); }
    }
    pageNumber += 1;
    if (rows.length < PAGE_SIZE) break;
    offset += rows.length;
  }
  return records;
}

function rawRowIdentity(row) {
  return [
    row?.id,
    row?.event_id,
    row?.sportsbook,
    row?.market_type || row?.market || row?.market_key,
    row?.player_name || row?.participant_name || row?.description,
    row?.selection_type,
    row?.selection,
    row?.line ?? row?.point,
    row?.odds_american ?? row?.odds_decimal,
  ].join("|");
}

async function fetchMarket(
  apiKey,
  market,
  maxPages = MAX_PAGES_PER_MARKET
) {
  const records = [];
  const seenRecordIds = new Set();
  const seenPages = new Set();

  let offset = 0;
  let pageNumber = 0;

  while (pageNumber < maxPages) {
    const params = new URLSearchParams({
      sport: "football",
      league: "nfl",
      market,
      live: "false",
      limit: String(PAGE_SIZE),
      offset: String(offset),
      sort: "event_start_time",
    });

    const response = await fetch(
      `${SHARP_API_URL}?${params.toString()}`,
      {
        headers: {
          "X-API-Key": apiKey,
          Accept: "application/json",
        },
      }
    );

    const responseText = await response.text();
    const body = parseResponse(responseText, market);

    if (!response.ok) {
      const error = new Error(
        getApiErrorMessage(body, response.status, market)
      );
      error.status = response.status;
      error.retryAfterSeconds = response.status === 429
        ? parseRetryAfter(response.headers?.get?.("retry-after"))
        : null;
      error.records = records;
      throw error;
    }

    const pageRows = getDataRows(body);
    if (!pageRows.length) break;

    const pageFingerprint = pageRows
      .slice(0, 10)
      .map((row) => row?.id || [
        row?.event_id,
        row?.sportsbook,
        row?.market_type,
        row?.selection_type,
        row?.selection,
        row?.line,
      ].join("|"))
      .join("::");

    if (seenPages.has(pageFingerprint)) break;
    seenPages.add(pageFingerprint);

    for (const row of pageRows) {
      const uniqueId =
        row?.id ||
        [
          row?.event_id,
          row?.sportsbook,
          row?.market_type,
          row?.selection_type,
          row?.selection,
          row?.line,
          row?.odds_american,
        ].join("|");

      if (!seenRecordIds.has(uniqueId)) {
        seenRecordIds.add(uniqueId);
        records.push(row);
      }
    }

    pageNumber += 1;

    const pagination = body?.pagination || body?.meta || {};
    const nextOffset = numberOrNull(
      pagination.next_offset ??
      pagination.nextOffset ??
      pagination.offset_next
    );
    const total = numberOrNull(
      pagination.total ??
      pagination.total_count ??
      pagination.count
    );
    const explicitHasMore =
      pagination.has_more === true ||
      pagination.hasMore === true;

    const candidateOffset =
      nextOffset !== null && nextOffset > offset
        ? nextOffset
        : offset + pageRows.length;

    const totalSaysMore =
      total !== null && candidateOffset < total;

    const fullPageSuggestsMore =
      pageRows.length >= PAGE_SIZE;

    if (!explicitHasMore && !totalSaysMore && !fullPageSuggestsMore) {
      break;
    }

    if (candidateOffset <= offset) break;
    offset = candidateOffset;
  }

  return records;
}

function getDataRows(body) {
  if (Array.isArray(body)) {
    return body;
  }

  if (Array.isArray(body?.data)) {
    return body.data;
  }

  if (Array.isArray(body?.odds)) {
    return body.odds;
  }

  if (Array.isArray(body?.results)) {
    return body.results;
  }

  if (Array.isArray(body?.items)) {
    return body.items;
  }

  return [];
}


function isEligibleOddsRow(row) {
  const marketType = String(row?.market_type || row?.market || row?.market_key || "");
  const marketKey = getMarketKey(marketType);
  if (!marketKey) return false;
  return isFullGamePlayerMarket(row, marketType);
}

// Applies to every market: only genuine full-game, pregame, non-alternate rows.
function isFullGamePlayerMarket(row, marketType) {
  if (row?.is_live === true || row?.is_alternate_line === true) return false;
  const text = [marketType, row?.period, row?.period_type, row?.segment, row?.scope, row?.market_name]
    .filter(Boolean).join("_").toLowerCase().replace(/[\s-]+/g, "_");
  if (/(^|_)(half|halves|halftime|quarter|quarters|h1|h2|1h|2h|live|inplay|in_play)(_|$)/.test(text)) return false;
  return !periodMarketMarkers().some((marker) => text.includes(marker));
}

function periodMarketMarkers() {
  return [
    "1st_half", "first_half", "firsthalf", "1h_", "_1h",
    "2nd_half", "second_half", "secondhalf", "2h_", "_2h",
    "1st_quarter", "first_quarter", "q1", "quarter_1",
    "2nd_quarter", "second_quarter", "q2", "quarter_2",
    "3rd_quarter", "third_quarter", "q3", "quarter_3",
    "4th_quarter", "fourth_quarter", "q4", "quarter_4",
    "alternate", "alt_line", "alternative",
  ];
}

function getMarketPeriod(row) {
  return row?.period || row?.period_type || row?.segment || row?.scope || "full_game";
}

function buildEvents(rows) {
  const eventMap = new Map();

  for (const row of rows) {
    if (!isUsableRow(row)) {
      continue;
    }

    const eventId = String(
      row.event_id
    );

    const homeTeam = getTeamName(
      row.home_team
    );

    const awayTeam = getTeamName(
      row.away_team
    );

    if (
      !eventId ||
      !homeTeam ||
      !awayTeam
    ) {
      continue;
    }

    if (!eventMap.has(eventId)) {
      eventMap.set(eventId, {
        id: eventId,
        sport_key:
          "americanfootball_nfl",
        sport_title: "NFL",
        commence_time:
          row.event_start_time || null,
        home_team: homeTeam,
        away_team: awayTeam,
        bookmakers: [],
      });
    }

    addOddsRow(
      eventMap.get(eventId),
      row
    );
  }

  return [...eventMap.values()]
    .map(cleanEvent)
    .filter(
      (event) =>
        event.bookmakers.length > 0
    )
    .sort((first, second) => {
      const firstTime = new Date(
        first.commence_time || 0
      ).getTime();

      const secondTime = new Date(
        second.commence_time || 0
      ).getTime();

      return firstTime - secondTime;
    });
}

function isUsableRow(row) {
  if (
    !row ||
    !row.event_id ||
    !row.home_team ||
    !row.away_team
  ) {
    return false;
  }

  if (row.is_live === true) {
    return false;
  }

  if (row.is_active === false) {
    return false;
  }

  if (row.is_alternate_line === true) {
    return false;
  }

  return getMarketKey(
    row.market_type || row.market || row.market_key
  ) !== null;
}

function addOddsRow(event, row) {
  const marketKey = getMarketKey(
    row.market_type || row.market || row.market_key
  );

  if (!marketKey) {
    return;
  }

  const sportsbookKey = normalizeBookKey(
    row.sportsbook
  );

  const sportsbookName =
    String(
      row.sportsbook_name || ""
    ).trim() ||
    formatSportsbookName(
      sportsbookKey
    );

  let bookmaker =
    event.bookmakers.find(
      (item) =>
        item.key === sportsbookKey
    );

  if (!bookmaker) {
    bookmaker = {
      key: sportsbookKey,
      title: sportsbookName,
      last_update:
        row.timestamp || null,
      markets: [],
    };

    event.bookmakers.push(
      bookmaker
    );
  }

  let market =
    bookmaker.markets.find(
      (item) =>
        item.key === marketKey
    );

  if (!market) {
    market = {
      key: marketKey,
      last_update:
        row.timestamp || null,
      outcomes: [],
    };

    bookmaker.markets.push(
      market
    );
  }

  const outcomeName =
    getOutcomeName(
      row,
      event,
      marketKey
    );

  const americanPrice =
    getAmericanPrice(row);

  if (
    !outcomeName ||
    americanPrice === null
  ) {
    return;
  }

  const outcome = {
    name: outcomeName,
    price: americanPrice,
    playerName: getPlayerName(row),
    playerId: row.player_id || row.participant_id || row.athlete_id || null,
    description: row.description || row.player_name || null,
    rawMarketType: row.market_type || row.market || row.market_key || null,
    period: getMarketPeriod(row),
  };

  if (
    marketKey === "spreads" ||
    marketKey === "totals" ||
    (marketKey.startsWith("player_") && marketKey !== "player_anytime_td")
  ) {
    const marketPoint =
      getMarketPoint(row);

    if (marketPoint === null) {
      return;
    }

    outcome.point = marketPoint;
  }

  const outcomeIdentity = [
    normalizeName(outcome.playerName || outcome.playerId),
    normalizeName(outcomeName),
    outcome.point ?? "no-line",
  ].join(":");
  const existingIndex = market.outcomes.findIndex((existing) =>
    [
      normalizeName(existing.playerName || existing.playerId),
      normalizeName(existing.name),
      existing.point ?? "no-line",
    ].join(":") === outcomeIdentity
  );

  if (existingIndex >= 0) {
    market.outcomes[
      existingIndex
    ] = outcome;
  } else {
    market.outcomes.push(
      outcome
    );
  }
}

function getMarketKey(marketType) {
  const value = String(marketType || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const compact = value.replace(/[^a-z0-9]/g, "");

  if (["moneyline", "money_line", "h2h", "ml"].includes(value)) return "h2h";
  if (["point_spread", "spread", "spreads"].includes(value)) return "spreads";
  if (["total_points", "total", "totals", "over_under"].includes(value)) return "totals";

  const hasPlayer = compact.includes("player") || compact.includes("athlete") || compact.includes("anytime");
  const hasYards = compact.includes("yard") || compact.includes("yds");
  if (compact.includes("anytime") && (compact.includes("td") || compact.includes("touchdown"))) return "player_anytime_td";
  if (["touchdownscorer", "anytimetdscorer", "toscoreatouchdown", "playertdscorer"].includes(compact)) return "player_anytime_td";
  if (hasPlayer && compact.includes("touchdown") && !compact.includes("passing")) return "player_anytime_td";
  if (hasPlayer && compact.includes("passing") && compact.includes("touchdown")) return "player_pass_tds";
  if (hasPlayer && compact.includes("passing") && hasYards) return "player_pass_yds";
  if (hasPlayer && compact.includes("passing") && compact.includes("attempt")) return "player_pass_attempts";
  if (hasPlayer && (compact.includes("completion") || compact.includes("completions"))) return "player_completions";
  if (hasPlayer && compact.includes("rushing") && compact.includes("receiving") && hasYards) return "player_rush_reception_yds";
  if (hasPlayer && compact.includes("rushing") && hasYards) return "player_rush_yds";
  if (hasPlayer && compact.includes("rushing") && compact.includes("attempt")) return "player_rush_attempts";
  if (hasPlayer && (compact.includes("receiving") || compact.includes("reception")) && hasYards) return "player_reception_yds";
  if (hasPlayer && (compact.includes("reception") || compact.includes("receptions"))) return "player_receptions";

  return null;
}

function getOutcomeName(
  row,
  event,
  marketKey
) {
  const selection = String(
    row.selection || ""
  ).trim();

  const selectionType = String(
    row.selection_type || ""
  )
    .trim()
    .toLowerCase();

  const teamSide = String(
    row.team_side || ""
  )
    .trim()
    .toLowerCase();

  if (marketKey.startsWith("player_")) {
    const rawSide = String(
      row.selection_type || row.side || row.over_under || row.selection || ""
    ).trim();
    if (marketKey === "player_anytime_td") return "Yes";
    if (/under/i.test(rawSide)) return "Under";
    if (/over/i.test(rawSide)) return "Over";
    if (/under/i.test(selection)) return "Under";
    if (/over/i.test(selection)) return "Over";
    return null;
  }
  if (marketKey === "totals") {
    if (
      selectionType === "over" ||
      selection.toLowerCase() ===
        "over"
    ) {
      return "Over";
    }

    if (
      selectionType === "under" ||
      selection.toLowerCase() ===
        "under"
    ) {
      return "Under";
    }

    return null;
  }

  if (
    selectionType === "home" ||
    teamSide === "home"
  ) {
    return event.home_team;
  }

  if (
    selectionType === "away" ||
    teamSide === "away"
  ) {
    return event.away_team;
  }

  if (
    normalizeName(selection) ===
    normalizeName(
      event.home_team
    )
  ) {
    return event.home_team;
  }

  if (
    normalizeName(selection) ===
    normalizeName(
      event.away_team
    )
  ) {
    return event.away_team;
  }

  return selection || null;
}

function getPlayerName(row) {
  const candidates = [
    row.player_name,
    row.player?.name,
    row.player?.full_name,
    typeof row.player === "string" ? row.player : null,
    row.participant_name,
    row.participant?.name,
    row.athlete_name,
    row.description,
    row.selection_name,
    row.selection?.name,
    row.outcome?.name,
    row.runner?.name,
    typeof row.selection === "string" ? row.selection : null,
  ];

  for (const candidate of candidates) {
    const extracted = extractPlayerName(candidate);
    if (extracted) return extracted;
  }

  return null;
}

function extractPlayerName(value) {
  const text = String(value || "").trim();
  if (!text || /^(over|under|yes|no)$/i.test(text)) return null;

  const cleaned = text
    .replace(/\b(over|under|yes|no)\b/gi, " ")
    .replace(/\b(anytime|touchdown|scorer|passing|rushing|receiving|yards?|attempts?|completions?|receptions?)\b/gi, " ")
    .replace(/[+\-]?\d+(?:\.\d+)?/g, " ")
    .replace(/[|:()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.split(" ").length >= 2 ? cleaned : null;
}

function getMarketPoint(row) {
  const candidates = [
    row.line,
    row.point,
    row.points,
    row.handicap,
    row.total,
  ];

  for (const candidate of candidates) {
    const number =
      numberOrNull(candidate);

    if (number !== null) {
      return number;
    }
  }

  const selection = String(
    row.selection || ""
  );

  const numberMatch =
    selection.match(
      /-?\d+(?:\.\d+)?/
    );

  if (numberMatch) {
    return Number(
      numberMatch[0]
    );
  }

  return null;
}

function getAmericanPrice(row) {
  const american = numberOrNull(
    row.odds_american ?? row.american_odds ?? row.american ?? row.price ??
    row.odds?.american ?? row.best_odds?.american
  );
  if (american !== null) return Math.round(american);
  const decimal = numberOrNull(
    row.odds_decimal ?? row.decimal_odds ?? row.decimal ??
    row.odds?.decimal ?? row.best_odds?.decimal
  );
  if (decimal === null || decimal <= 1) return null;
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : Math.round(-100 / (decimal - 1));
}

function cleanEvent(event) {
  const bookmakers =
    event.bookmakers
      .map((bookmaker) => ({
        ...bookmaker,
        markets:
          bookmaker.markets.filter(
            (market) =>
              market.outcomes.length >
              0
          ),
      }))
      .filter(
        (bookmaker) =>
          bookmaker.markets.length >
          0
      );

  return {
    ...event,
    bookmakers,
  };
}

function getTeamName(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return String(
      value.name ||
        value.display_name ||
        value.full_name ||
        ""
    ).trim();
  }

  return "";
}

function normalizeBookKey(value) {
  const normalized = String(
    value || "sharpapi"
  )
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  return normalized || "sharpapi";
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function formatSportsbookName(value) {
  return String(
    value || "SharpAPI"
  )
    .replace(/[_-]+/g, " ")
    .replace(
      /\b\w/g,
      (letter) =>
        letter.toUpperCase()
    );
}

function numberOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function parseResponse(
  responseText,
  market
) {
  if (!responseText) {
    return {};
  }

  try {
    return JSON.parse(responseText);
  } catch {
    const error = new Error(
      `SharpAPI returned invalid JSON for ${market}: ${responseText.slice(
        0,
        300
      )}`
    );

    error.status = 502;
    throw error;
  }
}

function getApiErrorMessage(
  body,
  status,
  market
) {
  const candidate =
    body?.error?.message ||
    body?.details ||
    body?.message ||
    body?.error;

  if (typeof candidate === "string") {
    return candidate;
  }

  if (
    candidate &&
    typeof candidate === "object"
  ) {
    try {
      return JSON.stringify(candidate);
    } catch {
      return `SharpAPI returned HTTP ${status} for ${market}`;
    }
  }

  return `SharpAPI returned HTTP ${status} for ${market}`;
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object"
  ) {
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown SharpAPI error";
    }
  }

  return String(error);
}