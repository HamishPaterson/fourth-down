const BALLDONTLIE_STATS_URL = "https://api.balldontlie.io/nfl/v1/stats";
const DAY_MS = 24 * 60 * 60 * 1000;

// BALLDONTLIE per-player game stat fields for each supported prop market.
const STAT_FIELDS = {
  passingyards: ["passing_yards"],
  passingtouchdowns: ["passing_touchdowns"],
  passingattempts: ["passing_attempts"],
  completions: ["passing_completions"],
  rushingyards: ["rushing_yards"],
  rushingattempts: ["rushing_attempts"],
  receptions: ["receptions"],
  receivingyards: ["receiving_yards"],
  rushreceivingyards: ["rushing_yards", "receiving_yards"],
};

const MARKET_ALIASES = {
  playerpassyds: "passingyards",
  playerpasstds: "passingtouchdowns",
  playerpassattempts: "passingattempts",
  playercompletions: "completions",
  playerrushyds: "rushingyards",
  playerrushattempts: "rushingattempts",
  playerreceptions: "receptions",
  playerreceptionyds: "receivingyards",
  playerreceivingyds: "receivingyards",
  playerrushreceptionyds: "rushreceivingyards",
  rushingreceivingyards: "rushreceivingyards",
};

const TEAM_MARKET = /moneyline|h2h|spread|total/i;

function marketKey(market) {
  const key = String(market || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return MARKET_ALIASES[key] || key;
}

export function isAnytimeTdLeg(leg) {
  return /anytimetouchdown|playeranytimetd/.test(String(leg?.market || "").toLowerCase().replace(/[^a-z0-9]/g, "")) ||
    /anytime\s*(td|touchdown)/i.test(String(leg?.selection || ""));
}

export function isPlayerLeg(leg) {
  return isAnytimeTdLeg(leg) || Boolean(STAT_FIELDS[marketKey(leg?.market)]);
}

export function isTeamLeg(leg) {
  return !isPlayerLeg(leg) && TEAM_MARKET.test(String(leg?.market || ""));
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sumFields(record, fields) {
  const values = fields.map((field) => number(record?.[field]));
  if (values.every((value) => value === null)) return null;
  return values.reduce((total, value) => total + (value ?? 0), 0);
}

function normaliseName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\b(jr|sr|ii|iii|iv)\b/g, " ").replace(/\s+/g, " ").trim();
}

function recordName(record) {
  const player = record?.player || {};
  return normaliseName(player.full_name || `${player.first_name || ""} ${player.last_name || ""}`);
}

// "J.K. Dobbins" and "Justin Herbert" both resolve by last name plus first initial.
function namesMatch(legName, statName) {
  const legTokens = legName.split(" ").filter(Boolean);
  const statTokens = statName.split(" ").filter(Boolean);
  if (legTokens.length < 2 || statTokens.length < 2) return false;
  return legTokens.at(-1) === statTokens.at(-1) && legTokens[0][0] === statTokens[0][0];
}
function parsePlayerLeg(leg) {
  const selection = String(leg?.selection || "");
  if (isAnytimeTdLeg(leg)) {
    const name = selection.replace(/\s*anytime\s*(td|touchdown).*$/i, "");
    return { name: normaliseName(name), anytime: true };
  }
  const match = selection.match(/^(.*?)\s+(over|under)\s+(-?\d+(?:\.\d+)?)/i);
  if (!match) return null;
  // The locked line wins over anything parsed from text.
  const line = number(leg.line ?? leg.point ?? leg.handicap) ?? Number(match[3]);
  return { name: normaliseName(match[1]), side: match[2].toLowerCase(), line };
}

