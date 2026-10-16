import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDepthMetrics, validDepthLineup, weeklyDepthCutoffs, depthAvailability, personnelAvailableAt } from "./depthCharts.js";
import { parseGenericCsv } from "../scripts/update-nflverse.mjs";
import { compareTeams } from "../api/nfl/play-by-play.js";
import dataset from "../api/nfl/nflverse-team-metrics.js";
import playerMetrics from "../data/nflverse-player-metrics.js";
import { playerMetricsResponse } from "./playerMetrics.js";
import healthHandler, { buildTeamHealth, pointInTimeHealth } from "../api/nfl/qb-roster-health.js";
import { buildPersonnelView, canonicalPosition } from "./personnelView.js";
import { predictMatchup } from "../src/services/predictionEngine.js";
import { getFullGamePrediction, clearFullGamePredictionCache } from "../src/services/gamePredictionService.js";
import { getQbRosterHealth } from "../src/services/nflApi.js";

// Verbatim source subset: nflverse depth_charts_2026.csv, inspected 2026-10-14.
// Cutoffs below are the first dated BALLDONTLIE games for weeks 2 and 6.
const historical = parseGenericCsv(readFileSync(new URL("./fixtures/depth-chart-history.csv", import.meta.url), "utf8"));
const cutoffs = { 2: "2026-09-18T00:15:00.000Z", 6: "2026-10-16T00:15:00.000Z" };
const extract = (rows, week = 6) => buildDepthMetrics(rows, { season: 2026, predictionWeek: week, cutoff: cutoffs[week] });
// Synthetic structural fixtures test edge cases, not claims about real player history.
const row = (player, position, slot, rank = 1, overrides = {}) => ({
  dt: "2026-10-13T12:00:00Z", team: "KC", espn_id: player, gsis_id: `gsis-${player}`,
  player_name: player, pos_grp: ["LDE", "RDE", "LDT", "RDT", "WLB", "MLB", "SLB", "LCB", "RCB", "SS", "FS", "NB"].includes(position) ? "Base 4-3 D" : "3WR 1TE",
  pos_abb: position, pos_slot: String(slot), pos_rank: String(rank), ...overrides,
});
const fullRoster = () => [
  row("qb", "QB", 9), row("rb", "RB", 11),
  row("wr1", "WR", 1, 1), row("wr2", "WR", 2, 2), row("wr3", "WR", 8, 3),
  row("te", "TE", 10),
  ...["LT", "LG", "C", "RG", "RT"].map((position, index) => row(position, position, index + 3)),
  ...["LDE", "LDT", "RDT", "RDE", "WLB", "MLB", "SLB", "LCB", "SS", "FS", "RCB"]
    .map((position, index) => row(position, position, index + 1)),
  row("nickel", "NB", 12),
];

test("two actual historical weeks select different documented QBs with no backward leakage", () => {
  const early = extract(historical, 2).NYG;
  const later = extract(historical, 6).NYG;
  assert.equal(early.startingQuarterback.name, "Jaxson Dart");
  assert.equal(later.startingQuarterback.name, "Jameis Winston");
  assert.equal(early.startingQuarterback.playerId, "4689114");
  assert.equal(later.startingQuarterback.playerId, "2969939");
  assert.ok(Date.parse(early.snapshotAt) <= Date.parse(cutoffs[2]));
  assert.deepEqual(early, extract(historical.filter((entry) => entry.dt.startsWith("2026-09")), 2).NYG);
  assert.equal(early.positionCounts.WR, 3);
  assert.equal(early.projectedStarters, 4); // Deliberately partial source subset, not a whole roster.
  assert.ok(validDepthLineup(early, 2, 2026));
  assert.notEqual(early.snapshotAt, later.snapshotAt);
});

test("archive accumulation and identical repeated snapshots never inflate counts", () => {
  const rows = fullRoster();
  const old = rows.map((entry) => ({ ...entry, dt: "2026-09-01T12:00:00Z" }));
  const base = extract(rows).KC;
  const repeated = extract([...old, ...rows, ...rows, ...old, ...rows]).KC;
  assert.deepEqual(repeated.players, base.players);
  assert.equal(repeated.projectedStarters, 22);
  assert.equal(repeated.offensiveLineStarters, 5);
});

test("formation slots preserve three WRs and isolate optional nickel/fullback personnel", () => {
  const lineup = extract([...fullRoster(), row("fb", "FB", 12)]).KC;
  assert.equal(lineup.offensiveStarters, 11);
  assert.equal(lineup.defensiveStarters, 11);
  assert.equal(lineup.positionCounts.WR, 3);
  assert.equal(lineup.positionCounts.DB, 4);
  assert.equal(lineup.supplemental.length, 2);
  assert.ok(validDepthLineup(lineup, 6, 2026));
});

