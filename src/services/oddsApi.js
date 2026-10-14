const ODDS_CACHE_KEY = "fourth-down:nfl-odds";
const ODDS_CACHE_TTL_MS = 5 * 60 * 1000;

let memoryCache = null;
let pendingRequest = null;

export async function getNflOdds(signal, options = {}) {
  const forceRefresh = options.forceRefresh === true;

  if (!forceRefresh) {
    const cached = getCachedOdds();
    if (cached) return cached;
  }

  if (pendingRequest) return pendingRequest;

  pendingRequest = requestNflOdds(signal)
    .then((events) => {
      saveCachedOdds(events);
      return events;
    })
    .catch((error) => {
      const stale = getStaleOdds();
      if (stale.length > 0) {
        console.warn("Odds refresh failed. Using cached odds.", error);
        return stale;
      }
      throw error;
    })
    .finally(() => {
      pendingRequest = null;
    });

  return pendingRequest;
}

const PROPS_CACHE_KEY = "fourth-down:nfl-odds-props";
const PROPS_CACHE_TTL_MS = 30 * 60 * 1000;

let propsMemoryCache = null;
let pendingPropsRequest = null;

/*
 * Core odds plus optional player props (used by Best Bets). Props are read from
 * the stored Supabase snapshots (/api/nfl/odds?props=1&source=snapshot), which
 * never call SharpAPI. They never block or discard core odds: if the props
 * request fails, core events are returned unchanged.
 */
export async function getNflOddsWithProps(signal, options = {}) {
  const coreEvents = await getNflOdds(signal, options);

  let propEvents = [];
  try {
    propEvents = await getPropEvents(signal, options.forceRefresh === true);
  } catch (error) {
    console.warn("Player prop odds unavailable. Using core odds only.", error);
  }

  return mergePropEvents(coreEvents, propEvents);
}

async function getPropEvents(signal, forceRefresh) {
  if (!forceRefresh) {
    const cached = readPropsCache();
    if (cached) return cached;
  }

  if (!pendingPropsRequest) {
    pendingPropsRequest = requestNflOdds(signal, "/api/nfl/odds?props=1&source=snapshot")
      .then((events) => {
        // Only keep non-empty prop responses so a rate-limited miss is retried.
        if (events.length > 0) savePropsCache(events);
        return events;
      })
      .finally(() => {
        pendingPropsRequest = null;
      });
  }

  return pendingPropsRequest;
}

function readPropsCache() {
  if (propsMemoryCache && Date.now() - propsMemoryCache.savedAt < PROPS_CACHE_TTL_MS) {
    return propsMemoryCache.events;
  }

  try {
    const cached = JSON.parse(sessionStorage.getItem(PROPS_CACHE_KEY) || "null");
    if (
      cached &&
      Array.isArray(cached.events) &&
      Date.now() - Number(cached.savedAt || 0) < PROPS_CACHE_TTL_MS
    ) {
      propsMemoryCache = cached;
      return cached.events;
    }
  } catch {
    // Fall through to a network request.
  }

  return null;
}

function savePropsCache(events) {
  propsMemoryCache = { events, savedAt: Date.now() };

  try {
    sessionStorage.setItem(PROPS_CACHE_KEY, JSON.stringify(propsMemoryCache));
  } catch {
    // In-memory caching remains available.
  }
}

