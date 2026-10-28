import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCanonicalPlayerIdentity,
  buildTeamPlayerMetrics,
  createPlayerIdentityContext,
  parsePlay,
} from "./update-nflverse-players.mjs";
import teamArtifact from "../api/nfl/nflverse-team-metrics.js";
import playerArtifact from "../data/nflverse-player-metrics.js";
import { buildPersonnelView } from "../api-lib/personnelView.js";
import { buildDepthMetrics } from "../api-lib/depthCharts.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const hall = { gsisId: "00-0038120", name: "Breece Hall", position: "RB" };
const allen = { gsisId: "00-0039794", name: "Braelon Allen", position: "RB" };
const contextFor = (roster = [hall, allen], players = [hall]) =>
  createPlayerIdentityContext({ NYJ: { expectedLineup: { roster, players } } });
const rush = (id, name, overrides = {}) => parsePlay({
  game_id: "2026_07_NYJ_NE", season: "2026", season_type: "REG", week: "7",
  play_id: "1", posteam: "NYJ", defteam: "NE", play_type: "run", wp: "0.5",
  rush_attempt: "1", rush: "1", rushing_yards: "7", yardline_100: "4",
  rusher_player_id: id, rusher_player_name: name, ...overrides,
});

test("full roster resolves roster-only usage separately from selected-lineup position evidence", () => {
  const context = contextFor();
  const [backup, starter] = applyCanonicalPlayerIdentity([
    rush(allen.gsisId, "B.Allen"), rush(hall.gsisId, "B.Hall", { play_id: "2" }),
  ], context);
  assert.equal(backup.rusherName, allen.name);
  assert.equal(backup.rusherPositionSource, "expectedRoster");
  assert.equal(starter.rusherPositionSource, "expectedLineup");
  const metrics = buildTeamPlayerMetrics([backup, starter], "NYJ");
  assert.equal(metrics.players[allen.gsisId].rushing.attempts, 1);
  assert.equal(metrics.players[hall.gsisId].rushing.attempts, 1);
  assert.equal(metrics.players[allen.gsisId].positionSource, "expectedRoster");
  assert.equal(metrics.players[allen.gsisId].health, "Unknown");
  assert.equal("starter" in metrics.players[allen.gsisId], false);
  assert.equal("roleConfidence" in metrics.players[allen.gsisId], false);
});

test("stable GSIS wins over similar names and never merges Braelon Allen with Breece Hall", () => {
  const result = applyCanonicalPlayerIdentity([
    rush(allen.gsisId, hall.name), rush(hall.gsisId, "B.Allen Jr."),
  ], contextFor());
  assert.equal(result[0].rusherId, allen.gsisId);
  assert.equal(result[0].rusherName, allen.name);
  assert.equal(result[1].rusherId, hall.gsisId);
  assert.equal(result[1].rusherName, hall.name);
});

test("only exact unique full-name/team mapping can replace a missing stable ID", () => {
  const context = contextFor();
  const result = applyCanonicalPlayerIdentity([
    rush("", allen.name), rush("", "B.Allen"), rush("", "B.Allen Jr."),
    rush("", "Braelon"), rush("00-0099999", allen.name),
    rush("00-0099998", "Unknown Player"),
  ], context);
  assert.equal(result[0].rusherId, allen.gsisId);
  for (const row of result.slice(1)) assert.equal(row.rusherId, null);
  assert.equal(result[4].rusherIdentityState, "ID_CONFLICT");
  assert.equal(context.idConflict, 1);
  const ambiguous = contextFor([allen, { ...allen, gsisId: "00-0099997" }], []);
  const [row] = applyCanonicalPlayerIdentity([rush("", allen.name)], ambiguous);
  assert.equal(row.rusherIdentityState, "AMBIGUOUS");
  assert.equal(ambiguous.ambiguous, 1);
  const fullName = contextFor([{ ...allen, name: "J. Michael Sturdivant" }], []);
  assert.equal(applyCanonicalPlayerIdentity([rush("", "J. Michael Sturdivant")], fullName)[0].rusherId, allen.gsisId);
  const initial = contextFor([{ ...allen, name: "B. Allen" }], []);
  assert.equal(applyCanonicalPlayerIdentity([rush("", "B. Allen")], initial)[0].rusherId, null);
});

