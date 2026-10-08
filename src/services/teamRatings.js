import ESPN_FPI_RATINGS from "./espnFpiRatings.js";

const TEAM_RATINGS = ESPN_FPI_RATINGS.teams;
const CURRENT_EFFICIENCY_WEIGHT = 0.45;

export function getTeamRatings(team) {
  const abbreviation =
    typeof team === "string"
      ? team
      : team?.abbreviation;
  const code = normalizeTeamCode(abbreviation);
  const stored = TEAM_RATINGS[code];

  if (!stored) {
    return {
      overall: 75,
      offense: 75,
      defense: 75,
      specialTeams: 75,
      source: "Fallback",
      espnFpi: null,
      projections: null,
      efficiencies: null,
    };
  }

  return {
    ...stored,
    overall: blendRating(
      stored.overall,
      efficiencyRating(stored.efficiencies?.overall)
    ),
    offense: blendRating(
      stored.offense,
      efficiencyRating(stored.efficiencies?.offense)
    ),
    defense: blendRating(
      stored.defense,
      efficiencyRating(stored.efficiencies?.defense)
    ),
    specialTeams: blendRating(
      stored.specialTeams,
      efficiencyRating(stored.efficiencies?.specialTeams)
    ),
    source: `${stored.source} + ESPN current-season efficiencies`,
    efficiencyWeight: CURRENT_EFFICIENCY_WEIGHT,
  };
}


export function getTeamQbr(team) {
  const abbreviation = typeof team === "string" ? team : team?.abbreviation;
  const code = normalizeTeamCode(abbreviation);
  return TEAM_RATINGS[code]?.qbr || null;
}

export function getTeamRatingsHealth() {
  return {
    available: ESPN_FPI_RATINGS.available,
    source: ESPN_FPI_RATINGS.source,
    generatedAt: ESPN_FPI_RATINGS.generatedAt,
    sourceUpdatedAt: ESPN_FPI_RATINGS.sourceUpdatedAt,
    teamCount: Object.keys(TEAM_RATINGS).length,
    efficiencyWeight: CURRENT_EFFICIENCY_WEIGHT,
  };
}

function efficiencyRating(value) {
  const efficiency = Number(value);
  if (!Number.isFinite(efficiency)) return null;
  return clamp(50 + efficiency * 0.5, 50, 100);
}

function blendRating(fpiRating, currentEfficiencyRating) {
  const baseline = Number(fpiRating);
  if (!Number.isFinite(baseline)) return 75;
  if (!Number.isFinite(currentEfficiencyRating)) return baseline;

  return Math.round(
    baseline * (1 - CURRENT_EFFICIENCY_WEIGHT) +
      currentEfficiencyRating * CURRENT_EFFICIENCY_WEIGHT
  );
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

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export { TEAM_RATINGS };
