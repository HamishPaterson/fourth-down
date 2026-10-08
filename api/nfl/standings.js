// api/nfl/standings.js
// Vercel serverless function — proxies NFL standings from BallDontLie.
// Normalizes to a clean shape (incl. home/road splits) so the frontend
// never has to guess field names.

const BALLDONTLIE_BASE = "https://api.balldontlie.io/nfl/v1";

export default async function handler(req, res) {
  const apiKey = process.env.BALLDONTLIE_API_KEY;

  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "Missing BALLDONTLIE_API_KEY environment variable" });
  }

  const season = String(req.query.season || defaultSeason());

  try {
    const response = await fetch(
      `${BALLDONTLIE_BASE}/standings?season=${encodeURIComponent(season)}`,
      { headers: { Authorization: apiKey } }
    );

    const body = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: body.error || `Standings request failed (${response.status})`,
      });
    }

    const rows = Array.isArray(body.data) ? body.data : [];
    const data = rows.map(normalize).filter((row) => row.abbreviation);

    return res.status(200).json({ data, season, count: data.length });
  } catch (error) {
    return res
      .status(500)
      .json({ error: error?.message || "Standings request failed" });
  }
}

// NFL season year = current calendar year once we're past February,
// otherwise the previous year (Jan/Feb belong to the prior season).
function defaultSeason() {
  const now = new Date();
  const year = now.getFullYear();
  return now.getMonth() >= 2 ? year : year - 1;
}

// Defensively pull values from whatever field names BallDontLie returns.
function normalize(entry) {
  const team = entry?.team || entry || {};

  const abbreviation = String(team.abbreviation || entry.abbreviation || "")
    .trim()
    .toUpperCase();

  const wins = firstNumber(entry.wins, entry.win, entry.record?.wins);
  const losses = firstNumber(entry.losses, entry.loss, entry.record?.losses);
  const ties = firstNumber(entry.ties, entry.tie, entry.record?.ties) ?? 0;

  const divisionRank = firstNumber(
    entry.division_rank,
    entry.divisionRank,
    entry.rank
  );
  const conferenceRank = firstNumber(
    entry.conference_rank,
    entry.conferenceRank
  );
  const playoffSeed = firstNumber(entry.playoff_seed, entry.playoffSeed);
  const pointsFor = firstNumber(entry.points_for, entry.pointsFor);
  const pointsAgainst = firstNumber(entry.points_against, entry.pointsAgainst);

  // Home / road splits — try several common shapes.
  const homeWins = firstNumber(
    entry.home_wins,
    entry.homeWins,
    entry.home_record?.wins,
    entry.home?.wins,
    parseRecord(entry.home_record).wins,
    parseRecord(entry.home).wins
  );
  const homeLosses = firstNumber(
    entry.home_losses,
    entry.homeLosses,
    entry.home_record?.losses,
    entry.home?.losses,
    parseRecord(entry.home_record).losses,
    parseRecord(entry.home).losses
  );
  const roadWins = firstNumber(
    entry.road_wins,
    entry.roadWins,
    entry.away_wins,
    entry.awayWins,
    entry.road_record?.wins,
    entry.away_record?.wins,
    parseRecord(entry.road_record).wins,
    parseRecord(entry.away_record).wins
  );
  const roadLosses = firstNumber(
    entry.road_losses,
    entry.roadLosses,
    entry.away_losses,
    entry.awayLosses,
    entry.road_record?.losses,
    entry.away_record?.losses,
    parseRecord(entry.road_record).losses,
    parseRecord(entry.away_record).losses
  );

  const played = (wins ?? 0) + (losses ?? 0) + (ties ?? 0);
  const winPct =
    played > 0 ? ((wins ?? 0) + (ties ?? 0) * 0.5) / played : null;

  return {
    abbreviation,
    conference: team.conference || entry.conference || null,
    division: team.division || entry.division || null,
    wins: wins ?? 0,
    losses: losses ?? 0,
    ties: ties ?? 0,
    winPct,
    divisionRank: divisionRank ?? null,
    conferenceRank: conferenceRank ?? null,
    playoffSeed: playoffSeed ?? null,
    pointsFor: pointsFor ?? null,
    pointsAgainst: pointsAgainst ?? null,
    home: { wins: homeWins ?? 0, losses: homeLosses ?? 0 },
    road: { wins: roadWins ?? 0, losses: roadLosses ?? 0 },
  };
}

// Parse a "W-L" or "W-L-T" string into {wins, losses} if present.
function parseRecord(value) {
  if (typeof value !== "string") return {};
  const parts = value.split("-").map((p) => Number(p.trim()));
  if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
    return { wins: parts[0], losses: parts[1] };
  }
  return {};
}

function firstNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}