test("the latest complete snapshot supersedes older players even when a slot disappears", () => {
  const rows = fullRoster();
  const latest = rows.filter((entry) => entry.pos_abb !== "TE").map((entry) => ({ ...entry, dt: "2026-10-14T12:00:00Z" }));
  const lineup = extract([...rows, ...latest]).KC;
  assert.equal(lineup.positionCounts.TE, 0);
  assert.equal(lineup.offensiveStarters, 10);
  assert.equal(lineup.projectedStarters, 21);
});

test("synthetic player transfer changes ownership only after the newer timestamp", () => {
  const previous = row("transfer", "QB", 9, 1, { team: "WAS", dt: "2026-09-17T12:00:00Z" });
  const next = { ...previous, team: "KC", dt: "2026-10-13T12:00:00Z" };
  assert.equal(extract([previous, next], 2).WSH.startingQuarterback.playerId, "transfer");
  const later = extract([previous, next]);
  assert.equal(later.WSH.startingQuarterback, null);
  assert.equal(later.KC.startingQuarterback.playerId, "transfer");
  assert.equal(later.WSH.available, false);
});

test("conflicting ownership/slots and a player duplicated across base roles are not trusted", () => {
  const player = row("duplicate", "QB", 9);
  const ambiguous = extract([player, { ...player, team: "SF" }]);
  assert.equal(ambiguous.KC.available, false);
  assert.equal(ambiguous.SF.available, false);
  assert.equal(extract([player, row("other", "QB", 9)]).KC.available, false);
  const multiple = extract([player, { ...player, pos_abb: "RB", pos_slot: "11" }]).KC;
  assert.equal(multiple.available, false);
});

test("cutoffs require timezone-aware dated regular-season games and use the first kickoff", () => {
  const games = [
    { season: 2026, week: 2, date: cutoffs[2], postseason: false },
    { season: 2026, week: 2, date: "2026-09-20T20:00:00Z" },
    { season: 2025, week: 2, date: "2025-09-01T00:00:00Z" },
    { season: 2026, week: 2, date: "2026-09-01T00:00:00Z", postseason: true },
    { season: 2026, week: 1, date: "2026-08-01T00:00:00Z", season_type: "PRE" },
  ];
  assert.deepEqual(weeklyDepthCutoffs(games, 2026), { 2: cutoffs[2] });
  assert.deepEqual(weeklyDepthCutoffs([...games, { season: 2026, week: 2, date: null }], 2026), {});
  for (const cutoff of [undefined, null, "bad", "2026-10-16"]) {
    assert.deepEqual(buildDepthMetrics(fullRoster(), { season: 2026, predictionWeek: 6, cutoff }), {});
  }
});

test("future, unparseable and different-season depth entries are excluded; the exact cutoff is included", () => {
  const valid = row("qb", "QB", 9, 1, { dt: cutoffs[6] });
  const map = extract([
    valid, { ...valid, dt: "2026-10-16T00:15:01Z", espn_id: "future" },
    { ...valid, dt: "2025-10-01T00:00:00Z", espn_id: "old" },
    { ...valid, dt: "bad", espn_id: "bad" },
  ]);
  assert.equal(map.KC.startingQuarterback.playerId, "qb");
  assert.equal(map.KC.projectedStarters, 1);
});

for (const [status, probability, available] of [
  ["Out", 1, false], ["IR", 1, false], ["Inactive", 1, false],
  ["Doubtful", .75, false], ["Questionable", .25, true], ["Probable", .08, true],
]) {
  test(`only the selected snapshot's ${status} status is applied`, () => {
    assert.equal(depthAvailability({ injury_status: status }).absenceProbability, probability);
    const lineup = extract([row("qb", "QB", 9, 1, { injury_status: status })]).KC;
    assert.equal(lineup.startingQuarterback.available, available);
    assert.equal(lineup.projectedStarters, available ? 1 : 0);
    const healthy = row("qb", "QB", 9, 1, { dt: "2026-10-14T12:00:00Z", injury_status: "Active" });
    const restored = extract([row("qb", "QB", 9, 1, { injury_status: status }), healthy]).KC;
    assert.equal(restored.projectedStarters, 1);
    assert.equal(restored.startingQuarterback.status, "Active");
  });
}

