import { createClient } from "@supabase/supabase-js";
import { SNAPSHOT_MAX_AGE_MS } from "./oddsSnapshots.js";
import { isPlayerLeg, settleLockedLegs } from "./weeklyMultiSettlement.js";
import { findOddsForGame, resolveTeamCode } from "../src/services/oddsApi.js";
import { usableDecimalOdds } from "../src/services/oddsDisplay.js";

const BALLDONTLIE_GAMES_URL = "https://api.balldontlie.io/nfl/v1/games";
// Odds now come from once-a-day stored snapshots, so quote age is bounded by
// the snapshot freshness window instead of a live-fetch window.
const ODDS_MAX_AGE_MS = SNAPSHOT_MAX_AGE_MS;
const PREDICTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RETRY_WINDOW_MS = 30 * 60 * 1000;
const SCHEDULE_REQUEST_TIMEOUT_MS = 3000;
const SCHEDULE_RETRY_DELAY_CAP_MS = 2500;
const LEG_COUNT = 5;
const START_PROBABILITY = 0.65;
const FLOOR_PROBABILITY = 0.55;
const PROBABILITY_STEP = 0.025;
// Thursday 10:00 AEST (Australia/Brisbane, no daylight saving) is 00:00 UTC.
export const WEEKLY_MULTI_TIME_ZONE = "Australia/Brisbane";
const TEAM_ALIASES = { WAS: "WSH", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" };

export function createWeeklyMultiClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase server environment variables are missing");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function getLockCycle(now = new Date()) {
  const mostRecentThursday = getMostRecentThursday(now);
  const nextThursday = mostRecentThursday + 7 * 24 * 60 * 60 * 1000;
  const wednesdayStart = mostRecentThursday + 6 * 24 * 60 * 60 * 1000;
  const beforeUpcomingWeeklyLock = now.getTime() >= wednesdayStart && now.getTime() < nextThursday;
  return {
    lockAt: mostRecentThursday,
    targetLockAt: beforeUpcomingWeeklyLock ? nextThursday : mostRecentThursday,
    eligible: !beforeUpcomingWeeklyLock && now.getTime() >= mostRecentThursday,
    placeholder: beforeUpcomingWeeklyLock,
  };
}

export function getDisplayLockCycle(now = new Date()) {
  const current = now.getTime();
  const mostRecentThursday = getMostRecentThursday(now);
  const wednesdayStart = mostRecentThursday + 6 * 24 * 60 * 60 * 1000;
  const nextThursday = mostRecentThursday + 7 * 24 * 60 * 60 * 1000;
  const placeholder = current >= wednesdayStart && current < nextThursday;
  const lockAt = placeholder ? nextThursday : mostRecentThursday;
  return { lockAt, eligible: !placeholder && current >= lockAt, placeholder };
}

export async function resolveLockWeekContext(now = new Date(), { allowBeforeLock = false, fetchGames = fetchScheduleGamesForWindow } = {}) {
  const cycle = getLockCycle(now);
  if (!cycle.eligible && !allowBeforeLock) {
    return {
      available: false,
      notYetLocked: true,
      eligible: false,
      lockAt: new Date(cycle.targetLockAt).toISOString(),
      deadlineAt: new Date(cycle.targetLockAt + RETRY_WINDOW_MS).toISOString(),
      reason: "The current lock moment has not arrived",
    };
  }
  const lockAt = allowBeforeLock ? getDryRunLockTime(now) : cycle.lockAt;
  let context;
  try {
    context = await resolveScheduleWeek(lockAt, fetchGames);
  } catch (error) {
    context = {
      available: false,
      lockAt: new Date(lockAt).toISOString(),
      deadlineAt: new Date(lockAt + RETRY_WINDOW_MS).toISOString(),
      reason: getScheduleFailureReason(error),
    };
  }
  return {
    ...context,
    eligible: cycle.eligible,
    notYetLocked: false,
    dryRunTarget: allowBeforeLock ? new Date(lockAt).toISOString() : undefined,
  };
}

export async function resolveDisplayWeekContext(now = new Date(), { fetchGames = fetchScheduleGamesForWindow } = {}) {
  const cycle = getDisplayLockCycle(now);
  let context;
  try {
    context = await resolveScheduleWeek(cycle.lockAt, fetchGames);
  } catch (error) {
    context = {
      available: false,
      lockAt: new Date(cycle.lockAt).toISOString(),
      deadlineAt: new Date(cycle.lockAt + RETRY_WINDOW_MS).toISOString(),
      reason: getScheduleFailureReason(error),
    };
  }
  return {
    ...context,
    placeholder: context.available && cycle.placeholder,
    notReady: !context.available,
  };
}

function getScheduleFailureReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message === "schedule provider rate limited"
    ? message
    : `Schedule data is unavailable: ${message}`;
}

function getNextThursday(now) {
  const latest = getMostRecentThursday(now);
  return now.getTime() === latest ? latest : latest + 7 * 24 * 60 * 60 * 1000;
}

function getDryRunLockTime(now) {
  return now.getUTCDay() === 4 ? getMostRecentThursday(now) : getNextThursday(now);
}

