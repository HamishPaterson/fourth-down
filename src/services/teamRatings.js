import ESPN_FPI_RATINGS from "./espnFpiRatings.js";

const TEAM_RATINGS = ESPN_FPI_RATINGS.teams;
export function getTeamRatings(team, { snapshot = ESPN_FPI_RATINGS } = {}) {
  const abbreviation =
    typeof team === "string"
      ? team
      : team?.abbreviation;
  const code = normalizeTeamCode(abbreviation);
  const stored = snapshot.teams[code];

  if (!stored) {
    return {
      overall: null,
      offense: null,
      defense: null,
      specialTeams: null,
      available: false,
      source: "ESPN unavailable",
      espnFpi: null,
      projections: null,
      efficiencies: null,
    };
  }

  return {
    ...stored,
    available: true,
    overall: stored.espnFpi.overall,
    offense: stored.espnFpi.offense,
    defense: stored.espnFpi.defense,
    specialTeams: stored.espnFpi.specialTeams,
    units: "ESPN FPI points",
  };
}


// League rank (1 = best of 32) for overall strength, offence and defence, from ESPN's FPI
// ratings. In FPI a higher number is better for all three, defence included.
const rankCache = new WeakMap();
export function getTeamRanks(team, { snapshot = ESPN_FPI_RATINGS } = {}) {
  if (!rankCache.has(snapshot)) {
    const teams = Object.entries(snapshot.teams || {});
    const ranks = {};
    for (const part of ["overall", "offense", "defense"]) {
      const values = teams.map(([code, stored]) => [code, Number(stored?.espnFpi?.[part])]).filter(([, v]) => Number.isFinite(v));
      for (const [code, value] of values) {
        (ranks[code] ||= {})[part] = 1 + values.filter(([, other]) => other > value).length; // ties share a rank
      }
    }
    rankCache.set(snapshot, { ranks, total: teams.length });
  }
  const { ranks, total } = rankCache.get(snapshot);
  const code = normalizeTeamCode(typeof team === "string" ? team : team?.abbreviation);
  const found = ranks[code];
  return { overall: found?.overall ?? null, offense: found?.offense ?? null, defense: found?.defense ?? null, total };
}

// 1 → "1st", 22 → "22nd"; a missing rank shows as a dash.
export function ordinalRank(rank) {
  if (!Number.isFinite(rank)) return "—";
  const tens = rank % 100, ones = rank % 10;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ones === 1 ? "st" : ones === 2 ? "nd" : ones === 3 ? "rd" : "th";
  return `${rank}${suffix}`;
}

// Plain-language band for a league rank out of 32.
export function rankBand(rank) {
  if (!Number.isFinite(rank)) return null;
  if (rank <= 5) return "Elite";
  if (rank <= 12) return "Good";
  if (rank <= 20) return "Average";
  if (rank <= 27) return "Below average";
  return "Poor";
}

// QBR follows the personnel-selected starting quarterback's identity, never
// the team. Exact canonicalId/GSIS match first; a uniquely matched normalised
// name is the only secondary identity. No roster or team fallback exists, so
// a starter without a QBR record (e.g. an unqualified rookie) resolves to null.
export function getQuarterbackQbr(quarterback, { snapshot = ESPN_FPI_RATINGS } = {}) {
  const players = snapshot?.quarterbacks?.players || {};
  if (!quarterback) return null;
  const id = String(
    (typeof quarterback === "string" ? quarterback : quarterback.canonicalId || quarterback.gsisId) || ""
  ).trim();
  if (id && players[id]) return players[id];
  if (typeof quarterback === "string") return null;
  const nameKey = normalizePlayerName(quarterback.name || quarterback.playerName || quarterback.fullName);
  if (!nameKey) return null;
  const matches = Object.values(players).filter(
    (player) => normalizePlayerName(player.playerName) === nameKey
  );
  return matches.length === 1 ? matches[0] : null;
}

function normalizePlayerName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z]/g, "");
}

export function getTeamRatingsHealth({ snapshot = ESPN_FPI_RATINGS } = {}) {
  return {
    available: snapshot.available,
    source: snapshot.source,
    season: snapshot.season,
    predictionWeek: snapshot.predictionWeek,
    generatedAt: snapshot.generatedAt,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
    providedAt: snapshot.providedAt,
    teamCount: Object.keys(snapshot.teams).length,
  };
}

function normalizeTeamCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return (
    {
      WAS: "WSH",
      LA: "LAR",
      JAC: "JAX",
      OAK: "LV",
      SD: "LAC",
      STL: "LAR",
    }[code] || code
  );
}

export { TEAM_RATINGS };