test("unknown availability stays explicitly unknown and missing/ambiguous QB depth never guesses", () => {
  const unknown = extract([row("qb", "QB", 9)]).KC.startingQuarterback;
  assert.equal(unknown.status, "Unknown");
  assert.equal(unknown.statusKnown, false);
  assert.equal(extract([row("backup", "QB", 9, 2)]).KC.startingQuarterback, null);
  const missing = row("qb", "QB", 9);
  delete missing.pos_rank;
  assert.equal(extract([missing]).KC.available, false);
});

test("Nico Collins keeps known Houston WR identity while availability remains Unknown", () => {
  const lineup = dataset.metricsByWeek[6].HOU.expectedLineup;
  const nicoChartRow = lineup.roster.find((player) => player.name === "Nico Collins");
  assert.ok(nicoChartRow, "checked-in Houston Week 6 chart contains Nico Collins");
  const view = buildPersonnelView({
    team: "HOU", lineup, season: 2026, week: 6, cutoff: lineup.cutoff,
  });
  const nico = view.players.find((player) => player.canonicalId === nicoChartRow.gsisId);
  assert.ok(nico);
  assert.equal(nico.name, "Nico Collins");
  assert.equal(nico.team, "HOU");
  assert.equal(nico.position, "WR");
  assert.equal(nico.status, "Unknown");
  assert.equal(nico.statusKnown, false);
  assert.equal(nico.propEligible, false);
  assert.equal(nico.eligibleBeforeCutoff, true);
  assert.equal(nico.identityConflict, false);
  assert.equal(nico.provenance.statusSource, "unknown");
});

test("Matchup wording distinguishes unknown health availability from unknown player identity", () => {
  const component = readFileSync(new URL("../src/components/MatchupPrediction.jsx", import.meta.url), "utf8");
  assert.match(component, /quarterback health status is unknown; player betting candidates are withheld/i);
  assert.doesNotMatch(component, /unknown player/i);
});

test("legacy, nonfinite, inconsistent, duplicated and impossible lineup objects fail validation", () => {
  const lineup = extract(fullRoster()).KC;
  const invalid = [
    {}, { ...lineup, schemaVersion: 1 },
    { ...lineup, projectedStarters: NaN }, { ...lineup, projectedStarters: Infinity },
    { ...lineup, predictionWeek: 2 }, { ...lineup, season: 2025 },
    { ...lineup, snapshotAt: "2027-01-01T00:00:00Z" },
    { ...lineup, players: [...lineup.players, lineup.players[0]] },
    extract([...fullRoster(), row("qb2", "QB", 13)]).KC,
  ];
  for (const entry of invalid) assert.equal(validDepthLineup(entry, 6, 2026), false);
});

const metrics = (lineup) => ({ ...dataset.metricsByWeek[6].KC, expectedLineup: lineup });
const predict = (lineup) => predictMatchup("SF", "KC", {
  week: 6, kickoff: "2026-10-18T20:25:00.000Z",
  modelLayers: {
    scoringBaseline: { active: true, awayExpected: 24, homeExpected: 25, gamesUsed: { away: 4, home: 4 }, confidence: .6 },
    expectedLineup: lineup,
  },
});
test("a genuine starter loss worsens the existing signal; stronger valid coverage improves it", () => {
  const healthy = extract(fullRoster()).KC;
  const injured = extract(fullRoster().map((entry) => entry.pos_abb === "LT" ? { ...entry, injury_status: "Out" } : entry)).KC;
  const neutral = compareTeams(metrics(healthy), metrics(healthy), 6).expectedLineup;
  const loss = compareTeams(metrics(healthy), metrics(injured), 6).expectedLineup;
  const gain = compareTeams(metrics(injured), metrics(healthy), 6).expectedLineup;
  assert.equal(neutral.homePoints, 0);
  assert.equal(loss.homePoints, -.013);
  assert.equal(gain.homePoints, .013);
  console.log("Lineup sensitivity", [loss, neutral, gain].map((layer) => ({
    homePoints: layer.homePoints, margin: predict(layer).continuousMargin, probability: predict(layer).homeWinProbability,
  })));
  for (const layer of [loss, neutral, gain]) {
    const prediction = predict(layer);
    assert.equal(prediction.modelLayers.expectedLineup.homePoints, layer.homePoints);
    assert.ok(Number.isFinite(prediction.continuousMargin));
    assert.ok(Number.isFinite(prediction.homeWinProbability));
  }
  const depleted = extract(fullRoster().map((entry) =>
    ["LT", "LG", "C", "RG", "RT"].includes(entry.pos_abb) ? { ...entry, injury_status: "Out" } : entry)).KC;
  const multiLoss = compareTeams(metrics(healthy), metrics(depleted), 6).expectedLineup;
  const multiGain = compareTeams(metrics(depleted), metrics(healthy), 6).expectedLineup;
  console.log("Five-starter sensitivity", [multiLoss, neutral, multiGain].map((layer) => ({
    homePoints: layer.homePoints, margin: predict(layer).continuousMargin, probability: predict(layer).homeWinProbability,
  })));
  assert.ok(predict(multiLoss).continuousMargin < predict(neutral).continuousMargin);
  assert.ok(predict(multiGain).continuousMargin > predict(neutral).continuousMargin);
  assert.ok(predict(multiLoss).homeWinProbability < predict(neutral).homeWinProbability);
  assert.ok(predict(multiGain).homeWinProbability > predict(neutral).homeWinProbability);
});

