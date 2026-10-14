export const PLAYER_METRICS_SCHEMA = 2;
const aliases = { WAS: "WSH", LA: "LAR", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LAR" };
export const playerTeam = (value) => {
  const code = String(value || "").trim().toUpperCase();
  return aliases[code] || code;
};
export function playerMetricsResponse(artifact, { season, week, away, home }) {
  const teams = artifact.playerMetricsByWeek?.[week] || {};
  const payload = {
    available: true, schemaVersion: artifact.schemaVersion, season: artifact.season,
    requestedWeek: week, metricsWeek: artifact.playerMetricsByWeek?.[week] ? week : null,
    cutoff: artifact.cutoffs?.[week], sourceAsOf: artifact.sourceAsOf,
    generatedAt: artifact.generatedAt, source: artifact.source,
    away: teams[playerTeam(away)] || null, home: teams[playerTeam(home)] || null,
  };
  const reason = validatePlayerMetrics(payload, { season, week, cutoff: payload.cutoff });
  if (reason || (!payload.away && !payload.home)) {
    return { ...payload, available: false, reason: reason || "No completed eligible player games", away: null, home: null };
  }
  return payload;
}
export function instant(value) {
  return typeof value === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
}
export function completedPlayerGames(games, season, week, cutoff) {
  const limit = instant(cutoff);
  if (limit === null) return [];
  const unique = new Map();
  for (const game of games) {
    const status = String(game.status || game.status_state || "").toLowerCase();
    const type = String(game.season_type || game.game_type || "").toUpperCase();
    const kickoff = instant(game.date);
    // updated_at is a conservative observation of final status, not an invented completion time.
    const completedAsOf = instant(game.completed_at || game.updated_at);
    if (Number(game.season) !== season || !Number.isInteger(Number(game.week)) ||
        Number(game.week) < 1 || Number(game.week) >= week ||
        [true, 1, "true", "1"].includes(game.postseason) ||
        (type && !["REG", "REGULAR", "REGULAR SEASON", "2"].includes(type)) ||
        !(game.completed === true || /^(final\b|completed?$|closed$|post$)/.test(status)) ||
        kickoff === null || completedAsOf === null ||
        kickoff >= limit || completedAsOf > limit || completedAsOf < kickoff) continue;
    const away = playerTeam(game.visitor_team?.abbreviation || game.away_team?.abbreviation);
    const home = playerTeam(game.home_team?.abbreviation);
    if (!away || !home || away === home) throw new Error("Invalid player-metrics game teams");
    const key = `${season}:${Number(game.week)}:${[away, home].sort().join(":")}`;
    const entry = { key, providerId: String(game.id), week: Number(game.week),
      away, home, kickoff: game.date, completedAsOf: new Date(completedAsOf).toISOString() };
    const previous = unique.get(key);
    if (previous && (previous.kickoff !== entry.kickoff || previous.away !== away)) {
      throw new Error(`Conflicting player-metrics schedule game ${key}`);
    }
    unique.set(key, entry);
  }
  return [...unique.values()];
}

export function validatePlayerMetrics(payload, { season, week, cutoff } = {}) {
  if (payload?.schemaVersion !== PLAYER_METRICS_SCHEMA) return "Legacy player artifact lacks game-level provenance";
  if (payload.available === false) return payload.reason || "Player metrics unavailable";
  if (payload.season !== season) return "Player artifact season mismatch";
  if (payload.requestedWeek !== week || payload.metricsWeek !== week) return "Exact prediction-week player data unavailable";
  if (instant(cutoff) === null || instant(payload.cutoff) !== instant(cutoff)) return "Player/depth weekly cutoff missing or mismatched";
  if (instant(payload.generatedAt) === null || instant(payload.sourceAsOf) === null ||
      Date.parse(payload.generatedAt) < Date.parse(payload.sourceAsOf)) return "Player source/generation provenance invalid";
  for (const side of ["away", "home"]) {
    const metrics = payload[side];
    if (!metrics) continue;
    if (metrics.predictionWeek !== week || instant(metrics.cutoff) !== instant(cutoff) ||
        !Array.isArray(metrics.gameProvenance) || !metrics.gameProvenance.length ||
        metrics.games !== metrics.gameProvenance.length ||
        metrics.expectedCompletedGames !== metrics.games) return `Invalid ${side} game coverage`;
    if (!["passAttempts", "sacksAllowed", "rushingAttempts", "targets", "completions"]
      .every((key) => typeof metrics.teamTotals?.[key] === "number" &&
        Number.isFinite(metrics.teamTotals[key]) && metrics.teamTotals[key] >= 0) ||
        metrics.teamTotals.passAttempts + metrics.teamTotals.sacksAllowed + metrics.teamTotals.rushingAttempts <= 0 ||
        typeof metrics.teamTotals.passingYards !== "number") return `Missing ${side} team volume`;
    const games = new Map();
    for (const game of metrics.gameProvenance) {
      if (!game.gameId || games.has(game.gameId) || !Number.isInteger(game.week) ||
          game.week < 1 || game.week >= week || instant(game.completedAsOf) === null ||
          instant(game.kickoff) === null || Date.parse(game.kickoff) >= Date.parse(cutoff) ||
          Date.parse(game.completedAsOf) < Date.parse(game.kickoff) ||
          Date.parse(game.completedAsOf) > Math.min(Date.parse(cutoff), Date.parse(payload.sourceAsOf)) ||
          ![game.away, game.home].includes(metrics.team)) return `Invalid ${side} game provenance`;
      games.set(game.gameId, game);
    }
    for (const player of Object.values(metrics.players || {})) {
      if (player.team !== metrics.team || !player.playerId ||
          !Array.isArray(player.gameLog) || !player.gameLog.length ||
          player.games !== player.gameLog.length ||
          !Array.isArray(player.weeks) || player.weeks.some((value) => !Number.isInteger(value) || value >= week || value < 1)) {
        return `Invalid ${side} player provenance`;
      }
      const seen = new Set();
      for (const row of player.gameLog) {
        if (seen.has(row.gameId) || !games.has(row.gameId) || games.get(row.gameId).week !== row.week) {
          return `Invalid ${side} player game log`;
        }
        seen.add(row.gameId);
      }
    }
    if (!finiteNumbers(metrics)) return `Nonfinite ${side} player statistics`;
  }
  return null;
}

function finiteNumbers(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (value && typeof value === "object") return Object.values(value).every(finiteNumbers);
  return true;
}
