import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import snapshot, { createEspnSnapshot } from "./espnFpiRatings.js";
import { getTeamRatings } from "./teamRatings.js";
import { predictMatchup } from "./predictionEngine.js";
import artifact from "../../api/nfl/nflverse-team-metrics.js";
import { buildTeamMetricsResponse } from "../../api/nfl/play-by-play.js";
import { solveOpponentNetwork, prepareNetworkGames, loadWeeklyOpponentNetwork } from "../../api/nfl/opponent-network.js";
import { validateTeamArtifact } from "../../scripts/update-nflverse.mjs";
import playerArtifact from "../../data/nflverse-player-metrics.js";
import { playerMetricsResponse } from "../../api-lib/playerMetrics.js";
import { buildPlayerProjections } from "./playerProjectionService.js";

const rankSet = Array.from({ length: 32 }, (_, i) => i + 1);
const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const rows = Object.entries(snapshot.teams).map(([code, team]) => [code, team.record,
  team.espnFpi.overall, team.espnFpi.rank, team.espnFpi.trend, team.espnFpi.offense,
  team.espnFpi.defense, team.espnFpi.specialTeams, team.espnFpi.strengthOfScheduleRank,
  team.espnFpi.remainingStrengthOfScheduleRank, team.espnFpi.averageWinProbabilityRank]);
const efficiencyRows = Object.entries(snapshot.teams).map(([code, team]) => [code, team.record,
  ...["overall", "overallRank", "offense", "offenseRank", "defense", "defenseRank", "specialTeams", "specialTeamsRank"]
    .map((key) => team.efficiencies[key])]);
const options = () => ({
  season: 2026, week: 7, kickoff: "2026-10-25T17:00:00Z",
  espnSnapshot: structuredClone(snapshot),
  teamMetrics: structuredClone(buildTeamMetricsResponse(artifact, { season: 2026, week: 7, away: "NE", home: "CHI" })),
  opponentNetwork: { source: "Fourth Down completed-score Opponent Network",
    season: 2026, week: 7, ratings: { NE: { offense: 1.1, defense: -0.5 }, CHI: { offense: 0.1, defense: 0.8 } } },
});

test("all 32 supplied ESPN teams, rank sets and records are complete and independently validated", () => {
  assert.equal(Object.keys(snapshot.teams).length, 32);
  assert.deepEqual(createEspnSnapshot(rows, efficiencyRows), snapshot);
  for (const getRank of [
    (t) => t.espnFpi.rank, ...["overallRank", "offenseRank", "defenseRank", "specialTeamsRank"]
      .map((key) => (t) => t.efficiencies[key]),
  ]) assert.deepEqual(Object.values(snapshot.teams).map(getRank).sort((a, b) => a - b), rankSet);
  assert.equal(snapshot.teams.SF.espnFpi.overall, 5.9);
  assert.equal(snapshot.teams.MIA.espnFpi.overall, -7.3);
  assert.equal(snapshot.teams.TB.espnFpi.trend, "UP 16");
  assert.equal(snapshot.teams.PHI.espnFpi.trend, "DOWN 9");
  assert.equal(snapshot.teams.WSH.record, "1-4-1");
  assert.equal(snapshot.teams.MIN.efficiencies.overall, 68.4);
  assert.equal(snapshot.teams.LAC.efficiencies.specialTeamsRank, 28);
  assert.equal(snapshot.teams.CHI.record, "5-2-0");
  assert.deepEqual(snapshot.teams.CHI.espnFpi, { overall: 3.9, rank: 7, trend: "UP 5",
    offense: 2.3, defense: 1.1, specialTeams: 0.5, strengthOfScheduleRank: 25,
    remainingStrengthOfScheduleRank: 3, averageWinProbabilityRank: 2 });
  assert.equal(snapshot.teams.CHI.efficiencies.overall, 65.4);
  assert.equal(snapshot.teams.CHI.efficiencies.overallRank, 4);
  assert.equal(snapshot.teams.NE.record, "4-3-0");
  assert.equal(snapshot.teams.NE.espnFpi.overall, 2.3);
  assert.equal(snapshot.teams.NE.espnFpi.rank, 9);
  assert.equal(snapshot.teams.NE.efficiencies.overall, 57.7);
  assert.equal(snapshot.teams.NE.efficiencies.overallRank, 10);
});

for (const conflict of ["duplicate-team", "duplicate-rank", "record", "non-finite", "trend"]) {
  test(`supplied ESPN ${conflict} conflict fails without fixing/deriving source data`, () => {
    const fpi = structuredClone(rows), efficiency = structuredClone(efficiencyRows);
    if (conflict === "duplicate-team") fpi[1][0] = fpi[0][0];
    if (conflict === "duplicate-rank") efficiency[1][5] = efficiency[0][5];
    if (conflict === "record") efficiency[0][1] = "0-0-0";
    if (conflict === "non-finite") fpi[0][2] = NaN;
    if (conflict === "trend") fpi[0][4] = "unknown";
    assert.throws(() => createEspnSnapshot(fpi, efficiency));
  });
}

