import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildDepthMetrics } from "./depthCharts.js";
import { parseGenericCsv } from "../scripts/update-nflverse.mjs";
import { buildWeeklyPlayerMetrics, parsePlay } from "../scripts/update-nflverse-players.mjs";
import { playerMetricsResponse, validatePlayerMetrics, completedPlayerGames } from "./playerMetrics.js";
import { buildPlayerProjections } from "../src/services/playerProjectionService.js";
import { buildBestBets } from "../src/services/bestBetsService.js";
import handler from "../api/nfl/game-stats.js";
import legacy from "../data/nflverse-player-metrics.js";
import { getFullGamePrediction, clearFullGamePredictionCache } from "../src/services/gamePredictionService.js";

const history = parseGenericCsv(readFileSync(new URL("./fixtures/depth-chart-history.csv", import.meta.url), "utf8"));
const cutoffs = { 2: "2026-09-18T00:15:00.000Z", 6: "2026-10-16T00:15:00.000Z" };
const ids = { dart: "00-0040691", winston: "00-0031503", wr: "00-0039337" };
const prediction = {
  away: { code: "NYG", expectedPossessions: 11, score: 24, passingTD: 2, rushingTD: 1 },
  home: { code: "KC", expectedPossessions: 11, score: 24, passingTD: 2, rushingTD: 1 },
  awayWinProbability: .5, homeWinProbability: .5,
};
// Only depth identities/snapshots are historical facts. All plays/schedules below are controlled inputs.
function scheduleGame(week, overrides = {}) {
  const days = { 1: "09-13", 3: "09-27", 5: "10-11", 6: "10-18" };
  return { id: week, season: 2026, week, season_type: "REG", postseason: false, status: "Final",
    date: `2026-${days[week]}T17:00:00Z`, updated_at: `2026-${days[week]}T21:00:00Z`,
    visitor_team: { abbreviation: "NYG" }, home_team: { abbreviation: "KC" }, ...overrides };
}
function raw(week, team, index, overrides = {}) {
  return { season: "2026", season_type: "REG", week: String(week), game_id: `2026_${String(week).padStart(2, "0")}_NYG_KC`,
    play_id: `${team}-${index}`, posteam: team, defteam: team === "NYG" ? "KC" : "NYG",
    play_type: "pass", wp: ".5", pass_attempt: "1", complete_pass: "1",
    passer_player_id: team === "NYG" ? ids.dart : "home-qb",
    passer_player_name: team === "NYG" ? "J.Dart" : "Home QB",
    receiver_player_id: team === "NYG" ? ids.wr : "home-wr", receiver_player_name: "Receiver",
    passing_yards: "8", receiving_yards: "8", air_yards: "8", yardline_100: "18", ...overrides };
}
function playsFor(week) {
  const rows = [];
  for (const code of ["NYG", "KC"]) {
    for (let index = 0; index < 40; index++) {
      rows.push(raw(week, code, index, code === "NYG" && index < 25 ? {
        passer_player_id: ids.winston, passer_player_name: "J.Winston",
        passing_yards: "5", receiving_yards: "5",
      } : {}));
    }
    for (let index = 0; index < 12; index++) {
      rows.push(raw(week, code, `r${index}`, { play_type: "run", pass_attempt: "0", rush_attempt: "1",
        complete_pass: "0", receiver_player_id: "", receiver_player_name: "",
        rusher_player_id: `${code}-rb`, rusher_player_name: "Runner", rushing_yards: "5", yardline_100: "4" }));
    }
    for (let index = 0; index < 6; index++) rows.push(raw(week, code, `te${index}`, {
      receiver_player_id: `${code}-te`, receiver_player_name: "Tight End",
    }));
  }
  return rows.map(parsePlay);
}
function role(team, id, position, slot, dt) {
  return { team, espn_id: id, gsis_id: id, player_name: id, pos_grp: "3WR 1TE",
    pos_abb: position, pos_rank: "1", pos_slot: String(slot), dt };
}
function depth(week = 2, extra = [], source = history) {
  const dt = week === 2 ? "2026-09-17T12:34:29Z" : "2026-10-14T06:01:55Z";
  return buildDepthMetrics([...source,
    role("NYG", "NYG-rb", "RB", 11, dt), role("NYG", "NYG-te", "TE", 10, dt),
    role("KC", "home-qb", "QB", 9, dt), role("KC", "home-wr", "WR", 1, dt),
    role("KC", "KC-rb", "RB", 11, dt), role("KC", "KC-te", "TE", 10, dt), ...extra,
  ], { season: 2026, predictionWeek: week, cutoff: cutoffs[week] });
}
function fixture(week = 2, plays = playsFor(1), schedule = [scheduleGame(1)]) {
  const teams = buildWeeklyPlayerMetrics(plays, schedule, { season: 2026, predictionWeek: week, cutoff: cutoffs[week] });
  const artifact = { schemaVersion: 2, season: 2026, generatedAt: "2026-10-14T22:00:00Z",
    sourceAsOf: "2026-10-14T21:00:00Z", cutoffs, playerMetricsByWeek: { [week]: teams } };
  const playerMetrics = playerMetricsResponse(artifact, { season: 2026, week, away: "NYG", home: "KC" });
  const lineups = depth(week);
  return { away: "NYG", home: "KC", season: 2026, week, cutoff: cutoffs[week],
    prediction, playerMetrics, teamMetrics: {
      away: { team: "NYG", expectedLineup: lineups.NYG },
      home: { team: "KC", expectedLineup: lineups.KC },
    }, artifact };
}
const run = (input = fixture()) => buildPlayerProjections(input);
const qb = (result) => result.away?.players.find((player) => player.passingAttempts !== undefined);
const receiver = (result) => result.away?.players.find((player) => player.playerId === ids.wr);
const runner = (result) => result.away?.players.find((player) => player.playerId === "NYG-rb");
function numericOutputs(value) {
  if (typeof value === "number") assert.ok(Number.isFinite(value));
  else if (value && typeof value === "object") Object.values(value).forEach(numericOutputs);
}

