import test from "node:test";
import assert from "node:assert/strict";
import { buildWeeklyKickerProfiles } from "./kickerMetrics.js";

const cutoff = "2026-10-16T00:00:00.000Z";
const sourceAsOf = "2026-10-15T12:00:00.000Z";
const generatedAt = "2026-10-15T12:05:00.000Z";

const schedule = [{
  id: "2026_05_HOU_JAX",
  season: 2026,
  week: 5,
  season_type: "REG",
  date: "2026-10-12T17:00:00.000Z",
  completed_at: "2026-10-12T21:30:00.000Z",
  status: "Final",
  visitor_team: { abbreviation: "HOU" },
  home_team: { abbreviation: "JAX" },
}];

function attempt(playId, playType, result, distance = "") {
  return {
    season: 2026,
    season_type: "REG",
    week: 5,
    game_id: "2026_05_HOU_JAX",
    play_id: playId,
    posteam: "HOU",
    play_type: playType,
    kicker_player_id: "00-0030001",
    kicker_player_name: "Fixture Kicker",
    kick_distance: distance,
    field_goal_result: playType === "field_goal" ? result : "",
    extra_point_result: playType === "extra_point" ? result : "",
  };
}

test("NFLverse kicker extraction separates distance buckets, blocks and point-in-time provenance", () => {
  const rows = [
    attempt("1", "field_goal", "made", "25"),
    attempt("2", "field_goal", "missed", "35"),
    attempt("3", "field_goal", "blocked", "45"),
    attempt("4", "field_goal", "made", "52"),
    attempt("5", "extra_point", "good"),
    attempt("6", "extra_point", "failed"),
    attempt("7", "extra_point", "blocked"),
  ];
  rows.push({ ...rows[0] });
  rows.push({ ...attempt("8", "field_goal", "made", "28"), week: 6 });
  rows.push({ ...attempt("9", "field_goal", "made", "28"), posteam: "CHI" });
  rows.push({ ...attempt("", "field_goal", "made", "28") });

  const result = buildWeeklyKickerProfiles(rows, schedule, {
    season: 2026, predictionWeek: 6, cutoff, sourceAsOf, generatedAt,
  });
  const profile = result.profilesByTeam.HOU[0];

  assert.equal(profile.fullName, "Fixture Kicker");
  assert.equal(profile.gsisId, "00-0030001");
  assert.deepEqual(profile.fieldGoals.under30, {
    attempts: 1, makes: 1, misses: 0, blocks: 0, accuracyAttempts: 1,
  });
  assert.deepEqual(profile.fieldGoals.from30to39, {
    attempts: 1, makes: 0, misses: 1, blocks: 0, accuracyAttempts: 1,
  });
  assert.deepEqual(profile.fieldGoals.from40to49, {
    attempts: 1, makes: 0, misses: 0, blocks: 1, accuracyAttempts: 0,
  });
  assert.equal(profile.fieldGoals.from50plus.makes, 1);
  assert.equal(profile.overallFieldGoals.attempts, 4);
  assert.deepEqual(profile.extraPoints, {
    attempts: 3, makes: 1, misses: 1, blocks: 1, accuracyAttempts: 2,
  });
  assert.equal(profile.gamesRepresented, 1);
  assert.equal(profile.latestEligibleGame.completedAsOf, "2026-10-12T21:30:00.000Z");
  assert.equal(result.excluded.duplicatePlays, 1);
  assert.equal(result.excluded.invalidPlayId, 1);
  assert.equal(result.excluded.invalidTeam, 1);
  assert.equal(profile.cutoff, cutoff);
  assert.equal(profile.predictionWeek, 6);
  assert.equal(profile.source, "nflverse play-by-play");
  assert.match(result.leaguePriors.blockedAttemptTreatment, /excluded from accuracy denominators/);
  assert.equal(result.leaguePriors.fieldGoals.from40to49.accuracyAttempts, 0);
});

test("NFLverse kicker extraction rejects unresolved and post-cutoff games", () => {
  const unresolved = { ...schedule[0], completed_at: null, status: "Scheduled" };
  const afterCutoff = { ...schedule[0], completed_at: "2026-10-17T00:00:00.000Z", status: "Final" };
  for (const game of [unresolved, afterCutoff]) {
    const result = buildWeeklyKickerProfiles(
      [attempt("1", "field_goal", "made", "25")],
      [game],
      { season: 2026, predictionWeek: 6, cutoff, sourceAsOf, generatedAt }
    );
    assert.deepEqual(result.profilesByTeam, {});
    assert.equal(result.eligiblePlays, 0);
  }
});
