import dataset from "./nflverse-team-metrics.js";

const TEAM_ALIASES = { WAS: "WSH", LA: "LAR", OAK: "LV", SD: "LAC", STL: "LAR" };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const season = Number(req.query.season);
  const week = Number(req.query.week);
  const away = normalizeTeamCode(req.query.away);
  const home = normalizeTeamCode(req.query.home);

  if (!Number.isInteger(season) || !Number.isInteger(week) || !away || !home) {
    return res.status(400).json({ error: "season, week, away and home are required" });
  }

  const metricWeek = latestAvailableWeek(dataset, season, week);
  const weekMetrics = metricWeek ? dataset.metricsByWeek?.[metricWeek] : null;
  const awayMetrics = weekMetrics?.[away];
  const homeMetrics = weekMetrics?.[home];

  if (!awayMetrics || !homeMetrics) {
    return sendNeutral(
      res,
      season,
      week,
      away,
      home,
      "Run npm run update:nflverse before deploying to refresh the pre-aggregated dataset"
    );
  }

  res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
  return res.status(200).json({
    season,
    week,
    metricWeek,
    source: dataset.source,
    sourceUrl: dataset.sourceUrl || null,
    generatedAt: dataset.generatedAt,
    latestCompletedWeek: metricWeek - 1,
    garbageTimeFilter: dataset.garbageTimeFilter,
    pressureDefinition: dataset.pressureDefinition || "QB hit or sack proxy",
    weighting: dataset.weighting || null,
    away: awayMetrics,
    home: homeMetrics,
    modelLayers: compareTeams(awayMetrics, homeMetrics, week),
    dataStatus: "available",
  });
}

function latestAvailableWeek(source, season, requestedWeek) {
  if (Number(source?.season) !== Number(season)) return null;
  return Object.keys(source?.metricsByWeek || {})
    .map(Number)
    .filter((value) => Number.isInteger(value) && value <= Number(requestedWeek))
    .sort((a, b) => b - a)[0] || null;
}

function compareTeams(away, home, week) {
  const weekConfidence = confidenceForWeek(week);
  const sampleConfidence = Math.min(confidenceForSample(away), confidenceForSample(home));
  const confidence = round(Math.min(weekConfidence, sampleConfidence));
  const edge = (value, cap) => clamp(value, -cap, cap) * confidence;

  const efficiency = edge(((home.epaPerPlay - away.epaPerPlay) + (away.defensiveEpaPerPlay - home.defensiveEpaPerPlay)) * 4, 1.25);
  const opponentAdjusted = edge(((metric(home, "opponentAdjusted.epaPerPlay") - metric(away, "opponentAdjusted.epaPerPlay")) + (metric(away, "opponentAdjusted.defensiveEpaPerPlay") - metric(home, "opponentAdjusted.defensiveEpaPerPlay"))) * 2.5, 0.8);
  const early = edge((home.earlyDownEpaPerPlay - away.earlyDownEpaPerPlay) * 2.5, 0.65);
  const success = edge(((home.successRate - away.successRate) + (away.defensiveSuccessRate - home.defensiveSuccessRate)) * 3, 0.65);
  const explosive = edge((home.explosivePlayRate - away.explosivePlayRate) * 5, 0.35);
  const drive = edge(((home.scoringDriveRate - away.scoringDriveRate) + (away.threeAndOutRate - home.threeAndOutRate)) * 1.1, 0.65);
  const situational = edge(((home.thirdDownRate - away.thirdDownRate) + (home.redZoneTouchdownRate - away.redZoneTouchdownRate)) * 0.55, 0.4);
  const protection = edge(((home.pressureGeneratedRate - away.pressureGeneratedRate) + (away.pressureAllowedRate - home.pressureAllowedRate)) * 1.5, 0.65);
  const pressureMatchup = edge(((home.pressureGeneratedRate - away.pressureAllowedRate) - (away.pressureGeneratedRate - home.pressureAllowedRate)) * 1.35, 0.55);
  const coverageMatchup = edge(((away.passingEpaAllowedPerPlay - home.passingEpaPerPlay) - (home.passingEpaAllowedPerPlay - away.passingEpaPerPlay)) * 0.8 + ((away.explosivePlayRateAllowed - home.explosivePlayRate) - (home.explosivePlayRateAllowed - away.explosivePlayRate)) * 1.5, 0.5);
  const snapAvailable = Boolean(away.snapParticipation?.available && home.snapParticipation?.available);
  const snapConfidence = Math.min(metric(away, "snapParticipation.continuityScore"), metric(home, "snapParticipation.continuityScore"), confidence);
  const snapDifference = metric(home, "snapParticipation.continuityScore") - metric(away, "snapParticipation.continuityScore");
  const lineRegularDifference = metric(home, "snapParticipation.offensiveLineRegulars") - metric(away, "snapParticipation.offensiveLineRegulars");
  const snaps = edge(snapDifference * 0.9, 0.45);
  const line = edge(lineRegularDifference * 0.12 + snapDifference * 0.35, 0.75);
  const lineupAvailable = Boolean(away.expectedLineup?.available && home.expectedLineup?.available && away.expectedLineup?.schemaValidated && home.expectedLineup?.schemaValidated);
  const lineup = edge((metric(home, "expectedLineup.projectedStarters") - metric(away, "expectedLineup.projectedStarters")) * 0.04, 0.3);
  const turnover = edge(((metric(away, "turnoversPerDrive") - metric(home, "turnoversPerDrive")) + (metric(home, "takeawaysPerDrive") - metric(away, "takeawaysPerDrive"))) * 0.9, 0.65);
  const averagePlays = (metric(away, "playsPerGame") + metric(home, "playsPerGame")) / 2;
  const paceTotal = edge((averagePlays - 63) * 0.055, 0.65);

  return {
    scoringBaseline: buildScoringBaseline(away, home, confidence),
    playByPlayEfficiency: layer(efficiency, confidence, "EPA per play and defensive EPA allowed"),
    opponentAdjustedEfficiency: layer(opponentAdjusted, confidence, "Opponent-adjusted offensive and defensive EPA"),
    earlyDownEpa: layer(early, confidence, "Early-down EPA per play"),
    successRate: layer(success, confidence, "Offensive and defensive success rate"),
    explosivePlays: layer(explosive, confidence, "Explosive pass and rush rate"),
    driveEfficiency: layer(drive, confidence, "Scoring-drive and three-and-out efficiency"),
    situationalEfficiency: layer(situational, confidence, "Third-down and red-zone performance"),
    passProtection: layer(protection, confidence, "Pressure generated versus pressure allowed"),
    pressureMatchup: layer(pressureMatchup, confidence, "Defensive pressure matched against opponent protection"),
    coverageMatchup: layer(coverageMatchup, confidence, "Passing EPA and explosive rate matched against opponent coverage results"),
    snapParticipation: sourceLayer(snaps, snapConfidence, "Snap-weighted participation and returning workload", snapAvailable),
    offensiveLineContinuity: sourceLayer(line, snapConfidence, "Offensive-line regulars, returning workload and snap continuity", snapAvailable),
    expectedLineup: sourceLayer(lineup, confidence, "Validated depth-chart starters", lineupAvailable),
    turnoverRegression: layer(turnover, confidence, "Regressed interceptions, fumbles and takeaways per drive"),
    pace: totalLayer(paceTotal, confidence, "Current-season offensive play volume"),
  };
}

