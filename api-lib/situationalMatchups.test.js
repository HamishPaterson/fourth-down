import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import dataset from "../api/nfl/nflverse-team-metrics.js";
import { buildWeeklySituationalMetrics, auditSituationalFields } from "./situationalMetrics.js";
import { buildSituationalMatchups, explainSituationalSignal, situationalFootballExplanation } from "../src/services/situationalMatchups.js";
import { predictMatchup, createModelLayers } from "../src/services/predictionEngine.js";
import { compareTeams } from "../api/nfl/play-by-play.js";

const cutoff = "2026-10-16T00:15:00.000Z", sourceAsOf = "2026-10-14T22:00:00.000Z";
const provenance = { gameId: "2026_01_BUF_KC", week: 1, away: "BUF", home: "KC",
  kickoff: "2026-09-13T17:00:00.000Z", completedAsOf: "2026-09-14T01:00:00.000Z" };
const schedule = [{ id: 1, season: 2026, week: 1, season_type: "REG", completed: true,
  date: provenance.kickoff, completed_at: provenance.completedAsOf,
  visitor_team: { abbreviation: "BUF" }, home_team: { abbreviation: "KC" } }];
const context = { season: 2026, predictionWeek: 6, cutoff, sourceAsOf };
const row = (overrides = {}) => ({ season: "2026", season_type: "REG", week: "1",
  game_id: "2026_01_BUF_KC", play_id: "1", posteam: "BUF", defteam: "KC", play_type: "run",
  down: "3", ydstogo: "2", third_down_converted: "1", third_down_failed: "0",
  fixed_drive: "1", fixed_drive_result: "Punt", yardline_100: "50", touchdown: "0",
  td_team: "", penalty: "0", ...overrides });
const extract = (rows, games = schedule, ctx = context) => buildWeeklySituationalMetrics(rows, games, ctx);
const rate = (conversions, opportunities) => ({ conversions, opportunities, rate: conversions / opportunities });
function metrics(team) {
  return { team, schemaVersion: 1, season: 2026, predictionWeek: 6, cutoff, sourceAsOf,
    gameProvenance: [structuredClone(provenance)],
    thirdDown: { offense: rate(40, 100), defense: rate(40, 100) },
    redZone: { offense: rate(24, 40), defense: rate(24, 40) },
    league: { cutoff, sourceAsOf, latestCompletion: provenance.completedAsOf, maxWeek: 1,
      thirdDown: rate(400, 1000), redZone: rate(240, 400) } };
}
function fixture() {
  return { away: "BUF", home: "KC", season: 2026, week: 6, kickoff: "2026-10-18T20:25:00Z",
    teamMetrics: { season: 2026, week: 6,
      away: { ...dataset.metricsByWeek[6].BUF, situational: metrics("BUF") },
      home: { ...dataset.metricsByWeek[6].KC, situational: metrics("KC") } } };
}
const signal = (input, key) => buildSituationalMatchups(input).signals.find((entry) => entry.key === key);
const predict = (input, layers = {}) => predictMatchup(input.away, input.home, { ...input, weather: { dome: true },
  modelLayers: { ...compareTeams(input.teamMetrics.away, input.teamMetrics.home, input.week), ...layers } });
const close = (a, b, tolerance = .00001) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
function finite(value) {
  if (typeof value === "number") assert.ok(Number.isFinite(value));
  else if (value && typeof value === "object") Object.values(value).forEach(finite);
}

