// Refuses to publish a week whose inputs are not all for that week.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getCalendarWeek } from "../src/services/weekLifecycle.js";

export function verifyWeeklyData({ week, team, players, ratings, external, espn }) {
  const problems = [], completed = week - 1;
  if (team.teamMetricsAuditsByWeek?.[week]?.referenceWeek !== completed) problems.push("NFLverse team metrics");
  if (players.latestCompletedWeek !== completed || !players.playerMetricsByWeek?.[week]) problems.push("NFLverse player metrics");
  if (ratings?.predictionWeek !== week || ratings.latestCompletedWeek !== completed) problems.push("player ratings");
  if (external.maxCompletedWeek !== completed) problems.push("external factors");
  if (espn.predictionWeek !== week || espn.fpiRows?.length !== 32 || espn.efficiencyRows?.length !== 32) problems.push("ESPN");
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const week = getCalendarWeek();
  const [team, players, external, espn, ratings] = (await Promise.all([import("../api/nfl/nflverse-team-metrics.js"),
    import("../data/nflverse-player-metrics.js"), import("../src/services/externalFactors2026Data.js"),
    import("../src/services/espnSnapshotData.js"), import("../data/player-ratings-2026.js")])).map((module) => module.default);
  const problems = verifyWeeklyData({ week, team, players, ratings, external, espn });
  if (problems.length) { console.error(`Week ${week} inputs are not ready: ${problems.join(", ")}`); process.exit(1); }
  console.log(`Week ${week} inputs verified.`);
}
