import process from "node:process";

export const PROVIDER_PRIMARY = "parlay";
export const PROVIDER_NAMES = Object.freeze(["parlay", "sharp", "theoddsapi", "propline"]);

export const COMPLETENESS = Object.freeze({
  COMPLETE: "COMPLETE",
  MORE_PAGES_AVAILABLE: "MORE_PAGES_AVAILABLE",
  SOURCE_TRUNCATED: "SOURCE_TRUNCATED",
  SOURCE_DEGRADED: "SOURCE_DEGRADED",
  UNKNOWN: "UNKNOWN",
});

export function createProviderRegistry({ primary = PROVIDER_PRIMARY, fallbacks = [], providers = [] } = {}) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const order = [primary, ...fallbacks].filter((id, index, values) => values.indexOf(id) === index);
  for (const id of order) {
    if (!providerMap.has(id)) throw new Error(`Configured odds provider is not registered: ${id}`);
  }
  return {
    primary,
    fallbacks: order.slice(1),
    providers: providerMap,
    order,
  };
}

export function readProviderSelection(env = process.env) {
  return {
    primary: normalizeProviderId(env.ODDS_PROVIDER_PRIMARY) || PROVIDER_PRIMARY,
    fallbacks: String(env.ODDS_PROVIDER_FALLBACKS || "")
      .split(",")
      .map(normalizeProviderId)
      .filter(Boolean),
  };
}

export function selectProviderResult(results, registry) {
  const byProvider = results instanceof Map
    ? results
    : new Map((results || []).map((result) => [result.provider, result]));

  const primaryResult = byProvider.get(registry.primary);
  if (primaryResult?.status === "success" && primaryResult.hasValidQuotes === true) {
    return { ...primaryResult, selectedProvider: registry.primary, fallback: false };
  }
  if (!primaryResult) {
    return unavailableResult(registry, byProvider);
  }

  const budgetExhausted = primaryResult.reason === "budget_exhausted" ||
    primaryResult.status === "budget_exhausted";
  for (const provider of registry.fallbacks) {
    const result = byProvider.get(provider);
    if (result?.status !== "success" || result.hasValidQuotes !== true) continue;
    if (budgetExhausted && !(result.fallbackAllowed === true && result.actualCredits === 0)) continue;
    return { ...result, selectedProvider: provider, fallback: true };
  }

  return unavailableResult(registry, byProvider);
}

export function normalizeEventIdentity({ season, week, kickoff, homeTeam, awayTeam }) {
  const timestamp = Date.parse(kickoff);
  const home = canonicalTeamIdentity(homeTeam);
  const away = canonicalTeamIdentity(awayTeam);
  if (!Number.isInteger(Number(season)) || !Number.isInteger(Number(week)) ||
      !Number.isFinite(timestamp) || !home || !away || home === away) {
    throw new Error("Odds event is missing a valid season, week, kickoff, or team identity");
  }
  return `nfl:${Number(season)}:${Number(week)}:${away}@${home}:${new Date(timestamp).toISOString()}`;
}

export function normalizeTeamIdentity(value) {
  const normalized = String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized || null;
}

export function canonicalTeamIdentity(value) {
  const normalized = normalizeTeamIdentity(value);
  if (!normalized) return null;
  return NFL_TEAM_IDENTITIES.get(normalized) || normalized;
}

export function quoteSnapshotKey(quote) {
  const identity = [
    quote.provider,
    quote.season,
    quote.week,
    quote.providerEventId,
    quote.bookmaker,
    quote.market,
    quote.rawProviderMarket,
    quote.playerId || quote.playerName || "",
    quote.selection || "",
    quote.side || "",
    quote.line ?? "",
  ];
  return identity.map((part) => encodeURIComponent(String(part))).join("|");
}

export function createLockedQuoteSnapshot(quote, assessment = {}) {
  const snapshot = {
    provider: quote.provider,
    providerEventId: quote.providerEventId,
    canonicalMatchupIdentity: quote.canonicalMatchupIdentity ?? null,
    season: quote.season ?? null,
    week: quote.week ?? null,
    matchup: quote.matchup ? structuredClone(quote.matchup) : null,
    bookmaker: quote.bookmaker,
    market: quote.market,
    rawProviderMarket: quote.rawProviderMarket,
    selection: quote.selection,
    side: quote.side ?? null,
    playerId: quote.playerId ?? null,
    playerName: quote.playerName ?? null,
    line: quote.line ?? null,
    americanOdds: quote.americanOdds,
    decimalOdds: quote.decimalOdds,
    impliedProbability: quote.impliedProbability,
    providerTimestamp: quote.providerTimestamp ?? null,
    fetchedAt: quote.fetchedAt,
    cacheFetchedAt: quote.fetchedAt,
    modelProbability: assessment.modelProbability ?? null,
    edge: assessment.edge ?? null,
  };
  return deepFreeze(snapshot);
}

