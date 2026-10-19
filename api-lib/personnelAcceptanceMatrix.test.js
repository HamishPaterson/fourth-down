import test from "node:test";
import assert from "node:assert/strict";
import dataset from "../api/nfl/nflverse-team-metrics.js";
import playerMetricsArtifact from "../data/nflverse-player-metrics.js";
import { playerMetricsResponse } from "./playerMetrics.js";
import { buildPersonnelView } from "./personnelView.js";
import { buildPlayerProjections } from "../src/services/playerProjectionService.js";
import { buildBestBets } from "../src/services/bestBetsService.js";
import { buildWeeklyMultiSelection } from "./weeklyMulti.js";
import { CURRENT_MODEL_VERSION, CURRENT_MODEL_KEY } from "../src/services/modelIdentity.js";
import { predictMatchup } from "../src/services/predictionEngine.js";
import { buildTeamHealth } from "../api/nfl/qb-roster-health.js";

const WEEK = 6;
const KICKOFF = "2026-10-18T17:00:00Z";
const QUOTE_AS_OF = "2026-10-16T10:00:00Z";
const ROUNDING_TOLERANCE = 0.11;
const HOUSTON = dataset.metricsByWeek[WEEK].HOU;
const JACKSONVILLE = dataset.metricsByWeek[WEEK].JAX;
const TAMPA = dataset.metricsByWeek[WEEK].TB;
const KANSAS_CITY = dataset.metricsByWeek[WEEK].KC;
const CUTOFF = HOUSTON.expectedLineup.cutoff;

function playerMetrics(away = "HOU", home = "JAX") {
  return structuredClone(playerMetricsResponse(playerMetricsArtifact, {
    season: 2026, week: WEEK, away, home,
  }));
}

function personnelView(team, lineup, statuses = {}, depthOrders = {}, cutoff = lineup.cutoff || CUTOFF) {
  const players = lineup.roster.map((role) => ({
    id: `fixture-${role.gsisId}`,
    gsisId: role.gsisId,
    fullName: role.name,
    team,
    position: role.position,
    depthChartPosition: role.position,
    depthChartOrder: depthOrders[role.gsisId] || role.rank,
    status: "Active",
    injuryStatus: statuses[role.gsisId] || "Active",
  }));
  return buildPersonnelView({
    team, lineup, season: 2026, week: WEEK, cutoff,
    roster: {
      team, sourceAsOf: new Date(Date.parse(cutoff) - 12 * 60 * 60 * 1000).toISOString(),
      groups: { roster: players },
      leagueIdentityIndex: players.map((player) => ({ gsisId: player.gsisId, team })),
    },
  });
}

function predictionFor(metrics, away = "HOU", home = "JAX", awayMetrics = HOUSTON, homeMetrics = JACKSONVILLE) {
  return predictMatchup(away, home, {
    season: 2026,
    week: WEEK,
    kickoff: KICKOFF,
    weather: { dome: true },
    teamMetrics: { season: 2026, week: WEEK, away: awayMetrics, home: homeMetrics },
    playerMetrics: metrics,
  });
}

function inputFor(statuses = {}, metrics = playerMetrics(), depthOrders = {}) {
  const personnelViews = {
    away: personnelView("HOU", HOUSTON.expectedLineup, statuses, depthOrders),
    home: personnelView("JAX", JACKSONVILLE.expectedLineup),
  };
  const prediction = predictionFor(metrics);
  const teamMetrics = {
    away: { team: "HOU", expectedLineup: HOUSTON.expectedLineup },
    home: { team: "JAX", expectedLineup: JACKSONVILLE.expectedLineup },
  };
  const playerProjections = buildPlayerProjections({
    away: "HOU", home: "JAX", prediction, playerMetrics: metrics,
    personnelViews, teamMetrics, season: 2026, week: WEEK, cutoff: CUTOFF,
  });
  return { prediction, personnelViews, teamMetrics, playerProjections, metrics };
}

function tampaInput(depthOrders = {}) {
  const cutoff = TAMPA.expectedLineup.cutoff;
  const metrics = playerMetrics("TB", "KC");
  const personnelViews = {
    away: personnelView("TB", TAMPA.expectedLineup, {}, depthOrders, cutoff),
    home: personnelView("KC", KANSAS_CITY.expectedLineup, {}, {}, cutoff),
  };
  const prediction = predictionFor(metrics, "TB", "KC", TAMPA, KANSAS_CITY);
  const teamMetrics = {
    away: { team: "TB", expectedLineup: TAMPA.expectedLineup },
    home: { team: "KC", expectedLineup: KANSAS_CITY.expectedLineup },
  };
  const playerProjections = buildPlayerProjections({
    away: "TB", home: "KC", prediction, playerMetrics: metrics,
    personnelViews, teamMetrics, season: 2026, week: WEEK, cutoff,
  });
  return { prediction, personnelViews, teamMetrics, playerProjections, metrics, cutoff };
}

function reproject(input, prediction) {
  input.prediction = prediction;
  input.playerProjections = buildPlayerProjections({
    away: input.teamMetrics.away.team, home: input.teamMetrics.home.team,
    prediction, playerMetrics: input.metrics,
    personnelViews: input.personnelViews, teamMetrics: input.teamMetrics,
    season: 2026, week: WEEK, cutoff: input.cutoff || CUTOFF,
  });
  return input;
}