test("duplicate GSIS, invalid IDs, contradictory team and selected-lineup identities fail closed", () => {
  assert.throws(() => contextFor([hall, hall]), /duplicate GSIS/);
  const invalid = contextFor([{ ...hall, gsisId: "not-gsis" }], []);
  assert.equal(invalid.byTeamId.size, 0);
  assert.equal(invalid.unavailableRosterRecords[0].reason, "INVALID_GSIS");
  assert.throws(() => contextFor([{ ...hall, team: "NE" }], []), /roster team/);
  assert.throws(() => contextFor([hall], [{ ...hall, name: "Braelon Allen" }]), /selected-lineup/);
  assert.throws(() => createPlayerIdentityContext({
    NYJ: { expectedLineup: { roster: [hall], players: [] } },
    NE: { expectedLineup: { roster: [hall], players: [] } },
  }), /cross-team/);
  assert.throws(() => createPlayerIdentityContext({
    NYJ: { expectedLineup: { players: [hall] } },
  }), /Missing authoritative roster/);
});

test("authoritative cutoff roster selects current team, never transfers historical PBP usage", () => {
  const context = createPlayerIdentityContext({
    NYJ: { expectedLineup: { roster: [allen], players: [] } },
    NE: { expectedLineup: { roster: [hall], players: [] } },
  });

  test("timestamped authoritative ownership chooses the cutoff team and ignores future roster moves", () => {
    const row = { espn_id: "4432708", gsis_id: "00-0039849", player_name: "Marvin Harrison Jr.",
      pos_grp: "3WR 1TE", pos_abb: "WR", pos_slot: "1", pos_rank: "1" };
    const depth = buildDepthMetrics([
      { ...row, team: "ARI", dt: "2026-10-11T13:56:31Z" },
      { ...row, team: "HOU", dt: "2026-10-27T06:01:59Z" },
      { ...row, team: "NE", dt: "2026-11-01T06:00:00Z" },
    ], { season: 2026, predictionWeek: 8, cutoff: "2026-10-30T00:15:00.000Z" });
    assert.equal(depth.HOU.snapshotAt, "2026-10-27T06:01:59.000Z");
    assert.equal(depth.ARI.roster.length, 0);
    assert.equal(depth.NE, undefined);
    const context = createPlayerIdentityContext({ HOU: { expectedLineup: depth.HOU } });
    const [old, current] = applyCanonicalPlayerIdentity([
      rush(row.gsis_id, "M.Harrison", { posteam: "ARI" }),
      rush(row.gsis_id, "M.Harrison", { posteam: "HOU" }),
    ], context);
    assert.equal(old.rusherIdentityState, "TEAM_MISMATCH");
    assert.equal(current.rusherId, row.gsis_id);
    assert.equal(current.rusherName, row.player_name);
  });
  const [oldTeam, current] = applyCanonicalPlayerIdentity([
    rush(hall.gsisId, hall.name),
    rush(hall.gsisId, hall.name, { posteam: "NE", defteam: "NYJ", play_id: "2" }),
  ], context);
  assert.equal(oldTeam.rusherIdentityState, "TEAM_MISMATCH");
  assert.equal(oldTeam.rusherId, null);
  assert.equal(current.team, "NE");
  assert.equal(current.rusherId, hall.gsisId);
  assert.equal(context.mismatchedTeam, 1);
});

test("real Week 8 roster retains Allen, Hall, Hurts and Achane without promoting backups to starters", () => {
  const context = createPlayerIdentityContext(teamArtifact.metricsByWeek[8]);
  const cases = [
    ["NYJ", allen.gsisId, "B.Allen"], ["NYJ", hall.gsisId, "B.Hall"],
    ["PHI", "00-0036389", "J.Hurts"], ["MIA", "00-0039040", "D.Achane"],
    ["GB", "00-0040948", "J.Sturdivant"],
  ];
  for (const [team, id, name] of cases) {
    const canonical = teamArtifact.metricsByWeek[8][team].expectedLineup.roster.find((x) => x.gsisId === id);
    assert.ok(canonical, `${team} ${id} roster evidence`);
    const [row] = applyCanonicalPlayerIdentity([rush(id, name, { posteam: team, defteam: "NE" })], context);
    assert.equal(row.rusherName, canonical.name);
    assert.equal(row.rusherId, id);
    const view = buildPersonnelView({ team, lineup: teamArtifact.metricsByWeek[8][team].expectedLineup,
      season: 2026, week: 8, cutoff: playerArtifact.cutoffs[8], observedAt: playerArtifact.sourceAsOf });
    const role = view.players.find((x) => x.gsisId === id);
    assert.ok(role);
    assert.equal(role.chartStarter, teamArtifact.metricsByWeek[8][team].expectedLineup.players.some((x) => x.gsisId === id));
    assert.equal(role.statusKnown, false);
  }
});