function getMostRecentThursday(now) {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysSinceThursday = (now.getUTCDay() - 4 + 7) % 7;
  const thursday = dayStart - daysSinceThursday * 24 * 60 * 60 * 1000;
  return now.getTime() < thursday ? thursday - 7 * 24 * 60 * 60 * 1000 : thursday;
}

async function resolveScheduleWeek(lockAt, fetchGames = fetchScheduleGamesForWindow) {
  const end = lockAt + 7 * 24 * 60 * 60 * 1000;
  const games = await fetchGames(lockAt, end);
  const inWindow = games.filter((game) => {
    const kickoff = new Date(game.date).getTime();
    return game.postseason !== true && Number(game.week) >= 1 && Number(game.week) <= 18 &&
      Number.isFinite(kickoff) && kickoff >= lockAt && kickoff < end;
  });
  const weeks = new Map();
  for (const game of inWindow) {
    const season = Number(game.season);
    const week = Number(game.week);
    if (Number.isInteger(season) && Number.isInteger(week)) weeks.set(`${season}:${week}`, { season, week });
  }
  if (weeks.size !== 1) {
    return {
      available: false,
      lockAt: new Date(lockAt).toISOString(),
      deadlineAt: new Date(lockAt + RETRY_WINDOW_MS).toISOString(),
      reason: weeks.size ? "Schedule interval maps to more than one NFL week" : "No regular-season schedule games found in the active lock interval",
    };
  }
  const { season, week } = [...weeks.values()][0];
  const firstKickoff = Math.min(...inWindow
    .filter((game) => Number(game.season) === season && Number(game.week) === week)
    .map((game) => new Date(game.date).getTime()));
  return {
    available: true,
    season,
    week,
    firstKickoffAt: new Date(firstKickoff).toISOString(),
    lockAt: new Date(lockAt).toISOString(),
    deadlineAt: new Date(lockAt + RETRY_WINDOW_MS).toISOString(),
    retryDeadline: lockAt + RETRY_WINDOW_MS,
    games: inWindow.filter((game) => Number(game.season) === season && Number(game.week) === week),
  };
}

export async function fetchScheduleGamesForWindow(lockAt, end, {
  fetchImpl = fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const apiKey = process.env.BALLDONTLIE_API_KEY;
  if (!apiKey) throw new Error("BALLDONTLIE_API_KEY is not configured for weekly lock week resolution");
  const games = [];
  let cursor = null;
  let retriedRateLimit = false;
  const params = new URLSearchParams({ per_page: "100" });
  for (let day = Date.UTC(new Date(lockAt).getUTCFullYear(), new Date(lockAt).getUTCMonth(), new Date(lockAt).getUTCDate()); day < end; day += 24 * 60 * 60 * 1000) {
    params.append("dates[]", new Date(day).toISOString().slice(0, 10));
  }
  do {
    if (cursor !== null) params.set("cursor", String(cursor));
    let response;
    let text;
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SCHEDULE_REQUEST_TIMEOUT_MS);
      try {
        response = await fetchImpl(`${BALLDONTLIE_GAMES_URL}?${params.toString()}`, {
          signal: controller.signal,
          cache: "no-store",
          headers: { Authorization: apiKey, Accept: "application/json" },
        });
        text = await response.text();
      } finally {
        clearTimeout(timeout);
      }
      if (response.ok) break;
      if (response.status === 429 && !retriedRateLimit) {
        const delay = getRetryAfterDelay(response.headers?.get?.("Retry-After"), Date.now());
        await sleep(Math.min(delay, SCHEDULE_RETRY_DELAY_CAP_MS));
        retriedRateLimit = true;
        continue;
      }
      if (response.status === 429) throw new Error("schedule provider rate limited");
      let errorBody;
      try {
        errorBody = text ? JSON.parse(text) : {};
      } catch {
        errorBody = null;
      }
      throw new Error(errorBody?.error?.message || errorBody?.error || `Schedule request failed (${response.status})`);
    }
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("Schedule provider returned invalid JSON");
    }
    games.push(...(Array.isArray(body.data) ? body.data : []));
    cursor = body.meta?.next_cursor ?? null;
  } while (cursor !== null);
  return games;
}

function getRetryAfterDelay(value, now) {
  if (!value) return SCHEDULE_RETRY_DELAY_CAP_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = new Date(value).getTime();
  return Number.isFinite(date) ? Math.max(0, date - now) : SCHEDULE_RETRY_DELAY_CAP_MS;
}