function withSupportedMillsProfile(metrics) {
  const id = allRoles("QB").find((role) => role.name === "Davis Mills")?.gsisId;
  const stroud = metrics.away.players[primaryRole("QB").gsisId];
  assert.ok(id && stroud?.gameLog?.length, "test fixture source includes an eligible prior game");
  const game = stroud.gameLog[0];
  metrics.away.players[id] = {
    ...structuredClone(stroud),
    playerId: id,
    gsisId: id,
    playerName: "Davis Mills",
    team: "HOU",
    games: 1,
    weeks: [game.week],
    gameLog: [{
      ...game,
      playerId: id,
      playerName: "Davis Mills",
      passingAttempts: 24,
      completions: 15,
      passingYards: 168,
      passingTouchdowns: 1,
      interceptions: 0,
      sacksTaken: 2,
    }],
    passing: {
      dropbacks: 26, attempts: 24, completions: 15, yards: 168, touchdowns: 1,
      interceptions: 0, sacksTaken: 2, sackRate: 2 / 26, completionRate: 15 / 24,
      yardsPerAttempt: 7, attemptsPerGame: 24, completionsPerGame: 15,
      yardsPerGame: 168, touchdownsPerGame: 1,
    },
    combined: { ...structuredClone(stroud.combined), opportunityShare: 0.35 },
    recent: { ...structuredClone(stroud.recent), games: 1, targetsPerGame: 0, rushingAttemptsPerGame: 1 },
  };
  return metrics;
}

function primaryRole(group) {
  const row = HOUSTON.expectedLineup.roster.find((player) =>
    player.group === group && player.rank === 1);
  assert.ok(row, `Houston fixture has a ${group}1`);
  return row;
}

function allRoles(group) {
  return HOUSTON.expectedLineup.roster.filter((player) => player.group === group)
    .sort((a, b) => a.rank - b.rank);
}

function opportunitySummary(team) {
  const allocatedTargets = team.players.reduce((sum, player) => sum + (player.targets || 0), 0);
  const allocatedCarries = team.players.reduce((sum, player) => sum + (player.rushingAttempts || 0), 0);
  return {
    passAttempts: team.passAttempts,
    expectedPlays: team.expectedPlays,
    passRate: team.passRate,
    allocatedTargets,
    targetShare: allocatedTargets / team.passAttempts,
    unallocatedTargets: team.unallocatedTargets,
    rushAttempts: team.rushAttempts,
    allocatedCarries,
    carryShare: allocatedCarries / team.rushAttempts,
    unallocatedCarries: team.unallocatedCarries,
    targetAllocations: Object.fromEntries(team.players
      .filter((player) => player.targets > 0)
      .map((player) => [player.playerId, player.targets])),
    carryAllocations: Object.fromEntries(team.players
      .filter((player) => player.rushingAttempts > 0)
      .map((player) => [player.playerId, player.rushingAttempts])),
  };
}

function statusScenario(name, statuses, omittedProfileIds = []) {
  const metrics = structuredClone(playerMetrics());
  for (const id of omittedProfileIds) delete metrics.away.players[id];
  return { name, input: inputFor(statuses, metrics), statuses };
}

function assertOpportunityConservation(row, scenario) {
  const team = scenario.input.playerProjections.away;
  const profileIds = new Set(Object.keys(scenario.input.metrics.away.players));
  const values = [
    row.passAttempts, row.allocatedTargets, row.targetShare, row.unallocatedTargets,
    row.rushAttempts, row.allocatedCarries, row.carryShare, row.unallocatedCarries,
  ];
  assert.ok(values.every(Number.isFinite), `${scenario.name}: finite values`);
  assert.ok(values.every((value) => value >= 0), `${scenario.name}: no negative allocations`);
  assert.ok(row.targetShare <= 1 + Number.EPSILON * 4,
    `${scenario.name}: target share at most 1 (${JSON.stringify(row)})`);
  assert.ok(row.carryShare <= 1 + Number.EPSILON * 4,
    `${scenario.name}: carry share at most 1 (${JSON.stringify(row)})`);
  assert.ok(Math.abs(row.allocatedTargets + row.unallocatedTargets - row.passAttempts) <= ROUNDING_TOLERANCE,
    `${scenario.name}: target rounding residual within ${ROUNDING_TOLERANCE}`);
  assert.ok(Math.abs(row.allocatedCarries + row.unallocatedCarries - row.rushAttempts) <= ROUNDING_TOLERANCE,
    `${scenario.name}: carry rounding residual within ${ROUNDING_TOLERANCE} (${JSON.stringify(row)})`);
  for (const player of team.players) {
    assert.ok(profileIds.has(player.playerId),
      `${scenario.name}: no fabricated player profile (${player.playerId}); available=${[...profileIds].join(",")}`);
    assert.ok((player.targets || 0) / row.passAttempts <= 0.6 + 0.0001,
      `${scenario.name}: receiving-share cap for ${player.playerId}`);
    assert.ok((player.rushingAttempts || 0) / row.rushAttempts <= 0.8 + 0.0001,
      `${scenario.name}: carry-share cap for ${player.playerId}`);
  }
  for (const [id, status] of Object.entries(scenario.statuses)) {
    if (!["Out", "Doubtful", "Inactive", "IR", "PUP", "Suspended", "NFI"].includes(status)) continue;
    const unavailable = team.players.find((player) => player.personnelId === id);
    assert.equal(unavailable, undefined, `${scenario.name}: unavailable player has no named projection`);
    assert.equal(row.targetAllocations[id] || 0, 0, `${scenario.name}: unavailable player has zero targets`);
    assert.equal(row.carryAllocations[id] || 0, 0, `${scenario.name}: unavailable player has zero carries`);
  }
  return {
    ...row,
    teamPassAttemptsDelta: row.passAttempts - opportunitySummary(scenario.baseline.playerProjections.away).passAttempts,
    teamCarriesDelta: row.rushAttempts - opportunitySummary(scenario.baseline.playerProjections.away).rushAttempts,
  };
}