function buildScoringBaseline(away, home, confidence) {
  const awayExpected = expectedPoints(away, home);
  const homeExpected = expectedPoints(home, away);
  return {
    active: true,
    awayPoints: 0,
    homePoints: 0,
    awayExpected,
    homeExpected,
    gamesUsed: {
      away: Number(away?.games) || 0,
      home: Number(home?.games) || 0,
    },
    confidence,
    reasons: ["Current-season nflverse scoring, drive efficiency and opponent defensive efficiency"],
  };
}

function expectedPoints(offense, opposingDefense) {
  const offenseDriveScore = metric(offense, "scoringDriveRate");
  const offenseRedZone = metric(offense, "redZoneTouchdownRate");
  const offenseEpa = metric(offense, "epaPerPlay");
  const defenseEpa = metric(opposingDefense, "defensiveEpaPerPlay");
  const plays = metric(offense, "playsPerGame") || 63;
  const drives = Math.max(8, plays / 6.1);
  const pointsPerScoringDrive = 3 + clamp(offenseRedZone, 0, 1) * 4;
  const drivePoints = drives * clamp(offenseDriveScore, 0.15, 0.65) * pointsPerScoringDrive;
  const efficiencyAdjustment = clamp((offenseEpa - defenseEpa) * 16, -4.5, 4.5);
  return round(clamp(drivePoints + efficiencyAdjustment, 10, 38));
}

function sourceLayer(edge, confidence, reason, available) {
  return available ? { ...layer(edge, confidence, reason), available: true } : { active: false, available: false, awayPoints: 0, homePoints: 0, confidence: 0, reasons: [reason] };
}
function totalLayer(points, confidence, reason) {
  return { active: Math.abs(points) > 0.01, available: true, awayPoints: round(points / 2), homePoints: round(points / 2), confidence: round(confidence), reasons: [reason] };
}
function metric(object, path) {
  const value = path.split(".").reduce((current, key) => current?.[key], object);
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}
function confidenceForSample(team) {
  const games = Number(team?.games) || 0;
  const plays = Math.min(Number(team?.offensivePlays) || 0, Number(team?.defensivePlays) || 0);
  return Math.min(0.85, games / 6, plays / 360);
}
function confidenceForWeek(week) {
  const curve = { 2: 0.25, 3: 0.4, 4: 0.55, 5: 0.7 };
  return curve[Number(week)] ?? (Number(week) >= 6 ? 0.8 : 0);
}
function layer(edge, confidence, reason) {
  return { active: Math.abs(edge) > 0.01, awayPoints: round(-edge / 2), homePoints: round(edge / 2), confidence: round(confidence), reasons: [reason] };
}
function sendNeutral(res, season, week, away, home, reason) {
  const neutral = { active: false, awayPoints: 0, homePoints: 0, confidence: 0, reasons: [] };
  return res.status(200).json({ season, week, source: "nflverse/nflfastR", away: { team: away, games: 0 }, home: { team: home, games: 0 }, modelLayers: { scoringBaseline: { ...neutral, awayExpected: null, homeExpected: null, gamesUsed: { away: 0, home: 0 } }, playByPlayEfficiency: { ...neutral }, earlyDownEpa: { ...neutral }, successRate: { ...neutral }, explosivePlays: { ...neutral }, driveEfficiency: { ...neutral }, situationalEfficiency: { ...neutral }, passProtection: { ...neutral }, pressureMatchup: { ...neutral }, coverageMatchup: { ...neutral }, snapParticipation: { ...neutral }, offensiveLineContinuity: { ...neutral }, expectedLineup: { ...neutral }, opponentAdjustedEfficiency: { ...neutral }, turnoverRegression: { ...neutral }, pace: { ...neutral } }, dataStatus: "neutral", reason });
}
function normalizeTeamCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return TEAM_ALIASES[code] || code;
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value) || 0)); }
function round(value) { return Math.round((Number(value) || 0) * 1000) / 1000; }
