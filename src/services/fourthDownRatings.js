// Shared by the ratings builder (scripts/player-ratings.mjs) and game predictions.
// Units, their places and replacement levels (25th percentile EA rating for the unit).
export const UNITS = {
  qb: { positions: ["QB"], places: 1, replacement: 63, sample: 150 },
  rb: { positions: ["RB", "HB", "FB"], places: 2, replacement: 70, sample: 100 },
  wr: { positions: ["WR"], places: 3, replacement: 70, sample: 250 },
  te: { positions: ["TE"], places: 2, replacement: 65, sample: 250 },
  ol: { positions: ["T", "G", "C", "OL", "OT", "OG", "LT", "LG", "RG", "RT"], places: 5, replacement: 66, sample: 300 },
  front: { positions: ["DL", "DE", "DT", "NT"], places: 4, replacement: 69, sample: 350 },
  lb: { positions: ["LB", "OLB", "ILB", "MLB"], places: 3, replacement: 65, sample: 350 },
  db: { positions: ["CB", "S", "FS", "SS", "DB"], places: 5, replacement: 68, sample: 350 },
};
export const nameKey = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");

export function unitForPosition(position) {
  const code = String(position || "").trim().toUpperCase();
  return Object.entries(UNITS).find(([, unit]) => unit.positions.includes(code))?.[0] || null;
}

// Unit ratings for one team: starters by recent snaps, skipping unavailable players.
export function teamUnitRatings(teamRatings, { unavailable = () => false } = {}) {
  const out = {};
  let places = 0, filled = 0;
  for (const [unit, spec] of Object.entries(UNITS)) {
    const chosen = (teamRatings?.[unit] || []).filter((player) => !unavailable(player)).slice(0, spec.places);
    places += spec.places; filled += chosen.length;
    out[unit] = (chosen.reduce((sum, player) => sum + player.rating, 0) + (spec.places - chosen.length) * spec.replacement) / spec.places;
  }
  return { units: out, coverage: places ? filled / places : 0 };
}