test("field audit reports missing values instead of treating field existence as coverage", () => {
  const audit = auditSituationalFields([row(), row({ ydstogo: "" })]);
  assert.equal(audit.ydstogo.nonNull, 1);
  assert.equal(audit.game_status.present, false);
  assert.equal(audit.no_play.nonNull, 0);
});
test("third down counts matched offense/defense once and keeps explicit distance buckets diagnostic only", () => {
  const result = extract([row(), row(), row({ play_id: "2", ydstogo: "5", third_down_converted: "0", third_down_failed: "1" }),
    row({ play_id: "3", ydstogo: "9" })]);
  assert.deepEqual(result.teams.BUF.thirdDown.offense, result.teams.KC.thirdDown.defense);
  const value = result.teams.BUF.thirdDown.offense;
  assert.equal(value.opportunities, 3);
  assert.equal(value.conversions, 2);
  assert.equal(value.buckets.short.opportunities, 1);
  assert.equal(value.buckets.medium.opportunities, 1);
  assert.equal(value.buckets.long.opportunities, 1);
  assert.equal(result.audit.excluded.duplicatePlays, 1);
});
test("third down rejects null/ambiguous outcomes, no-plays, kneels, spikes, invalid teams and other downs", () => {
  const extras = [
    { third_down_converted: "", third_down_failed: "" },
    { third_down_converted: "1", third_down_failed: "1" },
    { play_type: "no_play", penalty: "1" }, { play_type: "qb_kneel" }, { play_type: "qb_spike" },
    { no_play: "1" }, { qb_kneel: "1" }, { qb_spike: "1" }, { posteam: "ZZZ" }, { down: "4" },
  ];
  const result = extract([row(), ...extras.map((extra, index) => row({ play_id: String(index + 2), ...extra }))]);
  assert.equal(result.teams.BUF.thirdDown.offense.opportunities, 1);
  assert.equal(result.audit.excluded.unresolvedThirdDowns, 2);
});
test("penalized nullified plays do not count; resolved non-nullified opportunities can count", () => {
  const result = extract([row({ penalty: "1" }), row({ play_id: "2", play_type: "no_play", penalty: "1" })]);
  assert.equal(result.teams.BUF.thirdDown.offense.opportunities, 1);
});
test("both metrics exclude future, uncompleted, late-observed and postseason games", () => {
  const rows = [row({ yardline_100: "10", fixed_drive_result: "Touchdown", touchdown: "1", td_team: "BUF" })];
  for (const override of [
    { date: "2026-10-17T17:00:00Z" }, { completed: false, status: "in progress" },
    { completed_at: "2026-10-17T01:00:00Z" }, { completed_at: cutoff },
    { completed_at: "2026-10-15T01:00:00Z" },
    { postseason: true }, { season_type: "POST" }, { week: 6 },
  ]) {
    const result = extract(rows, [{ ...schedule[0], ...override }]);
    assert.equal(result.teams.BUF.thirdDown.offense.opportunities, 0);
    assert.equal(result.teams.BUF.redZone.offense.opportunities, 0);
  }
  assert.equal(extract(rows, schedule, { ...context, predictionWeek: 1 }).audit.eligiblePlays, 0);
});
test("duplicate schedule games and plays do not multiply either metric; conflicting plays fail", () => {
  const rows = [row({ yardline_100: "10", fixed_drive_result: "Touchdown", touchdown: "1", td_team: "BUF" })];
  const result = extract([...rows, ...rows], [...schedule, ...schedule]);
  assert.equal(result.teams.BUF.thirdDown.offense.opportunities, 1);
  assert.equal(result.teams.BUF.redZone.offense.opportunities, 1);
  assert.throws(() => extract([...rows, { ...rows[0], touchdown: "0" }]), /Conflicting situational play/);
});
test("mismatched game identity and missing required fields cannot fabricate metrics", () => {
  assert.equal(extract([row({ game_id: "2026_02_BUF_KC" })]).audit.excluded.mismatchedGames, 1);
  const value = row(); delete value.fixed_drive_result;
  assert.throws(() => extract([value]), /missing fixed_drive_result/);
});
test("red-zone trips group complete drives once, even after leaving the red zone", () => {
  const result = extract([
    row({ yardline_100: "10", down: "1", fixed_drive_result: "Touchdown" }),
    row({ play_id: "2", yardline_100: "25", touchdown: "1", td_team: "BUF", fixed_drive_result: "Touchdown" }),
    row({ play_id: "3", fixed_drive: "2", yardline_100: "18", fixed_drive_result: "Field goal" }),
  ]);
  assert.deepEqual(result.teams.BUF.redZone.offense, rate(1, 2));
  assert.deepEqual(result.teams.KC.redZone.defense, rate(1, 2));
});
test("incomplete/filtered drives, defensive touchdowns and missing IDs do not fabricate offensive touchdowns", () => {
  const result = extract([
    row({ yardline_100: "10", fixed_drive_result: "" }),
    row({ play_id: "2", fixed_drive: "2", yardline_100: "10", fixed_drive_result: "Touchdown" }),
    row({ play_id: "3", fixed_drive: "3", yardline_100: "10", fixed_drive_result: "Opp touchdown", touchdown: "1", td_team: "KC" }),
    row({ play_id: "4", fixed_drive: "", yardline_100: "10", fixed_drive_result: "Touchdown", touchdown: "1", td_team: "BUF" }),
  ]);
  assert.deepEqual(result.teams.BUF.redZone.offense, rate(0, 1));
  assert.equal(result.audit.excluded.unresolvedRedZoneDrives, 2);
});
test("red-zone no-plays/kneels/spikes cannot create an entry and long touchdowns do not create trips", () => {
  const result = extract(["no_play", "qb_kneel", "qb_spike", "pass"].map((play_type, i) =>
    row({ play_id: String(i + 1), fixed_drive: String(i + 1), play_type,
      yardline_100: play_type === "pass" ? "30" : "10", touchdown: "1", td_team: "BUF", fixed_drive_result: "Touchdown" })));
  assert.equal(result.teams.BUF.redZone.offense.opportunities, 0);
});
test("conflicting terminal results quarantine the entire red-zone trip", () => {
  const result = extract([
    row({ yardline_100: "10", fixed_drive_result: "Touchdown", touchdown: "1", td_team: "BUF" }),
    row({ play_id: "2", yardline_100: "5", fixed_drive_result: "Punt" }),
  ]);
  assert.equal(result.teams.BUF.redZone.offense.opportunities, 0);
  assert.equal(result.audit.excluded.unresolvedRedZoneDrives, 1);
});
test("a known field-goal-only possession inside the red zone is a completed non-TD trip", () => {
  const result = extract([row({ play_type: "field_goal", down: "4", yardline_100: "19",
    fixed_drive_result: "Field goal", third_down_converted: "0" })]);
  assert.deepEqual(result.teams.BUF.redZone.offense, rate(0, 1));
  assert.equal(result.teams.BUF.thirdDown.offense.opportunities, 0);
});

