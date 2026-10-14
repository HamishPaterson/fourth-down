import { timingSafeEqual } from "node:crypto";
import {
  SNAPSHOT_PROVIDER,
  createSnapshotClient,
  hasSnapshotData,
  readEarlierSnapshots,
  readSnapshots,
  selectRolloverFallback,
  snapshotRows,
  summarizeSnapshots,
  writeSnapshotFailure,
  writeSnapshotSuccess,
} from "../../api-lib/oddsSnapshots.js";

const SHARP_API_URL =
  "https://api.sharpapi.io/api/v1/odds";

const CORE_MARKETS = ["moneyline", "point_spread", "total_points"];

// Canonical player markets Best Bets consumes (bestBetsService.js), each with
// the provider market names the live props path already queries. The refresh
// route accepts only the canonical key; aliases are tried in order.
const PLAYER_MARKET_ALIASES = {
  player_pass_yds: ["player_pass_yds", "passing_yards", "player_passing_yards"],
  player_rush_yds: ["player_rush_yds", "rushing_yards", "player_rushing_yards"],
  player_receptions: ["player_receptions", "receptions"],
  player_reception_yds: ["player_receiving_yards"],
  player_pass_tds: ["player_pass_tds", "passing_touchdowns", "player_passing_touchdowns"],
  player_pass_attempts: ["player_pass_attempts", "passing_attempts", "player_passing_attempts"],
  player_completions: ["player_completions", "passing_completions", "player_passing_completions"],
  player_rush_attempts: ["player_rush_attempts", "rushing_attempts", "player_rushing_attempts"],
  player_rush_reception_yds: ["player_rushing_+_receiving_yards"],
};
const PLAYER_MARKETS = Object.keys(PLAYER_MARKET_ALIASES);
// Runaway guard for one player market job, shared across its provider aliases.
const MAX_PLAYER_PAGES_PER_JOB = 15;
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
// Runaway guard only; paging normally ends on coverage or provider exhaustion.
const MAX_CORE_SAFETY_PAGES = 25;
const MAX_PAGES_PER_MARKET = 10;
const ODDS_CACHE_MS = 5 * 60 * 1000;
const REFRESH_REUSE_MS = 60 * 1000;

// Core odds are read from Supabase snapshots, so the CDN only needs to absorb
// bursts. Kept short so a newly refreshed snapshot is visible within minutes.
const SNAPSHOT_CDN_SECONDS = 300;
const SNAPSHOT_CDN_SWR_SECONDS = 600;
const SNAPSHOT_CDN_STALE_IF_ERROR_SECONDS = 86400;
// Player props are only needed for Best Bets so they use a longer lifetime.
const PROPS_CDN_SECONDS = 21600;
const PROPS_STALE_SECONDS = 86400;

const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 3600;

// Per-instance caches only hold genuine, complete provider responses.
const memoryCache = { props: null, "core+props": null };
const inFlightRequests = new Map();
let rateLimitedUntil = 0;

export default function handler(req, res) {
  return handleOddsRequest(req, res);
}

export async function handleOddsRequest(req, res, deps = {}) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const params = new URL(req.url || "/", "http://localhost").searchParams;

  if (params.has("refreshMarket")) {
    return handleMarketRefresh(req, res, params.get("refreshMarket"), deps);
  }

  // The Weekly Best Multi refresh needs live core and player-prop odds, so it
  // bypasses every shared cache. All other callers use the cached paths.
  const refresh = params.has("weeklyMultiRefresh");
  const scope = refresh ? "core+props" : params.get("props") === "1" ? "props" : "core";

  // Normal core requests read Supabase snapshots and never call SharpAPI.
  if (scope === "core") {
    return handleCoreFromSnapshots(res, deps);
  }

  // Opt-in read of stored player snapshots. The default ?props=1 stays live
  // until Best Bets and Weekly Best Multi are moved over in a later phase.
  if (scope === "props" && params.get("source") === "snapshot") {
    return handlePropsFromSnapshots(res, deps);
  }

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
  // Browsers revalidate against the CDN; only Vercel's shared cache holds the response.
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  res.setHeader(
    "Vercel-CDN-Cache-Control",
    `s-maxage=${PROPS_CDN_SECONDS}, stale-while-revalidate=${PROPS_STALE_SECONDS}, stale-if-error=${PROPS_STALE_SECONDS}`
  );
}