test("ratings service exposes only raw ESPN values; no pre-blend or synthetic fallback exists", () => {
  for (const [code, team] of Object.entries(snapshot.teams)) {
    const ratings = getTeamRatings(code);
    assert.equal(ratings.overall, team.espnFpi.overall);
    assert.equal(ratings.offense, team.espnFpi.offense);
    assert.equal(ratings.defense, team.espnFpi.defense);
    assert.equal(ratings.specialTeams, team.espnFpi.specialTeams);
    assert.deepEqual(ratings.efficiencies, team.efficiencies);
    assert.equal(ratings.units, "ESPN FPI points");
  }
  assert.equal(getTeamRatings("UNKNOWN").overall, null);
  for (const file of ["./teamRatings.js", "./predictionEngine.js", "./espnFpiRatings.js",
    "./gamePredictionService.js", "../components/MatchupPrediction.jsx",
    "../pages/Teams.jsx", "../pages/TeamDetail.jsx", "../pages/Conference.jsx", "../pages/Divisions.jsx"]) {
    assert.doesNotMatch(read(file), /CURRENT_EFFICIENCY_WEIGHT|blendRating|efficiencyRating|efficiencyWeight/);
  }
});

test("written Week 8 source context validates and the stored network requires no external request", async () => {
  validateTeamArtifact(artifact, { season: 2026, predictionWeek: 8 });
  const audit = artifact.teamMetricsAuditsByWeek[8];
  assert.equal(audit.referenceWeek, 7);
  assert.equal(audit.eligiblePlays, 14374);
  assert.equal(audit.eligibleGames, 107);
  assert.equal(audit.gameProvenance.filter((game) => game.week === 7).length, 14);
  const network = await loadWeeklyOpponentNetwork(2026, 8, {
    cutoff: audit.cutoff, fetchImpl: () => assert.fail("Stored network must not fetch"),
  });
  assert.deepEqual(solveOpponentNetwork(network.games, 8), network.ratings);
  assert.equal(Object.keys(network.ratings).length, 32);
  for (const metrics of Object.values(artifact.metricsByWeek[8])) {
    assert.ok(Number.isFinite(metrics.epaPerPlay));
    assert.ok(Number.isFinite(metrics.defensiveEpaPerPlay));
    assert.ok(Number.isFinite(metrics.opponentAdjusted.epaPerPlay));
    assert.ok(Number.isFinite(metrics.opponentAdjusted.defensiveEpaPerPlay));
    assert.equal(metrics.expectedLineup.predictionWeek, 8);
  }
});

test("Week 8 network changes reach the engine without mutating ESPN or raw NFLverse evidence", () => {
  const input = options();
  input.week = 8;
  input.kickoff = "2026-11-01T21:25:00Z";
  input.teamMetrics = structuredClone(buildTeamMetricsResponse(artifact, { season: 2026, week: 8, away: "NE", home: "MIA" }));
  input.opponentNetwork = structuredClone(artifact.opponentNetworkByWeek[8]);
  input.modelLayers = { ...input.teamMetrics.modelLayers, opponentNetwork: {
    available: true, active: true, confidence: 0.8, awayPoints: 0.5, homePoints: -0.5,
  } };
  const original = predictMatchup("NE", "MIA", input);
  input.opponentNetwork.ratings.NE.offense += 2;
  input.modelLayers.opponentNetwork.awayPoints = -0.5;
  input.modelLayers.opponentNetwork.homePoints = 0.5;
  const changed = predictMatchup("NE", "MIA", input);
  assert.notEqual(changed.continuousMargin, original.continuousMargin);
  assert.deepEqual(changed.inputEvidence.espn, original.inputEvidence.espn);
  assert.deepEqual(changed.inputEvidence.nflverse, original.inputEvidence.nflverse);
  assert.notDeepEqual(changed.inputEvidence.opponentNetwork, original.inputEvidence.opponentNetwork);
});

test("missing Week 8 player data stays unavailable while team-level predictions remain deterministic", () => {
  const teamMetrics = buildTeamMetricsResponse(artifact, { season: 2026, week: 8, away: "NE", home: "MIA" });
  const missingWeekArtifact = structuredClone(playerArtifact);
  delete missingWeekArtifact.playerMetricsByWeek[8];
  const playerMetrics = playerMetricsResponse(missingWeekArtifact, { season: 2026, week: 8, away: "NE", home: "MIA" });
  assert.equal(playerMetrics.available, false);
  assert.match(playerMetrics.reason, /Exact prediction-week player data unavailable/);
  assert.equal(playerMetrics.away, null);
  assert.equal(playerMetrics.home, null);
  const input = { season: 2026, week: 8, kickoff: "2026-11-01T21:25:00Z",
    teamMetrics, playerMetrics, modelLayers: teamMetrics.modelLayers,
    opponentNetwork: artifact.opponentNetworkByWeek[8] };
  const prediction = predictMatchup("NE", "MIA", input);
  assert.deepEqual(predictMatchup("NE", "MIA", input), prediction);
  assert.ok(Number.isFinite(prediction.homeWinProbability));
  assert.equal(prediction.matchupIntelligence.playMix.away.available, false);
  assert.equal(prediction.matchupIntelligence.playMix.home.available, false);
  assert.equal(prediction.matchupIntelligence.playMix.away.reason, playerMetrics.reason);
  assert.equal(prediction.matchupIntelligence.playMix.home.reason, playerMetrics.reason);
  const projections = buildPlayerProjections({ away: "NE", home: "MIA", prediction, playerMetrics,
    teamMetrics, season: 2026, week: 8, cutoff: teamMetrics.away.cutoff });
  assert.equal(projections.available, false);
  assert.equal(projections.away, null);
  assert.equal(projections.home, null);
  assert.deepEqual(projections.reasons, [playerMetrics.reason]);
});

