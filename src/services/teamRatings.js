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


export function getTeamQbr(team) {
  const abbreviation = typeof team === "string" ? team : team?.abbreviation;
  const code = normalizeTeamCode(abbreviation);
  return TEAM_RATINGS[code]?.qbr || null;
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