function setSnapshotCacheHeaders(res, fresh) {
  if (!fresh) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vercel-CDN-Cache-Control", "no-store");
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  res.setHeader(
    "Vercel-CDN-Cache-Control",
    `s-maxage=${SNAPSHOT_CDN_SECONDS}, stale-while-revalidate=${SNAPSHOT_CDN_SWR_SECONDS}, stale-if-error=${SNAPSHOT_CDN_STALE_IF_ERROR_SECONDS}`
  );
}

// Each market falls back independently; current-week data always wins.
async function withRolloverFallback(client, snapshots, missingMarkets, week, now) {
  let earlier = [];
  try {
    earlier = await readEarlierSnapshots(client, { week });
  } catch (error) {
    console.error("Odds rollover fallback read failed:", error?.message || error);
    return snapshots;
  }
  const currentEventIds = new Set(
    snapshots.flatMap((snapshot) => (hasSnapshotData(snapshot) ? snapshotRows(snapshot) : []))
      .map((row) => String(row?.event_id))
  );
  const result = [...snapshots];
  for (const market of missingMarkets) {
    const fallback = selectRolloverFallback(earlier, market, { now, currentEventIds });
    if (!fallback) continue;
    const index = result.findIndex((snapshot) => snapshot.market === market);
    if (index >= 0) result[index] = { ...fallback, status: result[index].status, last_error: result[index].last_error };
    else result.push(fallback);
  }
  return result;
}

async function handleCoreFromSnapshots(res, deps) {
  const now = deps.now ?? Date.now();
  const { week } = getCurrentWeekWindow(now);

  let snapshots;
  try {
    const client = deps.client || createSnapshotClient();
    snapshots = await readSnapshots(client, { week });
    const missingMarkets = CORE_MARKETS.filter(
      (market) => !hasSnapshotData(snapshots.find((snapshot) => snapshot.market === market))
    );
    if (missingMarkets.length && week > 1) {
      snapshots = await withRolloverFallback(client, snapshots, missingMarkets, week, now);
    }
  } catch (error) {
    console.error("Odds snapshot read failed:", error?.message || error);
    setSnapshotCacheHeaders(res, false);
    return res.status(200).json({
      count: 0,
      events: [],
      provider: SNAPSHOT_PROVIDER,
      scope: "core",
      cacheStatus: "unavailable",
      markets: [],
      warning: "Odds snapshot storage is unavailable.",
      refreshedAt: new Date(now).toISOString(),
    });
  }

  const summary = summarizeSnapshots(snapshots, CORE_MARKETS, now);
  const byMarket = new Map(snapshots.map((snapshot) => [snapshot.market, snapshot]));
  const rows = CORE_MARKETS.flatMap((market) =>
    hasSnapshotData(byMarket.get(market)) ? snapshotRows(byMarket.get(market)) : []
  );
  // Snapshots are already filtered; the full-game check stays as a safety net.
  const eligibleRows = rows.filter(isEligibleOddsRow);
  const events = buildEvents(eligibleRows);
  const fetchedTimes = summary.markets
    .filter((detail) => detail.fetchedAt)
    .map((detail) => new Date(detail.fetchedAt).getTime());

  const payload = {
    count: events.length,
    events,
    provider: SNAPSHOT_PROVIDER,
    scope: "core",
    rawRecordCount: rows.length,
    eligibleRecordCount: eligibleRows.length,
    rejectedPeriodRecordCount: rows.length - eligibleRows.length,
    marketRecordCounts: Object.fromEntries(summary.markets.map((detail) => [detail.market, detail.rowCount])),
    rawMarketTypes: [...new Set(rows.map((row) => String(row?.market_type || row?.market || row?.market_key || "").trim()).filter(Boolean))].sort(),
    playerPropRecordCount: 0,
    playerPropSamples: [],
    rateLimited: summary.markets.some((detail) => detail.status === "rate_limited"),
    partialMarkets: summary.missing,
    markets: summary.markets.map(({ market, fetchedAt, status, stale, fallback, fallbackFromWeek }) => ({
      market,
      fetchedAt,
      status,
      stale,
      ...(fallback ? { fallback: true, fallbackFromWeek } : {}),
    })),
    refreshedAt: new Date(fetchedTimes.length ? Math.min(...fetchedTimes) : now).toISOString(),
    cacheStatus: summary.cacheStatus,
  };

  if (summary.cacheStatus === "stale-fallback") {
    payload.warning = "Odds snapshots are older than expected. Showing the last successful odds.";
  } else if (summary.cacheStatus === "partial") {
    payload.warning = `Odds snapshots are missing for: ${summary.missing.join(", ")}.`;
  } else if (summary.cacheStatus === "unavailable") {
    payload.warning = "Betting odds snapshots are not available yet.";
  }

  setSnapshotCacheHeaders(res, summary.cacheStatus === "fresh");
  return res.status(200).json(payload);
}