const MARKET_BY_POSITION = Object.freeze({
  QB: { key: "player_pass_yds", field: "passingYards", deviation: 42, minimum: 150.5, maximum: 399.5 },
  RB: { key: "player_rush_attempts", field: "rushingAttempts", deviation: 4.5, minimum: 1.5, maximum: 35.5 },
  WR: { key: "player_receptions", field: "receptions", deviation: 2.4, minimum: 1.5, maximum: 10.5 },
  TE: { key: "player_receptions", field: "receptions", deviation: 2.4, minimum: 1.5, maximum: 10.5 },
});

function nearestLine(projection, market) {
  const value = Math.floor((projection - market.deviation * 0.4) * 2) / 2;
  return Math.max(market.minimum, Math.min(market.maximum, value));
}

function logisticProbability(projection, line, deviation) {
  return Math.max(0.05, Math.min(0.95, 1 / (1 + Math.exp(-(projection - line) / deviation))));
}

function americanPriceForImplied(probability) {
  return probability >= 0.5
    ? -Math.round(100 * probability / (1 - probability))
    : Math.round(100 * (1 - probability) / probability);
}

function makeQuoteEvent(scenarios) {
  const projectionsById = new Map();
  const roles = new Map(HOUSTON.expectedLineup.roster.map((role) => [role.gsisId, role]));
  for (const scenario of scenarios) {
    for (const player of scenario.input.playerProjections.away.players) {
      if (!projectionsById.has(player.personnelId)) projectionsById.set(player.personnelId, player);
    }
  }
  const markets = [];
  for (const role of HOUSTON.expectedLineup.roster.filter((player) =>
    ["QB", "RB", "WR", "TE"].includes(player.group))) {
    const market = MARKET_BY_POSITION[role.group];
    const projected = projectionsById.get(role.gsisId);
    const projection = Number(projected?.[market.field]);
    const line = Number.isFinite(projection) ? nearestLine(projection, market) :
      role.group === "QB" ? 200.5 : market.minimum;
    const probability = Number.isFinite(projection)
      ? logisticProbability(projection, line, market.deviation) : 0.55;
    const implied = Math.max(0.05, probability - 0.05);
    markets.push({
      key: market.key,
      last_update: QUOTE_AS_OF,
      outcomes: [
        { name: "Over", playerName: role.name, point: line, price: americanPriceForImplied(implied) },
        { name: "Under", playerName: role.name, point: line, price: -110 },
      ],
    });
  }
  assert.ok(roles.size > 0);
  return {
    id: "mock-houston-week-six",
    away_team: "Houston Texans",
    home_team: "Jacksonville Jaguars",
    commence_time: KICKOFF,
    bookmakers: [{
      key: "draftkings", title: "DraftKings", last_update: QUOTE_AS_OF, markets,
    }],
  };
}

function betsFor(scenario, oddsEvent) {
  return buildBestBets({
    game: { away: "HOU", home: "JAX", season: 2026, week: WEEK },
    prediction: scenario.input.prediction,
    playerProjections: scenario.input.playerProjections,
    personnelViews: scenario.input.personnelViews,
    oddsEvent,
    quoteAsOf: new Date("2026-10-16T11:00:00Z"),
    dataQuality: { personnel: true, playByPlay: true, teamForm: true },
    audit: true,
  });
}

function weeklyLegForCandidate(scenario, candidate, oddsEvent) {
  const bestBets = {
    candidates: [candidate],
    recommendations: [candidate],
    candidateVersion: 3,
  };
  const selection = buildWeeklyMultiSelection(
    [{
      season: 2026, week: WEEK, awayCode: "HOU", homeCode: "JAX", kickoff: KICKOFF,
      modelVersion: CURRENT_MODEL_VERSION, modelKey: CURRENT_MODEL_KEY,
      bestBets, personnelViews: scenario.input.personnelViews,
    }],
    { cacheStatus: "fresh", events: [oddsEvent] },
    { season: 2026, week: WEEK, lockAt: "2026-10-16T20:00:00Z" },
    new Date("2026-10-16T11:00:00Z"),
  );
  return selection.legs.find((leg) => leg.personnelId === candidate.personnelId &&
    leg.market === candidate.market && leg.selection === candidate.selection) || null;
}

function weeklyContainsCandidate(scenario, candidate, oddsEvent) {
  return Boolean(weeklyLegForCandidate(scenario, candidate, oddsEvent));
}

const DOUBLE_COUNTING_LAYERS = Object.freeze([
  "QB personnel penalty",
  "non-QB personnel penalty",
  "QB rating/performance",
  "offensive unit rating",
  "defensive unit rating",
  "player exclusion",
  "replacement selection",
  "opportunity redistribution",
  "play mix",
  "player matchup efficiency",
  "Phase 1",
  "Phase 2A",
  "Opponent-Network",
  "Best Bets probability",
  "Weekly Multi probability",
]);
const VALID_PAIR_CLASSES = new Set([
  "no_overlap",
  "intentional_documented",
  "intentional_uncalibrated",
  "inactive_in_fixture",
  "accidental_double_counting",
]);
const UNCALIBRATED_PAIRS = new Set([
  "1:3", "1:4", "2:4", "2:5", "3:4", "4:5",
]);
const DOCUMENTED_LAYERS = new Set([6, 7, 8, 9, 10, 14, 15]);