export function predictionSnapshotsForWeek(rows, context, now = new Date()) {
  return (rows || []).map((row) => ({
    ...(row?.data_quality?.snapshot || {}),
    season: row?.season ?? row?.data_quality?.snapshot?.season,
    week: row?.week ?? row?.data_quality?.snapshot?.week,
    kickoff: row?.kickoff ?? row?.data_quality?.snapshot?.kickoff,
    awayCode: row?.away_code ?? row?.data_quality?.snapshot?.awayCode,
    homeCode: row?.home_code ?? row?.data_quality?.snapshot?.homeCode,
    fourthDownPick: row?.fourth_down_pick ?? row?.data_quality?.snapshot?.fourthDownPick,
    fourthDownAwayScore: row?.predicted_away_score ?? row?.data_quality?.snapshot?.fourthDownAwayScore,
    fourthDownHomeScore: row?.predicted_home_score ?? row?.data_quality?.snapshot?.fourthDownHomeScore,
    fourthDownAwayWinProbability: row?.away_win_probability ?? row?.data_quality?.snapshot?.fourthDownAwayWinProbability,
    fourthDownHomeWinProbability: row?.home_win_probability ?? row?.data_quality?.snapshot?.fourthDownHomeWinProbability,
    modelVersion: row?.model_version ?? row?.data_quality?.snapshot?.modelVersion,
    snapshotAt: row?.data_quality?.snapshot?.snapshotAt ?? row?.updated_at ?? row?.created_at,
  }))
    .filter((snapshot) => isFreshPrediction(snapshot, context, now));
}

function isFreshPrediction(snapshot, context, now) {
  if (!snapshot || Number(snapshot.season) !== context.season || Number(snapshot.week) !== context.week) return false;
  if (snapshot.source === "full-model-error") return false;
  const modelVersion = Number(snapshot.modelVersion ?? snapshot.dataQuality?.modelVersion);
  const modelKey = snapshot.modelKey ?? snapshot.dataQuality?.modelKey;
  if (modelVersion !== 11 || modelKey !== "full-v11-week5-data-gap-audit") return false;
  const payload = snapshot.predictionPayload ?? snapshot.dataQuality?.predictionPayload;
  const bestBets = snapshot.bestBets ?? snapshot.dataQuality?.bestBetsPayload;
  const dataQuality = snapshot.dataQuality;
  if (!payload || !bestBets || !dataQuality || dataQuality?.sources?.odds?.available !== true) return false;
  if (!snapshot.fourthDownPick || !Number.isFinite(Number(snapshot.fourthDownAwayScore)) || !Number.isFinite(Number(snapshot.fourthDownHomeScore))) return false;
  if (!Number.isFinite(Number(snapshot.fourthDownAwayWinProbability)) || !Number.isFinite(Number(snapshot.fourthDownHomeWinProbability))) return false;
  const generatedAt = new Date(snapshot.generatedAt || snapshot.snapshotAt || 0).getTime();
  const kickoff = new Date(snapshot.kickoff || 0).getTime();
  const age = now.getTime() - generatedAt;
  return Number.isFinite(generatedAt) && age >= -60000 && age <= PREDICTION_MAX_AGE_MS &&
    Number.isFinite(kickoff) && kickoff > now.getTime();
}