function isAuthorizedCron(header, secret) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(String(header || ""));
  return received.length === expected.length && timingSafeEqual(received, expected);
}

// Refreshes exactly one market and never starts another one.
async function handleMarketRefresh(req, res, market, deps) {
  res.setHeader("Cache-Control", "no-store");

  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: "CRON_SECRET is not configured" });
  if (!isAuthorizedCron(req.headers?.authorization, secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!CORE_MARKETS.includes(market) && !PLAYER_MARKETS.includes(market)) {
    return res.status(400).json({
      error: `Unsupported market. Use one of: ${[...CORE_MARKETS, ...PLAYER_MARKETS].join(", ")}`,
    });
  }

  const apiKey = process.env.SHARP_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "SHARP_API_KEY is not configured" });

  try {
    const client = deps.client || createSnapshotClient();
    const refresh = CORE_MARKETS.includes(market) ? refreshCoreMarket : refreshPlayerMarket;
    const result = await refresh({
      market,
      apiKey,
      client,
      now: new Date(deps.now ?? Date.now()),
    });
    const httpStatus = { ok: 200, empty: 200, rate_limited: 429, cooldown: 429, error: 502 }[result.status] || 500;
    return res.status(httpStatus).json(result);
  } catch (error) {
    console.error(`Odds snapshot refresh failed for ${market}:`, error?.message || error);
    return res.status(500).json({ market, status: "error", error: "Snapshot storage failed" });
  }
}

