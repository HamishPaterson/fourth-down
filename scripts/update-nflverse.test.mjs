import test from "node:test";
import assert from "node:assert/strict";
import { buildPredictionWeek, parsePbp } from "./update-nflverse.mjs";
import { compareTeams } from "../api/nfl/play-by-play.js";
import { buildTeamMetricsResponse } from "../api/nfl/play-by-play.js";
import { buildSpecialTeamsModel } from "../src/services/specialTeams.js";
import { buildPersonnelView } from "../api-lib/personnelView.js";

const day = 86400000;
const start = Date.parse("2026-09-13T17:00:00Z");
const date = (time) => new Date(time).toISOString();
const games = Array.from({ length: 6 }, (_, index) => ({
  id: index + 1, season: 2026, week: index + 1, season_type: "REG",
  date: date(start + index * 7 * day), completed_at: date(start + index * 7 * day + 4 * 3600000),
  status: "Final", visitor_team: { abbreviation: "ARI" }, home_team: { abbreviation: "LAC" },
}));
const rowsFor = (game) => ["ARI", "LAC"].flatMap((team, index) => [{
  season: "2026", season_type: "REG", week: String(game.week),
  game_id: `2026_${String(game.week).padStart(2, "0")}_ARI_LAC`, play_id: String(index * 10 + 1),
  posteam: team, defteam: index ? "ARI" : "LAC", play_type: "pass",
  epa: String(game.week / 10), success: "1", pass: "1", complete_pass: "1", yards_gained: "12",
  wp: ".5", down: "3", drive: "1", fixed_drive: String(index + 1), fixed_drive_result: "Touchdown",
  ydstogo: "2", third_down_converted: "1", third_down_failed: "0",
  yardline_100: "10", touchdown: "1", td_team: team, penalty: "0",
}, {
  season: "2026", season_type: "REG", week: String(game.week),
  game_id: `2026_${String(game.week).padStart(2, "0")}_ARI_LAC`, play_id: String(index * 10 + 2),
  posteam: team, defteam: index ? "ARI" : "LAC", play_type: "field_goal",
  kicker_player_id: `${team}-k`, kicker_player_name: `${team} Kicker`, kick_distance: "35",
  field_goal_result: "made", wp: ".5",
}]);
const rows = games.flatMap(rowsFor);
const snaps = games.flatMap((game) => ["ARI", "LAC"].map((team) => ({
  week: String(game.week), team, player: `${team}-${game.week}`, offense_pct: "80", position: "LT",
})));
const depth = games.flatMap((game) => ["ARI", "LAC"].map((team) => ({
  dt: game.date, team, espn_id: `${team}-k`, gsis_id: `${team}-k`, player_name: `${team} Kicker`,
  pos_grp: "Special Teams", pos_abb: "K", pos_slot: "1", pos_rank: "1",
})));
const context = (week, override = {}) => {
  const cutoff = date(start + (week - 1) * 7 * day - day);
  return { season: 2026, predictionWeek: week, cutoff, sourceAsOf: date(Date.parse(cutoff) - 1000),
    generatedAt: date(Date.parse(cutoff) - 500), ...override };
};
const build = (week, source = rows, schedule = games, override = {}) =>
  buildPredictionWeek(source, schedule, snaps, depth, context(week, override));

test("parsing never anchors recency to downloaded source rows", () => {
  const parsed = parsePbp(rows);
  assert.ok(parsed.every((play) => !("recencyWeight" in play)));
});