function normalizeProviderId(value) {
  const id = String(value || "").trim().toLowerCase();
  return id || null;
}

function unavailableResult(registry, byProvider) {
  return {
    status: "unavailable",
    selectedProvider: null,
    fallback: false,
    diagnostics: registry.order.map((provider) => ({
      provider,
      status: byProvider.get(provider)?.status || "not_attempted",
    })),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const NFL_TEAM_IDENTITIES = new Map([
  ["ari", "ARI"], ["arz", "ARI"], ["arizona", "ARI"], ["arizonacardinals", "ARI"], ["cardinals", "ARI"],
  ["atl", "ATL"], ["atlanta", "ATL"], ["atlantafalcons", "ATL"], ["falcons", "ATL"],
  ["bal", "BAL"], ["baltimore", "BAL"], ["baltimoreravens", "BAL"], ["ravens", "BAL"],
  ["buf", "BUF"], ["buffalo", "BUF"], ["buffalobills", "BUF"], ["bills", "BUF"],
  ["car", "CAR"], ["carolina", "CAR"], ["carolinapanthers", "CAR"], ["panthers", "CAR"],
  ["chi", "CHI"], ["chicago", "CHI"], ["chicagobears", "CHI"], ["bears", "CHI"],
  ["cin", "CIN"], ["cincinnati", "CIN"], ["cincinnatibengals", "CIN"], ["bengals", "CIN"],
  ["cle", "CLE"], ["cleveland", "CLE"], ["clevelandbrowns", "CLE"], ["browns", "CLE"],
  ["dal", "DAL"], ["dallas", "DAL"], ["dallascowboys", "DAL"], ["cowboys", "DAL"],
  ["den", "DEN"], ["denver", "DEN"], ["denverbroncos", "DEN"], ["broncos", "DEN"],
  ["det", "DET"], ["detroit", "DET"], ["detroitlions", "DET"], ["lions", "DET"],
  ["gb", "GB"], ["gnb", "GB"], ["greenbay", "GB"], ["greenbaypackers", "GB"], ["packers", "GB"],
  ["hou", "HOU"], ["houston", "HOU"], ["houstontexans", "HOU"], ["texans", "HOU"],
  ["ind", "IND"], ["indianapolis", "IND"], ["indianapoliscolts", "IND"], ["colts", "IND"],
  ["jax", "JAX"], ["jac", "JAX"], ["jacksonville", "JAX"], ["jacksonvillejaguars", "JAX"], ["jaguars", "JAX"],
  ["kc", "KC"], ["kan", "KC"], ["kansascity", "KC"], ["kansascitychiefs", "KC"], ["chiefs", "KC"],
  ["lv", "LV"], ["oak", "LV"], ["lasvegas", "LV"], ["lasvegasraiders", "LV"], ["raiders", "LV"],
  ["lac", "LAC"], ["sd", "LAC"], ["sandiego", "LAC"], ["losangeleschargers", "LAC"], ["chargers", "LAC"],
  ["lar", "LAR"], ["stl", "LAR"], ["losangelesrams", "LAR"], ["rams", "LAR"],
  ["mia", "MIA"], ["miami", "MIA"], ["miamidolphins", "MIA"], ["dolphins", "MIA"],
  ["min", "MIN"], ["minnesota", "MIN"], ["minnesotavikings", "MIN"], ["vikings", "MIN"],
  ["ne", "NE"], ["nwe", "NE"], ["newengland", "NE"], ["newenglandpatriots", "NE"], ["patriots", "NE"],
  ["no", "NO"], ["nor", "NO"], ["neworleans", "NO"], ["neworleanssaints", "NO"], ["saints", "NO"],
  ["nyg", "NYG"], ["newyorkgiants", "NYG"], ["giants", "NYG"],
  ["nyj", "NYJ"], ["newyorkjets", "NYJ"], ["jets", "NYJ"],
  ["phi", "PHI"], ["philadelphia", "PHI"], ["philadelphiaeagles", "PHI"], ["eagles", "PHI"],
  ["pit", "PIT"], ["pittsburgh", "PIT"], ["pittsburghsteelers", "PIT"], ["steelers", "PIT"],
  ["sf", "SF"], ["sfo", "SF"], ["sanfrancisco", "SF"], ["sanfrancisco49ers", "SF"], ["49ers", "SF"],
  ["sea", "SEA"], ["seattle", "SEA"], ["seattleseahawks", "SEA"], ["seahawks", "SEA"],
  ["tb", "TB"], ["tampa", "TB"], ["tampabay", "TB"], ["tampabaybuccaneers", "TB"], ["buccaneers", "TB"],
  ["ten", "TEN"], ["tennessee", "TEN"], ["tennesseetitans", "TEN"], ["titans", "TEN"],
  ["was", "WAS"], ["wsh", "WAS"], ["washington", "WAS"], ["washingtoncommanders", "WAS"], ["commanders", "WAS"],
]);