export function buildWeeklyMultiSelection(snapshots, oddsPayload, context, now = new Date()) {
  const reasonCounts = { stalePrediction: 0, staleOdds: 0, fallbackOdds: 0, invalidCandidates: 0 };
  const candidates = [];
  const oddsEvents = Array.isArray(oddsPayload?.events) ? oddsPayload.events : [];
  for (const snapshot of snapshots || []) {
    const bestBetsPayload = snapshot.bestBets || snapshot.dataQuality?.bestBetsPayload;
    const scorer = bestBetsPayload?.anytimeTdScorer;
    const tdProbability = Number(scorer?.tdProbability ?? scorer?.modelProbability);
    const roleConfidence = Number(scorer?.roleConfidence);
    const scorerProbability = tdProbability * roleConfidence;
    // The model-only Anytime TD scorer has no bookmaker price by design.
    if (scorer?.source === "model-only" && scorer.selection && tdProbability > 0 && tdProbability <= 1 &&
      roleConfidence > 0 && roleConfidence <= 1 && scorerProbability > 0 && scorerProbability <= 1 &&
      snapshot.awayCode && snapshot.homeCode) {
      candidates.push({
        ...scorer,
        category: "Anytime touchdowns",
        market: "Anytime touchdown",
        modelOnly: true,
        decimalOdds: null,
        price: null,
        sportsbook: null,
        modelProbability: scorerProbability,
        tdProbability,
        marketFamily: "anytime-td",
        impliedProbability: null,
        edge: null,
        expectedValue: null,
        awayCode: snapshot.awayCode,
        homeCode: snapshot.homeCode,
        matchup: `${snapshot.awayCode} at ${snapshot.homeCode}`,
        matchupKey: `${context.season}:${context.week}:${snapshot.awayCode}:${snapshot.homeCode}`,
        kickoff: snapshot.kickoff,
        oddsUpdatedAt: null,
      });
    }
    const event = findOddsForGame(oddsEvents, snapshot);
    if (!event || isFallbackEvent(event)) {
      reasonCounts.fallbackOdds += 1;
      continue;
    }
    const bets = [...(bestBetsPayload?.recommendations || [])];
    if (scorer?.source === "priced-market") bets.push(scorer);
    for (const bet of bets) {
      const decimalOdds = getDecimalOddsValue(bet);
      const modelProbability = Number(bet.modelProbability);
      const quoteTime = new Date(bet.updatedAt || 0).getTime();
      if (!Number.isFinite(quoteTime) || quoteTime <= 0 || now.getTime() - quoteTime > ODDS_MAX_AGE_MS || quoteTime > now.getTime() + 60000) {
        reasonCounts.staleOdds += 1;
        continue;
      }
      if (!Number.isFinite(decimalOdds) || decimalOdds <= 1 || !Number.isFinite(modelProbability) || modelProbability < 0 || modelProbability > 1 ||
        !bet.selection || !bet.market || !isRealBookmaker(bet.sportsbook, event, now) || !hasCurrentBookMarket(event, bet)) {
        reasonCounts.invalidCandidates += 1;
        continue;
      }
      const impliedProbability = 1 / decimalOdds;
      const edge = modelProbability - impliedProbability;
      if (edge <= 0) continue;
      candidates.push({
        ...bet,
        marketFamily: weeklyMultiMarketFamily(bet),
        decimalOdds,
        modelProbability,
        impliedProbability,
        edge,
        expectedValue: modelProbability * decimalOdds - 1,
        awayCode: snapshot.awayCode,
        homeCode: snapshot.homeCode,
        matchup: `${snapshot.awayCode} at ${snapshot.homeCode}`,
        matchupKey: `${context.season}:${context.week}:${snapshot.awayCode}:${snapshot.homeCode}`,
        kickoff: snapshot.kickoff,
        oddsUpdatedAt: new Date(quoteTime).toISOString(),
      });
    }
  }

  candidates.sort(compareCandidates);
  const uniqueOffers = new Map();
  for (const candidate of candidates) {
    const key = candidateIdentity(candidate);
    if (!uniqueOffers.has(key)) uniqueOffers.set(key, candidate);
  }
  const ranked = [...uniqueOffers.values()].sort(compareCandidates);
  let threshold = START_PROBABILITY;
  let distinctMatchups = [];
  while (true) {
    const byMatchup = new Map();
    const families = new Set();
    const eligible = ranked.filter((candidate) => candidate.modelProbability >= threshold);
    for (const phase of ["priced-families", "priced", "model-only"]) {
      for (const candidate of eligible) {
        if (Boolean(candidate.modelOnly) !== (phase === "model-only")) continue;
        const family = candidate.marketFamily;
        if (byMatchup.size >= LEG_COUNT || byMatchup.has(candidate.matchupKey)) continue;
        if (family === "anytime-td" && families.has(family)) continue;
        if (phase === "priced-families" && families.has(family)) continue;
        byMatchup.set(candidate.matchupKey, candidate);
        families.add(family);
      }
    }
    distinctMatchups = [...byMatchup.values()].sort(compareCandidates);
    if (distinctMatchups.length >= LEG_COUNT || threshold <= FLOOR_PROBABILITY) break;
    threshold = Math.max(FLOOR_PROBABILITY, Math.round((threshold - PROBABILITY_STEP) * 10000) / 10000);
  }
  const legs = distinctMatchups.slice(0, LEG_COUNT);
  const oddsTimes = legs.filter((leg) => leg.oddsUpdatedAt).map((leg) => new Date(leg.oddsUpdatedAt).getTime()).filter(Number.isFinite);
  const oddsUpdatedAt = oddsTimes.length ? new Date(Math.min(...oddsTimes)).toISOString() : null;
  const oddsLate = now.getTime() > new Date(context.lockAt).getTime() + 15 * 60 * 1000;
  return {
    legs,
    threshold,
    complete: legs.length === LEG_COUNT,
    partial: legs.length < LEG_COUNT,
    oddsUpdatedAt,
    oddsCacheStatus: oddsPayload?.cacheStatus || "unavailable",
    oddsRefreshedAt: oddsPayload?.refreshedAt || null,
    oddsLate,
    reasonCounts,
    candidateCounts: Object.fromEntries([...new Set(ranked.map((candidate) => candidate.marketFamily))].sort()
      .map((family) => [family, ranked.filter((candidate) => candidate.marketFamily === family && candidate.modelProbability >= FLOOR_PROBABILITY).length])),
  };
}

export function isFreshOddsPayload(payload) {
  return Boolean(payload && ["fresh", "memory-hit"].includes(payload.cacheStatus) && Array.isArray(payload.events));
}

export function lockIsPastDeadline(context, now = new Date()) {
  return now.getTime() >= context.retryDeadline;
}

export function isGeneratedLate(context, now = new Date()) {
  return now.getTime() > new Date(context.lockAt).getTime() + 15 * 60 * 1000;
}

export function makeWeeklyMultiRecord(selection, context, now = new Date(), reason = null) {
  return {
    season: context.season,
    week: context.week,
    lock_at: context.lockAt,
    locked_at: now.toISOString(),
    legs: selection.legs,
    model_probability_threshold: selection.threshold,
    status: selection.complete ? "locked" : "partial",
    partial: !selection.complete,
    generated_late: isGeneratedLate(context, now),
    odds_late: selection.oddsLate,
    odds_updated_at: selection.oddsUpdatedAt,
    odds_refreshed_at: selection.oddsRefreshedAt,
    odds_cache_status: selection.oddsCacheStatus,
    reason,
    reason_counts: selection.reasonCounts,
  };
}