test("adding Week 6 PBP, schedule, snaps and depth is byte-independent for prediction Weeks 2-6", () => {
  for (let week = 2; week <= 6; week++) {
    const ctx = context(week);
    const old = buildPredictionWeek(rows.filter((r) => Number(r.week) <= 5), games.slice(0, 5),
      snaps.filter((r) => Number(r.week) <= 5), depth.filter((r) => Date.parse(r.dt) <= Date.parse(games[4].date)), ctx);
    const added = build(week);
    assert.equal(JSON.stringify(added), JSON.stringify(old), `prediction week ${week}`);
    assert.equal(Object.keys(added.metrics).length, 32);
    assert.equal(added.metrics.ARI.availability.teamMetricsAvailable, true);
    assert.equal(added.metrics.LAC.availability.teamMetricsAvailable, true);
    assert.equal(added.metrics.KC.availability.teamMetricsAvailable, false);
    assert.equal(added.metrics.KC.epaPerPlay, null);
    assert.equal(added.metrics.KC.expectedLineup, null);
    assert.equal(compareTeams(added.metrics.ARI, added.metrics.LAC, week)
      .playByPlayEfficiency.available, true);
    assert.equal(added.audit.referenceWeek, week - 1);
    assert.equal(added.situational.teams.ARI.thirdDown.offense.opportunities, week - 1);
  }
  const before = build(7, rows.filter((r) => Number(r.week) <= 5), games.slice(0, 5));
  const after = build(7);
  assert.equal(before.audit.referenceWeek, 5);
  assert.equal(after.audit.referenceWeek, 6);
  assert.notEqual(JSON.stringify(before.metrics), JSON.stringify(after.metrics));
  assert.equal(after.metrics.ARI.games, 6);
});

test("recency uses only eligible completed samples and retains coefficients and same-week order", () => {
  const result = build(6);
  const weights = [.65, .75, .85, .95, 1];
  // Each game contributes a pass with known EPA and an FG with no EPA (existing null-to-zero policy).
  const expected = Math.round(weights.reduce((sum, weight, i) => sum + weight * (i + 1) / 10, 0) /
    (2 * weights.reduce((sum, weight) => sum + weight, 0)) * 10000) / 10000;
  assert.equal(result.metrics.ARI.epaPerPlay, expected);
  assert.deepEqual(result.audit.gameProvenance.map((g) => g.week), [1, 2, 3, 4, 5]);
  const unavailable = games.map((game) => ({ ...game, completed_at: null, status: "Scheduled" }));
  const none = build(6, rows, unavailable);
  assert.equal(none.audit.available, false);
  assert.equal(none.audit.referenceWeek, null);
  assert.match(none.audit.reason, /No completed point-in-time/);
  assert.equal(Object.keys(none.metrics).length, 32);
  assert.equal(none.metrics.ARI.availability.teamMetricsAvailable, false);
  assert.equal(none.metrics.ARI.epaPerPlay, null);
});

test("late completion observations do not advance the anchor or backfill an earlier prediction", () => {
  const cutoff = context(6).cutoff;
  const late = games.map((g) => g.week === 5 ? { ...g, completed_at: date(Date.parse(cutoff) + 1) } : g);
  const result = build(6, rows, late);
  assert.equal(result.audit.referenceWeek, 4);
  assert.equal(result.metrics.ARI.games, 4);
  const earlier = build(6, rows.filter((r) => Number(r.week) < 5), late);
  assert.deepEqual(result.metrics, earlier.metrics);
  assert.deepEqual(result.audit, earlier.audit);
  const later = build(7, rows, late);
  assert.equal(later.audit.referenceWeek, 6);
  assert.equal(later.metrics.ARI.games, 6);
  const futureSource = rows.concat(rowsFor({ ...games[0], week: 17 }));
  assert.equal(JSON.stringify(build(6, futureSource, late)), JSON.stringify(result));
});

