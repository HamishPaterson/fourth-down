import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWeeklyPlayerMetrics,
  parsePlay,
  PLAYER_SOURCE_REQUIRED_FIELDS,
  validatePlayerSourceRows,
} from "./update-nflverse-players.mjs";

const row = (overrides = {}) => ({
  ...Object.fromEntries(PLAYER_SOURCE_REQUIRED_FIELDS.map((field) => [field, ""])),
  season: "2026", season_type: "REG", week: "7", game_id: "2026_07_NE_MIA",
  play_id: "1", posteam: "NE", defteam: "MIA", play_type: "",
  pass: "0", rush: "0", wp: "0.5", two_point_attempt: "0",
  ...overrides,
});
const passing = (overrides = {}) => row({
  play_type: "pass", pass: "1", pass_attempt: "1", rush_attempt: "0",
  sack: "0", qb_scramble: "0", fumble: "0", fumble_lost: "0",
  complete_pass: "0", interception: "0", pass_touchdown: "0",
  passer_player_id: "00-0000001", passer_player_name: "Passing Quarterback",
  ...overrides,
});
const rushing = (overrides = {}) => row({
  play_type: "run", rush: "1", rush_attempt: "1",
  qb_scramble: "0", fumble: "0", fumble_lost: "0",
  rushing_yards: "5", rush_touchdown: "0", yardline_100: "50",
  rusher_player_id: "00-0000002", rusher_player_name: "Rushing Player",
  ...overrides,
});

test("cached real-source row 35 is an end-quarter marker, not a missing passing attempt", () => {
  // Both retained source copies contain this same sanitized row.
  const marker = row({
    game_id: "2026_01_ARI_LAC", play_id: "778", week: "1",
    posteam: "ARI", defteam: "LAC", qb_scramble: "0", desc: "END QUARTER 1",
  });
  validatePlayerSourceRows([marker]);
  const parsed = parsePlay(marker);
  assert.equal(marker.pass_attempt, "");
  assert.equal(parsed.passAttempt, 0);
  assert.equal(parsed.rushAttempt, 0);
  assert.equal(parsed.passerId, null);
  assert.equal(parsed.rusherId, null);
  assert.equal(parsed.receiverId, null);
});

test("non-pass and rushing rows allow unrelated passing nulls without altering raw values", () => {
  for (const empty of ["", null, undefined, "NA", " "]) {
    const source = rushing({
      pass_attempt: empty, sack: empty, complete_pass: empty,
      passing_yards: empty, air_yards: empty, yards_after_catch: empty,
    });
    validatePlayerSourceRows([source]);
    assert.equal(source.pass_attempt, empty);
    assert.equal(parsePlay(source).passAttempt, 0);
    assert.equal(parsePlay(source).rushingYards, 5);
    assert.equal(parsePlay(source).airYards, null);
    assert.equal(parsePlay(source).yardsAfterCatch, null);
  }
});

test("genuine pass attempts cannot silently use the pass indicator when pass_attempt is missing", () => {
  for (const empty of ["", null, "NA"]) {
    assert.throws(() => validatePlayerSourceRows([passing({ pass_attempt: empty })]),
      /missing relevant numeric pass_attempt/);
  }
});

test("explicit zero remains zero on a sack/dropback rather than becoming an attempt", () => {
  const source = passing({ sack: "1", pass_attempt: "0", complete_pass: "",
    interception: "", pass_touchdown: "" });
  validatePlayerSourceRows([source]);
  const parsed = parsePlay(source);
  assert.equal(source.pass_attempt, "0");
  assert.equal(parsed.passAttempt, 0);
  assert.equal(parsed.sack, 1);
});

test("a missing dataset column fails even on a non-applicable marker row", () => {
  const missing = row();
  delete missing.pass_attempt;
  assert.throws(() => validatePlayerSourceRows([missing]), /missing required column pass_attempt/);
});

test("malformed numeric text is never accepted as a non-applicable blank", () => {
  assert.throws(() => validatePlayerSourceRows([passing({ pass_attempt: "missing" })]), /invalid numeric/);
  assert.throws(() => validatePlayerSourceRows([row({ pass_attempt: "missing" })]), /invalid numeric/);
  assert.throws(() => validatePlayerSourceRows([rushing({ rushing_yards: "" })]),
    /missing relevant numeric rushing_yards/);
});

test("scramble uses rushing statistics without passing-attempt double counting", () => {
  const source = rushing({ play_type: "run", pass: "1", qb_scramble: "1",
    pass_attempt: "", sack: "0", rusher_player_id: "00-0000001",
    rusher_player_name: "Passing Quarterback" });
  validatePlayerSourceRows([source]);
  const parsed = parsePlay(source);
  assert.equal(parsed.passAttempt, 0);
  assert.equal(parsed.rushAttempt, 1);
  assert.equal(parsed.qbScramble, 1);
});