// Both URLs read stored Supabase snapshots; neither can reach SharpAPI.
export function getStoredOddsUrls(request) {
  const deploymentHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const requestHost = request?.headers?.["x-forwarded-host"] || request?.headers?.host;
  const host = deploymentHost || requestHost;
  if (!host) throw new Error("Could not determine the deployment host for stored odds");
  const hostname = String(host).replace(/^https?:\/\//, "").replace(/\/$/, "");
  const protocol = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(hostname) ? "http" : "https";
  const base = `${protocol}://${hostname}/api/nfl/odds`;
  return { core: base, props: `${base}?props=1&source=snapshot` };
}

const STATUS_ORDER = ["fresh", "stale-fallback", "partial", "unavailable"];

// Combined payload is only "fresh" when both stored sets are fresh.
export function mergeStoredOdds(core, props) {
  const statuses = [core?.cacheStatus || "unavailable", props?.cacheStatus || "unavailable"];
  const cacheStatus = STATUS_ORDER[Math.max(...statuses.map((status) => Math.max(0, STATUS_ORDER.indexOf(status))))];
  const events = (core?.events || []).map((event) => ({ ...event, bookmakers: (event.bookmakers || []).map((book) => ({ ...book, markets: [...(book.markets || [])] })) }));
  for (const propEvent of props?.events || []) {
    const target = findOddsForGame(events, {
      away: propEvent.away_team_code || propEvent.away_team,
      home: propEvent.home_team_code || propEvent.home_team,
      kickoff: propEvent.commence_time,
    });
    if (!target) continue;
    for (const propBook of propEvent.bookmakers || []) {
      const book = target.bookmakers.find((candidate) => candidate.key === propBook.key);
      if (book) book.markets.push(...(propBook.markets || []));
      else target.bookmakers.push({ ...propBook, markets: [...(propBook.markets || [])] });
    }
  }
  const refreshed = [core?.refreshedAt, props?.refreshedAt].filter(Boolean).sort();
  return { events, cacheStatus, refreshedAt: refreshed[0] || null };
}

export function secureBearerMatches(header, secret) {
  if (!secret || typeof header !== "string") return false;
  const supplied = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!supplied || supplied.length !== secret.length) return false;
  let difference = 0;
  for (let index = 0; index < secret.length; index += 1) difference |= supplied.charCodeAt(index) ^ secret.charCodeAt(index);
  return difference === 0;
}

function candidateIdentity(candidate) {
  return [candidate.matchupKey, String(candidate.market).trim().toLowerCase(), String(candidate.selection).trim().toLowerCase(), String(candidate.line ?? candidate.point ?? candidate.handicap ?? "").trim()].join(":");
}

function compareCandidates(first, second) {
  const firstPriced = Number.isFinite(first.expectedValue);
  if (firstPriced !== Number.isFinite(second.expectedValue)) return firstPriced ? -1 : 1;
  const tie = () => {
    const key = (candidate) => `${candidateIdentity(candidate)}:${normalizeText(candidate.sportsbook)}:${candidate.oddsUpdatedAt || ""}`;
    const a = key(first), b = key(second);
    return a < b ? -1 : a > b ? 1 : 0;
  };
  if (!firstPriced) return second.modelProbability - first.modelProbability || tie();
  return second.expectedValue - first.expectedValue || second.edge - first.edge || second.modelProbability - first.modelProbability || tie();
}

function getDecimalOddsValue(bet) {
  return usableDecimalOdds(bet?.decimalOdds, bet?.price);
}

function isFallbackEvent(event) {
  const markers = [event?.id, event?.fallbackSource, event?.fallbackReason, event?.cacheStatus, event?.warning]
    .filter(Boolean).join(" ").toLowerCase();
  return /(fallback|placeholder|stale|unavailable|published consensus)/.test(markers);
}

function isRealBookmaker(sportsbook, event, now) {
  const name = normalizeText(sportsbook);
  if (!name || /(fallback|placeholder|publishedconsensus|^market$)/.test(name)) return false;
  return (event.bookmakers || []).some((book) => {
    const updatedAt = new Date(book?.last_update || 0).getTime();
    return [book?.title, book?.name, book?.key].some((value) => normalizeText(value) === name) &&
      Number.isFinite(updatedAt) && now.getTime() - updatedAt <= ODDS_MAX_AGE_MS && updatedAt <= now.getTime() + 60000;
  });
}