function mergePropEvents(coreEvents, propEvents) {
  if (!Array.isArray(propEvents) || propEvents.length === 0) return coreEvents;

  const teamKey = (event) =>
    `${String(event?.away_team || "").toLowerCase()}@${String(event?.home_team || "").toLowerCase()}`;
  const byId = new Map(coreEvents.map((event) => [event.id, event]));
  const byTeams = new Map(coreEvents.map((event) => [teamKey(event), event]));
  const additions = new Map();

  for (const propEvent of propEvents) {
    const target = byId.get(propEvent.id) || byTeams.get(teamKey(propEvent));
    if (!target) continue;
    additions.set(target, [...(additions.get(target) || []), ...(propEvent.bookmakers || [])]);
  }

  return coreEvents.map((event) => {
    const extra = additions.get(event);
    if (!extra) return event;

    const bookmakers = (event.bookmakers || []).map((bookmaker) => ({
      ...bookmaker,
      markets: [...(bookmaker.markets || [])],
    }));

    for (const propBookmaker of extra) {
      const existing = bookmakers.find((bookmaker) => bookmaker.key === propBookmaker.key);
      if (existing) existing.markets.push(...(propBookmaker.markets || []));
      else bookmakers.push({ ...propBookmaker, markets: [...(propBookmaker.markets || [])] });
    }

    return { ...event, bookmakers };
  });
}

async function requestNflOdds(signal, url = "/api/nfl/odds") {
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
  });

  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      response.ok
        ? "The odds endpoint returned invalid JSON"
        : text.slice(0, 300) || `Odds request failed (${response.status})`
    );
  }

  if (!response.ok) {
    throw new Error(extractErrorMessage(body, response.status));
  }

  return Array.isArray(body?.events) ? body.events : [];
}

function getCachedOdds() {
  if (memoryCache && Date.now() - memoryCache.savedAt < ODDS_CACHE_TTL_MS) {
    return memoryCache.events;
  }

  try {
    const raw = sessionStorage.getItem(ODDS_CACHE_KEY);
    if (!raw) return null;

    const cached = JSON.parse(raw);

    if (!cached || !Array.isArray(cached.events)) {
      sessionStorage.removeItem(ODDS_CACHE_KEY);
      return null;
    }

    if (Date.now() - Number(cached.savedAt || 0) >= ODDS_CACHE_TTL_MS) {
      return null;
    }

    memoryCache = cached;
    return cached.events;
  } catch {
    return null;
  }
}

function getStaleOdds() {
  if (memoryCache && Array.isArray(memoryCache.events)) {
    return memoryCache.events;
  }

  try {
    const raw = sessionStorage.getItem(ODDS_CACHE_KEY);
    if (!raw) return [];
    const cached = JSON.parse(raw);
    return Array.isArray(cached?.events) ? cached.events : [];
  } catch {
    return [];
  }
}

function saveCachedOdds(events) {
  const cached = {
    events: Array.isArray(events) ? events : [],
    savedAt: Date.now(),
  };

  memoryCache = cached;

  try {
    sessionStorage.setItem(ODDS_CACHE_KEY, JSON.stringify(cached));
  } catch {
    // In-memory caching remains available.
  }
}

export function clearNflOddsCache() {
  memoryCache = null;

  try {
    sessionStorage.removeItem(ODDS_CACHE_KEY);
  } catch {
    // Nothing else required.
  }
}

export function findOddsForGame(events, game) {
  if (!Array.isArray(events) || !game) return null;
  const awayCode = resolveTeamCode(game.away || game.awayCode || game.awayName);
  const homeCode = resolveTeamCode(game.home || game.homeCode || game.homeName);

  const direct = events.find((event) =>
    resolveTeamCode(event?.away_team_code || event?.away_code || event?.away_team) === awayCode &&
    resolveTeamCode(event?.home_team_code || event?.home_code || event?.home_team) === homeCode
  );
  if (direct) return direct;

  return events.find((event) =>
    resolveTeamCode(event?.away_team_code || event?.away_code || event?.away_team) === homeCode &&
    resolveTeamCode(event?.home_team_code || event?.home_code || event?.home_team) === awayCode
  ) || null;
}

