import dataset from "./nflverse-team-metrics.js";

const aliases = { WAS: "WSH", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" };
const normalizeTeam = (value) => {
  const code = String(value || "").trim().toUpperCase();
  return aliases[code] || code;
};

export default function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const season = Number(req.query.season);
  const week = Number(req.query.week);
  if (!Number.isInteger(season) || !Number.isInteger(week) || week < 1) {
    return res.status(400).json({ error: "season and week are required" });
  }
  const profiles = Number(dataset?.season) === season
    ? dataset.kickerProfilesByWeek?.[week] || null
    : null;
  if (!profiles) {
    return res.status(200).json({
      season,
      week,
      available: false,
      source: "nflverse",
      kickerProfiles: null,
      reason: "No point-in-time kicker profile artifact is available",
    });
  }
  const teams = [normalizeTeam(req.query.away), normalizeTeam(req.query.home)].filter(Boolean);
  const profilesByTeam = teams.length
    ? Object.fromEntries(teams.map((team) => [team, profiles.profilesByTeam?.[team] || []]))
    : profiles.profilesByTeam;
  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  return res.status(200).json({
    season,
    week,
    available: true,
    source: profiles.source,
    generatedAt: profiles.generatedAt,
    kickerProfiles: { ...profiles, profilesByTeam },
  });
}