function hasCurrentBookMarket(event, bet) {
  const marketName = String(bet.market || "").toLowerCase();
  const bookmaker = (event.bookmakers || []).find((book) => [book?.title, book?.name, book?.key]
    .some((value) => normalizeText(value) === normalizeText(bet.sportsbook)));
  if (!bookmaker) return false;
  const markets = Array.isArray(bookmaker.markets) ? bookmaker.markets : [];
  const matches = markets.filter((market) => marketLabelMatches(market.key, marketName));
  if (!matches.length) return false;
  const selection = normalizeText(bet.selection);
  const suppliedLine = bet.line ?? bet.point ?? bet.handicap;
  const line = suppliedLine === null || suppliedLine === undefined ? null : Number(suppliedLine);
  return matches.some((market) => (market.outcomes || []).some((outcome) => {
    const name = normalizeText(outcome.name || outcome.selection || "");
    const point = outcome.point ?? outcome.line;
    const isTeamMarket = ["moneyline", "spread"].includes(canonicalMarketKey(bet.market));
    const player = isTeamMarket ? "" : normalizeText(outcome.playerName || outcome.description || "");
    const playerMatch = player && selection.startsWith(player + name);
    const selectionMatch = isTeamMarket ? resolveTeamCode(outcome.name) === resolveTeamCode(bet.selection)
      : player ? playerMatch : name && (name === selection || selection.startsWith(name));
    return selectionMatch && (line === null || Number(point) === line);
  }));
}

function marketLabelMatches(key, label) {
  return canonicalMarketKey(key) === canonicalMarketKey(label);
}

function canonicalMarketKey(value) {
  const text = normalizeText(value);
  const groups = {
    moneyline: ["moneyline", "h2h"],
    spread: ["spread", "spreads", "pointspread"],
    total: ["total", "totals", "totalpoints"],
    passingYards: ["passingyards", "playerpassyds", "playerpassingyards"],
    passingAttempts: ["passingattempts", "playerpassattempts", "playerpassingattempts"],
    passingTouchdowns: ["passingtouchdowns", "playerpasstds", "playerpassingtouchdowns"],
    completions: ["completions", "playercompletions", "playerpassingcompletions"],
    rushingYards: ["rushingyards", "playerrushyds", "playerrushingyards"],
    rushingAttempts: ["rushingattempts", "playerrushattempts", "playerrushingattempts"],
    receivingYards: ["receivingyards", "playerreceptionyds", "playerreceivingyards"],
    receptions: ["receptions", "playerreceptions"],
    rushReceivingYards: ["rushreceivingyards", "playerrushreceptionyds", "playerrushingreceivingyards"],
    anytimeTd: ["anytimetouchdown", "anytimetouchdowns", "anytimetd", "anytimetdscorer", "playeranytimetd"],
  };
  return Object.entries(groups).find(([, names]) => names.includes(text))?.[0] || text;
}

export function weeklyMultiMarketFamily(bet) {
  const key = canonicalMarketKey(bet.market);
  if (key === "anytimeTd") return "anytime-td";
  if (["moneyline", "spread", "total"].includes(key)) return key;
  if (["passingYards", "passingAttempts", "passingTouchdowns", "completions"].includes(key)) return "passing-props";
  if (["rushingYards", "rushingAttempts"].includes(key)) return "rushing-props";
  if (["receivingYards", "receptions", "rushReceivingYards"].includes(key)) return "receiving-props";
  return "other";
}