test("ARI-LAC completion observed October 16 06:00 cannot qualify before October 16 00:15", () => {
  const game = { ...games[0], completed_at: "2026-10-16T06:00:08.530Z" };
  const sourceAsOf = "2026-10-16T06:19:10.270Z", generatedAt = "2026-10-16T06:19:10.275Z";
  const source = rowsFor(game);
  const early = build(6, source, [game], { cutoff: "2026-10-16T00:15:00.000Z", sourceAsOf, generatedAt });
  const late = build(7, source, [game], { cutoff: "2026-10-23T00:15:00.000Z", sourceAsOf, generatedAt });
  assert.equal(early.audit.referenceWeek, null);
  assert.equal(early.kickers.eligibleGames, 0);
  assert.equal(late.audit.referenceWeek, 1);
  assert.equal(late.kickers.eligibleGames, 1);
  assert.equal(late.metrics.ARI.games, 1);
  const lineup = { schemaVersion: 2, season: 2026, predictionWeek: 6,
    snapshotAt: "2026-10-15T12:00:00Z", cutoff: early.kickers.cutoff,
    roster: [{ playerId: "ARI-k", gsisId: "ARI-k", name: "ARI Kicker", position: "K", rank: 1, status: "Unknown" }] };
  const view = buildPersonnelView({ team: "ARI", lineup, cutoff: lineup.cutoff, season: 2026, week: 6 });
  const model = buildSpecialTeamsModel({ away: "ARI", home: "LAC", personnelViews: { away: view },
    kickerProfiles: early.kickers, season: 2026, week: 6, cutoff: lineup.cutoff });
  assert.equal(model.away.expectedKicker.playerId, "ARI-k");
  assert.equal(model.away.availabilityStatus, "Unknown");
  assert.equal(model.away.profileAvailable, false);
  assert.equal(model.away.sampleConfidence, 0);
  assert.equal(model.away.fallbackActive, true);
});

test("completed status, season, source observation, game and play identities are required", () => {
  const one = rowsFor(games[0]);
  for (const override of [
    { completed_at: null }, { status: "Scheduled" }, { postseason: true },
    { completed_at: "2026-10-30T00:00:00Z" }, { season: 2025 },
    { completed_at: "2026-09-01T00:00:00Z" },
  ]) assert.equal(build(6, one, [{ ...games[0], ...override }]).audit.available, false);
  assert.equal(build(6, one, [games[0]], { sourceAsOf: games[0].date }).audit.available, false);
  assert.equal(build(6, one.map((r) => ({ ...r, game_id: "2026_01_LAC_ARI" })), [games[0]]).audit.available, false);
  assert.equal(build(6, one.map((r) => ({ ...r, week: "2" })), [games[0]]).audit.available, false);
  const base = build(6, one, [games[0]]);
  const duplicated = build(6, [...one, ...one], [games[0], games[0]]);
  assert.deepEqual(duplicated.metrics, base.metrics);
  assert.deepEqual(duplicated.audit, base.audit);
  assert.equal(duplicated.kickers.excluded.duplicatePlays, 2);
  assert.throws(() => build(6, [...one, { ...one[0], epa: "99" }], [games[0]]), /Conflicting team-metrics play/);
  assert.throws(() => build(6, one, [games[0]], { cutoff: null }), /provenance is incomplete/);
});

test("empty source returns unavailable without inventing recency or zero performance", () => {
  const result = build(6, [], []);
  assert.equal(Object.keys(result.metrics).length, 32);
  assert.equal(result.audit.referenceWeek, null);
  assert.equal(result.audit.available, false);
  for (const value of Object.values(result.metrics)) {
    assert.equal(value.availability.teamMetricsAvailable, false);
    assert.equal(value.availability.opponentAdjustedAvailable, false);
    assert.equal(value.availability.phase1Available, false);
    assert.equal(value.availability.situationalAvailable, false);
    assert.equal(value.epaPerPlay, null);
    assert.equal(value.opponentAdjusted.epaPerPlay, null);
    assert.equal(value.snapParticipation.continuityScore, null);
  }
  assert.equal(result.kickers.leaguePriors.extraPoints.rate, null);
});

