import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import dataset from "../api/nfl/nflverse-team-metrics.js";
import players from "../data/nflverse-player-metrics.js";
import { playerMetricsResponse } from "./playerMetrics.js";
import { compareTeams } from "../api/nfl/play-by-play.js";
import { predictMatchup } from "../src/services/predictionEngine.js";

let server, Panel;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  const module = await server.ssrLoadModule("/src/components/MatchupIntelligencePanel.jsx");
  Panel = module.default;
});
after(async () => { await server?.close(); });
function prediction(week = 6, awayCode = "BUF", homeCode = "KC") {
  const away = dataset.metricsByWeek[week][awayCode], home = dataset.metricsByWeek[week][homeCode];
  return predictMatchup(awayCode, homeCode, { season: 2026, week, weather: { dome: true },
    teamMetrics: { season: 2026, week, away, home },
    playerMetrics: playerMetricsResponse(players, { season: 2026, week, away: awayCode, home: homeCode }),
    modelLayers: compareTeams(away, home, week) });
}
function supportedPrediction(week = 7, awayCode = "BUF", homeCode = "KC") {
  const cutoff = dataset.metricsByWeek[week][awayCode].cutoff;
  const sourceAsOf = new Date(Date.parse(cutoff) - 3600000).toISOString();
  const game = { gameId: `fixture-${awayCode}-${homeCode}`, week: 1, away: awayCode, home: homeCode,
    kickoff: new Date(Date.parse(cutoff) - 3 * 86400000).toISOString(),
    completedAsOf: new Date(Date.parse(cutoff) - 2 * 86400000).toISOString() };
  const side = (team) => ({
    team, predictionWeek: week, cutoff, games: 1, expectedCompletedGames: 1,
    gameProvenance: [game],
    teamTotals: { passAttempts: 30, sacksAllowed: 2, rushingAttempts: 25, targets: 30,
      completions: 20, passingYards: 240 },
    players: {},
  });
  const playerMetrics = {
    available: true, schemaVersion: 2, season: 2026, requestedWeek: week, metricsWeek: week,
    cutoff, sourceAsOf, generatedAt: cutoff, away: side(awayCode), home: side(homeCode),
  };
  const away = dataset.metricsByWeek[week][awayCode], home = dataset.metricsByWeek[week][homeCode];
  return predictMatchup(awayCode, homeCode, { season: 2026, week,
    weather: { dome: true }, teamMetrics: { season: 2026, week, away, home }, playerMetrics,
    modelLayers: compareTeams(away, home, week) });
}
const render = (value) => renderToStaticMarkup(createElement(Panel, { prediction: value }));
const explain = (signal) => {
  const input = supportedPrediction();
  input.matchupIntelligence.signals = [signal];
  return render(input);
};

test("Matchup renders named supported signals, game style and a named lean without redesign", () => {
  const input = supportedPrediction(), markup = render(input);
  assert.match(markup, /KEY MATCHUP ADVANTAGES/);
  assert.match(markup, /Buffalo Bills/);
  assert.match(markup, /Kansas City Chiefs/);
  assert.match(markup, /Game style/);
  assert.match(markup, /expected to/);
  assert.doesNotMatch(markup, /<table|EPA|hit\/sack|ablation|Removing only|metric-specific|pre-simulation|Coverage and model limits|baseline projection/);
  assert.match(markup, /Why Fourth Down leans (Buffalo Bills|Kansas City Chiefs)/);
  assert.doesNotMatch(markup, /leans (the home team|the away team)|the opponent|the opposing team|the offense|the defense|NaN|Infinity|undefined/i);
  for (const signal of input.matchupIntelligence.signals.filter((s) => s.explanationSafe)) {
    assert.ok(signal.explanation);
  }
});

test("context-only weeks omit unsupported matchup explanations", () => {
  const input = prediction(6);
  assert.equal(input.matchupIntelligence.available, false);
  assert.equal(render(input), "");
});

test("old saved predictions are not retrofitted with fresh matchup explanations", () => {
  assert.equal(render({ away: { code: "BUF" }, home: { code: "KC" }, winner: "KC" }), "");
});

test("missing historical mix does not invent game style or percentages", () => {
  const markup = render(prediction(2));
  assert.doesNotMatch(markup, /Game style|%|possessions/);
});

test("explanation-unsafe factors are never presented as an advantage", () => {
  const input = supportedPrediction();
  input.matchupIntelligence.signals = input.matchupIntelligence.signals.map((signal) => ({
    ...signal, explanationSafe: false, explanation: "UNSUPPORTED ADVANTAGE MUST NOT APPEAR",
  }));
  const markup = render(input);
  assert.doesNotMatch(markup, /UNSUPPORTED ADVANTAGE MUST NOT APPEAR/);
  assert.match(markup, /has a standout matchup advantage/);
  assert.match(markup, /broader team projection rather than one dominant matchup advantage/);
});

