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

// A regular starter averages at least this share of his side's snaps over recent games.
// Defensive linemen, running backs and tight ends rotate, so their starters play fewer.
export const STARTER_SHARE = Object.freeze({ qb: 0.6, rb: 0.45, wr: 0.6, te: 0.5, ol: 0.6, front: 0.5, lb: 0.6, db: 0.6 });

// Points of margin a team loses when a regular starter misses the game, measured on 2,318
// regular-season games from 2016-2025 (6,300 starter absences) by scripts/fit-absence-values.mjs:
// margin = home field + each team's strength that season - the cost of each side's absences,
// cost = starter + quality x (how well he had played that season, in standard deviations from
// the season's regular starters at his unit, shrunk for sample). Quality slopes are shared
// within groups (skill positions, defence) because single positions are too thin. Adding the
// absences cut the error on held-out weeks from 13.19 to 13.05 points (MAE 10.39 to 10.25).
// Standard errors: quarterback 0.73 / 1.09, offensive line 0.30, others 0.3-0.7 / 0.45-0.59.
export const ABSENCE_COSTS = Object.freeze({
  qb: Object.freeze({ starter: 3.16, quality: 3.82 }),
  rb: Object.freeze({ starter: 0.29, quality: 0.74 }),
  wr: Object.freeze({ starter: 0.86, quality: 0.74 }),
  te: Object.freeze({ starter: 0.68, quality: 0.74 }),
  ol: Object.freeze({ starter: 0.91, quality: 0 }),
  front: Object.freeze({ starter: 0.76, quality: 0.70 }),
  lb: Object.freeze({ starter: 0.61, quality: 0.70 }),
  db: Object.freeze({ starter: 0.37, quality: 0.70 }),
});

export function absenceCost(unit, quality) {
  const cost = ABSENCE_COSTS[unit];
  return cost ? Math.max(0, cost.starter + cost.quality * (Number.isFinite(quality) ? quality : 0)) : 0;
}