test("a contemporaneous IR roster designation cannot be overridden by a questionable injury label", () => {
  const state = depthAvailability({ injury_status: "Questionable", roster_status: "IR" });
  assert.equal(state.available, false);
  assert.equal(state.absenceProbability, 1);
});

test("an explicitly legacy lineup is gated off without modifying other PBP layers", () => {
  const valid = extract(fullRoster()).KC;
  const baseline = compareTeams(metrics(valid), metrics(valid), 6);
  const layers = compareTeams(metrics(valid), metrics({ ...valid, schemaVersion: 1 }), 6);
  assert.equal(layers.expectedLineup.available, false);
  assert.equal(layers.expectedLineup.homePoints, 0);
  assert.equal(layers.expectedLineup.confidence, 0);
  assert.match(layers.expectedLineup.reasons[0], /regenerate/);
  for (const key of Object.keys(baseline).filter((key) => key !== "expectedLineup")) {
    assert.deepEqual(layers[key], baseline[key]);
  }
  const changed = compareTeams(metrics(null), metrics({ projectedStarters: Infinity }), 6).expectedLineup;
  assert.equal(changed.homePoints, 0);
  assert.equal(changed.awayPoints, 0);
});

test("live Sleeper QB selection does not fall back to an arbitrary or tied depth player", () => {
  const player = (id, depth) => ({ id, gsis_id: `gsis-${id}`, team: "KC", position: "QB",
    full_name: id, depth_chart_order: depth, status: "Active", injury_status: "Active" });
  const args = [2026, 6, "2026-10-18T17:00:00Z", "2026-10-15T12:00:00Z"];
  assert.equal(buildTeamHealth("KC", [player("unknown", null)], [], ...args).expectedStarter, null);
  assert.equal(buildTeamHealth("KC", [player("a", 1), player("b", 1)], [], ...args).expectedStarter, null);
  const known = buildTeamHealth("KC", [player("a", 1), player("b", 2)], [], ...args);
  assert.equal(known.expectedStarter.name, "a");
  assert.equal(known.projectedStarter.name, "a");
});

test("weekly personnel requests never fetch present-day Sleeper injury state", async () => {
  const original = global.fetch;
  const key = process.env.BALLDONTLIE_API_KEY;
  delete process.env.BALLDONTLIE_API_KEY;
  global.fetch = async () => { throw new Error("Must not fetch current state for historical week"); };
  const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  try {
    await healthHandler({ method: "GET", query: { season: "2026", week: "2", away: "SF", home: "KC" } }, response);
    assert.equal(response.code, 200);
    assert.deepEqual(response.body.home.expectedStarter, pointInTimeHealth("KC", 2026, 2).expectedStarter);
    assert.equal(response.body.home.projectedStarter, null);
    assert.equal(response.body.home.starterUnavailable, null);
    assert.equal(response.body.home.quarterback.available, false);
    assert.equal(response.body.home.rosterHealth.points, 0);
    assert.equal(response.body.home.rosterHealth.confidence, 0);
  } finally {
    global.fetch = original;
    if (key !== undefined) process.env.BALLDONTLIE_API_KEY = key;
  }
});

