// services/homeFieldAdvantage.js
// Venue-specific home-field advantage, blended with in-season
// home/road performance as real results accumulate.
//
// PRIOR: each venue has a static base edge (modern ~1.5 avg, tiered).
// OBSERVED: once games are played, the home team's home/road split and
//   the away team's home/road split reveal the true venue effect.
// BLEND: a confidence weight (based on games played) shifts the number
//   from the prior toward the observed edge over the season.
//
// With no split data (preseason) this returns exactly the static model.

const HFA_BASE = {
  // Elite venue edges
  PIT: 2.50,
  KC: 2.50,
  SEA: 2.35,
  BUF: 2.30,
  DET: 2.25,

  // Strong venue or structural edges
  DEN: 2.00,
  MIA: 2.00,
  GB: 2.00,
  MIN: 2.00,
  NO: 2.00,
  BAL: 1.90,
  PHI: 1.90,

  // Above-average home environments
  CHI: 1.75,
  CLE: 1.75,
  NE: 1.70,
  CIN: 1.65,
  SF: 1.65,
  DAL: 1.60,
  HOU: 1.60,
  TEN: 1.55,

  // Modern league-average range
  ATL: 1.50,
  ARI: 1.50,
  IND: 1.50,
  JAX: 1.45,
  LAR: 1.35,
  NYG: 1.25,
  WSH: 1.25,

  // Below-average and takeover-prone environments
  TB: 1.00,
  LV: 1.00,
  CAR: 0.75,
  NYJ: 0.75,
  LAC: 0.35,
};

const DEFAULT_HFA = 1.5;

// Time zone offset relative to Eastern (ET = 0, CT = -1, MT = -2, PT = -3).
const TEAM_TZ = {
  ARI: -2, ATL: 0, BAL: 0, BUF: 0, CAR: 0, CHI: -1, CIN: 0, CLE: 0,
  DAL: -1, DEN: -2, DET: 0, GB: -1, HOU: -1, IND: 0, JAX: 0, KC: -1,
  LV: -3, LAC: -3, LAR: -3, MIA: 0, MIN: -1, NE: 0, NO: -1, NYG: 0,
  NYJ: 0, PHI: 0, PIT: 0, SF: -3, SEA: -3, TB: 0, TEN: -1, WSH: 0,
};

// --- Tuning constants -----------------------------------------------------
const POINTS_PER_WINPCT = 10; // a full 0->1 win% swing ~ 10 points of edge
const SAMPLE_K = 4;           // games needed before observed ~50% trusted
const MIN_EDGE = 0.0;         // floor for the blended venue edge
const MAX_EDGE = 3.25;         // ceiling for the blended venue edge
// --------------------------------------------------------------------------

function tierLabel(base) {
  if (base >= 2.25) return "Elite";
  if (base >= 1.85) return "Strong";
  if (base >= 1.35) return "League average";
  if (base >= 0.85) return "Below average";
  return "Weak";
}

// Travel / body-clock penalty applied to the away team (adds to home edge).
function travelPenalty(homeCode, awayCode, kickoff) {
  const homeTz = TEAM_TZ[homeCode];
  const awayTz = TEAM_TZ[awayCode];
  if (homeTz === undefined || awayTz === undefined) return 0;

  const zonesEast = homeTz - awayTz; // PT(-3) away @ ET(0) home = 3
  if (zonesEast < 2) return 0;

  let localHour = null;
  if (kickoff) {
    const date = kickoff instanceof Date ? kickoff : new Date(kickoff);
    if (!Number.isNaN(date.getTime())) localHour = date.getHours();
  }

  if (localHour === null) return 0.5;
  if (localHour <= 14) return zonesEast >= 3 ? 1.0 : 0.75;
  return 0.25; // late / prime-time largely neutralises the effect
}

// Win% from a {wins, losses} record, or null if no games.
function winPct(record) {
  if (!record) return null;
  const wins = num(record.wins, 0);
  const losses = num(record.losses, 0);
  const games = wins + losses;
  return games > 0 ? wins / games : null;
}

function gamesPlayed(record) {
  if (!record) return 0;
  return num(record.wins, 0) + num(record.losses, 0);
}

// Observed venue edge (points) from both teams' home/road splits.
// Returns { edge, weight } where weight is 0..1 confidence.
function observedEdge(homeSplit, awaySplit) {
  if (!homeSplit && !awaySplit) return { edge: null, weight: 0 };

  const homeHome = winPct(homeSplit?.home);
  const homeRoad = winPct(homeSplit?.road);
  const awayHome = winPct(awaySplit?.home);
  const awayRoad = winPct(awaySplit?.road);

  // Each team's own home-minus-road tendency (their venue sensitivity).
  const homeEffect =
    homeHome != null && homeRoad != null ? homeHome - homeRoad : null;
  const awayEffect =
    awayHome != null && awayRoad != null ? awayHome - awayRoad : null;

  const effects = [homeEffect, awayEffect].filter((v) => v != null);
  if (!effects.length) return { edge: null, weight: 0 };

  const avgEffect = effects.reduce((a, b) => a + b, 0) / effects.length;
  const edge = avgEffect * POINTS_PER_WINPCT * 0.5; // half = isolate venue

  // Confidence from the relevant samples: home team's home games and
  // away team's road games are what matter most for this matchup.
  const sample = Math.min(
    gamesPlayed(homeSplit?.home) || 0,
    gamesPlayed(awaySplit?.road) || 0
  );
  const rawWeight = sample / (sample + SAMPLE_K);
  const weight = Math.min(0.5, rawWeight);

  return { edge, weight };
}

// Main entry point.
// options.homeSplit / options.awaySplit = { home:{wins,losses}, road:{wins,losses} }
export function getHomeFieldAdvantage(homeCode, awayCode, options = {}) {
  const home = normalize(homeCode);
  const away = normalize(awayCode);
  const prior = HFA_BASE[home] ?? DEFAULT_HFA;

  const { edge, weight } = observedEdge(options.homeSplit, options.awaySplit);

  // Blend prior toward observed edge by confidence weight.
  let base = prior;
  if (edge != null && weight > 0) {
    base = prior * (1 - weight) + (prior + edge) * weight;
    base = clamp(round1(base), MIN_EDGE, MAX_EDGE);
  }

  const travel = travelPenalty(home, away, options.kickoff);
  const total = round1(clamp(base + travel, MIN_EDGE, MAX_EDGE));

  return {
    prior,
    base,          // blended venue edge (prior + in-season observed)
    travel: round1(travel),
    total,
    tier: tierLabel(prior),
    dataWeight: round1(weight), // 0 = pure prior, ->1 = mostly observed
  };
}

function normalize(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const aliases = { WAS: "WSH", LA: "LAR" };
  return aliases[normalized] || normalized;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

export default HFA_BASE;