function classifyLayerPair(first, second, opponentNetworkActive) {
  const [a, b] = [first, second].sort((left, right) => left - right);
  if (!opponentNetworkActive && (a === 13 || b === 13)) return "inactive_in_fixture";
  if (UNCALIBRATED_PAIRS.has(`${a}:${b}`)) return "intentional_uncalibrated";
  if (DOCUMENTED_LAYERS.has(a) && DOCUMENTED_LAYERS.has(b)) return "intentional_documented";
  if ((a === 14 || a === 15 || b === 14 || b === 15) &&
      (DOCUMENTED_LAYERS.has(a) || DOCUMENTED_LAYERS.has(b))) return "intentional_documented";
  if ([1, 2].includes(a) && DOCUMENTED_LAYERS.has(b)) return "intentional_documented";
  if ([1, 2].includes(b) && DOCUMENTED_LAYERS.has(a)) return "intentional_documented";
  return "no_overlap";
}

test("all 105 personnel layer pairs have one reviewed classification and no accidental overlap", () => {
  const baseline = predictionFor(playerMetrics());
  const opponentNetworkActive = baseline.modelLayers.opponentNetwork?.available === true;
  const rows = [];
  for (let first = 1; first <= DOUBLE_COUNTING_LAYERS.length; first += 1) {
    for (let second = first + 1; second <= DOUBLE_COUNTING_LAYERS.length; second += 1) {
      rows.push({
        first,
        second,
        pair: `${DOUBLE_COUNTING_LAYERS[first - 1]} × ${DOUBLE_COUNTING_LAYERS[second - 1]}`,
        classifications: [classifyLayerPair(first, second, opponentNetworkActive)],
      });
    }
  }
  const pairKeys = rows.map((row) => `${row.first}:${row.second}`);
  assert.equal(DOUBLE_COUNTING_LAYERS.length, 15);
  assert.equal(rows.length, 105);
  assert.equal(new Set(pairKeys).size, 105, "every unordered pair appears exactly once");
  for (const row of rows) {
    assert.equal(row.classifications.length, 1, `${row.pair} has exactly one classification`);
    assert.ok(VALID_PAIR_CLASSES.has(row.classifications[0]),
      `${row.pair} has a known classification`);
  }
  const totals = Object.fromEntries([...VALID_PAIR_CLASSES].map((classification) => [
    classification, rows.filter((row) => row.classifications[0] === classification).length,
  ]));
  assert.equal(Object.values(totals).reduce((sum, count) => sum + count, 0), 105);
  assert.equal(totals.accidental_double_counting, 0,
    `stop if an accidental overlap is found: ${JSON.stringify(rows.filter((row) =>
      row.classifications[0] === "accidental_double_counting"))}`);

  const activePersonnel = inputFor({ [primaryRole("WR").gsisId]: "Out" });
  const scenario = activePersonnel.playerProjections.away;
  assert.equal(scenario.players.some((player) => player.personnelId === primaryRole("WR").gsisId), false,
    "unavailable player excluded from projections");
  assert.deepEqual(activePersonnel.prediction, baseline,
    "player exclusion and redistribution do not add a second team-scoring penalty");
  const qbId = primaryRole("QB").gsisId;
  const qbHealth = buildTeamHealth("HOU", HOUSTON.expectedLineup.roster.map((role) => ({
    id: `fixture-${role.gsisId}`, gsis_id: role.gsisId, team: "HOU",
    position: role.position, depth_chart_position: role.position, depth_chart_order: role.rank,
    full_name: role.name, status: "Active", injury_status: role.gsisId === qbId ? "Out" : "Active",
  })), [], 2026, WEEK, CUTOFF, "2026-10-15T12:00:00Z");
  assert.equal(qbHealth.rosterHealth.affectedStarters.some((player) => player.position === "QB"), false,
    "QB absence is not counted in the non-QB personnel penalty");

  const adjusted = predictMatchup("HOU", "JAX", {
    season: 2026, week: WEEK, kickoff: KICKOFF, weather: { dome: true },
    teamMetrics: { season: 2026, week: WEEK, away: HOUSTON, home: JACKSONVILLE },
    playerMetrics: playerMetrics(),
    modelLayers: { rosterHealth: {
      active: true, available: true, awayPoints: -0.42, homePoints: 0, confidence: 1,
    } },
  });
  const phase1 = ["rushMatchup", "passMatchup", "successMatchup", "explosiveMatchup", "pressureMatchup"];
  const phase2a = ["thirdDownMatchup", "redZoneMatchup"];
  for (const layer of [...phase1, ...phase2a, "opponentNetwork"]) {
    assert.equal(JSON.stringify(adjusted.modelLayers[layer]), JSON.stringify(baseline.modelLayers[layer]),
      `${layer} evidence remains byte-identical for personnel-score-only change`);
  }
  assert.equal(adjusted.modelLayers.opponentNetwork?.available === true, opponentNetworkActive);

  const millsId = allRoles("QB").find((role) => role.name === "Davis Mills").gsisId;
  const millsScenario = inputFor({ [primaryRole("QB").gsisId]: "Out" },
    withSupportedMillsProfile(playerMetrics()));
  assert.equal(millsScenario.playerProjections.away.startingQuarterback, millsId);
  const millsProjection = millsScenario.playerProjections.away.players
    .filter((player) => player.position === "QB");
  assert.equal(millsProjection.length, 1, "the supported replacement profile is consumed once");
  assert.equal(millsProjection[0].profile.passing.yardsPerAttempt, 7);
  console.log("PERSONNEL_DOUBLE_COUNTING_TOTALS", JSON.stringify({
    pairCount: rows.length, classifications: totals, accidentalPairs: [],
  }));
});