test("frozen HOU tackle and defensive removals use canonical injury weights and supported replacements", () => {
  const lineup = dataset.metricsByWeek[6].HOU.expectedLineup;
  const cases = [
    { label: "offensive tackle", name: "Aireontae Ersery", replacementName: "Nate Thomas",
      id: "00-0040745", source: "LT", canonical: "LT", weight: 0.42, replacement: "00-0039422" },
    { label: "EDGE", name: "Will Anderson Jr.", replacementName: "Dominique Robinson",
      id: "00-0039108", source: "LDE", canonical: "DE", weight: 0.30, replacement: "00-0037082" },
    { label: "interior DL", name: "Tommy Togiai", replacementName: "Kayden McDonald",
      id: "00-0036883", source: "LDT", canonical: "DT", weight: 0.20, replacement: "00-0041440" },
    { label: "LB", name: "Jake Hansen", replacementName: "Jamal Hill",
      id: "00-0037457", source: "SLB", canonical: "LB", weight: 0.14, replacement: "00-0039395" },
    { label: "CB", name: "Derek Stingley Jr.", replacementName: "Collin Wright",
      id: "00-0037237", source: "LCB", canonical: "CB", weight: 0.30, replacement: "00-0041313" },
    { label: "safety", name: "Reed Blankenship", replacementName: "Kamari Ramsey",
      id: "00-0037130", source: "SS", canonical: "SS", weight: 0.18, replacement: "00-0041466" },
  ];
  const playersFor = (unavailableId) => lineup.roster.map((role) => ({
    id: role.playerId,
    gsis_id: role.gsisId,
    team: "HOU",
    position: role.position,
    depth_chart_position: role.position,
    depth_chart_order: role.rank,
    full_name: role.name,
    status: "Active",
    injury_status: role.gsisId === unavailableId ? "Out" : "Active",
  }));
  const sourceMetrics = {
    season: 2026, week: 6, dataStatus: "available",
    away: dataset.metricsByWeek[6].HOU,
    home: dataset.metricsByWeek[6].JAX,
  };
  const matchupPlayers = playerMetricsResponse(playerMetrics, { season: 2026, week: 6, away: "HOU", home: "JAX" });
  const options = {
    season: 2026, week: 6, kickoff: "2026-10-18T17:00:00Z", weather: { dome: true },
    teamMetrics: sourceMetrics, playerMetrics: matchupPlayers,
  };
  const baseline = predictMatchup("HOU", "JAX", options);
  const baselineImpactRow = {
    scenario: "baseline", subject: "none", sourcePosition: null, canonicalPosition: null,
    status: "Active", appliedWeight: 0, replacement: null, replacementDepth: null,
    rawPersonnelAdjustment: 0, finalAwayAdjustment: 0, finalHomeAdjustment: 0,
    houExpectedPoints: baseline.away.expectedPoints, jaxExpectedPoints: baseline.home.expectedPoints,
    continuousMargin: baseline.continuousMargin,
    houWinProbability: baseline.awayWinProbability, jaxWinProbability: baseline.homeWinProbability,
  };
  const impactRows = [baselineImpactRow];
  for (const scenario of cases) {
    const subject = lineup.roster.find((player) => player.gsisId === scenario.id);
    assert.ok(subject, `${scenario.label} fixture identity`);
    assert.equal(subject.name, scenario.name, `${scenario.label} named fixture identity`);
    assert.equal(subject.position, scenario.source, `${scenario.label} source position`);
    assert.equal(canonicalPosition(subject.position), scenario.canonical, `${scenario.label} canonical position`);

    const health = buildTeamHealth("HOU", playersFor(scenario.id), [], 2026, 6,
      lineup.cutoff, "2026-10-15T00:00:00Z");
    const impactRecord = health.personnelView.players.find((player) => player.canonicalId === scenario.id);
    assert.equal(impactRecord.status, "Out", `${scenario.label} point-in-time status`);
    assert.equal(impactRecord.rank, 1);
    assert.equal(impactRecord.replacementId, scenario.replacement);
    const replacement = health.personnelView.players.find((player) => player.canonicalId === scenario.replacement);
    assert.equal(replacement.rank, 2);
    assert.equal(replacement.name, scenario.replacementName, `${scenario.label} replacement identity`);
    assert.equal(replacement.projectedAvailable, true);
    assert.equal(replacement.provenance.statusSource, "live-personnel-status");
    assert.equal(replacement.replacementFor, scenario.id);
    assert.equal(health.rosterHealth.points, -scenario.weight,
      `${scenario.label} must use the existing canonical-position weight, not the generic fallback`);

    const adjusted = predictMatchup("HOU", "JAX", {
      ...options,
      modelLayers: {
        rosterHealth: {
          active: true, available: true, awayPoints: health.rosterHealth.points, homePoints: 0,
          confidence: health.rosterHealth.confidence, reasons: health.rosterHealth.reasons,
        },
      },
    });
    assert.equal(adjusted.modelLayers.rosterHealth.awayPoints, -scenario.weight / 2);
    assert.equal(adjusted.modelLayers.rosterHealth.homePoints, scenario.weight / 2);
    assert.ok(adjusted.home.expectedPoints > baseline.home.expectedPoints);
    assert.ok(adjusted.continuousMargin > baseline.continuousMargin);
    assert.ok(adjusted.awayWinProbability < baseline.awayWinProbability);
    const evidenceLayers = ["rushMatchup", "passMatchup", "successMatchup", "explosiveMatchup",
      "pressureMatchup", "thirdDownMatchup", "redZoneMatchup", "opponentNetwork"];
    for (const layer of evidenceLayers) {
      assert.deepEqual(adjusted.modelLayers[layer], baseline.modelLayers[layer], `${scenario.label} ${layer}`);
    }
    const evidenceBytes = (prediction) => JSON.stringify({
      phase1: Object.fromEntries(evidenceLayers.slice(0, 5)
        .map((layer) => [layer, prediction.modelLayers[layer]])),
      phase2a: Object.fromEntries(evidenceLayers.slice(5, 7)
        .map((layer) => [layer, prediction.modelLayers[layer]])),
      opponentNetwork: prediction.modelLayers.opponentNetwork,
    });
    assert.equal(evidenceBytes(adjusted), evidenceBytes(baseline),
      `${scenario.label} Phase 1/2A and Opponent-Network evidence bytes`);
    const replacementRecord = health.personnelView.players.find((player) => player.canonicalId === scenario.replacement);
    impactRows.push({
      scenario: scenario.label, subject: subject.name,
      sourcePosition: subject.position, canonicalPosition: canonicalPosition(subject.position),
      status: impactRecord.status, appliedWeight: scenario.weight,
      replacement: replacement.name, replacementDepth: replacement.rank,
      replacementProvenance: replacement.provenance.statusSource,
      rawPersonnelAdjustment: health.rosterHealth.points,
      finalAwayAdjustment: adjusted.modelLayers.rosterHealth.awayPoints,
      finalHomeAdjustment: adjusted.modelLayers.rosterHealth.homePoints,
      houExpectedPoints: adjusted.away.expectedPoints, jaxExpectedPoints: adjusted.home.expectedPoints,
      continuousMargin: adjusted.continuousMargin,
      houWinProbability: adjusted.awayWinProbability, jaxWinProbability: adjusted.homeWinProbability,
      replacementEvidence: replacementRecord.provenance.statusSource,
    });
  }
  assert.equal(cases[0].weight, 0.42, "Aireontae Ersery uses his canonical LT weight, not generic 0.08");
  console.log("HOU_TACKLE_DEFENSIVE_IMPACT_MATRIX", JSON.stringify(impactRows));
});