test("player extractor imports without fetching/writing and endpoint parses", () => {
  execFileSync(process.execPath, ["--check", "scripts\\update-nflverse-players.mjs"]);
  execFileSync(process.execPath, ["--check", "api\\nfl\\game-stats.js"]);
});
test("actual two-week depth changes select Dart then Winston, never the volume leader by default", () => {
  const early = run();
  const later = run(fixture(6));
  assert.ok(early.available && later.available);
  assert.equal(qb(early).playerId, ids.dart);
  assert.equal(qb(later).playerId, ids.winston);
  assert.ok(fixture().playerMetrics.away.players[ids.winston].passing.attempts >
    fixture().playerMetrics.away.players[ids.dart].passing.attempts);
  assert.ok(qb(early).passingYards - qb(later).passingYards > 50, "Own QB profiles materially change passing yards");
  assert.equal(qb(early).profile.passing.yardsPerAttempt, 8);
  assert.equal(qb(later).profile.passing.yardsPerAttempt < 8, true);
});
test("future depth rows cannot replace the earlier verified QB or roles", () => {
  const input = fixture();
  const earlier = depth(2, [], history.filter((row) => row.dt.startsWith("2026-09")));
  assert.deepEqual(input.teamMetrics.away.expectedLineup, earlier.NYG);
});
test("QB own completions, attempts, yards, sacks, rushing and scramble profile are independent", () => {
  const plays = playsFor(1);
  plays.push(parsePlay(raw(1, "NYG", "sack", { pass_attempt: "1", sack: "1", passing_yards: "0",
    receiving_yards: "0", complete_pass: "0", receiver_player_id: "", receiver_player_name: "" })));
  plays.push(parsePlay(raw(1, "NYG", "scramble", { play_type: "run", pass_attempt: "0", rush_attempt: "1",
    qb_scramble: "1", rusher_player_id: ids.dart, rusher_player_name: "J.Dart",
    rushing_yards: "9", complete_pass: "0", receiver_player_id: "", receiver_player_name: "" })));
  const input = fixture(2, plays);
  const result = run(input);
  const profile = qb(result).profile;
  assert.equal(profile.passing.sacksTaken, 1);
  assert.equal(profile.passing.attempts, fixture().playerMetrics.away.players[ids.dart].passing.attempts);
  assert.equal(profile.rushing.scrambles, 1);
  assert.equal(profile.rushing.yards, 9);
  assert.equal(profile.passing.interceptions, 0);
  assert.equal(profile.passing.yards, input.playerMetrics.away.players[ids.dart].passing.yards);
  const before = qb(result).passingYards;
  input.playerMetrics.away.players[ids.winston].passing.yards = 99999;
  input.playerMetrics.away.players[ids.winston].passing.sacksTaken = 99;
  assert.equal(qb(run(input)).passingYards, before);
});
test("missing verified QB preserves independently supported RB WR TE, without a guessed QB", () => {
  const input = fixture();
  input.teamMetrics.away.expectedLineup.startingQuarterback = null;
  const result = run(input);
  assert.equal(qb(result), undefined);
  assert.ok(receiver(result) && runner(result));
  assert.ok(result.away.players.some((player) => player.position === "TE"));
  assert.ok(result.reasons.some((reason) => reason.includes("named passing projection omitted")));
});
test("ambiguous QB depth omits named QB but retains independently valid non-QB roles", () => {
  const input = fixture();
  const conflict = { ...history.find((row) => row.gsis_id === ids.dart && row.pos_rank === "1"),
    espn_id: "other-qb", gsis_id: "other-qb" };
  input.teamMetrics.away.expectedLineup = depth(2, [conflict]).NYG;
  const result = run(input);
  assert.equal(qb(result), undefined);
  assert.ok(receiver(result) && runner(result));
  assert.equal(result.home.players.length > 0, true);
});
test("verified QB with no eligible passing sample is omitted, not assigned predecessor rates", () => {
  const input = fixture();
  delete input.playerMetrics.away.players[ids.dart];
  const result = run(input);
  assert.equal(qb(result), undefined);
  assert.ok(receiver(result));
});
test("small own-QB sample keeps existing clamps and carries low sample confidence", () => {
  const result = run();
  assert.ok(qb(result).roleConfidence < .5);
  assert.equal(qb(result).profile.games, 1);
  numericOutputs(result);
});
test("archived/repeated plays cannot multiply usage; conflicting duplicates fail explicitly", () => {
  const plays = playsFor(1);
  assert.deepEqual(fixture(2, [...plays, ...plays]).playerMetrics, fixture(2, plays).playerMetrics);
  assert.throws(() => fixture(2, [...plays, { ...plays[0], passingYards: 999 }]), /Conflicting player play/);
});
test("only completed games observed before cutoff contribute; future/current week and postseason excluded", () => {
  const rows = [scheduleGame(1), scheduleGame(3), scheduleGame(5), scheduleGame(6)];
  assert.equal(completedPlayerGames(rows, 2026, 2, cutoffs[2]).length, 1);
  for (const change of [{ status: "In Progress" }, { postseason: true }, { season_type: "PRE" },
    { date: "2026-10-17T00:00:00Z" }, { updated_at: "2026-09-19T00:00:00Z" }, { updated_at: undefined }]) {
    assert.deepEqual(completedPlayerGames([scheduleGame(1, change)], 2026, 2, cutoffs[2]), []);
  }
  const full = fixture(2, [...playsFor(1), ...playsFor(3), ...playsFor(5), ...playsFor(6)], rows);
  assert.deepEqual(full.playerMetrics, fixture().playerMetrics);
});
test("future RB WR TE target/carry/red-zone/end-zone changes cannot leak backward", () => {
  const future = playsFor(5).map((play) => ({ ...play, target: 1, rushingYards: 999,
    redZone: true, goalLine: true, endZoneTarget: true }));
  const result = fixture(2, [...playsFor(1), ...future], [scheduleGame(1), scheduleGame(5)]);
  assert.deepEqual(result.playerMetrics.away.teamTotals, fixture().playerMetrics.away.teamTotals);
  assert.deepEqual(run(result).away.players, run().away.players);
});
test("recent role includes zero-usage team games and excludes byes/future games", () => {
  const plays = [...playsFor(1), ...playsFor(3), ...playsFor(5)]
    .filter((play) => !(play.week === 5 && play.receiverId === ids.wr));
  const input = fixture(6, plays, [scheduleGame(1), scheduleGame(3), scheduleGame(5)]);
  const player = input.playerMetrics.away.players[ids.wr];
  assert.equal(player.recent.games, 2);
  assert.equal(player.recent.targetsPerGame, player.gameLog.find((row) => row.week === 3).targets / 2);
  assert.equal(player.receiving.targets, player.gameLog.reduce((sum, row) => sum + row.targets, 0));
  for (const candidate of Object.values(input.playerMetrics.away.players)) {
    for (const [profile, field, logField] of [
      ["rushing", "attempts", "rushingAttempts"], ["rushing", "goalLineCarries", "goalLineCarries"],
      ["receiving", "redZoneTargets", "redZoneTargets"], ["receiving", "endZoneTargets", "endZoneTargets"],
    ]) {
      assert.equal(candidate[profile][field], candidate.gameLog.reduce((sum, row) => sum + row[logField], 0));
    }
  }
});
test("schedule duplicate games cannot double totals and incomplete eligible coverage fails", () => {
  assert.deepEqual(fixture(2, playsFor(1), [scheduleGame(1), scheduleGame(1)]).playerMetrics, fixture().playerMetrics);
  assert.throws(() => fixture(6, playsFor(1), [scheduleGame(1), scheduleGame(3)]), /Incomplete player game coverage/);
});
test("archived status is superseded; unknown health is explicit, not confirmed healthy", () => {
  const input = fixture();
  assert.equal(run(input).away.availabilityKnown, false);
  const source = history.map((row) => ({ ...row, injury_status: row.dt.startsWith("2026-09") ? "Out" : "" }));
  const later = depth(6, [], source);
  input.week = 6; input.cutoff = cutoffs[6];
  const current = fixture(6);
  current.teamMetrics.away.expectedLineup = later.NYG;
  assert.equal(qb(run(current)).playerId, ids.winston);
});
for (const status of ["Out", "IR", "Inactive", "Doubtful", "Questionable", "Probable"]) {
  test(`point-in-time ${status} is honored without promoting a backup QB`, () => {
    const input = fixture();
    const modified = history.map((row) => row.gsis_id === ids.dart ? { ...row, injury_status: status } : row);
    input.teamMetrics.away.expectedLineup = depth(2, [], modified).NYG;
    assert.equal(Boolean(qb(run(input))), ["Questionable", "Probable"].includes(status));
  });
}
test("future/undated status snapshots cannot affect historical projections", () => {
  const source = history.filter((row) => row.dt.startsWith("2026-09"));
  const extra = [{ ...source[0], injury_status: "Out", dt: "2026-10-17T00:00:00Z" },
    { ...source[0], injury_status: "Out", dt: "" }];
  assert.deepEqual(depth(2, extra).NYG, depth(2).NYG);
});
test("synthetic team transfer excludes the former team and never borrows its profile", () => {
  const input = fixture(6);
  const transfer = role("KC", "transfer", "WR", 2, "2026-10-14T12:00:00Z");
  transfer.gsis_id = ids.wr; transfer.espn_id = "4595348"; transfer.pos_rank = "2";
  const lineups = depth(6, [
    role("KC", "home-qb", "QB", 9, transfer.dt), role("KC", "home-wr", "WR", 1, transfer.dt),
    role("KC", "KC-rb", "RB", 11, transfer.dt), role("KC", "KC-te", "TE", 10, transfer.dt), transfer,
  ]);
  input.teamMetrics.away.expectedLineup = lineups.NYG;
  input.teamMetrics.home.expectedLineup = lineups.KC;
  const result = run(input);
  assert.equal(receiver(result), undefined);
  assert.ok(result.home);
  assert.equal(result.home?.players.some((player) => player.playerId === ids.wr), false);
});
test("current roster members without GSIS identity or sufficient own role samples are excluded", () => {
  const input = fixture();
  input.playerMetrics.away.players[ids.wr].gsisId = null;
  input.playerMetrics.away.players["NYG-rb"].rushing.attempts = 2;
  const result = run(input);
  assert.equal(receiver(result), undefined);
  assert.equal(runner(result), undefined);
});
test("conflicting individual depth roles are excluded without discarding independent receivers", () => {
  const input = fixture();
  input.teamMetrics.away.expectedLineup = depth(2, [
    role("NYG", "NYG-rb", "TE", 12, "2026-09-17T12:34:29Z"),
  ]).NYG;
  const result = run(input);
  assert.equal(runner(result), undefined);
  assert.ok(receiver(result));
});
for (const field of ["passingEpaAllowedPerPlay", "rushingEpaAllowedPerPlay", "pressureGeneratedRate"]) {
  test(`${field} preserves expected matchup direction`, () => {
    const strong = fixture(); const weak = fixture();
    const pressure = field === "pressureGeneratedRate";
    strong.teamMetrics.home[field] = pressure ? .4 : -.4;
    weak.teamMetrics.home[field] = pressure ? .02 : .4;
    const a = run(strong); const b = run(weak); const neutral = run();
    if (field === "rushingEpaAllowedPerPlay") {
      assert.ok(runner(a).rushingYards < runner(neutral).rushingYards);
      assert.ok(runner(neutral).rushingYards < runner(b).rushingYards);
    }
    else {
      assert.ok(qb(a).passingYards < qb(b).passingYards);
      assert.ok(receiver(a).receivingYards < receiver(b).receivingYards);
      if (!pressure) {
        assert.ok(qb(a).passingYards < qb(neutral).passingYards);
        assert.ok(qb(neutral).passingYards < qb(b).passingYards);
      }
    }
  });
}
test("Anytime TD remains 1-exp(-expected TDs) and Best Bets consumes only eligible projections", () => {
  const result = run();
  for (const player of result.away.players) {
    const expected = 1 - Math.exp(-(player.rushingTouchdowns + player.receivingTouchdowns));
    assert.ok(Math.abs(player.anytimeTouchdownProbability - expected) < .00011);
  }
  const bets = buildBestBets({ game: { away: "NYG", home: "KC" }, prediction, playerProjections: result,
    oddsEvent: null, dataQuality: {} });
  assert.ok(bets.anytimeTdScorer);
  assert.equal(bets.anytimeTdScorer.source, "model-only");
});
for (const change of ["legacy", "season", "week", "cutoff", "futureLog", "duplicateLog", "nonfinite", "missingVolume"]) {
  test(`rejects ${change} input instead of silently fabricating certainty`, () => {
    const input = fixture();
    const payload = input.playerMetrics;
    if (change === "legacy") delete payload.schemaVersion;
    if (change === "season") payload.season = 2025;
    if (change === "week") payload.metricsWeek = 1;
    if (change === "cutoff") payload.cutoff = cutoffs[6];
    if (change === "futureLog") payload.away.players[ids.dart].gameLog[0].week = 6;
    if (change === "duplicateLog") payload.away.players[ids.dart].gameLog.push(payload.away.players[ids.dart].gameLog[0]);
    if (change === "nonfinite") payload.away.players[ids.dart].passing.yards = Infinity;
    if (change === "missingVolume") payload.away.teamTotals.rushingAttempts = null;
    const result = run(input);
    assert.equal(result.away, null);
    assert.ok(result.reasons.length);
    numericOutputs(result);
  });
}
test("null required individual rates exclude that unsupported profile, not other valid players", () => {
  const input = fixture();
  input.playerMetrics.away.players[ids.wr].receiving.catchRate = null;
  const result = run(input);
  assert.equal(receiver(result), undefined);
  assert.ok(runner(result) && qb(result));
  for (const player of result.away.players) {
    for (const field of ["rushingYards", "receivingYards", "anytimeTouchdownProbability"]) {
      assert.equal(typeof player[field], "number");
      assert.ok(Number.isFinite(player[field]));
    }
  }
});
test("legacy production artifact is rejected; endpoint executes without artifact writes or providers", async () => {
  const response = { status(code) { this.code = code; return this; }, setHeader() {}, json(value) { this.body = value; return this; } };
  await handler({ method: "GET", query: { action: "player-metrics", season: 2026, week: 6, away: "NYG", home: "KC" } }, response);
  assert.equal(response.code, 200);
  assert.equal(response.body.available, false);
  assert.match(response.body.reason, /Legacy/);
  assert.equal(legacy.generatedAt, "2026-09-29T03:47:09.511Z");
});
test("exact-week endpoint payload rejects older-week fallback and season mismatches", () => {
  const { artifact } = fixture();
  const missing = playerMetricsResponse(artifact, { season: 2026, week: 6, away: "NYG", home: "KC" });
  assert.equal(missing.available, false);
  assert.equal(missing.metricsWeek, null);
  assert.match(missing.reason, /Exact prediction-week/);
  assert.equal(playerMetricsResponse(artifact, { season: 2025, week: 2, away: "NYG", home: "KC" }).available, false);
  assert.equal(validatePlayerMetrics(fixture().playerMetrics, { season: 2026, week: 2, cutoff: cutoffs[2] }), null);
});
test("generation/source time cannot predate included final observations", () => {
  const input = fixture();
  input.playerMetrics.sourceAsOf = "2026-09-13T18:00:00Z";
  assert.equal(run(input).away, null);
  input.playerMetrics.sourceAsOf = "2026-10-15T00:00:00Z";
  assert.equal(run(input).available, false); // Generation predates source.
});
test("mismatched QB identity cannot substitute a backup for the declared starter", () => {
  const input = fixture();
  input.teamMetrics.away.expectedLineup.startingQuarterback =
    input.teamMetrics.away.expectedLineup.roster.find((player) => player.gsisId === ids.winston);
  assert.equal(qb(run(input)), undefined);
  assert.ok(receiver(run(input)));
});
test("missing team volume is unavailable, never a zero or fabricated player projection", () => {
  const input = fixture();
  input.prediction = structuredClone(prediction);
  input.prediction.away.passingTD = null;
  const result = run(input);
  assert.equal(result.away.players.length, 0);
  assert.match(result.away.reasons[0], /Required team opportunity/);
});
test("aliases resolve source teams and absent game identity fails explicitly", () => {
  const game = scheduleGame(1, { visitor_team: { abbreviation: "WAS" } });
  const plays = playsFor(1).filter((play) => play.team === "NYG")
    .map((play) => ({ ...play, team: "WSH" }));
  const teams = buildWeeklyPlayerMetrics(plays, [game], { season: 2026, predictionWeek: 2, cutoff: cutoffs[2] });
  assert.ok(teams.WSH);
  assert.throws(() => fixture(2, [{ ...playsFor(1)[0], playId: null }]), /Missing player play identity/);
});
test("verified weekly roles survive real orchestration into projections and Best Bets", async () => {
  const original = global.fetch;
  const input = fixture();
  clearFullGamePredictionCache();
  global.fetch = async (url) => {
    const path = String(url);
    let body = {};
    if (path.startsWith("/api/nfl/play-by-play")) body = input.teamMetrics;
    if (path.startsWith("/api/nfl/game-stats") && path.includes("action=player-metrics")) body = input.playerMetrics;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  try {
    const result = await getFullGamePrediction({ away: "NYG", home: "KC", week: 2,
      sourceDate: "2026-09-20T17:00:00Z", weather: { dome: true } }, null, { season: 2026, forceRefresh: true });
    assert.equal(qb(result.playerProjections).playerId, ids.dart);
    assert.equal(result.dataQuality.playerProjections, true);
    assert.ok(result.bestBets.anytimeTdScorer);
    assert.equal(result.bestBets.anytimeTdScorer.source, "model-only");
    numericOutputs(result.playerProjections);
    input.teamMetrics.away.expectedLineup.available = false;
    input.teamMetrics.away.expectedLineup.issues = ["Conflicting depth slot"];
    const ambiguous = await getFullGamePrediction({ away: "NYG", home: "KC", week: 2,
      sourceDate: "2026-09-20T17:00:00Z", weather: { dome: true } }, null, { season: 2026, forceRefresh: true });
    assert.equal(qb(ambiguous.playerProjections), undefined);
    assert.ok(receiver(ambiguous.playerProjections));
  } finally { global.fetch = original; clearFullGamePredictionCache(); }
});