test("display threshold hides sub-0.05 effects without mutating model output or lean reasons", () => {
  const input = supportedPrediction();
  input.winner = "KC";
  const template = input.matchupIntelligence.signals.find((s) => s.explanationSafe);
  input.matchupIntelligence.signals = [
    { ...template, layer: "passMatchup", category: "Immaterial passing", modelMarginContribution: .0499,
      advantagedTeam: "KC", explanationSafe: true,
      explanation: "Kansas City Chiefs passing against Buffalo Bills remains in diagnostics only." },
    { ...template, layer: "rushMatchup", category: "Rushing", modelMarginContribution: .05,
      advantagedTeam: "KC", explanationSafe: true,
      explanation: "Kansas City Chiefs rushing against Buffalo Bills reaches the display threshold." },
    { ...template, layer: "explosiveMatchup", category: "Explosive plays", modelMarginContribution: -.09,
      advantagedTeam: "BUF", disadvantagedTeam: "KC", explanationSafe: true,
      explanation: "Buffalo Bills explosive plays against Kansas City Chiefs exceed the display threshold." },
  ];
  const before = structuredClone(input);
  const markup = render(input);
  assert.deepEqual(input, before);
  assert.equal(input.matchupIntelligence.signals[0].modelMarginContribution, .0499);
  assert.doesNotMatch(markup, /Immaterial passing|diagnostics only/);
  assert.match(markup, /Running game - Kansas City Chiefs/);
  assert.match(markup, /Explosive plays - Buffalo Bills/);
  assert.doesNotMatch(markup, /Passing game/);
  assert.match(markup, /Why Fourth Down leans Kansas City Chiefs/);
  const lean = markup.split("Why Fourth Down leans Kansas City Chiefs")[1];
  assert.match(lean, /ground|run|rushing/);
  assert.doesNotMatch(lean, /passing|big plays|chunk yardage/);
  assert.doesNotMatch(markup, /the opponent|the opposing team|the offense|the defense/i);
});

test("Seattle-Denver uses football language without altering predictions or diagnostics", () => {
  const input = supportedPrediction(7, "SEA", "DEN"), before = structuredClone(input);
  const markup = render(input);
  assert.deepEqual(input, before);
  assert.match(markup, /Seattle Seahawks/);
  assert.match(markup, /Denver Broncos/);
  assert.match(markup, /pass protection|pressure/);
  assert.match(markup, /THIRD-DOWN ADVANTAGE/);
  assert.match(markup, /RED-ZONE ADVANTAGE/);
  assert.doesNotMatch(markup, /EPA|proxy|ablation|layer|metric-specific|%|\d+\.\d+|the opponent|the opposing team|the opposing defense|the offense|the defense|the quarterback|blitz|play-action|screen|route-depth|special-teams/i);
  assert.ok(input.matchupIntelligence.signals.some((signal) => signal.explanation?.includes("Removing only")));
});

test("raw and adjusted football descriptions respect the exact contributing metric", () => {
  const signal = structuredClone(supportedPrediction().matchupIntelligence.signals.find((s) => s.layer === "rushMatchup"));
  signal.advantagedTeam = signal.homeTeam;
  signal.disadvantagedTeam = signal.awayTeam;
  const own = signal.matchups.home, other = signal.matchups.away;
  own.offensiveMetric.value = .2; other.offensiveMetric.value = .1;
  own.defensiveMetric.value = .1; other.defensiveMetric.value = -.1;
  own.opponentAdjustedMetric = { value: .3, unit: "EPA/play" };
  signal.metricAdjustmentHomePoints = .01;
  assert.match(explain(signal), /favourable path to sustain drives on the ground.*hold up after accounting/);
  own.defensiveMetric.value = -.2;
  assert.match(explain(signal), /but Buffalo Bills have done more to contain the run/);
  own.opponentAdjustedMetric.value = .1;
  signal.metricAdjustmentHomePoints = -.01;
  assert.match(explain(signal), /soften after accounting/);
  own.opponentAdjustedMetric = null;
  assert.doesNotMatch(explain(signal), /accounting/);
});

test("Matchup scoring breakdown is removed while scoring calculations remain in predictions", () => {
  const source = readFileSync(new URL("../src/components/MatchupPrediction.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /Passing TDs|Rushing TDs|Defensive TDs \(Pick 6\)|Field goals|Extra points|2-pt conversions/);
  const value = prediction();
  assert.ok(Number.isFinite(value.home.passingTD));
  assert.ok(Number.isFinite(value.away.rushingTD));
  assert.ok(Number.isFinite(value.home.score));
});