for (const [key, opportunities, baseline] of [["thirdDown", 100, 40], ["redZone", 40, 24]]) {
  test(`${key}: attack and defensive allowance have correct cross-team directions`, () => {
    const input = fixture();
    close(signal(input, key).homePoints, 0);
    input.teamMetrics.home.situational[key].offense = rate(baseline + 10, opportunities);
    const improved = signal(input, key).homePoints;
    assert.ok(improved > 0);
    input.teamMetrics.away.situational[key].defense = rate(baseline + 10, opportunities);
    assert.ok(signal(input, key).homePoints > improved);
    input.teamMetrics.away.situational[key].defense = rate(baseline - 10, opportunities);
    assert.ok(signal(input, key).homePoints < improved);
    input.teamMetrics.home.situational[key].defense = rate(baseline - 10, opportunities);
    assert.ok(signal(input, key).homePoints > 0);
  });
  test(`${key}: tiny samples regress strongly; larger samples have greater confidence`, () => {
    const input = fixture();
    for (const side of ["away", "home"]) for (const direction of ["offense", "defense"]) {
      input.teamMetrics[side].situational[key][direction] = rate(1, 1);
    }
    const tiny = signal(input, key).matchups.home;
    assert.ok(Math.abs(tiny.regressedOffense - tiny.leagueAverage) < .04);
    assert.ok(tiny.confidence < .06);
    for (const side of ["away", "home"]) for (const direction of ["offense", "defense"]) {
      input.teamMetrics[side].situational[key][direction] = rate(100, 100);
    }
    assert.ok(signal(input, key).confidence > tiny.confidence);
    assert.ok(signal(input, key).matchups.home.regressedOffense > tiny.regressedOffense);
  });
  test(`${key}: swapping teams reverses the pre-simulation effect`, () => {
    const input = fixture();
    input.teamMetrics.home.situational[key].offense = rate(opportunities, opportunities);
    const first = signal(input, key).homePoints;
    const swapped = { ...input, away: input.home, home: input.away,
      teamMetrics: { ...input.teamMetrics, away: input.teamMetrics.home, home: input.teamMetrics.away } };
    close(signal(swapped, key).homePoints, -first);
  });
  test(`${key}: final-margin ablation equals removal of exactly this layer`, () => {
    const input = fixture();
    input.teamMetrics.home.situational[key].offense = rate(opportunities, opportunities);
    const result = predict(input), output = result.matchupIntelligence.situational.signals.find((s) => s.key === key);
    const without = predictMatchup(input.away, input.home, { ...input, teamMetrics: undefined, weather: { dome: true },
      modelLayers: { ...result.modelLayers, [output.layer]: { homePoints: 0, awayPoints: 0 } } });
    close(output.modelMarginContribution, result.continuousMargin - without.continuousMargin, .00011);
    assert.ok(output.modelMarginContribution > 0);
  });
  test(`${key}: stronger home defense and weaker away defense help home in the actual simulation`, () => {
    const input = fixture(), before = predict(input);
    input.teamMetrics.home.situational[key].defense = rate(0, 100);
    input.teamMetrics.away.situational[key].defense = rate(100, 100);
    const after = predict(input);
    assert.ok(after.continuousMargin > before.continuousMargin);
    const output = after.matchupIntelligence.situational.signals.find((s) => s.key === key);
    assert.ok(output.modelMarginContribution > 0);
  });
}
test("model rejects future provenance, duplicate games, source-after-cutoff and invalid counts", () => {
  const mutations = [
    (s) => { s.gameProvenance[0].completedAsOf = "2026-10-17T00:00:00Z"; },
    (s) => { s.gameProvenance.push(s.gameProvenance[0]); },
    (s) => { s.sourceAsOf = "2026-10-17T00:00:00Z"; },
    (s) => { s.league.maxWeek = 6; },
    (s) => { s.thirdDown.offense.opportunities = 0; },
    (s) => { s.redZone.defense.rate = Infinity; },
    (s) => { s.gameProvenance[0].week = 6; },
    (s) => { s.team = "BUF"; },
  ];
  for (const mutate of mutations) {
    const input = fixture(); mutate(input.teamMetrics.home.situational);
    const result = buildSituationalMatchups(input);
    assert.equal(result.available, false);
    assert.ok(result.signals.every((s) => s.homePoints === 0 && s.reason));
  }
});
test("prediction kickoff, depth cutoff and team source observations must agree", () => {
  const early = fixture(); early.kickoff = "2026-10-15T00:00:00Z";
  assert.equal(buildSituationalMatchups(early).available, false);
  const depth = fixture();
  depth.teamMetrics.home.expectedLineup = { ...depth.teamMetrics.home.expectedLineup, cutoff: "2026-10-17T00:00:00Z" };
  assert.equal(buildSituationalMatchups(depth).available, false);
  const different = fixture();
  different.teamMetrics.home.situational.sourceAsOf = "2026-10-14T23:00:00Z";
  different.teamMetrics.home.situational.league.sourceAsOf = "2026-10-14T23:00:00Z";
  assert.equal(buildSituationalMatchups(different).available, false);
});
test("insufficient eligible league samples cannot invent a league average", () => {
  const input = fixture();
  for (const side of ["away", "home"]) input.teamMetrics[side].situational.league.redZone = rate(2, 3);
  const result = buildSituationalMatchups(input);
  assert.equal(result.available, false);
  assert.ok(result.signals.every((s) => !s.available && s.homePoints === 0));
});
test("legacy artifact stays neutral with explicit reasons, no invented counts and unchanged projections", () => {
  const input = fixture();
  delete input.teamMetrics.away.situational;
  delete input.teamMetrics.home.situational;
  const result = predict(input);
  assert.equal(result.matchupIntelligence.situational.available, false);
  assert.equal(result.matchupIntelligence.situational.finalMarginAblation, 0);
  assert.ok(result.matchupIntelligence.situational.signals.every((s) => !s.explanationSafe && s.matchups === null));
});
test("Phase 1 signals, legacy situational layer, pressure and Opponent-Network remain unchanged", () => {
  const input = fixture();
  input.teamMetrics.home.situational.thirdDown.offense = rate(95, 100);
  input.teamMetrics.home.situational.redZone.offense = rate(38, 40);
  const network = { opponentNetwork: { active: true, available: true, homePoints: .25, awayPoints: -.25, confidence: .7 } };
  const withPhase2 = predict(input, network);
  delete input.teamMetrics.away.situational; delete input.teamMetrics.home.situational;
  const phase1 = predict(input, network);
  assert.deepEqual(withPhase2.matchupIntelligence.signals.filter((s) => s.phase !== "2A"), phase1.matchupIntelligence.signals);
  for (const layer of ["opponentNetwork", "pressureMatchup", "situationalEfficiency"]) {
    assert.deepEqual(withPhase2.modelLayers[layer], phase1.modelLayers[layer]);
  }
  assert.equal(withPhase2.confidenceScore, phase1.confidenceScore);
  assert.deepEqual(withPhase2.confidenceReasons.slice(0, 2), phase1.confidenceReasons.slice(0, 2));
  finite(withPhase2);
});
test("individual and shared situational budgets survive normalization and opposing/correlated extremes", () => {
  for (const opposing of [false, true]) {
    const input = fixture();
    for (const key of ["thirdDown", "redZone"]) {
      const reverse = key === "redZone" && opposing;
      for (const [side, direction, high] of [["home", "offense", !reverse], ["away", "defense", !reverse],
        ["away", "offense", reverse], ["home", "defense", reverse]]) {
        input.teamMetrics[side].situational[key][direction] = rate(high ? 10000 : 0, 10000);
      }
    }
    const built = buildSituationalMatchups(input), layers = createModelLayers(built.layers);
    assert.ok(built.signals.every((s) => s.correlationScale < 1));
    const margin = built.signals.reduce((sum, s) => sum + Math.abs(layers[s.layer].homePoints * 2), 0);
    assert.ok(margin <= .4);
    assert.ok(built.signals.every((s) => Math.abs(s.homePoints * 2) <= .25));
    assert.ok(margin < built.signals.reduce((sum, s) => sum + Math.abs(s.unbudgetedHomePoints * 2), 0));
  }
});
test("distance bucket changes cannot change Phase 2A model points", () => {
  const input = fixture(), before = buildSituationalMatchups(input).layers;
  input.teamMetrics.home.situational.thirdDown.offense.buckets = { short: rate(1000, 1000) };
  assert.deepEqual(buildSituationalMatchups(input).layers, before);
});