async function refreshCoreMarket({ market, apiKey, client, now }) {
  const window = getCurrentWeekWindow(now.getTime());
  const key = { week: window.week, market };
  const snapshots = await readSnapshots(client, { week: window.week });
  const existing = snapshots.find((snapshot) => snapshot.market === market);

  const cooldownEnds = existing?.rate_limited_until ? new Date(existing.rate_limited_until).getTime() : 0;
  if (cooldownEnds > now.getTime()) {
    return {
      market,
      week: window.week,
      status: "cooldown",
      providerRequests: 0,
      retryAfterSeconds: Math.ceil((cooldownEnds - now.getTime()) / 1000),
    };
  }

  let isComplete = null;
  if (market !== "moneyline") {
    const moneyline = snapshots.find((snapshot) => snapshot.market === "moneyline");
    const targetEventIds = collectUsableEventIds(snapshotRows(moneyline));
    // Without a moneyline snapshot, rows are sorted by start time, so the
    // first usable row after this week means every current-week row was seen.
    isComplete = targetEventIds.size
      ? (records) => hasEveryEvent(collectUsableEventIds(records), targetEventIds)
      : (records) => records.some((row) => isUsableRow(row) && isEligibleOddsRow(row) && kickoffMs(row) >= window.end);
  }

  const stats = { pages: 0, requests: 0 };
  let rows;
  try {
    rows = await fetchMarket(
      apiKey,
      market,
      market === "moneyline" ? MAX_CORE_PAGES_PER_MARKET : MAX_CORE_SAFETY_PAGES,
      isComplete,
      stats
    );
  } catch (error) {
    const rateLimited = error?.status === 429;
    const retryAfterSeconds = rateLimited ? error.retryAfterSeconds || DEFAULT_RETRY_AFTER_SECONDS : null;
    const status = rateLimited ? "rate_limited" : "error";
    await writeSnapshotFailure(client, key, {
      status,
      error: error?.message,
      rateLimitedUntil: rateLimited ? new Date(now.getTime() + retryAfterSeconds * 1000) : null,
      pageCount: stats.pages,
      now,
    });
    return {
      market,
      week: window.week,
      status,
      error: error?.message,
      retryAfterSeconds,
      providerRequests: stats.requests,
      pageCount: stats.pages,
      preservedPreviousSnapshot: hasSnapshotData(existing),
    };
  }

  const marketKey = getMarketKey(market);
  const kept = rows.filter(
    (row) =>
      isUsableRow(row) &&
      isEligibleOddsRow(row) &&
      getMarketKey(row?.market_type || row?.market || row?.market_key) === marketKey &&
      kickoffMs(row) >= window.start &&
      kickoffMs(row) < window.end
  );

  if (!kept.length) {
    await writeSnapshotFailure(client, key, {
      status: "empty",
      error: "Provider returned no current-week full-game rows",
      pageCount: stats.pages,
      now,
    });
    return {
      market,
      week: window.week,
      status: "empty",
      providerRequests: stats.requests,
      pageCount: stats.pages,
      preservedPreviousSnapshot: hasSnapshotData(existing),
    };
  }

  await writeSnapshotSuccess(client, key, { rows: kept, pageCount: stats.pages, now });
  return {
    market,
    week: window.week,
    status: "ok",
    rowCount: kept.length,
    providerRequests: stats.requests,
    pageCount: stats.pages,
    fetchedAt: now.toISOString(),
  };
}

function kickoffMs(row) {
  return new Date(row?.event_start_time || 0).getTime();
}

/*
 * Refreshes one canonical player market. Provider aliases are tried in order
 * and the first alias that yields usable current-week rows wins. A 429 or a
 * server error stops the job at once; "unknown market" style 4xx responses
 * move on to the next alias. Failures never touch the stored rows.
 */