test("engine receives unchanged ESPN fields, NFLverse and network as separately named deterministic evidence", () => {
  const input = options(), before = structuredClone(input);
  const first = predictMatchup("NE", "CHI", input);
  assert.deepEqual(first, predictMatchup("NE", "CHI", input));
  assert.deepEqual(input, before);
  assert.deepEqual(first.inputEvidence.espn.away.fpi, snapshot.teams.NE.espnFpi);
  assert.deepEqual(first.inputEvidence.espn.home.efficiencies, snapshot.teams.CHI.efficiencies);
  assert.deepEqual(first.inputEvidence.nflverse.away, input.teamMetrics.away);
  assert.deepEqual(first.inputEvidence.opponentNetwork, input.opponentNetwork);
  assert.notEqual(first.inputEvidence.nflverse.away.epaPerPlay, first.inputEvidence.nflverse.away.opponentAdjusted.epaPerPlay);
});

test("changing only FPI changes future output without changing NFLverse or network", () => {
  const input = options(), original = predictMatchup("NE", "CHI", input);
  input.espnSnapshot.teams.NE.espnFpi.overall += 5;
  const changed = predictMatchup("NE", "CHI", input);
  assert.notEqual(changed.continuousMargin, original.continuousMargin);
  assert.deepEqual(changed.inputEvidence.nflverse, original.inputEvidence.nflverse);
  assert.deepEqual(changed.inputEvidence.opponentNetwork, original.inputEvidence.opponentNetwork);
});

test("efficiencies, special teams and schedule ranks without model coefficients are diagnostic-only, never double counted", () => {
  const input = options(), original = predictMatchup("NE", "CHI", input);
  input.espnSnapshot.teams.NE.efficiencies.offense += 5;
  input.espnSnapshot.teams.NE.espnFpi.strengthOfScheduleRank = 32;
  input.espnSnapshot.teams.NE.espnFpi.specialTeams += 1;
  const changed = predictMatchup("NE", "CHI", input);
  assert.equal(changed.continuousMargin, original.continuousMargin);
  assert.notDeepEqual(changed.inputEvidence.espn, original.inputEvidence.espn);
  assert.deepEqual(changed.inputEvidence.nflverse, original.inputEvidence.nflverse);
  assert.deepEqual(changed.inputEvidence.opponentNetwork, original.inputEvidence.opponentNetwork);
});

test("changing raw NFLverse performance changes future output without changing ESPN", () => {
  const input = options(), original = predictMatchup("NE", "CHI", input);
  input.teamMetrics.away.passingEpaPerPlay += 0.5;
  input.teamMetrics.away.passingEpaAllowedPerPlay -= 0.5;
  const changed = predictMatchup("NE", "CHI", input);
  assert.notEqual(changed.continuousMargin, original.continuousMargin);
  assert.deepEqual(changed.inputEvidence.espn, original.inputEvidence.espn);
  assert.deepEqual(changed.inputEvidence.opponentNetwork, original.inputEvidence.opponentNetwork);
});

test("Opponent Network opponent-baseline changes are independent of raw ESPN and historical Week 7", () => {
  const source = [
    { id: 1, season: 2026, week: 6, status: "Final", visitor_team: { abbreviation: "NE" },
      home_team: { abbreviation: "CHI" }, visitor_team_score: 24, home_team_score: 30 },
    { id: 2, season: 2026, week: 7, status: "Final", visitor_team: { abbreviation: "CHI" },
      home_team: { abbreviation: "SF" }, visitor_team_score: 20, home_team_score: 27 },
  ];
  const espn = JSON.stringify(snapshot), historical = solveOpponentNetwork(prepareNetworkGames(source, 2026, 7), 7);
  const current = solveOpponentNetwork(prepareNetworkGames(source, 2026, 8), 8);
  source[1].home_team_score = 40;
  assert.notDeepEqual(solveOpponentNetwork(prepareNetworkGames(source, 2026, 8), 8), current);
  assert.deepEqual(solveOpponentNetwork(prepareNetworkGames(source, 2026, 7), 7), historical);
  assert.equal(JSON.stringify(snapshot), espn);
});
