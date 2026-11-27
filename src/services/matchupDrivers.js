// "What's driving it": the model's projected margin split into plain-language factors.
// Points are from the home team's side (positive helps home, negative helps away). The
// named factors come straight from the model's layers; "Team strength and form" is
// everything else (season scoring, ratings and the market blend), so the factors always
// add up to the projected margin.

const LAYER_GROUPS = {
  quarterback: "Quarterbacks",
  rosterHealth: "Injuries",
  playerRatings: "Player ratings",
  specialTeams: "Special teams",
  opponentNetwork: "Strength of schedule",
};
const MATCHUP_STATS = "Matchup stats";

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function buildMatchupDrivers(prediction, { limit = 5 } = {}) {
  if (!prediction || !Number.isFinite(Number(prediction.continuousMargin))) return [];
  const total = Number(prediction.continuousMargin);
  const groups = new Map();
  const add = (label, points) => {
    if (Math.abs(points) < 1e-9) return;
    groups.set(label, (groups.get(label) || 0) + points);
  };

  for (const [name, layer] of Object.entries(prediction.modelLayers || {})) {
    if (!layer || typeof layer !== "object" || layer.active === false) continue;
    add(LAYER_GROUPS[name] || MATCHUP_STATS, finite(layer.homePoints) - finite(layer.awayPoints));
  }
  const external = prediction.externalFactors2026;
  if (!external?.active) {
    add("Home field", finite(prediction.homeField?.total));
    add("Rest and schedule", finite(prediction.schedule?.differential));
  }

  const named = [...groups.entries()].map(([label, points]) => ({ label, points }));
  const explained = named.reduce((sum, driver) => sum + driver.points, 0);
  const drivers = [...named, { label: "Team strength and form", points: total - explained }]
    .map((driver) => ({ ...driver, points: Math.round(driver.points * 10) / 10 }))
    .filter((driver) => Math.abs(driver.points) >= 0.1)
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  return drivers.slice(0, limit).map((driver) => ({
    ...driver,
    team: driver.points > 0 ? prediction.home?.code : prediction.away?.code,
  }));
}