async function refreshPlayerMarket({ market, apiKey, client, now }) {
  const window = getCurrentWeekWindow(now.getTime());
  const key = { week: window.week, market };
  const snapshots = await readSnapshots(client, { week: window.week });
  const existing = snapshots.find((snapshot) => snapshot.market === market);

  const cooldownEnds = existing?.rate_limited_until ? new Date(existing.rate_limited_until).getTime() : 0;
  if (cooldownEnds > now.getTime()) {
    return {
      market,
      week: window.week,
      status: "cooldown",
      providerRequests: 0,
      retryAfterSeconds: Math.ceil((cooldownEnds - now.getTime()) / 1000),
    };
  }

  // Rows arrive sorted by kickoff, so a usable row after this week means every
  // current-week row has been seen.
  const isComplete = (records) =>
    records.some((row) => isUsableRow(row) && isEligibleOddsRow(row) && kickoffMs(row) >= window.end);
  const keep = (row) =>
    isUsableRow(row) &&
    isEligibleOddsRow(row) &&
    getMarketKey(row?.market_type || row?.market || row?.market_key) === market &&
    kickoffMs(row) >= window.start &&
    kickoffMs(row) < window.end;

  const totals = { pages: 0, requests: 0 };
  let keptRows = [];
  let usedAlias = null;
  let lastSkippedError = null;

  for (const alias of PLAYER_MARKET_ALIASES[market]) {
    const remaining = MAX_PLAYER_PAGES_PER_JOB - totals.pages;
    if (remaining <= 0) break;
    const stats = { pages: 0, requests: 0 };
    try {
      const rows = await fetchMarket(apiKey, alias, remaining, isComplete, stats);
      totals.pages += stats.pages;
      totals.requests += stats.requests;
      keptRows = rows.filter(keep);
      if (keptRows.length) {
        usedAlias = alias;
        break;
      }
    } catch (error) {
      totals.pages += stats.pages;
      totals.requests += stats.requests;
      const skippable = [400, 404, 422].includes(error?.status);
      if (skippable) {
        lastSkippedError = error;
        continue;
      }
      const rateLimited = error?.status === 429;
      const retryAfterSeconds = rateLimited ? error.retryAfterSeconds || DEFAULT_RETRY_AFTER_SECONDS : null;
      const status = rateLimited ? "rate_limited" : "error";
      await writeSnapshotFailure(client, key, {
        status,
        error: error?.message,
        rateLimitedUntil: rateLimited ? new Date(now.getTime() + retryAfterSeconds * 1000) : null,
        pageCount: totals.pages,
        now,
      });
      return {
        market,
        week: window.week,
        status,
        error: error?.message,
        retryAfterSeconds,
        providerRequests: totals.requests,
        pageCount: totals.pages,
        preservedPreviousSnapshot: hasSnapshotData(existing),
      };
    }
  }

  if (!keptRows.length) {
    await writeSnapshotFailure(client, key, {
      status: "empty",
      error: lastSkippedError?.message || "Provider returned no current-week full-game rows",
      pageCount: totals.pages,
      now,
    });
    return {
      market,
      week: window.week,
      status: "empty",
      providerRequests: totals.requests,
      pageCount: totals.pages,
      preservedPreviousSnapshot: hasSnapshotData(existing),
    };
  }

  await writeSnapshotSuccess(client, key, { rows: keptRows, pageCount: totals.pages, now });
  return {
    market,
    week: window.week,
    status: "ok",
    rowCount: keptRows.length,
    providerMarket: usedAlias,
    providerRequests: totals.requests,
    pageCount: totals.pages,
    fetchedAt: now.toISOString(),
  };
}

