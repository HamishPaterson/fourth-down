import test, { before, after } from "node:test";
import assert from "node:assert/strict";
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
  Panel = (await server.ssrLoadModule("/src/components/MatchupIntelligencePanel.jsx")).default;
});
after(async () => { await server?.close(); });
function prediction(week = 6) {
  const away = dataset.metricsByWeek[week].BUF, home = dataset.metricsByWeek[week].KC;
  return predictMatchup("BUF", "KC", { season: 2026, week, weather: { dome: true },
    teamMetrics: { season: 2026, week, away, home },
    playerMetrics: playerMetricsResponse(players, { season: 2026, week, away: "BUF", home: "KC" }),
    modelLayers: compareTeams(away, home, week) });
}
const render = (value) => renderToStaticMarkup(createElement(Panel, { prediction: value }));

test("Matchup renders named supported signals, game style and a named lean without redesign", () => {
  const input = prediction(), markup = render(input);
  assert.match(markup, /KEY MATCHUP ADVANTAGES/);
  assert.match(markup, /Buffalo Bills/);
  assert.match(markup, /Kansas City Chiefs/);
  assert.match(markup, /Game style/);
  assert.match(markup, /Pass \/ rush/);
  assert.match(markup, /Why Fourth Down leans (Buffalo Bills|Kansas City Chiefs)/);
  assert.doesNotMatch(markup, /leans (the home team|the away team)|the opponent|the opposing team|the offense|the defense|NaN|Infinity|undefined/i);
  for (const signal of input.matchupIntelligence.signals.filter((s) => s.explanationSafe)) {
    assert.ok(signal.explanation);
  }
});

test("old saved predictions are not retrofitted with fresh matchup explanations", () => {
  assert.equal(render({ away: { code: "BUF" }, home: { code: "KC" }, winner: "KC" }), "");
});

test("missing historical mix is visible rather than invented percentages", () => {
  const markup = render(prediction(2));
  assert.match(markup, /Eligible play mix unavailable/);
  assert.match(markup, /Buffalo Bills: /);
  assert.match(markup, /Kansas City Chiefs: /);
});

test("explanation-unsafe factors are never presented as an advantage", () => {
  const input = prediction();
  input.matchupIntelligence.signals = input.matchupIntelligence.signals.map((signal) => ({
    ...signal, explanationSafe: false, explanation: "UNSUPPORTED ADVANTAGE MUST NOT APPEAR",
  }));
  const markup = render(input);
  assert.doesNotMatch(markup, /UNSUPPORTED ADVANTAGE MUST NOT APPEAR/);
  assert.match(markup, /No measured interaction materially changes/);
});

test("display threshold hides sub-0.05 effects without mutating model output or lean reasons", () => {
  const input = prediction();
  input.winner = "KC";
  const template = input.matchupIntelligence.signals.find((s) => s.explanationSafe);
  input.matchupIntelligence.signals = [
    { ...template, layer: "passing", category: "Immaterial passing", modelMarginContribution: .0499,
      advantagedTeam: "KC", explanationSafe: true,
      explanation: "Kansas City Chiefs passing against Buffalo Bills remains in diagnostics only." },
    { ...template, layer: "rushing", category: "Rushing", modelMarginContribution: .05,
      advantagedTeam: "KC", explanationSafe: true,
      explanation: "Kansas City Chiefs rushing against Buffalo Bills reaches the display threshold." },
    { ...template, layer: "explosives", category: "Explosive plays", modelMarginContribution: -.09,
      advantagedTeam: "BUF", explanationSafe: true,
      explanation: "Buffalo Bills explosive plays against Kansas City Chiefs exceed the display threshold." },
  ];
  const before = structuredClone(input);
  const markup = render(input);
  assert.deepEqual(input, before);
  assert.equal(input.matchupIntelligence.signals[0].modelMarginContribution, .0499);
  assert.doesNotMatch(markup, /Immaterial passing|diagnostics only/);
  assert.match(markup, /reaches the display threshold/);
  assert.match(markup, /exceed the display threshold/);
  assert.match(markup, /Why Fourth Down leans Kansas City Chiefs/);
  assert.match(markup, /Rushing favour Kansas City Chiefs/);
  assert.doesNotMatch(markup, /the opponent|the opposing team|the offense|the defense/i);
});