let server, Panel;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom" });
  Panel = (await server.ssrLoadModule("/src/components/MatchupIntelligencePanel.jsx")).default;
});
after(async () => { await server?.close(); });
const render = (value) => renderToStaticMarkup(createElement(Panel, { prediction: value }));
function displayFixture() {
  const input = fixture();
  for (const key of ["thirdDown", "redZone"]) {
    input.teamMetrics.home.situational[key].offense = rate(90, 100);
    input.teamMetrics.away.situational[key].defense = rate(90, 100);
    input.teamMetrics.away.situational[key].offense = rate(10, 100);
    input.teamMetrics.home.situational[key].defense = rate(10, 100);
  }
  return predict(input);
}
test("material Phase 2A cards use actual names and football language, not raw model diagnostics", () => {
  const result = displayFixture();
  const output = render(result);
  assert.match(output, /THIRD-DOWN ADVANTAGE/);
  assert.match(output, /RED-ZONE ADVANTAGE/);
  assert.match(output, /Kansas City Chiefs.*Buffalo Bills/);
  assert.doesNotMatch(output, /the opponent|the opposing team|the offense|the defense|ablation|regression|coefficient|pre-simulation|logistic|NaN|Infinity/i);
  for (const signal of result.matchupIntelligence.situational.signals) {
    assert.equal(signal.advantagedTeam, "KC");
    assert.ok(signal.explanationSafe);
    assert.match(situationalFootballExplanation(signal), /Kansas City Chiefs.*Buffalo Bills/);
  }
});
test("sub-0.05, low-confidence and wrong-direction effects remain diagnostic only", () => {
  const result = displayFixture(), original = result.matchupIntelligence.situational.signals[0];
  for (const effect of [.0499, -.1]) assert.equal(explainSituationalSignal(original, effect).explanationSafe, false);
  assert.equal(explainSituationalSignal({ ...original, confidence: .39 }, .1).explanationSafe, false);
  assert.equal(explainSituationalSignal(original, .05).explanationSafe, true);
  result.matchupIntelligence.signals = result.matchupIntelligence.signals.map((s) =>
    s.phase === "2A" ? explainSituationalSignal(s, .0499) : s);
  const output = render(result);
  assert.doesNotMatch(output, /THIRD-DOWN ADVANTAGE|RED-ZONE ADVANTAGE/);
  assert.ok(result.matchupIntelligence.signals.some((s) => s.phase === "2A" && s.modelMarginContribution === .0499));
});
test("a smaller situational reason never displaces stronger Phase 1 reasons", () => {
  const result = displayFixture();
  result.winner = "KC";
  const phase1 = result.matchupIntelligence.signals.filter((s) => s.phase !== "2A").slice(0, 2);
  for (const s of phase1) {
    s.advantagedTeam = "KC"; s.disadvantagedTeam = "BUF"; s.explanationSafe = true; s.modelMarginContribution = .5;
  }
  result.matchupIntelligence.signals = [...phase1, ...result.matchupIntelligence.situational.signals];
  const lean = render(result).split("Why Fourth Down leans Kansas City Chiefs")[1];
  assert.doesNotMatch(lean, /third down|red-zone/);
});
test("missing Phase 2A data creates no empty situational cards", () => {
  const result = predict(fixture());
  result.matchupIntelligence.signals = result.matchupIntelligence.signals.filter((s) => s.phase !== "2A");
  assert.doesNotMatch(render(result), /THIRD-DOWN ADVANTAGE|RED-ZONE ADVANTAGE/);
});