test("frozen Houston QB-out case uses a finite fallback without selecting a later unavailable QB", () => {
  const lineup = dataset.metricsByWeek[6].HOU.expectedLineup;
  const players = lineup.roster.map((role) => ({
    id: role.playerId, gsis_id: role.gsisId, team: "HOU",
    position: role.position, depth_chart_position: role.position, depth_chart_order: role.rank,
    full_name: role.name, status: "Active",
    injury_status: role.group === "QB" ? "Out" : "Active",
  }));
  const result = buildTeamHealth("HOU", players, [], 2026, 6, lineup.cutoff, "2026-10-15T00:00:00Z");
  assert.equal(result.expectedStarter.name, "C.J. Stroud");
  assert.equal(result.projectedStarter, null);
  assert.equal(result.personnelView.quarterback.player, null);
  assert.match(result.quarterback.reasons.join(" "), /no available replacement quarterback/i);
  assert.match(result.personnelView.quarterback.reason, /replacement identity is unresolved/i);
  assert.ok(Number.isFinite(result.quarterback.points));
  assert.ok(Number.isFinite(result.rosterHealth.points));
  assert.equal(result.rosterHealth.affectedStarters.some((player) => player.position === "QB"), false);
});

test("point-in-time QB identity reaches personnel without fabricating game availability", () => {
  const lineup = extract(historical, 2).NYG;
  const health = pointInTimeHealth("NYG", 2026, 2, lineup);
  assert.equal(health.expectedStarter.name, "Jaxson Dart");
  assert.equal(health.expectedStarter.availableForGame, null);
  assert.equal(health.projectedStarter, null);
  assert.equal(health.quarterback.available, false);
  assert.equal(health.rosterHealth.available, false);
});