test("empty eligible PBP preserves independent 32-team depth and kicker identity context", () => {
  const source = [];
  const teams = ["ARI", "LAC"];
  for (const code of teams) {
    const add = (position, slot, formation, index) => source.push({
      dt: "2026-10-13T12:00:00Z", team: code, espn_id: `${code}-${index}`,
      gsis_id: `${code}-gsis-${index}`, player_name: `${code} Player ${index}`,
      pos_grp: formation, pos_abb: position, pos_slot: String(slot), pos_rank: "1",
    });
    add("QB", 1, "3WR 1TE", 1); add("RB", 2, "3WR 1TE", 2);
    ["WR", "WR", "WR", "TE", "LT", "LG", "C", "RG", "RT"].forEach((position, i) =>
      add(position, i + 3, "3WR 1TE", i + 3));
    ["LDE", "LDT", "RDT", "RDE", "WLB", "MLB", "SLB", "LCB", "SS", "FS", "RCB"]
      .forEach((position, i) => add(position, i + 1, "Base 4-3 D", i + 20));
    source.push({ dt: "2026-10-13T12:00:00Z", team: code, espn_id: `${code}-k`, gsis_id: `${code}-k`,
      player_name: `${code} Kicker`, pos_grp: "Special Teams", pos_abb: "K",
      pos_slot: "K-1", pos_rank: "1" });
  }
  const result = buildPredictionWeek([], [], [], source, context(6));
  for (const code of teams) {
    const record = result.metrics[code];
    assert.equal(record.availability.contextAvailable, true);
    assert.equal(record.availability.lineupAvailable, true);
    assert.equal(record.availability.kickerIdentityAvailable, true);
    assert.equal(record.expectedKicker.playerId, `${code}-k`);
    assert.equal(record.expectedKicker.team, code);
    assert.equal(record.expectedKicker.status, "Unknown");
    assert.equal(record.expectedKicker.statusKnown, false);
    assert.equal(record.availability.teamMetricsAvailable, false);
    assert.equal(record.availability.kickerProfileAvailable, false);
    assert.equal(record.provenance.performance.available, false);
    assert.equal(record.provenance.performance.reason,
      "No completed point-in-time team PBP sample before cutoff");
    assert.equal(record.expectedLineup.players.length, 22);
    assert.equal(record.expectedLineup.offensiveStarters, 11);
    assert.equal(record.expectedLineup.defensiveStarters, 11);
    assert.equal(new Set(record.expectedLineup.players.map((player) => player.playerId)).size, 22);
    assert.equal(record.expectedLineup.snapshotAt, "2026-10-13T12:00:00.000Z");
    assert.equal(record.expectedLineup.roster.find((player) => player.position === "DE").sourcePosition, "LDE");
  }
});

test("context-only API handoff preserves lineup and kicker identity without supporting PBP signals", () => {
  const built = buildPredictionWeek([], [], [], depth, context(6));
  const response = buildTeamMetricsResponse({
    season: 2026, source: "nflverse/nflfastR", generatedAt: context(6).generatedAt,
    metricsByWeek: { 6: built.metrics },
    kickerProfilesByWeek: { 6: built.kickers },
  }, { season: 2026, week: 6, away: "ARI", home: "LAC" });
  assert.equal(response.dataStatus, "context-only");
  assert.equal(response.availability.contextAvailable, true);
  assert.equal(response.availability.lineupAvailable, false);
  assert.equal(response.availability.teamMetricsAvailable, false);
  assert.equal(response.availability.phase1Available, false);
  assert.ok(response.away.expectedKicker);
  assert.ok(response.home.expectedKicker);
  assert.equal(response.away.epaPerPlay, null);
  assert.equal(response.kickerProfiles.profilesByTeam.ARI.length, 0);
  assert.equal(response.kickerFallback.ARI.active, true);
  assert.equal(response.kickerFallback.ARI.confidence, 0);
  assert.equal(response.kickerFallback.ARI.fieldGoalRatesByBucket.from40to49, .84);
  assert.equal(response.kickerFallback.ARI.extraPointMakeRate, .945);
  assert.equal(response.modelLayers.playByPlayEfficiency.available, false);
});