function normalizeCode(value) {
  const text = normalizeText(value);
  const aliases = {
    ...Object.fromEntries(Object.entries(TEAM_ALIASES).map(([alias, code]) => [alias.toLowerCase(), code])),
    arizona: "ARI", arizonacardinals: "ARI", atlanta: "ATL", atlantafalcons: "ATL", baltimore: "BAL", baltimoreravens: "BAL",
    buffalo: "BUF", buffalobills: "BUF", carolina: "CAR", carolinapanthers: "CAR", chicago: "CHI", chicagobears: "CHI",
    cincinnati: "CIN", cincinnatibengals: "CIN", cleveland: "CLE", clevelandbrowns: "CLE", dallas: "DAL", dallascowboys: "DAL",
    denver: "DEN", denverbroncos: "DEN", detroit: "DET", detroitlions: "DET", greenbay: "GB", greenbaypackers: "GB",
    houston: "HOU", houstontexans: "HOU", indianapolis: "IND", indianapoliscolts: "IND", jacksonville: "JAX", jacksonvillejaguars: "JAX",
    kansascity: "KC", kansascitychiefs: "KC", lasvegas: "LV", lasvegasraiders: "LV", losangeleschargers: "LAC", chargers: "LAC",
    losangelesrams: "LAR", rams: "LAR", miami: "MIA", miamidolphins: "MIA", minnesota: "MIN", minnesotavikings: "MIN",
    newengland: "NE", newenglandpatriots: "NE", neworleans: "NO", neworleanssaints: "NO", newyorkgiants: "NYG", giants: "NYG",
    newyorkjets: "NYJ", jets: "NYJ", philadelphia: "PHI", philadelphiaeagles: "PHI", pittsburgh: "PIT", pittsburghsteelers: "PIT",
    sanfrancisco: "SF", sanfrancisco49ers: "SF", seattle: "SEA", seattleseahawks: "SEA", tampa: "TB", tampabay: "TB",
    tampabaybuccaneers: "TB", tennessee: "TEN", tennesseetitans: "TEN", washington: "WSH", washingtoncommanders: "WSH",
  };
  if (aliases[text]) return aliases[text];
  const known = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC", "LV", "LAC", "LAR", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SF", "SEA", "TB", "TEN", "WSH"];
  return known.find((code) => text === code.toLowerCase()) || String(value || "").trim().toUpperCase();
}

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function createWeeklyMultiCurrentHandler(overrides = {}) {
  const createClient = overrides.createClient || createWeeklyMultiClient;
  const getNow = overrides.getNow || (() => new Date());
  const resolveDisplayContext = overrides.resolveDisplayContext || ((now) =>
    resolveDisplayWeekContext(now, { fetchGames: overrides.fetchGames }));
  const fetchGames = overrides.fetchGames || fetchScheduleGamesForWindow;
  const settle = overrides.settleLegs || ((record) =>
    settleLockedLegs(record, { fetchGames, fetchStats: overrides.fetchStats, normaliseCode: normalizeCode }));

  return async function handler(req, res) {
    setWeeklyMultiReadCache(res, 30);
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const now = getNow();
      const cycle = getDisplayLockCycle(now);
      const savedBody = async (savedRecord, legResults, unresolved) => {
        setWeeklyMultiReadCache(res, unresolved ? 30 : 180);
        return res.status(200).json({
          status: savedRecord.generated_late ? "generated late" : savedRecord.partial ? "partial" : "locked",
          locked: true,
          season: savedRecord.season,
          week: savedRecord.week,
          record: savedRecord,
          ...(legResults ? { legResults } : {}),
        });
      };
      const readRecord = async (lockAtMs) => {
        const { data, error } = await createClient()
          .from("weekly_best_multis")
          .select("*")
          .eq("lock_at", new Date(lockAtMs).toISOString())
          .maybeSingle();
        if (error) throw error;
        return data;
      };
      if (!cycle.placeholder) {
        const savedRecord = await readRecord(cycle.lockAt);
        if (savedRecord) {
          const hasPlayerLegs = (savedRecord.legs || []).some(isPlayerLeg);
          const started = (savedRecord.legs || []).some((leg) => new Date(leg.kickoff || 0).getTime() <= now.getTime());
          const settlement = hasPlayerLegs && started ? await settle(savedRecord) : null;
          return savedBody(savedRecord, settlement?.legResults, settlement?.unresolved);
        }
      } else {
        // From Wednesday the display moves to the next week, but a previous-week
        // multi with unsettled legs stays visible until it is fully resolved.
        const previous = await readRecord(cycle.lockAt - 7 * 24 * 60 * 60 * 1000);
        if (previous?.legs?.length) {
          const settlement = await settle(previous);
          if (settlement.unresolved) return savedBody(previous, settlement.legResults, true);
        }
      }
      const context = await resolveDisplayContext(now);
      if (!context.available) {
        setWeeklyMultiReadCache(res, 30);
        return res.status(200).json({
          status: "not ready",
          locked: false,
          placeholder: false,
          season: context.season,
          week: context.week,
          lockAt: context.lockAt,
          reason: context.reason,
          message: "Weekly Best Multi is not ready yet. Please check back later.",
        });
      }
      if (context.placeholder) {
        setWeeklyMultiReadCache(res, 180);
        return res.status(200).json({
          status: "before lock",
          locked: false,
          placeholder: true,
          season: context.season,
          week: context.week,
          lockAt: context.lockAt,
        });
      }
      const firstKickoff = new Date(context.firstKickoffAt || "").getTime();
      if (Number.isFinite(firstKickoff) && now.getTime() >= firstKickoff) {
        setWeeklyMultiReadCache(res, 30);
        return res.status(200).json({
          status: "missed",
          locked: false,
          season: context.season,
          week: context.week,
          firstKickoffAt: context.firstKickoffAt,
          message: "No Weekly Best Multi was locked for this week.",
        });
      }
      setWeeklyMultiReadCache(res, 30);
      return res.status(200).json({
        status: "not ready",
        locked: false,
        season: context.season,
        week: context.week,
        lockAt: context.lockAt,
        message: `No shared Weekly Best Multi has been locked for Week ${context.week}. Scheduled locking requires fresh, complete saved predictions and eligible Best Bets with current odds.`,
      });
    } catch (error) {
      console.error("Weekly Best Multi read failed", error);
      setWeeklyMultiReadCache(res, 30);
      return res.status(500).json({ error: "Weekly Best Multi read failed" });
    }

function setWeeklyMultiReadCache(res, seconds) {
  res.setHeader("Cache-Control", `public, s-maxage=${seconds}, stale-while-revalidate=${seconds}`);
  res.setHeader("CDN-Cache-Control", `public, s-maxage=${seconds}`);
  res.setHeader("Vercel-CDN-Cache-Control", `public, s-maxage=${seconds}, stale-while-revalidate=${seconds}`);
}
  };
}