test("personnel timing requires proven pre-cutoff fetch/source time, never undated/current history", () => {
  assert.equal(personnelAvailableAt({ refreshedAt: "2026-09-17T12:00:00Z" }, cutoffs[2]), true);
  assert.equal(personnelAvailableAt({ generatedAt: cutoffs[2] }, cutoffs[2]), true);
  assert.equal(personnelAvailableAt({ refreshedAt: "2026-10-14T12:00:00Z" }, cutoffs[2]), false);
  assert.equal(personnelAvailableAt({}, cutoffs[2]), false);
  assert.equal(personnelAvailableAt({ refreshedAt: "2026-09-17T12:00:00Z" }, null), false);
});

test("corrected lineup survives real orchestration and invalid personnel stays finite/neutral", async () => {
  const original = global.fetch;
  const healthy = extract(fullRoster()).KC;
  const injured = extract(fullRoster().map((entry) => entry.pos_abb === "LT" ? { ...entry, injury_status: "Out" } : entry)).KC;
  const pbp = { modelLayers: compareTeams(metrics(healthy), metrics(injured), 6) };
  clearFullGamePredictionCache();
  let weekRequested = false;
  global.fetch = async (url) => {
    const path = String(url);
    let body = {};
    if (path.startsWith("/api/nfl/play-by-play")) body = pbp;
    if (path.startsWith("/api/nfl/qb-roster-health")) {
      weekRequested = new URL(path, "http://test").searchParams.get("week") === "6";
      body = { cutoff: cutoffs[6], generatedAt: "2026-10-14T12:00:00Z",
        away: { quarterback: { available: false }, rosterHealth: { available: false } },
        home: { quarterback: { available: false }, rosterHealth: { available: false } } };
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  try {
    const result = await getFullGamePrediction({ away: "SF", home: "KC", week: 6,
      sourceDate: "2026-10-18T20:25:00Z", weather: { dome: true } }, null, { season: 2026, forceRefresh: true });
    assert.equal(weekRequested, true);
    assert.equal(result.prediction.modelLayers.expectedLineup.homePoints, pbp.modelLayers.expectedLineup.homePoints);
    assert.equal(result.prediction.modelLayers.expectedLineup.available, true);
    assert.equal(result.prediction.modelLayers.quarterback.available, false);
    assert.equal(result.prediction.modelLayers.rosterHealth.available, false);
    for (const value of [result.prediction.continuousMargin, result.prediction.homeWinProbability,
      result.prediction.modelLayers.homePoints, result.prediction.modelLayers.awayPoints]) assert.ok(Number.isFinite(value));
  } finally { global.fetch = original; clearFullGamePredictionCache(); }
});

test("historical orchestration gates post-cutoff Sleeper/playerRatings but permits proven earlier data", async () => {
  const original = global.fetch;
  let observedAt = "2026-10-14T12:00:00Z";
  let injuryPoints = -2;
  let missingRatings = false;
  const run = async () => getFullGamePrediction({ away: "SF", home: "KC", week: 2,
    weather: { dome: true }, sourceDate: "2026-09-20T20:00:00Z" }, null, { season: 2026, forceRefresh: true });
  global.fetch = async (url) => {
    const path = String(url);
    let body = {};
    if (path.startsWith("/api/nfl/qb-roster-health")) {
      body = { cutoff: cutoffs[2], generatedAt: observedAt,
        away: { quarterback: { available: true, points: 0, confidence: .8 }, rosterHealth: { points: 0, confidence: .8 } },
        home: { quarterback: { available: true, points: injuryPoints, confidence: .8 }, rosterHealth: { points: injuryPoints, confidence: .8 } } };
    }
    if (path.startsWith("/api/nfl/sleeper-players")) {
      const strong = path.includes("team=KC");
      body = { refreshedAt: observedAt, groups: { roster: [
        "QB", "RB", "WR", "WR", "WR", "TE", "LT", "LG", "C", "RG", "RT", "DE", "DT", "LB", "CB", "S",
      ].map((position, index) => ({
        id: `player-${index}`, active: true, position, depthChartOrder: 1,
        playerRating: missingRatings ? null : strong ? 99 : 40,
      })) } };
    }
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  try {
    const future = await run();
    assert.equal(future.prediction.modelLayers.playerRatings.available, false);
    assert.equal(future.prediction.modelLayers.quarterback.available, false);
    assert.equal(future.prediction.modelLayers.rosterHealth.homePoints, 0);
    injuryPoints = -6;
    const changedFuture = await run();
    assert.equal(changedFuture.prediction.continuousMargin, future.prediction.continuousMargin);
    observedAt = "2026-09-17T12:00:00Z";
    injuryPoints = -2;
    const earlier = await run();
    assert.equal(earlier.prediction.modelLayers.playerRatings.available, true);
    assert.equal(earlier.prediction.modelLayers.quarterback.homePoints, -1);
    assert.equal(earlier.prediction.modelLayers.rosterHealth.homePoints, -1);
    assert.equal(earlier.dataQuality.personnelTiming.personnel, true);
    missingRatings = true;
    const missing = await run();
    assert.equal(missing.prediction.modelLayers.playerRatings.available, false);
    assert.equal(missing.prediction.modelLayers.playerRatings.homePoints, 0);
    observedAt = undefined;
    const undated = await run();
    assert.equal(undated.prediction.modelLayers.playerRatings.available, false);
    assert.equal(undated.prediction.modelLayers.quarterback.available, false);
  } finally { global.fetch = original; clearFullGamePredictionCache(); }
});

test("secondary MatchupPrediction passes week/dependency and uses the same timing gate", async () => {
  const source = readFileSync(new URL("../src/components/MatchupPrediction.jsx", import.meta.url), "utf8");
  const callStart = source.indexOf("getQbRosterHealth(normalizeCode");
  const effect = source.slice(callStart, source.indexOf("useEffect(", callStart));
  assert.match(effect, /controller\.signal, Number\(week\)\)/);
  assert.match(effect, /\[awayCode, homeCode, kickoff, week\]/);
  assert.match(source, /loadedPersonnel\?\.week === Number\(week\)/);
  assert.match(source, /personnelAvailableAt\(loadedPlayerMatchup\?\.rosters\?\.away, personnel\?\.cutoff\)/);
  assert.match(source, /personnelAvailableAt\(loadedPlayerMatchup\?\.rosters\?\.home, personnel\?\.cutoff\)/);
  assert.match(source, /personnelAvailableAt\(getTeamRatingsHealth\(\), cutoff\) \? getTeamQbr\(teamCode\) : null/);
  const original = global.fetch;
  const key = process.env.BALLDONTLIE_API_KEY;
  process.env.BALLDONTLIE_API_KEY = "test-only";
  let sleeperRequested = false;
  global.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith("/api/nfl/qb-roster-health?")) {
      const query = Object.fromEntries(new URL(path, "http://test").searchParams);
      assert.equal(query.week, "2");
      const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
      await healthHandler({ method: "GET", query }, response);
      return { ok: true, json: async () => response.body };
    }
    if (path.includes("/games?")) return { ok: true, json: async () => ({ data: [
      { season: 2026, week: 2, date: cutoffs[2] },
    ] }) };
    sleeperRequested = true;
    throw new Error("Historical secondary path must not fetch live players");
  };
  try {
    const payload = await getQbRosterHealth("SF", "KC", 2026, undefined, 2);
    assert.equal(payload.home.quarterback.available, false);
    assert.equal(payload.home.rosterHealth.points, 0);
    assert.equal(payload.cutoff, cutoffs[2]);
    assert.equal(sleeperRequested, false);
  } finally {
    global.fetch = original;
    if (key === undefined) delete process.env.BALLDONTLIE_API_KEY;
    else process.env.BALLDONTLIE_API_KEY = key;
  }
});