test("Houston Week 6 opportunity matrix conserves player allocations separately from team volume", () => {
  const qbStarter = primaryRole("QB");
  const qbBackup = allRoles("QB").find((role) => role.rank > qbStarter.rank);
  const wr1 = primaryRole("WR");
  const wr2 = allRoles("WR").find((role) => role.rank > wr1.rank);
  const rb1 = primaryRole("RB");
  const te1 = primaryRole("TE");
  assert.ok(qbBackup && wr2);
  const scenarios = [
    { name: "baseline", statuses: {} },
    { name: "Stroud Out / Mills supported", statuses: { [qbStarter.gsisId]: "Out" }, millsSupported: true },
    { name: "Stroud Out / no supported QB", statuses: Object.fromEntries(
      allRoles("QB").map((role) => [role.gsisId, "Out"])) },
    { name: "Nico Collins Out", statuses: { [wr1.gsisId]: "Out" } },
    { name: "RB1 Out", statuses: { [rb1.gsisId]: "Out" } },
    { name: "TE1 Out", statuses: { [te1.gsisId]: "Out" } },
    { name: "multiple WRs Out", statuses: { [wr1.gsisId]: "Out", [wr2.gsisId]: "Out" } },
    { name: "Nico Collins Questionable", statuses: { [wr1.gsisId]: "Questionable" } },
    { name: "Nico Collins Unknown availability", statuses: { [wr1.gsisId]: "Unknown" } },
  ].map((scenario) => ({
    ...scenario,
    input: inputFor(scenario.statuses,
      scenario.millsSupported ? withSupportedMillsProfile(playerMetrics()) : playerMetrics()),
  }));
  const fixedPrediction = scenarios[0].input.prediction;
  for (const scenario of scenarios) reproject(scenario.input, fixedPrediction);
  delete scenarios[2].input.metrics.away.players[qbBackup.gsisId];
  scenarios[2].input = inputFor(scenarios[2].statuses, scenarios[2].input.metrics);
  reproject(scenarios[2].input, fixedPrediction);
  const rows = scenarios.map((scenario) => opportunitySummary(scenario.input.playerProjections.away));
  for (const scenario of scenarios) scenario.baseline = scenarios[0].input;

  for (let index = 0; index < scenarios.length; index += 1) {
    assertOpportunityConservation(rows[index], scenarios[index]);
  }
  assert.equal(qbBackup.name, "Davis Mills");
  assert.equal(scenarios[1].input.playerProjections.away.startingQuarterback, qbBackup.gsisId,
    `Mills is selected by supported point-in-time evidence (${JSON.stringify({
      expected: qbBackup.gsisId,
      actual: scenarios[1].input.playerProjections.away.startingQuarterback,
      reason: scenarios[1].input.personnelViews.away.quarterback.reason,
    })})`);
  assert.equal(scenarios[2].input.playerProjections.away.startingQuarterback, null,
    "without a supported QB profile no named QB is projected");
  assert.equal(scenarios[2].input.playerProjections.away.players.some((player) => player.position === "QB"), false);
  assert.equal(scenarios[7].input.playerProjections.away.players
    .find((player) => player.personnelId === wr1.gsisId).personnel.status, "Questionable");
  assert.equal(scenarios[8].input.playerProjections.away.players
    .find((player) => player.personnelId === wr1.gsisId).personnel.status, "Unknown");
  assert.ok(rows.every((row) => row.expectedPlays === rows[0].expectedPlays &&
    row.passRate === rows[0].passRate),
  "fixed team prediction keeps play volume and play mix unchanged; pass/carry volume deltas are separately reported");
  console.log("PERSONNEL_OPPORTUNITY_MATRIX", JSON.stringify(scenarios.map((scenario, index) => ({
    scenario: scenario.name,
    ...rows[index],
    teamPassAttemptsDelta: rows[index].passAttempts - rows[0].passAttempts,
    teamCarriesDelta: rows[index].rushAttempts - rows[0].rushAttempts,
  }))));
});