export function createWeeklyMultiLockHandler(overrides = {}) {
  const resolveContext = overrides.resolveContext || resolveLockWeekContext;
  const createClient = overrides.createClient || createWeeklyMultiClient;
  const fetchOdds = overrides.fetchOdds || ((...args) => fetch(...args));
  const getNow = overrides.getNow || (() => new Date());

  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    }

    const secret = process.env.CRON_SECRET;
    if (!secret || !secureBearerMatches(req.headers.authorization, secret)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const dryRun = String(req.query?.dryRun ?? req.query?.dry_run ?? req.body?.dryRun ?? req.body?.dry_run ?? "")
      .toLowerCase() === "true" || String(req.query?.dryRun ?? req.query?.dry_run ?? req.body?.dryRun ?? req.body?.dry_run ?? "") === "1";

    try {
      const now = getNow();
      const context = await resolveContext(now, { allowBeforeLock: dryRun });
      if (!context.available) {
        return res.status(200).json({
          status: context.notYetLocked ? "not yet locked" : "not ready",
          reason: context.reason,
          lockAt: context.lockAt,
          deadlineAt: context.deadlineAt,
        });
      }
      if (!context.eligible && !dryRun) {
        return res.status(200).json({
          status: "not yet locked",
          season: context.season,
          week: context.week,
          lockAt: context.lockAt,
          deadlineAt: context.deadlineAt,
        });
      }

      const supabase = createClient();
      const { data: existing, error: readError } = await supabase
        .from("weekly_best_multis")
        .select("*")
        .eq("season", context.season)
        .eq("week", context.week)
        .maybeSingle();
      if (readError) throw readError;
      if (existing && !dryRun) return res.status(200).json({ status: "already locked", record: existing });

      const atDeadline = lockIsPastDeadline(context, now);
      if (!dryRun && atDeadline) {
        const firstKickoff = new Date(context.firstKickoffAt || "").getTime();
        if (!Number.isFinite(firstKickoff)) {
          return res.status(200).json({
            status: "not ready",
            season: context.season,
            week: context.week,
            reason: "The first regular-season kickoff is unavailable",
          });
        }
        if (now.getTime() >= firstKickoff) {
          return res.status(200).json({
            status: "missed",
            season: context.season,
            week: context.week,
            firstKickoffAt: context.firstKickoffAt,
            message: "No Weekly Best Multi was locked for this week.",
          });
        }
      }

      const urls = getStoredOddsUrls(req);
      const readStored = async (url) => {
        const response = await fetchOdds(url, { cache: "no-store", headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`Stored odds request failed (${response.status})`);
        return response.json();
      };
      const [{ data: predictionRows, error: predictionError }, coreOdds, propOdds] = await Promise.all([
        supabase.from("prediction_snapshots").select("*").eq("season", context.season).eq("week", context.week),
        readStored(urls.core),
        readStored(urls.props),
      ]);
      if (predictionError) throw predictionError;
      const oddsPayload = mergeStoredOdds(coreOdds, propOdds);
      const snapshots = predictionSnapshotsForWeek(predictionRows, context, now);
      const freshOdds = isFreshOddsPayload(oddsPayload);
      const selection = buildWeeklyMultiSelection(snapshots, freshOdds ? oddsPayload : null, context, now);
      const dataReady = snapshots.length > 0 && freshOdds;
      const notReadyReason = !dataReady
        ? snapshots.length === 0 ? "No fresh, current-model complete saved predictions are available" : "Fresh stored odds snapshots are unavailable"
        : selection.complete ? null : "Fewer than five eligible legs qualify at the 55% probability floor";

      if (dryRun) {
        return res.status(200).json({
          status: !dataReady || !selection.complete ? "not ready" : "locked",
          dryRun: true,
          season: context.season,
          week: context.week,
          lockAt: context.lockAt,
          deadlineAt: context.deadlineAt,
          legCount: selection.legs.length,
          legs: selection.legs,
          threshold: selection.threshold,
          complete: selection.complete,
          reason: notReadyReason,
          oddsCacheStatus: oddsPayload.cacheStatus || "unavailable",
          predictionCount: snapshots.length,
        });
      }

      if (!atDeadline && (!dataReady || !selection.complete)) {
        return res.status(200).json({
          status: "not ready",
          season: context.season,
          week: context.week,
          lockAt: context.lockAt,
          deadlineAt: context.deadlineAt,
          legCount: selection.legs.length,
          threshold: selection.threshold,
          reason: notReadyReason,
          oddsCacheStatus: oddsPayload.cacheStatus || "unavailable",
        });
      }

      const reason = selection.complete
        ? null
        : [notReadyReason, !dataReady ? "Saved at retry deadline with incomplete inputs" : null].filter(Boolean).join("; ");
      const record = makeWeeklyMultiRecord(selection, context, now, reason);
      const { data: inserted, error: insertError } = await supabase
        .from("weekly_best_multis")
        .insert(record)
        .select("*")
        .single();

      if (insertError) {
        if (insertError.code === "23505") {
          const { data: winner, error: winnerError } = await supabase
            .from("weekly_best_multis")
            .select("*")
            .eq("season", context.season)
            .eq("week", context.week)
            .single();
          if (winnerError) throw winnerError;
          return res.status(200).json({ status: "already locked", record: winner });
        }
        throw insertError;
      }

      const status = record.generated_late ? "generated late" : record.partial ? "partial" : "locked";
      return res.status(200).json({ status, record: inserted });
    } catch (error) {
      console.error("Weekly Best Multi lock failed", error);
      return res.status(500).json({ error: "Weekly Best Multi lock failed" });
    }
  };
}