// Grades one locked player leg against final per-player game stats.
// Returns won | lost | push | pending; it never guesses when data is missing.
export function gradePlayerLeg(leg, records) {
  const parsed = parsePlayerLeg(leg);
  if (!parsed || !parsed.name || !Array.isArray(records)) return "pending";
  const matches = records.filter((record) => namesMatch(parsed.name, recordName(record)));
  if (matches.length !== 1) return "pending";
  const record = matches[0];
  if (parsed.anytime) {
    const touchdowns = sumFields(record, ["rushing_touchdowns", "receiving_touchdowns"]);
    if (touchdowns === null) return "pending";
    return touchdowns > 0 ? "won" : "lost";
  }
  const fields = STAT_FIELDS[marketKey(leg.market)];
  if (!fields || !Number.isFinite(parsed.line)) return "pending";
  const actual = sumFields(record, fields);
  if (actual === null) return "pending";
  if (actual === parsed.line) return "push";
  return (parsed.side === "over" ? actual > parsed.line : actual < parsed.line) ? "won" : "lost";
}

export async function fetchPlayerStatsForGames(gameIds, { fetchImpl = fetch } = {}) {
  const apiKey = process.env.BALLDONTLIE_API_KEY;
  if (!apiKey) throw new Error("BALLDONTLIE_API_KEY is not configured for player settlement");
  const records = [];
  let cursor = null;
  do {
    const params = new URLSearchParams({ per_page: "100" });
    for (const id of gameIds) params.append("game_ids[]", String(id));
    if (cursor !== null) params.set("cursor", String(cursor));
    const response = await fetchImpl(`${BALLDONTLIE_STATS_URL}?${params.toString()}`, {
      headers: { Authorization: apiKey, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Player stats request failed (${response.status})`);
    const body = await response.json();
    records.push(...(body.data || []));
    cursor = body.meta?.next_cursor ?? null;
  } while (cursor !== null);
  return records;
}

function isFinalGame(game) {
  const status = String(game?.status || "").toLowerCase();
  return status.includes("final") || status.includes("complete");
}

// Reads settlement state for a locked record. Locked legs are never modified.
// legResults holds player-leg grades (null for team legs, which the client grades
// from the results ledger); unresolved is true while any leg cannot yet be settled.
export async function settleLockedLegs(record, { fetchGames, fetchStats = fetchPlayerStatsForGames, normaliseCode }) {
  const legs = Array.isArray(record?.legs) ? record.legs : [];
  if (!legs.length) return { legResults: [], unresolved: false };
  const empty = legs.map(() => null);
  try {
    const lockAt = new Date(record.lock_at).getTime();
    const games = await fetchGames(lockAt, lockAt + 7 * DAY_MS);
    const byMatchup = new Map(games.map((game) => [
      `${normaliseCode(game.visitor_team?.abbreviation)}:${normaliseCode(game.home_team?.abbreviation)}`,
      game,
    ]));
    const gameFor = (leg) => byMatchup.get(`${normaliseCode(leg.awayCode)}:${normaliseCode(leg.homeCode)}`);
    const finalPlayerGames = [...new Set(legs.filter(isPlayerLeg).map(gameFor).filter((game) => game && isFinalGame(game)).map((game) => game.id))];
    const stats = finalPlayerGames.length ? await fetchStats(finalPlayerGames) : [];
    const legResults = legs.map((leg) => {
      if (!isPlayerLeg(leg)) return null;
      const game = gameFor(leg);
      if (!game || !isFinalGame(game)) return "pending";
      const teams = new Set([normaliseCode(leg.awayCode), normaliseCode(leg.homeCode)]);
      const records = stats.filter((row) => String(row.game?.id ?? row.game_id) === String(game.id) &&
        teams.has(normaliseCode(row.team?.abbreviation)));
      return gradePlayerLeg(leg, records);
    });
    const unresolved = legs.some((leg, index) => {
      const game = gameFor(leg);
      if (!game || !isFinalGame(game)) return true;
      return isPlayerLeg(leg) && legResults[index] === "pending";
    });
    return { legResults, unresolved };
  } catch (error) {
    console.error("Weekly Best Multi settlement lookup failed", error?.message || error);
    return { legResults: empty, unresolved: true };
  }
}
