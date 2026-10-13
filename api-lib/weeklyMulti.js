import { createClient } from "@supabase/supabase-js";

const BALLDONTLIE_GAMES_URL = "https://api.balldontlie.io/nfl/v1/games";
const ODDS_MAX_AGE_MS = 15 * 60 * 1000;
const PREDICTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RETRY_WINDOW_MS = 30 * 60 * 1000;
const LEG_COUNT = 5;
const START_PROBABILITY = 0.65;
const FLOOR_PROBABILITY = 0.55;
const PROBABILITY_STEP = 0.025;
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

export async function resolveLockWeekContext(now = new Date(), { allowBeforeLock = false, fetchGames = fetchSeasonGames } = {}) {
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
      reason: `Schedule data is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ...context,
    eligible: cycle.eligible,
    notYetLocked: false,
    dryRunTarget: allowBeforeLock ? new Date(lockAt).toISOString() : undefined,
  };
}

export async function resolveDisplayWeekContext(now = new Date(), { fetchGames = fetchSeasonGames } = {}) {
  const cycle = getDisplayLockCycle(now);
  let context;
  try {
    context = await resolveScheduleWeek(cycle.lockAt, fetchGames);
  } catch (error) {
    context = {
      available: false,
      lockAt: new Date(cycle.lockAt).toISOString(),
      deadlineAt: new Date(cycle.lockAt + RETRY_WINDOW_MS).toISOString(),
      reason: `Schedule data is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    ...context,
    placeholder: context.available && cycle.placeholder,
    notReady: !context.available,
  };
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

async function resolveScheduleWeek(lockAt, fetchGames = fetchSeasonGames) {
  const end = lockAt + 7 * 24 * 60 * 60 * 1000;
  const calendarYears = [...new Set([new Date(lockAt).getUTCFullYear(), new Date(lockAt).getUTCFullYear() - 1])];
  const gamesBySeason = await Promise.all(calendarYears.map(fetchGames));
  const inWindow = gamesBySeason.flat().filter((game) => {
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
  };
}

async function fetchSeasonGames(season) {
  const apiKey = process.env.BALLDONTLIE_API_KEY;
  if (!apiKey) throw new Error("BALLDONTLIE_API_KEY is not configured for weekly lock week resolution");
  const games = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({ "seasons[]": String(season), per_page: "100" });
    if (cursor !== null) params.set("cursor", String(cursor));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(`${BALLDONTLIE_GAMES_URL}?${params.toString()}`, {
        signal: controller.signal,
        cache: "no-store",
        headers: { Authorization: apiKey, Accept: "application/json" },
      });
    } finally {
      clearTimeout(timeout);
    }
    const body = await response.json();
    if (!response.ok) throw new Error(body?.error?.message || body?.error || `Schedule request failed (${response.status})`);
    games.push(...(Array.isArray(body.data) ? body.data.map((game) => ({ ...game, season: Number(game.season) || season })) : []));
    cursor = body.meta?.next_cursor ?? null;
  } while (cursor !== null);
  return games;
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
    const event = findOddsEvent(oddsEvents, snapshot.awayCode, snapshot.homeCode);
    if (!event || isFallbackEvent(event)) {
      reasonCounts.fallbackOdds += 1;
      continue;
    }
    const bets = snapshot.bestBets?.recommendations || snapshot.dataQuality?.bestBetsPayload?.recommendations || [];
    for (const bet of bets) {
      const decimalOdds = getDecimalOddsValue(bet);
      const modelProbability = Number(bet.modelProbability);
      const quoteTime = new Date(bet.updatedAt || 0).getTime();
      if (!Number.isFinite(quoteTime) || quoteTime <= 0 || now.getTime() - quoteTime > ODDS_MAX_AGE_MS || quoteTime > now.getTime() + 60000) {
        reasonCounts.staleOdds += 1;
        continue;
      }
      if (!Number.isFinite(decimalOdds) || decimalOdds <= 1 || !Number.isFinite(modelProbability) || modelProbability < 0 || modelProbability > 1 ||
        !bet.selection || !bet.market || !isRealBookmaker(bet.sportsbook, event) || !hasCurrentBookMarket(event, bet)) {
        reasonCounts.invalidCandidates += 1;
        continue;
      }
      const impliedProbability = 1 / decimalOdds;
      const edge = modelProbability - impliedProbability;
      if (edge <= 0) continue;
      candidates.push({
        ...bet,
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
    for (const candidate of ranked) {
      if (candidate.modelProbability < threshold) continue;
      if (!byMatchup.has(candidate.matchupKey)) byMatchup.set(candidate.matchupKey, candidate);
    }
    distinctMatchups = [...byMatchup.values()].sort(compareCandidates);
    if (distinctMatchups.length >= LEG_COUNT || threshold <= FLOOR_PROBABILITY) break;
    threshold = Math.max(FLOOR_PROBABILITY, Math.round((threshold - PROBABILITY_STEP) * 10000) / 10000);
  }
  const legs = distinctMatchups.slice(0, LEG_COUNT);
  const oddsTimes = legs.map((leg) => new Date(leg.oddsUpdatedAt).getTime()).filter(Number.isFinite);
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

export function getOddsEndpointUrl(request) {
  const deploymentHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  const requestHost = request?.headers?.["x-forwarded-host"] || request?.headers?.host;
  const host = deploymentHost || requestHost;
  if (!host) throw new Error("Could not determine the deployment host for odds refresh");
  const hostname = String(host).replace(/^https?:\/\//, "").replace(/\/$/, "");
  const protocol = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(hostname) ? "http" : "https";
  return `${protocol}://${hostname}/api/nfl/odds?weeklyMultiRefresh=${Date.now()}`;
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
  return second.expectedValue - first.expectedValue || second.edge - first.edge || second.modelProbability - first.modelProbability;
}

function getDecimalOddsValue(bet) {
  if (bet?.decimalOdds !== null && bet?.decimalOdds !== undefined && bet?.decimalOdds !== "") {
    const decimal = Number(bet.decimalOdds);
    if (Number.isFinite(decimal)) return decimal;
  }
  const american = Number(bet?.price);
  if (!Number.isFinite(american) || american === 0) return null;
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

function findOddsEvent(events, away, home) {
  const awayCode = normalizeCode(away);
  const homeCode = normalizeCode(home);
  return events.find((event) => normalizeCode(event.away_team_code || event.away_code || event.away_team) === awayCode &&
    normalizeCode(event.home_team_code || event.home_code || event.home_team) === homeCode) || null;
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
  const line = Number(bet.line ?? bet.point ?? bet.handicap);
  return matches.some((market) => (market.outcomes || []).some((outcome) => {
    const name = normalizeText(outcome.name || outcome.selection || "");
    const point = outcome.point ?? outcome.line;
    return (name === selection || name.includes(selection) || selection.includes(name)) &&
      (!Number.isFinite(line) || Number(point) === line);
  }));
}

function marketLabelMatches(key, label) {
  const market = String(key || "").toLowerCase().replace(/[\s-]+/g, "_");
  if (label.includes("moneyline")) return ["h2h", "moneyline", "money_line"].includes(market);
  if (label.includes("spread")) return ["spreads", "spread", "point_spread"].includes(market);
  if (label.includes("total")) return ["totals", "total", "total_points"].includes(market);
  return market === label.replace(/[\s-]+/g, "_") || normalizeText(market) === normalizeText(label);
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