test("Houston priced candidate matrix uses fixed near-threshold quotes and ordinary downstream probabilities", () => {
  const qbStarter = primaryRole("QB");
  const wr1 = primaryRole("WR");
  const rb1 = primaryRole("RB");
  const te1 = primaryRole("TE");
  const scenarioDefinitions = [
    { name: "baseline", statuses: {} },
    { name: "QB Out with supported replacement", statuses: { [qbStarter.gsisId]: "Out" }, millsSupported: true },
    { name: "QB Out without supported replacement", statuses: Object.fromEntries(
      allRoles("QB").map((role) => [role.gsisId, "Out"])), unsupported: true },
    { name: "WR1 Out", statuses: { [wr1.gsisId]: "Out" } },
    { name: "RB1 Out", statuses: { [rb1.gsisId]: "Out" } },
    { name: "TE1 Out", statuses: { [te1.gsisId]: "Out" } },
    { name: "WR1 Questionable", statuses: { [wr1.gsisId]: "Questionable" } },
    { name: "WR1 Doubtful", statuses: { [wr1.gsisId]: "Doubtful" } },
    { name: "WR1 Unknown availability", statuses: { [wr1.gsisId]: "Unknown" } },
  ];
  const scenarios = scenarioDefinitions.map((definition) => {
    const scenario = {
      ...definition,
      input: inputFor(definition.statuses,
        definition.millsSupported ? withSupportedMillsProfile(playerMetrics()) : playerMetrics()),
    };
    if (definition.unsupported) {
      const qbBackup = allRoles("QB").find((role) => role.rank > qbStarter.rank);
      delete scenario.input.metrics.away.players[qbBackup.gsisId];
      scenario.input = inputFor(definition.statuses, scenario.input.metrics);
    }
    return scenario;
  });
  const fixedPrediction = scenarios[0].input.prediction;
  for (const scenario of scenarios) reproject(scenario.input, fixedPrediction);
  const oddsEvent = makeQuoteEvent(scenarios);
  const results = scenarios.map((scenario) => ({ scenario, bets: betsFor(scenario, oddsEvent) }));
  const candidateKey = (candidate) => `${candidate.personnelId}|${candidate.market}|${candidate.selection}`;
  const baseline = results[0].bets.candidates;
  const baselineSet = new Set(baseline.map(candidateKey));
  const report = results.map(({ scenario, bets }) => {
    const set = new Set(bets.candidates.map(candidateKey));
    const candidateDetails = bets.candidates.map((candidate) => {
      const projected = scenario.input.playerProjections.away.players
        .find((player) => player.personnelId === candidate.personnelId);
      return {
        player: candidate.playerName,
        team: candidate.playerTeam,
        market: candidate.market,
        line: candidate.line,
        decimalOdds: candidate.decimalOdds,
        modelProjection: candidate.modelProjection,
        modelProbability: candidate.modelProbability,
        impliedProbability: candidate.marketProbability,
        edge: candidate.edge,
        EV: candidate.expectedValue,
        roleConfidence: candidate.roleConfidence,
        dataQuality: candidate.dataQuality,
        personnelStatus: projected?.personnel.status || "no_named_projection",
        eligible: true,
        rejectionReason: null,
        bestBets: true,
        weeklyMulti: weeklyContainsCandidate(scenario, candidate, oddsEvent),
      };
    });
    const removed = baseline.filter((candidate) => !set.has(candidateKey(candidate))).map(candidateKey);
    const added = bets.candidates.filter((candidate) => !baselineSet.has(candidateKey(candidate))).map(candidateKey);
    return {
      scenario: scenario.name,
      baselineCandidateSet: [...baselineSet].sort(),
      scenarioCandidateSet: [...set].sort(),
      additions: added.sort(),
      removals: removed.sort(),
      candidates: candidateDetails,
      rejected: bets.assessments.filter((assessment) => assessment.rejectionReasons?.length)
        .map((assessment) => ({
          player: assessment.playerName,
          team: assessment.playerTeam || null,
          market: assessment.market,
          line: assessment.line,
          decimalOdds: assessment.decimalOdds,
          modelProjection: assessment.modelProjection,
          modelProbability: assessment.modelProbability,
          impliedProbability: assessment.marketProbability,
          edge: assessment.edge,
          EV: assessment.expectedValue,
          roleConfidence: assessment.roleConfidence,
          dataQuality: assessment.dataQuality,
          personnelStatus: scenario.input.personnelViews.away.players
            .find((player) => player.name === assessment.playerName)?.status || "Unknown",
          eligible: false,
          rejectionReason: assessment.rejectionReasons,
          bestBets: false,
          weeklyMulti: false,
        })),
    };
  });

  for (const { scenario, bets } of results) {
    const excluded = Object.entries(scenario.statuses || {})
      .filter(([, status]) => ["Out", "Doubtful"].includes(status))
      .map(([id]) => id);
    for (const id of excluded) {
      assert.equal(bets.candidates.some((candidate) => candidate.personnelId === id), false,
        `${scenario.name}: unavailable candidate excluded`);
    }
    assert.ok(bets.candidates.every((candidate) => ["HOU", "JAX"].includes(candidate.playerTeam)));
    for (const candidate of bets.candidates) {
      const projected = scenario.input.playerProjections.away.players
        .find((player) => player.personnelId === candidate.personnelId);
      assert.ok(projected);
      const market = MARKET_BY_POSITION[projected.position];
      const expectedProbability = Math.round(logisticProbability(
        candidate.modelProjection, candidate.line, market.deviation,
      ) * 10000) / 10000;
      assert.equal(candidate.modelProbability, expectedProbability,
        "Best Bets consumes the final projection probability without a second injury deduction");
      assert.ok(candidate.edge >= 0.045 && candidate.expectedValue >= 0.03,
        "existing Best Bets edge and EV thresholds remain in force");
      const weeklyLeg = weeklyLegForCandidate(scenario, candidate, oddsEvent);
      assert.ok(weeklyLeg);
      assert.equal(weeklyLeg.modelProbability, candidate.modelProbability,
        "Weekly Multi consumes the candidate probability without a second injury deduction");
      assert.ok(Math.abs(weeklyLeg.expectedValue - candidate.expectedValue) <= 0.001,
        "Weekly Multi EV differs only by the candidate decimal-odds rounding");
    }
  }
  const questionable = scenarios[6].input.playerProjections.away.players
    .find((player) => player.personnelId === wr1.gsisId);
  const activeWr = scenarios[0].input.playerProjections.away.players
    .find((player) => player.personnelId === wr1.gsisId);
  assert.ok(questionable && activeWr);
  assert.ok(questionable.targets < activeWr.targets);
  assert.ok(questionable.roleConfidence < activeWr.roleConfidence);
  assert.equal(scenarios[6].input.personnelViews.away.players
    .find((player) => player.canonicalId === wr1.gsisId).propEligible, true);
  assert.equal(results[2].bets.candidates.some((candidate) => candidate.position === "QB"), false,
    "QB without a supported own profile has no named candidate");
  assert.equal(results[7].bets.candidates.some((candidate) => candidate.personnelId === wr1.gsisId), false);
  assert.equal(results[8].bets.candidates.some((candidate) => candidate.personnelId === wr1.gsisId), false,
    "Unknown availability is not promoted to healthy/eligible");
  for (const { scenario, bets } of results) {
    for (const candidate of bets.candidates) {
      assert.equal(weeklyContainsCandidate(scenario, candidate, oddsEvent), true,
        "unlocked Weekly Multi receives each eligible candidate at the same model probability");
    }
  }
  console.log("PERSONNEL_CANDIDATE_MATRIX", JSON.stringify(report));
});

