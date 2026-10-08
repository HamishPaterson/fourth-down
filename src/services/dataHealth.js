const DATA_HEALTH_KEY = "fourth-down:data-health:v3";
const LEGACY_KEYS = ["fourth-down:data-health:v1", "fourth-down:data-health:v2"];

const VISIBLE_LAYERS = new Set([
  "quarterback", "rosterHealth", "specialTeams", "playerRatings",
  "opponentNetwork", "playByPlayEfficiency", "opponentAdjustedEfficiency",
  "successRate", "explosivePlays", "earlyDownEpa", "passProtection",
  "pressureMatchup", "offensiveLineContinuity", "coverageMatchup",
  "driveEfficiency", "situationalEfficiency", "snapParticipation",
  "expectedLineup", "turnoverRegression", "pace",
]);

export function readDataHealthSnapshots() {
  if (typeof window === "undefined") return [];
  try {
    const rows = JSON.parse(window.localStorage.getItem(DATA_HEALTH_KEY) || "[]");
    return Array.isArray(rows) ? rows.map(normaliseSnapshot) : [];
  } catch {
    return [];
  }
}

export function saveDataHealthSnapshot(snapshot) {
  if (!snapshot?.id || typeof window === "undefined") return;
  const rows = readDataHealthSnapshots();
  const next = normaliseSnapshot({ ...snapshot, auditVersion: 3, checkedAt: new Date().toISOString() });
  const index = rows.findIndex((row) => row.id === next.id);
  if (index >= 0) rows[index] = next;
  else rows.push(next);

  try {
    window.localStorage.setItem(
      DATA_HEALTH_KEY,
      JSON.stringify(rows.sort((a, b) => new Date(b.checkedAt) - new Date(a.checkedAt)).slice(0, 250))
    );
    LEGACY_KEYS.forEach((key) => window.localStorage.removeItem(key));
    window.dispatchEvent(new Event("fourth-down-data-health-updated"));
  } catch {
    // Data health is optional if browser storage is unavailable.
  }
}

export function normaliseLayers(layers) {
  const entries = Array.isArray(layers)
    ? layers.map((layer) => [layer.name, layer])
    : Object.entries(layers || {});

  return entries
    .filter(([name, layer]) => VISIBLE_LAYERS.has(name) && layer && typeof layer === "object")
    .map(([name, layer]) => {
      const awayPoints = finite(layer.awayPoints);
      const homePoints = finite(layer.homePoints);
      const confidence = finite(layer.confidence);
      const meaningful = Math.abs(awayPoints) >= 0.005 || Math.abs(homePoints) >= 0.005;
      const available = layer.available !== false && confidence > 0;
      return {
        name,
        awayPoints,
        homePoints,
        confidence,
        reasons: Array.isArray(layer.reasons) ? layer.reasons : [],
        status: !available ? "unavailable" : meaningful ? "active" : "measured-neutral",
      };
    });
}

export function classifyDataHealth(layers, sources) {
  const normalised = normaliseLayers(layers);
  const activeCount = normalised.filter((layer) => layer.status === "active").length;
  const sourceEntries = Object.entries(sources || {});
  const unavailableSources = sourceEntries
    .filter(([, source]) => !source?.available)
    .map(([, source]) => source?.label || "Data source");

  const staleSources = sourceEntries
    .filter(([, source]) => source?.stale === true)
    .map(([, source]) => source?.label || "Data source");
  const status = unavailableSources.length >= 2 || activeCount < 3
    ? "limited"
    : unavailableSources.length > 0 || activeCount < 7
      ? "partial"
      : "healthy";

  return {
    status,
    activeCount,
    warnings: [
      ...unavailableSources.map((label) => `${label} is unavailable.`),
      ...staleSources.map((label) => `${label} is stale.`),
    ],
  };
}

function normaliseSnapshot(snapshot) {
  const layers = normaliseLayers(snapshot.layers);
  const classification = classifyDataHealth(layers, snapshot.sources || {});
  return {
    ...snapshot,
    auditVersion: 3,
    layers,
    healthStatus: classification.status,
    activeLayerCount: classification.activeCount,
    warnings: classification.warnings,
  };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