function resolveTeamCode(value) {
  const name = normalizeName(value);
  const aliases = {
    ari: "ARI", arz: "ARI", arizona: "ARI", cardinals: "ARI", arizonacardinals: "ARI",
    nyg: "NYG", giants: "NYG", nygiants: "NYG", newyorkgiants: "NYG",
    lar: "LAR", la: "LAR", rams: "LAR", losangelesrams: "LAR",
    phi: "PHI", eagles: "PHI", philadelphiaeagles: "PHI",
    sf: "SF", sfo: "SF", "49ers": "SF", sanfrancisco: "SF", sanfrancisco49ers: "SF",
  };
  if (aliases[name]) return aliases[name];
  for (const [code, canonical] of Object.entries(TEAM_NAME_ALIASES)) {
    const canonicalName = normalizeName(canonical);
    const nickname = normalizeName(teamNickname(canonical));
    if (name === normalizeName(code) || name === canonicalName || name === nickname) return code;
  }
  return normalizeTeamCode(value);
}

function buildTeamAliases(code, suppliedName) {
  const normalizedCode = normalizeTeamCode(code);
  const canonicalName = TEAM_NAME_ALIASES[normalizedCode];
  const aliases = new Set([
    normalizeName(normalizedCode),
    normalizeName(suppliedName),
    normalizeName(canonicalName),
    normalizeName(teamNickname(canonicalName)),
  ]);

  if (normalizedCode === "SF") {
    aliases.add("49ers");
    aliases.add("sanfrancisco49ers");
    aliases.add("sanfrancisco");
    aliases.add("sf");
    aliases.add("sfo");
  }

  if (normalizedCode === "ARI") {
    aliases.add("cardinals");
    aliases.add("arizonacardinals");
    aliases.add("arizona");
    aliases.add("ari");
    aliases.add("arz");
  }

  aliases.delete("");
  return aliases;
}

function aliasesOverlap(firstAliases, secondAliases) {
  for (const first of firstAliases) {
    for (const second of secondAliases) {
      if (
        first === second ||
        first.endsWith(second) ||
        second.endsWith(first)
      ) {
        return true;
      }
    }
  }

  return false;
}

function teamNickname(value) {
  const words = String(value || "").trim().split(/\s+/);
  return words[words.length - 1] || "";
}

function normalizeTeamCode(value) {
  const code = String(value || "").trim().toUpperCase();

  return (
    {
      ARZ: "ARI",
      WAS: "WSH",
      LA: "LAR",
      JAC: "JAX",
      OAK: "LV",
      SD: "LAC",
      STL: "LAR",
      SFO: "SF",
      SF49ERS: "SF",
      "49ERS": "SF",
    }[code] || code
  );
}

const TEAM_NAME_ALIASES = {
  ARI: "Arizona Cardinals",
  ATL: "Atlanta Falcons",
  BAL: "Baltimore Ravens",
  BUF: "Buffalo Bills",
  CAR: "Carolina Panthers",
  CHI: "Chicago Bears",
  CIN: "Cincinnati Bengals",
  CLE: "Cleveland Browns",
  DAL: "Dallas Cowboys",
  DEN: "Denver Broncos",
  DET: "Detroit Lions",
  GB: "Green Bay Packers",
  HOU: "Houston Texans",
  IND: "Indianapolis Colts",
  JAX: "Jacksonville Jaguars",
  KC: "Kansas City Chiefs",
  LV: "Las Vegas Raiders",
  LAC: "Los Angeles Chargers",
  LAR: "Los Angeles Rams",
  MIA: "Miami Dolphins",
  MIN: "Minnesota Vikings",
  NE: "New England Patriots",
  NO: "New Orleans Saints",
  NYG: "New York Giants",
  NYJ: "New York Jets",
  PHI: "Philadelphia Eagles",
  PIT: "Pittsburgh Steelers",
  SF: "San Francisco 49ers",
  SEA: "Seattle Seahawks",
  TB: "Tampa Bay Buccaneers",
  TEN: "Tennessee Titans",
  WSH: "Washington Commanders",
};

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function extractErrorMessage(body, status) {
  const value =
    body?.details ||
    body?.error?.message ||
    body?.message ||
    body?.error;

  if (typeof value === "string") return value;
  return `Odds request failed (${status})`;
}
