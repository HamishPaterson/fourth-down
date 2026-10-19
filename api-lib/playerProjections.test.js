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
import { buildWeeklyMultiSelection } from "./weeklyMulti.js";
import { CURRENT_MODEL_VERSION, CURRENT_MODEL_KEY } from "../src/services/modelIdentity.js";
import handler from "../api/nfl/game-stats.js";
import regenerated from "../data/nflverse-player-metrics.js";
import { getFullGamePrediction, clearFullGamePredictionCache } from "../src/services/gamePredictionService.js";
import { buildPersonnelView, canonicalTeam } from "./personnelView.js";
import dataset from "../api/nfl/nflverse-team-metrics.js";

const history = parseGenericCsv(readFileSync(new URL("./fixtures/depth-chart-history.csv", import.meta.url), "utf8"));
const cutoffs = { 2: "2026-09-18T00:15:00.000Z", 6: "2026-10-16T00:15:00.000Z" };
const ids = { dart: "00-0040691", winston: "00-0031503", wr: "00-0039337" };
const tampaQbs = {
  baker: { id: "00-0034855", name: "Baker Mayfield" },
  jalon: { id: "00-0041251", name: "Jalon Daniels" },
};
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
function confirmedPersonnelViews(input, statusById = {}) {
  return Object.fromEntries(["away", "home"].map((side) => {
    const team = input[side];
    const lineup = input.teamMetrics[side].expectedLineup;
    const players = lineup.roster.map((role) => ({
      id: `live-${role.playerId}`,
      gsisId: role.gsisId,
      fullName: role.name,
      team,
      position: role.position,
      depthChartPosition: role.position,
      depthChartOrder: role.rank,
      status: "Active",
      injuryStatus: statusById[role.gsisId] || "Active",
    }));
    return [side, buildPersonnelView({
      team, lineup, season: input.season, week: input.week, cutoff: input.cutoff,
      roster: {
        team,
        sourceAsOf: new Date(Date.parse(input.cutoff) - 1000).toISOString(),
        groups: { players },
      },
    })];
  }));
}
function addSyntheticSkillProfiles(input, roles) {
  const chartRoles = [];
  for (const { id, position, rank, templateId } of roles) {
    const profile = structuredClone(input.playerMetrics.away.players[templateId]);
    profile.playerId = id;
    profile.gsisId = id;
    profile.playerName = id;
    profile.team = input.away;
    if (position === "WR" || position === "TE") {
      profile.receiving.targetShare = 0.22;
      profile.receiving.targets = 14;
      profile.receiving.catchRate = 0.65;
      profile.receiving.yardsPerTarget = 8;
      profile.recent.targetsPerGame = 14;
    } else {
      profile.rushing.carryShare = 0.25;
      profile.rushing.attempts = 12;
      profile.rushing.yardsPerCarry = 4.2;
      profile.recent.rushingAttemptsPerGame = 12;
    }
    input.playerMetrics.away.players[id] = profile;
    const chartRole = role(input.away, id, position, rank, "2026-09-17T12:34:29Z");
    chartRole.pos_rank = String(rank);
    chartRoles.push(chartRole);
  }
  input.teamMetrics.away.expectedLineup = depth(input.week, chartRoles).NYG;
}
function phillyReplacementFixture() {
  const input = fixture();
  const lineup = structuredClone(input.teamMetrics.away.expectedLineup);
  const chartQb = lineup.roster.find((player) => player.group === "QB" && player.rank === 1);
  const originalId = chartQb.gsisId;
  const hurts = { ...chartQb, playerId: "hurts-id", gsisId: "hurts-id", name: "Jalen Hurts",
    team: "PHI", rank: 1, chartRank: 1, slot: "QB-1" };
  const mckee = { ...hurts, playerId: "mckee-id", gsisId: "mckee-id", name: "Tanner McKee",
    rank: 2, chartRank: 2, slot: "QB-2" };
  lineup.team = "PHI";
  lineup.roster = lineup.roster.filter((player) => player.group !== "QB")
    .map((player) => ({ ...player, team: "PHI" }));
  lineup.roster.push(hurts, mckee);
  lineup.players = lineup.players.map((player) => player.group === "QB" ? hurts : { ...player, team: "PHI" });
  lineup.startingQuarterback = hurts;
  input.away = "PHI";
  input.teamMetrics.away.team = "PHI";
  input.teamMetrics.away.expectedLineup = lineup;
  input.playerMetrics.away.team = "PHI";
  input.playerMetrics.away.gameProvenance = input.playerMetrics.away.gameProvenance.map((game) => ({
    ...game,
    gameId: game.gameId.replaceAll("NYG", "PHI"),
    away: game.away === "NYG" ? "PHI" : game.away,
    home: game.home === "NYG" ? "PHI" : game.home,
  }));
  for (const profile of Object.values(input.playerMetrics.away.players)) {
    profile.team = "PHI";
    profile.gameLog = profile.gameLog.map((game) => ({
      ...game,
      gameId: game.gameId.replaceAll("NYG", "PHI"),
    }));
  }
  const original = structuredClone(input.playerMetrics.away.players[originalId]);
  delete input.playerMetrics.away.players[originalId];
  input.playerMetrics.away.players["hurts-id"] = {
    ...structuredClone(original), playerId: "hurts-id", gsisId: "hurts-id",
    playerName: "Jalen Hurts", team: "PHI",
    passing: { ...original.passing, attempts: 40, completions: 25, yards: 320, yardsPerAttempt: 8 },
  };
  input.playerMetrics.away.players["mckee-id"] = {
    ...structuredClone(original), playerId: "mckee-id", gsisId: "mckee-id",
    playerName: "Tanner McKee", team: "PHI",
    passing: { ...original.passing, attempts: 12, completions: 8, yards: 72, yardsPerAttempt: 6 },
  };
  input.personnelViews = confirmedPersonnelViews(input, {
    "hurts-id": "Out",
    "mckee-id": "Active",
  });
  return input;
}
function tampaConflictFixture(resolvedStarter = null) {
  const input = fixture();
  input.away = "TB";
  input.home = "KC";
  input.week = 6;
  const awayMetrics = dataset.metricsByWeek[6].TB;
  const homeMetrics = dataset.metricsByWeek[6].KC;
  const lineup = structuredClone(awayMetrics.expectedLineup);
  input.cutoff = lineup.cutoff;
  input.teamMetrics = { away: awayMetrics, home: homeMetrics };
  input.playerMetrics = playerMetricsResponse(regenerated, {
    season: 2026, week: 6, away: "TB", home: "KC",
  });
  input.prediction = {
    ...prediction,
    away: { ...prediction.away, code: "TB" },
    home: { ...prediction.home, code: "KC" },
  };
  const qbs = lineup.roster.filter((player) => player.group === "QB");
  assert.deepEqual(qbs.map((player) => ({ id: player.gsisId, name: player.name })), [
    { id: tampaQbs.baker.id, name: tampaQbs.baker.name },
    { id: tampaQbs.jalon.id, name: tampaQbs.jalon.name },
  ]);
  const livePlayers = lineup.roster.map((player) => ({
    id: `live-${player.gsisId}`,
    gsisId: player.gsisId,
    fullName: player.name,
    team: "TB",
    position: player.position,
    depthChartPosition: player.position,
    depthChartOrder: player.group === "QB"
      ? resolvedStarter ? player.gsisId === resolvedStarter ? 1 : 2 : 1
      : player.rank,
    status: "Active",
    injuryStatus: player.group === "QB" ? "Active" : "Unknown",
  }));
  livePlayers.push({
    id: "nyg-only-qb", gsisId: ids.dart, fullName: "Jaxson Dart", team: "NYG",
    position: "QB", depthChartPosition: "QB", depthChartOrder: 1,
    status: "Active", injuryStatus: "Active",
  });
  const liveRoster = {
    team: "TB",
    sourceAsOf: "2026-10-15T12:00:00.000Z",
    groups: { players: livePlayers },
    leagueIdentityIndex: livePlayers.map((player) => ({ gsisId: player.gsisId, team: player.team })),
  };
  const away = buildPersonnelView({
    team: "TB", lineup, season: 2026, week: 6, cutoff: input.cutoff, roster: liveRoster,
  });
  input.personnelViews = { ...confirmedPersonnelViews(input), away };
  return input;
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
test("player identity and personnel-role team must match the fixture team before projection", () => {
  const mismatchedRole = fixture();
  mismatchedRole.personnelViews = confirmedPersonnelViews(mismatchedRole);
  const qbRole = mismatchedRole.personnelViews.away.players
    .find((player) => player.canonicalId === ids.dart);
  qbRole.team = "TB";
  const roleRejected = run(mismatchedRole);
  assert.equal(qb(roleRejected), undefined);
  assert.ok(roleRejected.away.players.every((player) => player.personnelId !== ids.dart));

  const mismatchedProfile = fixture();
  mismatchedProfile.playerMetrics.away.players[ids.dart].team = "TB";
  const profileRejected = run(mismatchedProfile);
  assert.equal(profileRejected.away, null);
  assert.equal(qb(profileRejected), undefined);
  assert.match(profileRejected.reasons.join(" "), /Invalid away player provenance/);
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
test("Philadelphia Hurts Out excludes his projection and Best Bets; McKee uses his own profile", () => {
  const input = phillyReplacementFixture();
  const result = run(input);
  const projectedQb = result.away.players.find((player) => player.position === "QB");
  assert.equal(projectedQb.playerId, "mckee-id");
  assert.equal(projectedQb.profile.passing.yardsPerAttempt, 6);
  assert.notEqual(projectedQb.profile.passing.yardsPerAttempt, 8);
  assert.equal(result.away.players.some((player) => player.playerId === "hurts-id"), false);
  assert.match(input.personnelViews.away.quarterback.reason, /Philadelphia Eagles: Tanner McKee.*Jalen Hurts/);
  const quoteAt = "2026-10-16T10:00:00Z";
  const kickoff = "2026-10-18T17:00:00Z";
  const oddsEvent = {
    id: "frozen-philadelphia-qb-markets", away_team: "Philadelphia Eagles",
    home_team: "Kansas City Chiefs", commence_time: kickoff,
    bookmakers: [{
      key: "draftkings", title: "DraftKings", last_update: quoteAt,
      markets: ["Jalen Hurts", "Tanner McKee"].map((playerName) => ({
        key: "player_pass_yds", last_update: quoteAt,
        outcomes: [
          { name: "Over", playerName, point: 150.5, price: -110 },
          { name: "Under", playerName, point: 150.5, price: -110 },
        ],
      })),
    }],
  };
  const bets = buildBestBets({
    game: { away: "PHI", home: "KC", season: 2026, week: 6 },
    prediction: { ...prediction, away: { ...prediction.away, code: "PHI" } },
    playerProjections: result,
    personnelViews: input.personnelViews,
    oddsEvent, quoteAsOf: new Date("2026-10-16T11:00:00Z"),
    dataQuality: { personnel: true, playByPlay: true, teamForm: true }, audit: true,
  });
  assert.equal(bets.candidates.some((candidate) => candidate.personnelId === "hurts-id"), false);
  const mckeeBets = bets.candidates.filter((candidate) => candidate.personnelId === "mckee-id");
  assert.equal(mckeeBets.length, 0, "the one-game profile fails the normal role-confidence floor");
  assert.ok(bets.assessments.some((assessment) =>
    assessment.playerName === "Tanner McKee" &&
    assessment.rejectionReasons.includes("role_confidence_below_0.55")));
  assert.ok(mckeeBets
    .every((candidate) => candidate.edge >= 0.045 && candidate.expectedValue >= 0.03));
  const weekly = buildWeeklyMultiSelection(
    [{
      season: 2026, week: 6, awayCode: "PHI", homeCode: "KC", kickoff,
      modelVersion: CURRENT_MODEL_VERSION, modelKey: CURRENT_MODEL_KEY,
      bestBets: bets, personnelViews: input.personnelViews,
    }],
    { cacheStatus: "fresh", events: [oddsEvent] },
    { season: 2026, week: 6, lockAt: "2026-10-16T20:00:00Z" },
    new Date("2026-10-16T11:00:00Z"),
  );
  assert.equal(weekly.legs.some((candidate) => candidate.personnelId === "hurts-id"), false);
  const mckeeLegs = weekly.legs.filter((candidate) => candidate.personnelId === "mckee-id");
  assert.equal(mckeeLegs.length, 0, "Weekly Multi receives no McKee candidate rejected by normal Best Bets gates");
});
test("Philadelphia unavailable QB without verified replacement status or profile has no named QB projection", () => {
  const input = phillyReplacementFixture();
  delete input.playerMetrics.away.players["mckee-id"];
  input.personnelViews = confirmedPersonnelViews(input, {
    "hurts-id": "Out",
    "mckee-id": "Unknown",
  });
  const result = run(input);
  assert.equal(result.away.players.some((player) => player.position === "QB"), false);
  assert.equal(result.away.players.some((player) => player.playerId === "hurts-id"), false);
});
test("Tampa Bay Baker Mayfield/Jalon Daniels conflict uses only Tampa chart, live identity and own profiles", () => {
  const unresolvedInput = tampaConflictFixture();
  const unresolvedView = unresolvedInput.personnelViews.away;
  const qbs = unresolvedView.players.filter((player) => player.position === "QB");
  assert.deepEqual(qbs.map((player) => ({ id: player.canonicalId, name: player.name })), [
    { id: tampaQbs.baker.id, name: tampaQbs.baker.name },
    { id: tampaQbs.jalon.id, name: tampaQbs.jalon.name },
  ]);
  assert.equal(qbs.some((player) => player.canonicalId === ids.dart), false,
    "the New York Giants QB is not a Tampa Bay personnel member");
  assert.equal(unresolvedView.quarterback.conflict, true);
  assert.equal(unresolvedView.quarterback.resolved, false);
  assert.equal(unresolvedView.quarterback.player, null);
  assert.equal(unresolvedView.quarterback.chartStarter, tampaQbs.baker.id);
  assert.equal(unresolvedView.quarterback.liveStarter, null);
  assert.match(unresolvedView.quarterback.reason, /Tampa Bay Buccaneers.*unresolved/i);
  const unresolved = run(unresolvedInput);
  assert.equal(unresolved.away.players.some((player) => player.position === "QB"), false);
  assert.ok(unresolved.away.players.length > 0);
  numericOutputs(unresolved.away);

  const quoteAt = "2026-10-16T10:00:00Z";
  const kickoff = "2026-10-18T17:00:00Z";
  const oddsEvent = {
    id: "frozen-tampa-qb-markets", away_team: "Tampa Bay Buccaneers",
    home_team: "Kansas City Chiefs", commence_time: kickoff,
    bookmakers: [{
      key: "draftkings", title: "DraftKings", last_update: quoteAt,
      markets: qbs.map((player) => ({
        key: "player_pass_yds", last_update: quoteAt,
        outcomes: [
          { name: "Over", playerName: player.name, point: 150.5, price: -110 },
          { name: "Under", playerName: player.name, point: 150.5, price: -110 },
        ],
      })),
    }],
  };
  const bets = buildBestBets({
    game: { away: "TB", home: "KC", season: 2026, week: 6 },
    prediction: { ...prediction, away: { ...prediction.away, code: "TB" } },
    playerProjections: unresolved, personnelViews: unresolvedInput.personnelViews,
    oddsEvent, quoteAsOf: new Date("2026-10-16T11:00:00Z"),
    dataQuality: { personnel: true, playByPlay: true, teamForm: true },
  });
  assert.ok(bets.candidates.every((candidate) =>
    !qbs.some((qbPlayer) => candidate.personnelId === qbPlayer.canonicalId)));
  const scorerSnapshots = qbs.map((qbPlayer) => ({
    modelVersion: CURRENT_MODEL_VERSION, modelKey: CURRENT_MODEL_KEY,
    season: 2026, week: 6, awayCode: "TB", homeCode: "KC", kickoff,
    personnelViews: unresolvedInput.personnelViews,
    bestBets: { anytimeTdScorer: {
      source: "model-only", playerId: qbPlayer.canonicalId, personnelId: qbPlayer.canonicalId,
      playerTeam: "TB", position: "QB", tdProbability: 0.8, roleConfidence: 0.8,
      selection: `${qbPlayer.name} anytime TD`,
    } },
  }));
  const weekly = buildWeeklyMultiSelection(
    scorerSnapshots, { cacheStatus: "fresh", events: [oddsEvent] },
    { season: 2026, week: 6, lockAt: "2026-10-16T20:00:00Z" },
    new Date("2026-10-16T11:00:00Z"),
  );
  assert.ok(weekly.legs.every((candidate) =>
    !qbs.some((qbPlayer) => candidate.personnelId === qbPlayer.canonicalId)));
  assert.equal(weekly.reasonCounts.personnelExcluded, qbs.length);

  const resolvedInput = tampaConflictFixture(tampaQbs.jalon.id);
  const resolvedView = resolvedInput.personnelViews.away;
  assert.equal(resolvedView.quarterback.conflict, true);
  assert.equal(resolvedView.quarterback.resolved, true);
  assert.equal(resolvedView.quarterback.chartStarter, tampaQbs.baker.id);
  assert.equal(resolvedView.quarterback.liveStarter, tampaQbs.jalon.id);
  assert.equal(resolvedView.quarterback.player.canonicalId, tampaQbs.jalon.id);
  assert.match(resolvedView.quarterback.reason, /Tampa Bay Buccaneers: point-in-time evidence resolves the QB conflict; Jalon Daniels replaces Baker Mayfield/);
  assert.equal(resolvedView.live.available, true);
  assert.equal(resolvedView.players.find((player) => player.canonicalId === tampaQbs.jalon.id).liveStarter, true);
  assert.ok(Date.parse(resolvedView.live.observedAt) <= Date.parse(resolvedInput.cutoff));
  const resolved = run(resolvedInput);
  const projectedQbs = resolved.away.players.filter((player) => player.position === "QB");
  assert.deepEqual(projectedQbs.map((player) => player.personnelId), [tampaQbs.jalon.id]);
  const assertTampaQbSupport = (candidateId, fixtureTeam) => {
    const record = resolvedView.players.find((player) => player.canonicalId === candidateId);
    const profile = resolvedInput.playerMetrics.away.players[candidateId];
    assert.equal(fixtureTeam, resolvedInput.away);
    assert.equal(canonicalTeam(fixtureTeam), "TB");
    assert.equal(canonicalTeam(record?.team), "TB");
    assert.equal(record?.eligibleBeforeCutoff, true);
    assert.equal(record?.identityConflict, false);
    assert.equal(record?.sourceConflict, false);
    assert.ok(record?.provenance?.live?.playerId);
    assert.equal(canonicalTeam(profile?.team), "TB");
    assert.equal(profile?.gsisId, candidateId);
    assert.ok(profile?.passing?.attempts > 0 && profile?.games > 0);
    return profile;
  };
  const jalonProfile = assertTampaQbSupport(tampaQbs.jalon.id, projectedQbs[0].team);
  assert.equal(projectedQbs[0].profile.passing.yardsPerAttempt, jalonProfile.passing.yardsPerAttempt);
  assert.equal(resolved.away.players.some((player) => player.gsisId === ids.dart), false);
  const resolvedBets = buildBestBets({
    game: { away: "TB", home: "KC", season: 2026, week: 6 },
    prediction: { ...prediction, away: { ...prediction.away, code: "TB" } },
    playerProjections: resolved, personnelViews: resolvedInput.personnelViews,
    oddsEvent, quoteAsOf: new Date("2026-10-16T11:00:00Z"),
    dataQuality: { personnel: true, playByPlay: true, teamForm: true }, audit: true,
  });
  assert.equal(resolvedBets.candidates.some((candidate) => candidate.personnelId === ids.dart), false);
  const resolvedQbBets = resolvedBets.candidates.filter((candidate) =>
    [tampaQbs.baker.id, tampaQbs.jalon.id].includes(candidate.personnelId));
  for (const candidate of resolvedQbBets) {
    const profile = assertTampaQbSupport(candidate.personnelId, candidate.playerTeam);
    assert.equal(profile.passing.attempts > 0, true);
  }
  assert.ok(resolvedQbBets.every((candidate) =>
    candidate.edge >= 0.045 && candidate.expectedValue >= 0.03));
  const resolvedWeekly = buildWeeklyMultiSelection(
    [{
      season: 2026, week: 6, awayCode: "TB", homeCode: "KC", kickoff,
      modelVersion: CURRENT_MODEL_VERSION, modelKey: CURRENT_MODEL_KEY,
      bestBets: resolvedBets, personnelViews: resolvedInput.personnelViews,
    }],
    { cacheStatus: "fresh", events: [oddsEvent] },
    { season: 2026, week: 6, lockAt: "2026-10-16T20:00:00Z" },
    new Date("2026-10-16T11:00:00Z"),
  );
  for (const candidate of resolvedWeekly.legs.filter((leg) =>
    [tampaQbs.baker.id, tampaQbs.jalon.id].includes(leg.personnelId))) {
    assertTampaQbSupport(candidate.personnelId, candidate.playerTeam);
  }
});
test("Houston Stroud-out case excludes every unsupported QB through projections and betting candidates", () => {
  const input = fixture();
  input.away = "HOU";
  input.home = "JAX";
  input.week = 6;
  const awayMetrics = dataset.metricsByWeek[6].HOU;
  const homeMetrics = dataset.metricsByWeek[6].JAX;
  input.cutoff = awayMetrics.expectedLineup.cutoff;
  input.teamMetrics = { away: awayMetrics, home: homeMetrics };
  input.playerMetrics = playerMetricsResponse(regenerated, {
    season: 2026, week: 6, away: "HOU", home: "JAX",
  });
  input.prediction = {
    ...prediction,
    away: { ...prediction.away, code: "HOU" },
    home: { ...prediction.home, code: "JAX" },
  };
  const qbIds = awayMetrics.expectedLineup.roster
    .filter((player) => player.group === "QB").map((player) => player.gsisId);
  const unavailableStatuses = Object.fromEntries(qbIds.map((id) => [id, "Out"]));
  const buildView = (team, lineup, statusById = {}) => {
    const players = lineup.roster.map((role) => ({
      id: `live-${role.gsisId}`, gsisId: role.gsisId, fullName: role.name, team,
      position: role.position, depthChartPosition: role.position, depthChartOrder: role.rank,
      status: "Active", injuryStatus: statusById[role.gsisId] || "Unknown",
    }));
    return buildPersonnelView({
      team, lineup, season: 2026, week: 6, cutoff: input.cutoff,
      roster: {
        team, sourceAsOf: "2026-10-15T12:00:00.000Z",
        groups: { players },
        leagueIdentityIndex: players.map((player) => ({ gsisId: player.gsisId, team: player.team })),
      },
    });
  };
  input.personnelViews = {
    away: buildView("HOU", awayMetrics.expectedLineup, unavailableStatuses),
    home: buildView("JAX", homeMetrics.expectedLineup),
  };
  const houQbs = input.personnelViews.away.players.filter((player) => player.position === "QB");
  assert.deepEqual(houQbs.map((player) => player.name), ["C.J. Stroud", "Davis Mills", "Graham Mertz"]);
  assert.ok(houQbs.every((player) => player.status === "Out" && !player.projectedAvailable));
  assert.equal(input.personnelViews.away.quarterback.player, null);
  assert.match(input.personnelViews.away.quarterback.reason, /replacement identity is unresolved/i);

  const projections = run(input);
  assert.equal(projections.away.players.some((player) => player.position === "QB"), false);
  assert.ok(Number.isFinite(projections.away.passAttempts));
  assert.ok(Number.isFinite(projections.away.passingYards));
  assert.ok(projections.away.players.some((player) => player.position === "WR"));
  assert.ok(projections.away.players.some((player) => player.position === "RB"));
  numericOutputs(projections.away);

  const kickoff = "2026-10-18T17:00:00Z";
  const quoteAt = "2026-10-16T10:00:00Z";
  const oddsEvent = {
    id: "frozen-houston-qb-markets", away_team: "Houston Texans",
    home_team: "Jacksonville Jaguars", commence_time: kickoff,
    bookmakers: [{
      key: "draftkings", title: "DraftKings", last_update: quoteAt,
      markets: houQbs.map((player) => ({
        key: "player_pass_yds", last_update: quoteAt,
        outcomes: [
          { name: "Over", playerName: player.name, point: 200.5, price: -110 },
          { name: "Under", playerName: player.name, point: 200.5, price: -110 },
        ],
      })),
    }],
  };
  const bets = buildBestBets({
    game: { away: "HOU", home: "JAX", season: 2026, week: 6 },
    prediction: input.prediction, playerProjections: projections,
    personnelViews: input.personnelViews, oddsEvent,
    quoteAsOf: new Date("2026-10-16T11:00:00Z"),
    dataQuality: { personnel: true, playByPlay: true, teamForm: true }, audit: true,
  });
  assert.ok(bets.candidates.every((candidate) => !qbIds.includes(candidate.personnelId)));
  const weekly = buildWeeklyMultiSelection(
    [{
      season: 2026, week: 6, awayCode: "HOU", homeCode: "JAX", kickoff,
      modelVersion: CURRENT_MODEL_VERSION, modelKey: CURRENT_MODEL_KEY,
      bestBets: bets, personnelViews: input.personnelViews,
    }],
    { cacheStatus: "fresh", events: [oddsEvent] },
    { season: 2026, week: 6, lockAt: "2026-10-16T20:00:00Z" },
    new Date("2026-10-16T11:00:00Z"),
  );
  assert.ok(weekly.legs.every((candidate) => !qbIds.includes(candidate.personnelId)));
});
test("all supported QB identities unavailable leaves a finite unnamed fallback and excludes QB markets", () => {
  const input = fixture();
  const lineup = input.teamMetrics.away.expectedLineup;
  const quarterbackIds = lineup.roster.filter((role) => role.group === "QB").map((role) => role.gsisId);
  assert.ok(quarterbackIds.length > 1, "fixture includes a starter and later depth QBs");
  input.personnelViews = confirmedPersonnelViews(input,
    Object.fromEntries(quarterbackIds.map((id) => [id, "Out"])));
  const view = input.personnelViews.away;
  assert.equal(view.quarterback.player, null);
  assert.match(view.quarterback.reason, /replacement identity is unresolved/i);
  assert.ok(view.players.filter((player) => player.position === "QB")
    .every((player) => player.status === "Out" && !player.projectedAvailable));

  const result = run(input);
  assert.equal(result.away.startingQuarterback, null);
  assert.equal(result.away.players.some((player) => player.position === "QB"), false);
  assert.ok(receiver(result));
  assert.ok(runner(result));
  numericOutputs(result.away);

  const kickoff = "2026-10-18T17:00:00Z";
  const quoteAt = "2026-10-16T10:00:00Z";
  const oddsEvent = {
    id: "frozen-qb-markets", away_team: "New York Giants", home_team: "Kansas City Chiefs",
    commence_time: kickoff,
    bookmakers: [{
      key: "draftkings", title: "DraftKings", last_update: quoteAt,
      markets: quarterbackIds.map((id) => {
        const role = lineup.roster.find((player) => player.gsisId === id);
        return {
          key: "player_pass_yds", last_update: quoteAt,
          outcomes: [
            { name: "Over", playerName: role.name, point: 150.5, price: 100 },
            { name: "Under", playerName: role.name, point: 150.5, price: 100 },
          ],
        };
      }),
    }],
  };
  const bets = buildBestBets({
    game: { away: "NYG", home: "KC", season: 2026, week: 6 },
    prediction, playerProjections: result, personnelViews: input.personnelViews,
    oddsEvent, quoteAsOf: new Date("2026-10-16T11:00:00Z"),
    dataQuality: { personnel: true, playByPlay: true, teamForm: true },
  });
  assert.equal(bets.candidates.some((candidate) => candidate.position === "QB"), false);
  assert.ok(bets.candidates.every((candidate) =>
    !quarterbackIds.some((id) => candidate.personnelId === id || candidate.playerId === id)));
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
test("unavailable WR1 is removed and supported WR2 receives only capped target opportunity", () => {
  const input = fixture();
  addSyntheticSkillProfiles(input, [{ id: "NYG-wr2", position: "WR", rank: 2, templateId: ids.wr }]);
  input.personnelViews = confirmedPersonnelViews(input, { [ids.wr]: "Out" });
  const result = run(input);
  assert.equal(result.away.players.some((player) => player.playerId === ids.wr), false);
  const replacement = result.away.players.find((player) => player.playerId === "NYG-wr2");
  assert.ok(replacement && replacement.targets > 0);
  assert.ok(replacement.targets < result.away.passAttempts);
  assert.ok(result.away.players.reduce((sum, player) => sum + (player.targets || 0), 0) <= result.away.passAttempts + 0.1);
});
test("QB, WR1, RB1 and TE1 removals conserve supported opportunity without exceeding share caps", () => {
  const input = fixture();
  addSyntheticSkillProfiles(input, [
    { id: "NYG-wr2", position: "WR", rank: 2, templateId: ids.wr },
    { id: "NYG-wr3", position: "WR", rank: 3, templateId: ids.wr },
    { id: "NYG-rb2", position: "RB", rank: 2, templateId: "NYG-rb" },
    { id: "NYG-te2", position: "TE", rank: 2, templateId: "NYG-te" },
  ]);
  delete input.playerMetrics.away.players["NYG-wr3"];
  const active = confirmedPersonnelViews(input);
  const baseline = run({ ...input, personnelViews: active });
  const qbIds = input.teamMetrics.away.expectedLineup.roster
    .filter((role) => role.group === "QB").map((role) => role.gsisId);
  const scenarios = [
    { name: "QB", statuses: Object.fromEntries(qbIds.map((id) => [id, "Out"])) },
    { name: "WR1", statuses: { [ids.wr]: "Out" } },
    { name: "RB1", statuses: { "NYG-rb": "Out" } },
    { name: "TE1", statuses: { "NYG-te": "Out" } },
  ];
  const summary = (team) => {
    const targets = team.players.reduce((sum, player) => sum + (player.targets || 0), 0);
    const carries = team.players.reduce((sum, player) => sum + (player.rushingAttempts || 0), 0);
    return {
      passAttempts: team.passAttempts, targets, targetShare: targets / team.passAttempts,
      rushAttempts: team.rushAttempts, carries, carryShare: carries / team.rushAttempts,
      unallocatedTargets: team.unallocatedTargets, unallocatedCarries: team.unallocatedCarries,
    };
  };
  const baseTotals = summary(baseline.away);
  for (const scenario of scenarios) {
    const scenarioInput = structuredClone(input);
    scenarioInput.personnelViews = confirmedPersonnelViews(scenarioInput, scenario.statuses);
    const result = run(scenarioInput);
    const totals = summary(result.away);
    assert.ok(totals.passAttempts > 0 && totals.rushAttempts > 0, scenario.name);
    assert.ok(totals.targetShare >= 0 && totals.targetShare <= 1 + 0.1 / totals.passAttempts,
      `${scenario.name} target share exceeds only the one-decimal rounding bound: ${JSON.stringify(totals)}`);
    assert.ok(totals.carryShare >= 0 && totals.carryShare <= 1 + 0.1 / totals.rushAttempts,
      `${scenario.name} carry share exceeds only the one-decimal rounding bound: ${JSON.stringify(totals)}`);
    assert.ok(totals.unallocatedTargets >= 0 && totals.unallocatedCarries >= 0, scenario.name);
    numericOutputs(result.away);
    for (const player of result.away.players) {
      assert.ok((player.targets || 0) >= 0, scenario.name);
      assert.ok((player.rushingAttempts || 0) >= 0, scenario.name);
      assert.ok((player.targets || 0) / totals.passAttempts <= 0.6 + 0.0001, `${scenario.name} target cap`);
      assert.ok((player.rushingAttempts || 0) / totals.rushAttempts <= 0.8 + 0.1 / totals.rushAttempts,
        `${scenario.name} carry cap ${player.playerId} ${JSON.stringify(totals)} ${player.rushingAttempts}`);
    }
    const unavailable = Object.entries(scenario.statuses)
      .filter(([, status]) => status === "Out").map(([id]) => id);
    assert.equal(result.away.players.some((player) => unavailable.includes(player.personnelId)), false,
      `${scenario.name} unavailable players cannot retain usage`);
    assert.equal(result.away.players.some((player) => player.playerId === "NYG-wr3"), false,
      "unsupported replacement profile receives no allocation");
    assert.ok(Math.abs(totals.targets + totals.unallocatedTargets - totals.passAttempts) <= 0.11,
      `${scenario.name} target rounding bound`);
    assert.ok(Math.abs(totals.carries + totals.unallocatedCarries - totals.rushAttempts) <= 0.11,
      `${scenario.name} carry rounding bound`);
    assert.ok(Math.abs(totals.passAttempts - baseTotals.passAttempts) <= 0.11,
      `${scenario.name} team pass-volume delta is separately bounded`);
    assert.ok(Math.abs(totals.rushAttempts - baseTotals.rushAttempts) <= 0.11,
      `${scenario.name} team carry-volume delta is separately bounded`);
  }
});
test("Questionable status adjusts opportunity and role confidence while retaining supported prop eligibility", () => {
  const activeInput = fixture();
  activeInput.personnelViews = confirmedPersonnelViews(activeInput, { [ids.wr]: "Active" });
  const questionableInput = structuredClone(activeInput);
  questionableInput.personnelViews = confirmedPersonnelViews(questionableInput, { [ids.wr]: "Questionable" });
  const active = run(activeInput).away.players.find((player) => player.playerId === ids.wr);
  const questionable = run(questionableInput).away.players.find((player) => player.playerId === ids.wr);

  assert.ok(active && questionable);
  assert.equal(questionable.personnel.status, "Questionable");
  assert.equal(questionable.personnel.eligible, true);
  assert.ok(questionable.targets < active.targets);
  assert.ok(questionable.roleConfidence < active.roleConfidence);
});
test("unavailable RB1 is removed and supported RB2 receives only capped carry opportunity", () => {
  const input = fixture();
  addSyntheticSkillProfiles(input, [{ id: "NYG-rb2", position: "RB", rank: 2, templateId: "NYG-rb" }]);
  input.personnelViews = confirmedPersonnelViews(input, { "NYG-rb": "Out" });
  const result = run(input);
  assert.equal(result.away.players.some((player) => player.playerId === "NYG-rb"), false);
  const replacement = result.away.players.find((player) => player.playerId === "NYG-rb2");
  assert.ok(replacement && replacement.rushingAttempts > 0);
  assert.ok(replacement.rushingAttempts < result.away.rushAttempts);
  assert.ok(result.away.unallocatedCarries > 0);
});
test("unavailable TE1 is removed and a supported TE2 remains eligible", () => {
  const input = fixture();
  addSyntheticSkillProfiles(input, [{ id: "NYG-te2", position: "TE", rank: 2, templateId: "NYG-te" }]);
  input.personnelViews = confirmedPersonnelViews(input, { "NYG-te": "Out" });
  const result = run(input);
  assert.equal(result.away.players.some((player) => player.playerId === "NYG-te"), false);
  assert.ok(result.away.players.some((player) => player.playerId === "NYG-te2" && player.targets > 0));
});
test("multiple unavailable receivers are removed and redistribution stays capped", () => {
  const input = fixture();
  addSyntheticSkillProfiles(input, [
    { id: "NYG-wr2", position: "WR", rank: 2, templateId: ids.wr },
    { id: "NYG-wr3", position: "WR", rank: 3, templateId: ids.wr },
  ]);
  input.personnelViews = confirmedPersonnelViews(input, {
    [ids.wr]: "Out",
    "NYG-wr2": "Out",
  });
  const result = run(input);
  assert.equal(result.away.players.some((player) => [ids.wr, "NYG-wr2"].includes(player.playerId)), false);
  const replacement = result.away.players.find((player) => player.playerId === "NYG-wr3");
  assert.ok(replacement && replacement.targets > 0);
  assert.ok(replacement.targets < result.away.passAttempts);
  assert.ok(result.away.players.reduce((sum, player) => sum + (player.targets || 0), 0) <= result.away.passAttempts + 0.1);
});
test("replacement identity without its own supported profile produces no fabricated projection", () => {
  const input = fixture();
  addSyntheticSkillProfiles(input, [{ id: "NYG-wr2", position: "WR", rank: 2, templateId: ids.wr }]);
  delete input.playerMetrics.away.players["NYG-wr2"];
  input.personnelViews = confirmedPersonnelViews(input, { [ids.wr]: "Out" });
  const result = run(input);
  assert.equal(result.away.players.some((player) => player.playerId === "NYG-wr2"), false);
  assert.ok(result.away.reasons.some((reason) => reason.includes("historical players excluded")));
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
  const input = fixture();
  input.personnelViews = confirmedPersonnelViews(input);
  const result = run(input);
  for (const player of result.away.players) {
    const expected = 1 - Math.exp(-(player.rushingTouchdowns + player.receivingTouchdowns));
    assert.ok(Math.abs(player.anytimeTouchdownProbability - expected) < .00011);
  }
  const bets = buildBestBets({ game: { away: "NYG", home: "KC" }, prediction, playerProjections: result,
    personnelViews: input.personnelViews,
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
test("regenerated schema-2 Week 6 artifact is accepted; legacy provenance is still rejected", async () => {
  const response = { status(code) { this.code = code; return this; }, setHeader() {}, json(value) { this.body = value; return this; } };
  await handler({ method: "GET", query: { action: "player-metrics", season: 2026, week: 6, away: "NYG", home: "KC" } }, response);
  assert.equal(response.code, 200);
  assert.equal(response.body.available, true);
  assert.equal(response.body.schemaVersion, 2);
  assert.equal(response.body.metricsWeek, 6);
  assert.equal(validatePlayerMetrics(response.body, { season: 2026, week: 6, cutoff: regenerated.cutoffs[6] }), null);
  assert.deepEqual(response.body.away, regenerated.playerMetricsByWeek[6].NYG);
  assert.deepEqual(response.body.home, regenerated.playerMetricsByWeek[6].KC);
  const legacy = {
    ...regenerated,
    schemaVersion: 1,
    sourceAsOf: undefined,
    generatedAt: "2026-09-29T03:47:09.511Z",
  };
  const rejected = playerMetricsResponse(legacy, { season: 2026, week: 6, away: "NYG", home: "KC" });
  assert.equal(rejected.available, false);
  assert.match(rejected.reason, /Legacy/);
  assert.equal(rejected.away, null);
  assert.equal(rejected.home, null);
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
    assert.equal(result.bestBets.anytimeTdScorer.source, "unavailable");
    numericOutputs(result.playerProjections);
    input.teamMetrics.away.expectedLineup.available = false;
    input.teamMetrics.away.expectedLineup.issues = ["Conflicting depth slot"];
    const ambiguous = await getFullGamePrediction({ away: "NYG", home: "KC", week: 2,
      sourceDate: "2026-09-20T17:00:00Z", weather: { dome: true } }, null, { season: 2026, forceRefresh: true });
    assert.equal(qb(ambiguous.playerProjections), undefined);
    assert.ok(receiver(ambiguous.playerProjections));
  } finally { global.fetch = original; clearFullGamePredictionCache(); }
});