test("receiving statistics are required only on the applicable attempted/completed pass", () => {
  const target = passing({ receiver_player_id: "00-0000003",
    receiver_player_name: "Receiving Player", yardline_100: "30", air_yards: "10" });
  validatePlayerSourceRows([target]);
  assert.equal(parsePlay(target).yardsAfterCatch, null);
  for (const field of ["receiving_yards", "yards_after_catch", "passing_yards"]) {
    const completed = { ...target, complete_pass: "1", passing_yards: "15",
      receiving_yards: "15", yards_after_catch: "5", [field]: "" };
    assert.throws(() => validatePlayerSourceRows([completed]), /missing relevant numeric/);
  }
  assert.throws(() => validatePlayerSourceRows([{ ...target, air_yards: "" }]),
    /missing relevant numeric air_yards/);
  const unresolved = parsePlay({ ...target, receiver_player_id: "" });
  assert.equal(unresolved.receiverId, null);
});

test("two-point attempts retain their unavailable ordinary yardage but are excluded from player totals", () => {
  const conversion = passing({ two_point_attempt: "1", complete_pass: "1",
    receiver_player_id: "00-0000003", receiver_player_name: "Receiving Player" });
  validatePlayerSourceRows([conversion, rushing({ two_point_attempt: "1", rushing_yards: "" })]);
  assert.equal(conversion.passing_yards, "");
  assert.equal(parsePlay(conversion).twoPointAttempt, true);
});

test("mixed play totals preserve all ordinary player feature families without counting administrative plays", () => {
  const sources = [
    passing({ complete_pass: "1", passing_yards: "20", pass_touchdown: "1",
      receiver_player_id: "00-0000003", receiver_player_name: "Receiving Player",
      receiving_yards: "20", air_yards: "20", yards_after_catch: "8", yardline_100: "15" }),
    passing({ receiver_player_id: "00-0000003", receiver_player_name: "Receiving Player",
      air_yards: "30", yardline_100: "40" }),
    passing({ interception: "1" }),
    passing({ sack: "1", pass_attempt: "0", complete_pass: "", interception: "", pass_touchdown: "" }),
    rushing({ rush_touchdown: "1", yardline_100: "5" }),
    rushing({ pass: "1", qb_scramble: "1", rushing_yards: "7", yardline_100: "10",
      rusher_player_id: "00-0000001", rusher_player_name: "Passing Quarterback" }),
    row(),
    passing({ play_type: "no_play", complete_pass: "1", passing_yards: "99" }),
    passing({ play_type: "qb_spike" }),
    rushing({ play_type: "qb_kneel" }),
    passing({ two_point_attempt: "1", complete_pass: "1" }),
  ].map((source, i) => ({ ...source, play_id: String(i + 1) }));
  validatePlayerSourceRows(sources);
  const metrics = buildWeeklyPlayerMetrics(sources.map(parsePlay), [{
    id: "final", season: 2026, week: 7, season_type: "REG", status: "Final",
    date: "2026-10-25T17:00:00Z", updated_at: "2026-10-26T00:00:00Z",
    visitor_team: { abbreviation: "NE" }, home_team: { abbreviation: "MIA" },
  }], { season: 2026, predictionWeek: 8, cutoff: "2026-10-30T00:15:00.000Z" }).NE;
  const totals = metrics.teamTotals;
  for (const [field, expected] of Object.entries({
    passAttempts: 3, completions: 1, passingYards: 20, passingTouchdowns: 1,
    interceptions: 1, sacksAllowed: 1, rushingAttempts: 2, rushingYards: 12,
    rushingTouchdowns: 1, qbScrambles: 1, targets: 2, receptions: 1,
    receivingYards: 20, receivingTouchdowns: 1, airYards: 50, yardsAfterCatch: 8,
    redZoneCarries: 2, goalLineCarries: 1, redZoneTargets: 1, goalLineTargets: 0,
    endZoneTargets: 1,
  })) assert.equal(totals[field], expected, field);
  const qb = metrics.players["00-0000001"];
  assert.equal(qb.passing.dropbacks, 4);
  assert.equal(qb.passing.sacksTaken, 1);
  assert.equal(qb.rushing.scrambles, 1);
  assert.equal(qb.touches, 1);
  assert.equal(qb.combined.rushingReceivingYards, 7);
  const receiver = metrics.players["00-0000003"];
  assert.equal(receiver.touches, 1);
  assert.equal(receiver.combined.rushingReceivingYards, 20);
  assert.equal(receiver.receiving.endZoneTargets, 1);
  assert.equal(Object.keys(metrics.players).length, 3);
});