test("selected-only supplement needs valid pre-cutoff provenance and remains unknown health", () => {
  const lineup = {
    roster: [hall], players: [allen], season: 2026, predictionWeek: 8,
    available: true, schemaVersion: 2, schemaValidated: true,
    cutoff: "2026-10-30T00:15:00.000Z", snapshotAt: "2026-10-27T06:01:59.000Z",
  };
  const teams = { NYJ: { expectedLineup: lineup } };
  const first = applyCanonicalPlayerIdentity([rush(allen.gsisId, "B.Allen")],
    createPlayerIdentityContext(teams));
  assert.equal(first[0].rusherName, allen.name);
  assert.equal(first[0].rusherPositionSource, "expectedLineup");
  assert.equal(lineup.roster.some((x) => x.gsisId === allen.gsisId), false);
  const metrics = buildTeamPlayerMetrics(first, "NYJ");
  assert.equal(metrics.players[allen.gsisId].health, "Unknown");
  assert.equal(metrics.players[allen.gsisId].healthSource, "Unavailable");
  assert.deepEqual(applyCanonicalPlayerIdentity([rush(allen.gsisId, "B.Allen")],
    createPlayerIdentityContext(teams)), first);
  for (const invalid of [
    { ...lineup, snapshotAt: "2026-10-31T00:00:00.000Z" },
    { ...lineup, snapshotAt: undefined },
    { ...lineup, schemaValidated: false },
    { ...lineup, available: false },
    { ...lineup, players: [{ ...allen, team: "NE" }] },
    { ...lineup, players: [allen, allen] },
    { ...lineup, players: [{ ...hall, gsisId: allen.gsisId }] },
    { ...lineup, players: [{ ...hall, name: "Conflicting Name" }] },
  ]) {
    assert.throws(() => createPlayerIdentityContext({ NYJ: { expectedLineup: invalid } }),
      /Contradictory authoritative/);
  }
});

test("validated JAX selected-only Travis Hunter identity supplements, not mutates, the full roster", () => {
  const lineup = teamArtifact.metricsByWeek[8].JAX.expectedLineup;
  assert.equal(lineup.roster.some((x) => x.gsisId === "00-0040718"), false);
  const context = createPlayerIdentityContext(teamArtifact.metricsByWeek[8]);
  const identity = context.byTeamId.get("JAX:00-0040718");
  assert.equal(identity.playerName, "Travis Hunter");
  assert.equal(identity.positionSource, "expectedLineup");
  assert.equal(identity.team, "JAX");
});

test("Marvin Harrison Jr. ARI usage remains excluded against authoritative Week 8 HOU roster", () => {
  const context = createPlayerIdentityContext(teamArtifact.metricsByWeek[8]);
  const id = "00-0039849";
  assert.equal(context.byTeamId.get(`HOU:${id}`).playerName, "Marvin Harrison Jr.");
  assert.equal(context.byTeamId.has(`ARI:${id}`), false);
  const [row] = applyCanonicalPlayerIdentity([parsePlay({
    season: "2026", season_type: "REG", week: "1", game_id: "2026_01_ARI_LAC",
    play_id: "1", posteam: "ARI", defteam: "LAC", play_type: "pass",
    pass_attempt: "1", complete_pass: "1", receiver_player_id: id,
    receiver_player_name: "M.Harrison", receiving_yards: "8",
  })], context);
  assert.equal(row.receiverIdentityState, "TEAM_MISMATCH");
  assert.equal(row.receiverId, null);
  assert.equal(context.mismatchedTeam, 1);
});

test("identity extraction leaves historical player contexts and protected input artifacts unchanged", () => {
  const hash = (file) => createHash("sha256").update(readFileSync(new URL(file, import.meta.url))).digest("hex");
  const hashes = ["../api/nfl/nflverse-team-metrics.js", "../src/services/espnFpiRatings.js",
    "../api/nfl/opponent-network.js"].map((file) => [file, hash(file)]);
  const before = structuredClone(playerArtifact.playerMetricsByWeek);
  const teamBefore = structuredClone(teamArtifact);
  applyCanonicalPlayerIdentity([rush(allen.gsisId, "B.Allen")],
    createPlayerIdentityContext(teamArtifact.metricsByWeek[8]));
  for (let week = 2; week <= 7; week++) assert.deepEqual(playerArtifact.playerMetricsByWeek[week], before[week]);
  assert.deepEqual(teamArtifact, teamBefore);
  for (const [file, expected] of hashes) {
    assert.equal(hash(file), expected);
  }
});