test("Tampa Bay unresolved and resolved QB candidate matrix uses Baker Mayfield and Jalon Daniels only", () => {
  const baker = TAMPA.expectedLineup.roster.find((role) => role.name === "Baker Mayfield");
  const jalon = TAMPA.expectedLineup.roster.find((role) => role.name === "Jalon Daniels");
  assert.ok(baker && jalon);
  assert.equal(baker.gsisId, "00-0034855");
  assert.equal(jalon.gsisId, "00-0041251");
  const baselineInput = tampaInput();
  const unresolvedInput = tampaInput({
    [baker.gsisId]: 1,
    [jalon.gsisId]: 1,
  });
  const resolvedInput = tampaInput({
    [baker.gsisId]: 2,
    [jalon.gsisId]: 1,
  });
  assert.equal(unresolvedInput.personnelViews.away.quarterback.conflict, true);
  assert.equal(unresolvedInput.personnelViews.away.quarterback.resolved, false);
  assert.equal(unresolvedInput.playerProjections.away.players.some((player) => player.position === "QB"), false);
  assert.equal(resolvedInput.personnelViews.away.quarterback.resolved, true);
  assert.equal(resolvedInput.personnelViews.away.quarterback.player.canonicalId, jalon.gsisId);
  assert.equal(resolvedInput.playerProjections.away.players.filter((player) => player.position === "QB").length, 1);
  assert.equal(resolvedInput.playerProjections.away.players.find((player) => player.position === "QB")
    .profile.passing.yardsPerAttempt,
  resolvedInput.metrics.away.players[jalon.gsisId].passing.yards /
    resolvedInput.metrics.away.players[jalon.gsisId].passing.attempts,
  "resolved Jalon projection uses Jalon's own supported profile");

  const inputRows = [
    { scenario: "Tampa baseline", input: baselineInput },
    { scenario: "Tampa unresolved QB conflict", input: unresolvedInput },
    { scenario: "Tampa resolved QB conflict", input: resolvedInput },
  ];
  const fixedPrediction = baselineInput.prediction;
  for (const row of inputRows) reproject(row.input, fixedPrediction);
  const projections = new Map();
  for (const row of inputRows) {
    for (const player of row.input.playerProjections.away.players) {
      if (player.position === "QB") projections.set(player.personnelId, player);
    }
  }
  const market = MARKET_BY_POSITION.QB;
  const offers = [baker, jalon].map((role) => {
    const projection = projections.get(role.gsisId);
    const yards = Number(projection?.passingYards);
    const line = Number.isFinite(yards) ? nearestLine(yards, market) : 200.5;
    const probability = Number.isFinite(yards) ? logisticProbability(yards, line, market.deviation) : 0.55;
    return {
      key: market.key,
      last_update: QUOTE_AS_OF,
      outcomes: [
        { name: "Over", playerName: role.name, point: line,
          price: americanPriceForImplied(Math.max(0.05, probability - 0.05)) },
        { name: "Under", playerName: role.name, point: line, price: -110 },
      ],
    };
  });
  const oddsEvent = {
    id: "mock-tampa-week-six-qbs",
    away_team: "Tampa Bay Buccaneers",
    home_team: "Kansas City Chiefs",
    commence_time: KICKOFF,
    bookmakers: [{ key: "draftkings", title: "DraftKings", last_update: QUOTE_AS_OF, markets: offers }],
  };
  const results = inputRows.map(({ scenario, input }) => ({
    scenario,
    input,
    bets: buildBestBets({
      game: { away: "TB", home: "KC", season: 2026, week: WEEK },
      prediction: input.prediction, playerProjections: input.playerProjections,
      personnelViews: input.personnelViews, oddsEvent,
      quoteAsOf: new Date("2026-10-16T11:00:00Z"),
      dataQuality: { personnel: true, playByPlay: true, teamForm: true },
      audit: true,
    }),
  }));
  const key = (candidate) => `${candidate.personnelId}|${candidate.market}|${candidate.selection}`;
  const baselineKeys = new Set(results[0].bets.candidates.map(key));
  const weeklyLeg = (row, candidate) => {
    const selection = buildWeeklyMultiSelection(
      [{
        season: 2026, week: WEEK, awayCode: "TB", homeCode: "KC", kickoff: KICKOFF,
        modelVersion: CURRENT_MODEL_VERSION, modelKey: CURRENT_MODEL_KEY,
        bestBets: { candidates: [candidate], recommendations: [candidate] },
        personnelViews: row.input.personnelViews,
      }],
      { cacheStatus: "fresh", events: [oddsEvent] },
      { season: 2026, week: WEEK, lockAt: "2026-10-16T20:00:00Z" },
      new Date("2026-10-16T11:00:00Z"),
    );
    return selection.legs.find((leg) => leg.personnelId === candidate.personnelId) || null;
  };
  const report = results.map((row) => {
    const candidateKeys = new Set(row.bets.candidates.map(key));
    return {
      scenario: row.scenario,
      baselineCandidateSet: [...baselineKeys].sort(),
      scenarioCandidateSet: [...candidateKeys].sort(),
      additions: row.bets.candidates.filter((candidate) => !baselineKeys.has(key(candidate))).map(key).sort(),
      removals: results[0].bets.candidates.filter((candidate) => !candidateKeys.has(key(candidate))).map(key).sort(),
      candidates: row.bets.candidates.map((candidate) => {
        const player = row.input.playerProjections.away.players
          .find((projection) => projection.personnelId === candidate.personnelId);
        const leg = weeklyLeg(row, candidate);
        assert.ok(leg, "eligible Tampa prop follows normal unlocked Weekly Multi gates");
        assert.equal(leg.modelProbability, candidate.modelProbability);
        return {
          player: candidate.playerName, team: candidate.playerTeam, market: candidate.market,
          line: candidate.line, decimalOdds: candidate.decimalOdds,
          modelProjection: candidate.modelProjection, modelProbability: candidate.modelProbability,
          impliedProbability: candidate.marketProbability, edge: candidate.edge,
          EV: candidate.expectedValue, roleConfidence: candidate.roleConfidence,
          dataQuality: candidate.dataQuality, personnelStatus: player?.personnel.status,
          eligible: true, rejectionReason: null, bestBets: true, weeklyMulti: true,
        };
      }),
      qbRejections: row.bets.assessments.filter((assessment) =>
        [baker.name, jalon.name].includes(assessment.playerName))
        .map((assessment) => {
          const quote = offers.flatMap((offer) => offer.outcomes)
            .find((outcome) => outcome.playerName === assessment.playerName &&
              outcome.name === assessment.selection);
          const projection = row.input.playerProjections.away.players
            .find((player) => player.personnelId ===
              [baker, jalon].find((role) => role.name === assessment.playerName)?.gsisId);
          const price = quote?.price;
          const decimalOdds = assessment.decimalOdds ??
            (price === undefined ? null : price > 0 ? 1 + price / 100 : 1 + 100 / -price);
          const projectedProbability = projection && quote
            ? logisticProbability(projection.passingYards, quote.point, market.deviation)
            : null;
          const modelProbability = assessment.modelProbability ??
            (projectedProbability === null ? null : Math.round(
              (assessment.selection === "Under" ? 1 - projectedProbability : projectedProbability) * 10000,
            ) / 10000);
          const impliedProbability = assessment.marketProbability ??
            (decimalOdds ? Math.round(10000 / decimalOdds) / 10000 : null);
          const edge = assessment.edge ??
            (modelProbability === null || impliedProbability === null ? null :
              Math.round((modelProbability - impliedProbability) * 10000) / 10000);
          const expectedValue = assessment.expectedValue ??
            (modelProbability === null || decimalOdds === null ? null :
              Math.round((modelProbability * decimalOdds - 1) * 10000) / 10000);
          return {
            player: assessment.playerName,
            team: "TB",
            market: assessment.market,
            line: assessment.line ?? quote?.point ?? null,
            decimalOdds,
            modelProjection: assessment.modelProjection ?? projection?.passingYards ?? null,
            modelProbability,
            impliedProbability,
            edge,
            EV: expectedValue,
            roleConfidence: assessment.roleConfidence ?? projection?.roleConfidence ?? null,
            dataQuality: assessment.dataQuality ?? null,
            personnelStatus: row.input.personnelViews.away.players
              .find((player) => player.name === assessment.playerName)?.status ?? "Unknown",
            eligible: false,
            rejectionReason: assessment.rejectionReasons,
            bestBets: assessment.persistedCandidate === true,
            weeklyMulti: false,
          };
        }),
    };
  });
  assert.ok(results[0].bets.candidates.every((candidate) =>
    [baker.gsisId, jalon.gsisId].includes(candidate.personnelId)));
  assert.equal(results[1].bets.candidates.some((candidate) => candidate.position === "QB"), false);
  assert.equal(results[2].bets.candidates.some((candidate) => candidate.personnelId === baker.gsisId), false);
  assert.equal(results[2].bets.candidates.some((candidate) => candidate.position === "QB"), false,
    "a resolved Tampa QB candidate must still meet the normal role-confidence gate");
  assert.ok(report[2].qbRejections.some((row) => row.player === jalon.name &&
    row.rejectionReason.includes("role_confidence_below_0.55")));
  for (const row of results) {
    assert.ok(row.bets.candidates.every((candidate) =>
      candidate.edge >= 0.045 && candidate.expectedValue >= 0.03));
    assert.ok(row.input.playerProjections.away.players.filter((player) => player.position === "QB")
      .every((player) => player.team === "TB" &&
        row.input.metrics.away.players[player.personnelId].team === "TB"));
  }
  console.log("TAMPA_QB_CANDIDATE_MATRIX", JSON.stringify(report));
});
