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