test("before the weekly cutoff, genuinely current Sleeper personnel retains normal behavior", async () => {
  const original = global.fetch;
  const key = process.env.BALLDONTLIE_API_KEY;
  process.env.BALLDONTLIE_API_KEY = "test-only";
  const cutoff = new Date(Date.now() + 86400000).toISOString();
  const season = new Date(cutoff).getUTCFullYear();
  let sleeperRequested = false;
  global.fetch = async (url) => {
    const path = String(url);
    let body = { data: [] };
    if (path.includes("/games?")) body = { data: [{ season, week: 1, date: cutoff }] };
    if (path.includes("sleeper.app")) {
      sleeperRequested = true;
      body = { qb: { id: "qb", full_name: "Synthetic current QB", team: "KC",
        gsis_id: "synthetic-gsis-qb", position: "QB", depth_chart_order: 1, status: "Active",
        injury_status: "Active" } };
    }
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  try {
    await healthHandler({ method: "GET", query: { away: "SF", home: "KC", season, week: 1 } }, response);
    assert.equal(sleeperRequested, true);
    assert.equal(response.body.home.expectedStarter.name, "Synthetic current QB");
    assert.equal(response.body.home.projectedStarter.name, "Synthetic current QB");
    assert.equal(response.body.home.quarterback.available, true);
    assert.ok(personnelAvailableAt(response.body, cutoff));
  } finally {
    global.fetch = original;
    if (key === undefined) delete process.env.BALLDONTLIE_API_KEY;
    else process.env.BALLDONTLIE_API_KEY = key;
  }
});
