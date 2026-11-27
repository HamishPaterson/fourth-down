// api/nfl/standings.js
// NFL standings from ESPN's public standings feed (division level), which applies the official
// tiebreakers to division order and playoff seeds. Our BALLDONTLIE plan does not include
// standings. Returns the shape the pages already use, kept on the server for 10 minutes.
//
// With ?team=PIT it instead returns that team's season averages from ESPN's team statistics
// (points and yards per game, gained and allowed), kept for an hour. This lives here rather
// than in its own route because the hosting plan allows 12 server functions.

import { withApprovedUser } from "../../api-lib/authorization.js";
import { HOUR, MINUTE, providerCache } from "../../api-lib/serverCache.js";

const ESPN_STANDINGS = "https://site.api.espn.com/apis/v2/sports/football/nfl/standings";
const ESPN_TEAM_STATS = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams";
const TEAM_CODES = new Set(["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB",
  "HOU", "IND", "JAX", "KC", "LV", "LAC", "LAR", "MIA", "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SF",
  "SEA", "TB", "TEN", "WSH"]);
const CACHE_MS = 10 * MINUTE;
const TEAM_ALIASES = { WAS: "WSH", LA: "LAR", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LAR" };
const DIVISION_NAMES = { EAST: "East", NORTH: "North", SOUTH: "South", WEST: "West" };

export default withApprovedUser(handler);
export async function handler(req, res, { fetchImpl = globalThis.fetch } = {}) {
  if (req.method && req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const season = String(req.query?.season || defaultSeason());
  if (!/^\d{4}$/.test(season)) return res.status(400).json({ error: "A valid season is required" });
  if (req.query?.team !== undefined) return teamStats(req, res, season, fetchImpl);
  try {
    const data = await providerCache(`standings:${season}`, CACHE_MS, async () => {
      const response = await fetchImpl(`${ESPN_STANDINGS}?season=${season}&level=3`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Object.assign(new Error(`Standings request failed (${response.status})`), { status: response.status });
      const rows = parseEspnStandings(await response.json());
      if (rows.length !== 32) throw Object.assign(new Error(`Standings returned ${rows.length} teams`), { status: 502 });
      return rows;
    });
    return res.status(200).json({ data, season, count: data.length, source: "ESPN" });
  } catch (error) {
    return res.status(error?.status >= 400 ? error.status : 500).json({ error: error?.message || "Standings request failed" });
  }
}

async function teamStats(req, res, season, fetchImpl) {
  const raw = String(req.query.team || "").trim().toUpperCase();
  const code = TEAM_ALIASES[raw] || raw;
  if (!TEAM_CODES.has(code)) return res.status(400).json({ error: "A valid team is required" });
  try {
    const data = await providerCache(`team-stats:${season}:${code}`, HOUR, async () => {
      const response = await fetchImpl(`${ESPN_TEAM_STATS}/${code.toLowerCase()}/statistics?season=${season}`, {
        headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Object.assign(new Error(`Team statistics request failed (${response.status})`), { status: response.status });
      const stats = parseEspnTeamStats(await response.json());
      if (stats.offense.passingYardsPerGame == null || stats.offense.rushingYardsPerGame == null) {
        throw Object.assign(new Error("Team statistics were incomplete"), { status: 502 });
      }
      return { team: code, ...stats };
    });
    return res.status(200).json({ data, season, source: "ESPN" });
  } catch (error) {
    return res.status(error?.status >= 400 ? error.status : 500).json({ error: error?.message || "Team statistics request failed" });
  }
}

// ESPN lists the team's own statistics (results.stats) and its opponents' (results.opponent),
// each as categories of named stats. Passing is net of sacks.
export function parseEspnTeamStats(json) {
  const side = (categories) => {
    const byName = new Map();
    for (const category of Array.isArray(categories) ? categories : []) {
      for (const stat of category?.stats || []) if (!byName.has(stat.name)) byName.set(stat.name, stat.value);
    }
    const value = (name) => {
      const number = Number(byName.get(name));
      return byName.has(name) && Number.isFinite(number) ? Math.round(number * 10) / 10 : null;
    };
    return {
      pointsPerGame: value("totalPointsPerGame"),
      yardsPerGame: value("yardsPerGame"),
      passingYardsPerGame: value("netPassingYardsPerGame"),
      rushingYardsPerGame: value("rushingYardsPerGame"),
    };
  };
  return { offense: side(json?.results?.stats?.categories), defense: side(json?.results?.opponent) };
}

// NFL season year = current calendar year once we're past February,
// otherwise the previous year (Jan/Feb belong to the prior season).
function defaultSeason() {
  const now = new Date();
  return now.getMonth() >= 2 ? now.getFullYear() : now.getFullYear() - 1;
}

// ESPN nests conferences (AFC, NFC) over divisions, each division's entries in standings order.
export function parseEspnStandings(json) {
  const rows = [];
  for (const conference of json?.children || []) {
    const conferenceName = String(conference.abbreviation || conference.name || "").toUpperCase();
    for (const division of conference.children || []) {
      const divisionKey = String(division.abbreviation || division.name || "").toUpperCase().split(" ").pop();
      const divisionName = DIVISION_NAMES[divisionKey] || division.name || null;
      (division.standings?.entries || []).forEach((entry, index) => {
        rows.push(normalize(entry, { conference: conferenceName, division: divisionName, divisionRank: index + 1 }));
      });
    }
  }
  return rows.filter((row) => row.abbreviation);
}

function normalize(entry, { conference, division, divisionRank }) {
  const stats = Object.fromEntries((entry?.stats || []).map((stat) => [stat.name, stat]));
  const value = (name) => {
    const number = Number(stats[name]?.value);
    return Number.isFinite(number) ? number : null;
  };
  const record = (name) => parseRecord(stats[name]?.displayValue ?? stats[name]?.summary);
  const code = String(entry?.team?.abbreviation || "").trim().toUpperCase();
  const wins = value("wins") ?? 0, losses = value("losses") ?? 0, ties = value("ties") ?? 0;
  const played = wins + losses + ties;
  const seed = value("playoffSeed");
  return {
    abbreviation: TEAM_ALIASES[code] || code,
    name: entry?.team?.displayName || null,
    conference,
    division,
    wins,
    losses,
    ties,
    winPct: played > 0 ? (wins + ties * 0.5) / played : null,
    divisionRank,
    // ESPN seeds every team 1-16 within its conference: the conference order.
    conferenceRank: seed,
    playoffSeed: seed != null && seed <= 7 ? seed : null,
    pointsFor: value("pointsFor"),
    pointsAgainst: value("pointsAgainst"),
    pointDifferential: value("pointDifferential") ?? value("differential"),
    streak: stats.streak?.displayValue ?? null,
    divisionRecord: stats.divisionRecord?.displayValue ?? stats["vs. Div."]?.displayValue ?? null,
    conferenceRecord: stats["vs. Conf."]?.displayValue ?? null,
    home: record("Home"),
    road: record("Road"),
  };
}

// "W-L" or "W-L-T" into { wins, losses, ties }.
function parseRecord(text) {
  const parts = String(text || "").split("-").map((part) => Number(part.trim()));
  if (parts.length < 2 || !parts.every(Number.isFinite)) return { wins: 0, losses: 0, ties: 0 };
  return { wins: parts[0], losses: parts[1], ties: parts[2] || 0 };
}