// Stored player snapshots; only used when ?props=1&source=snapshot is requested.
async function handlePropsFromSnapshots(res, deps) {
  const now = deps.now ?? Date.now();
  const { week } = getCurrentWeekWindow(now);

  let snapshots;
  try {
    snapshots = await readSnapshots(deps.client || createSnapshotClient(), { week });
  } catch (error) {
    console.error("Props snapshot read failed:", error?.message || error);
    setSnapshotCacheHeaders(res, false);
    return res.status(200).json({
      count: 0,
      events: [],
      provider: SNAPSHOT_PROVIDER,
      scope: "props",
      source: "snapshot",
      cacheStatus: "unavailable",
      markets: [],
      warning: "Odds snapshot storage is unavailable.",
      refreshedAt: new Date(now).toISOString(),
    });
  }

  const summary = summarizeSnapshots(snapshots, PLAYER_MARKETS, now);
  const byMarket = new Map(snapshots.map((snapshot) => [snapshot.market, snapshot]));
  const rows = PLAYER_MARKETS.flatMap((market) =>
    hasSnapshotData(byMarket.get(market)) ? snapshotRows(byMarket.get(market)) : []
  );
  const eligibleRows = rows.filter(isEligibleOddsRow);
  const events = buildEvents(eligibleRows);
  const fetchedTimes = summary.markets
    .filter((detail) => detail.fetchedAt)
    .map((detail) => new Date(detail.fetchedAt).getTime());

  const payload = {
    count: events.length,
    events,
    provider: SNAPSHOT_PROVIDER,
    scope: "props",
    source: "snapshot",
    rawRecordCount: rows.length,
    eligibleRecordCount: eligibleRows.length,
    rejectedPeriodRecordCount: rows.length - eligibleRows.length,
    marketRecordCounts: Object.fromEntries(summary.markets.map((detail) => [detail.market, detail.rowCount])),
    playerPropRecordCount: eligibleRows.filter(isPlayerRow).length,
    rateLimited: summary.markets.some((detail) => detail.status === "rate_limited"),
    partialMarkets: summary.missing,
    markets: summary.markets.map(({ market, fetchedAt, status, stale }) => ({ market, fetchedAt, status, stale })),
    refreshedAt: new Date(fetchedTimes.length ? Math.min(...fetchedTimes) : now).toISOString(),
    cacheStatus: summary.cacheStatus,
  };
  if (summary.cacheStatus !== "fresh") {
    payload.warning =
      summary.cacheStatus === "unavailable"
        ? "Player prop snapshots are not available yet."
        : `Player prop snapshots are ${summary.cacheStatus === "partial" ? `missing for: ${summary.missing.join(", ")}` : "older than expected"}.`;
  }

  setSnapshotCacheHeaders(res, summary.cacheStatus === "fresh");
  return res.status(200).json(payload);
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
  let expectedEventIds = new Set();

  for (const market of CORE_MARKETS) {
    try {
      let marketRows;
      if (market === "moneyline") {
        marketRows = await fetchMarket(apiKey, market, MAX_CORE_PAGES_PER_MARKET);
        expectedEventIds = selectCurrentWeekEventIds(marketRows);
      } else {
        // Half/quarter/alternate rows are rejected after retrieval, so keep
        // paging until every current-week moneyline event has a genuine
        // full-game line. Future-week events never extend paging.
        marketRows = await fetchMarket(
          apiKey,
          market,
          MAX_CORE_SAFETY_PAGES,
          (records) => hasEveryEvent(collectUsableEventIds(records), expectedEventIds)
        );
      }
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

function collectUsableEventIds(rows) {
  const ids = new Set();
  for (const row of rows) {
    if (row?.event_id && isUsableRow(row) && isEligibleOddsRow(row)) ids.add(row.event_id);
  }
  return ids;
}

function hasEveryEvent(found, expected) {
  for (const id of expected) if (!found.has(id)) return false;
  return true;
}

// Same week calculation as Predictions.jsx and Schedule.jsx: week 1 starts
// Tuesday 8 September 2026 (UTC) and each week lasts seven days.
const WEEK_ONE_START_MS = Date.UTC(2026, 8, 8, 0, 0, 0);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Monday night kickoffs fall just after 00:00 UTC Tuesday, so the window
// boundary is moved to midday Tuesday to keep them in their own week.
const WEEK_BOUNDARY_OFFSET_MS = 12 * 60 * 60 * 1000;

export function getCurrentWeekWindow(now = Date.now()) {
  const week = Math.min(18, Math.max(1, Math.floor((now - WEEK_ONE_START_MS) / WEEK_MS) + 1));
  const start = WEEK_ONE_START_MS + (week - 1) * WEEK_MS + WEEK_BOUNDARY_OFFSET_MS;
  return { week, start, end: start + WEEK_MS };
}

function selectCurrentWeekEventIds(rows) {
  const { start, end } = getCurrentWeekWindow();
  const ids = new Set();
  for (const row of rows) {
    if (!row?.event_id || !isUsableRow(row) || !isEligibleOddsRow(row)) continue;
    const kickoff = new Date(row.event_start_time || 0).getTime();
    if (kickoff >= start && kickoff < end) ids.add(row.event_id);
  }
  // With no current-week games in the provider data, fall back to every known
  // event rather than stopping paging on an empty target.
  return ids.size ? ids : collectUsableEventIds(rows);
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
  maxPages = MAX_PAGES_PER_MARKET,
  isComplete = null,
  stats = { pages: 0, requests: 0 }
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

    stats.requests += 1;
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
    stats.pages = pageNumber;

    if (isComplete && isComplete(records)) break;

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