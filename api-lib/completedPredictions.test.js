import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { isFinalGame, getGameScore, withGameResult, resultGameKey, completedPickLabel } from "../src/services/gameResults.js";
import { fetchSharedPredictionLedger } from "../src/services/sharedPredictionLedger.js";

const snapshots = JSON.parse(readFileSync(new URL("./fixtures/week7-rendered-bets.json", import.meta.url)));
const saved = () => structuredClone(snapshots[0]);
// Captured from the existing ESPN Results-source branch for event 401873010.
const finalGame = () => ({
  id: "espn-401873010", season: 2026, week: 7, date: "2026-10-23T00:15Z",
  visitor_team: { abbreviation: "NE" }, home_team: { abbreviation: "CHI" },
  completed: true, status: "Final", status_state: "post",
  visitor_team_score: 24, home_team_score: 30,
});
let server, ui, results;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    plugins: [{ name: "completed-predictions-test-exports", transform(code, id) {
      if (id.replace(/\\/g, "/").endsWith("/src/pages/Predictions.jsx"))
        return `${code}\nexport { mapScheduleGame, findLedgerRow, sortPredictions, filterPredictions, enrichSavedPredictionWithCurrentMarket };`;
      if (id.replace(/\\/g, "/").endsWith("/src/pages/Results.jsx"))
        return `${code}\nexport { hydrateFinalScores, isValidCompletedResult, ResultGameCard };`;
    } }] });
  ui = await server.ssrLoadModule("/src/pages/Predictions.jsx");
  results = await server.ssrLoadModule("/src/pages/Results.jsx");
});
after(async () => { await server?.close(); });
const render = (prediction) => renderToStaticMarkup(createElement(ui.PredictionCard, { prediction, onOpen() {} }));

test("A: upcoming card retains projected scores and never shows a final result", () => {
  const row = saved(), game = { ...finalGame(), completed: false, status: "Scheduled", status_state: "pre" };
  assert.equal(withGameResult(row, game), row);
  const html = render(row);
  assert.match(html, /PROJECTED/);
  assert.match(html, /24 - 28/);
  assert.doesNotMatch(html, /aria-label="Final result"|PICK CORRECT|PICK INCORRECT/);
});

test("B/J/K: Patriots-Bears retains original prediction and immutable model/bets, with authoritative final separately", () => {
  const row = { ...saved(), game: { venue: "Saved pre-game venue", weather: { temperature: 12, windSpeed: 8 } } };
  const before = structuredClone(row), game = ui.mapScheduleGame(finalGame());
  assert.equal(ui.findLedgerRow([row], game), row);
  assert.equal(resultGameKey(row), resultGameKey(finalGame()));
  const displayed = ui.enrichSavedPredictionWithCurrentMarket(row, game, [], new Date("2099-01-01"));
  assert.deepEqual([displayed.fourthDownAwayScore, displayed.fourthDownHomeScore], [24, 28]);
  assert.deepEqual([displayed.actualAwayScore, displayed.actualHomeScore], [24, 30]);
  assert.deepEqual(displayed.bestBets, row.bestBets);
  assert.deepEqual(displayed.predictionPayload, row.predictionPayload);
  assert.deepEqual(displayed.game.weather, row.game.weather);
  assert.equal(displayed.fourthDownWinnerProbability, row.fourthDownWinnerProbability);
  assert.equal(displayed.fourthDownPick, "CHI");
  const html = render(displayed);
  for (const text of ["PROJECTED", "24 - 28", "FINAL", "NE 24 - CHI 30", "Chicago Bears won", "PICK CORRECT", "Open matchup", "Pre-game Best Bets", "Not actionable"])
    assert.ok(html.includes(text), text);
  assert.deepEqual(row, before);
});

test("C/D/E: incomplete games precede all completed games with deterministic kickoff ordering", () => {
  const first = withGameResult(saved(), finalGame());
  const later = { ...first, id: "later", kickoff: "2026-10-26T00:20Z" };
  const upcoming = structuredClone(snapshots[1]);
  const rows = [later, first, upcoming];
  assert.deepEqual(ui.filterPredictions(rows, "all").sort(ui.sortPredictions).map((r) => r.id), [upcoming.id, first.id, later.id]);
  assert.deepEqual(rows.map((r) => r.id), [later.id, first.id, upcoming.id]);
  assert.ok(ui.sortPredictions({ ...first, id: "a" }, { ...first, id: "b" }) < 0);
});

test("F/G: Completed Games filters resolved rows only and empty weeks remain empty", () => {
  const completed = withGameResult(saved(), finalGame());
  const upcoming = structuredClone(snapshots[1]);
  assert.deepEqual(ui.filterPredictions([completed, upcoming], "completed"), [completed]);
  assert.deepEqual(ui.filterPredictions([upcoming], "completed"), []);
  const source = readFileSync(new URL("../src/pages/Predictions.jsx", import.meta.url), "utf8");
  assert.match(source, /<option value="completed">Completed Games<\/option>/);
  assert.match(source, /No games have a final result for Week/);
});

for (const [pick, expected] of [["CHI", "PICK CORRECT"], ["NE", "PICK INCORRECT"], [null, "PICK NOT GRADED"]])
  test(`H/I: ${pick} produces ${expected} without changing the pick`, () => {
    const row = withGameResult({ ...saved(), fourthDownPick: pick }, finalGame());
    assert.equal(completedPickLabel(row), expected);
    assert.match(render(row), new RegExp(expected));
    assert.equal(row.fourthDownPick, pick);
  });

test("tied final result is neutral rather than inventing prediction correctness", () => {
  const row = withGameResult(saved(), { ...finalGame(), visitor_team_score: 30 });
  assert.equal(row.actualWinner, "TIE");
  assert.equal(completedPickLabel(row), "PICK NOT GRADED");
  assert.match(render(row), /Tied game/);
});

for (const [name, change] of [
  ["different season", (g) => { g.season = 2025; }],
  ["different week rematch", (g) => { g.week = 8; }],
  ["different kickoff same-week rematch", (g) => { g.date = "2026-10-24T00:15Z"; }],
  ["reversed home/away", (g) => { [g.visitor_team, g.home_team] = [g.home_team, g.visitor_team]; }],
  ["similarly named team", (g) => { g.visitor_team.abbreviation = "NYJ"; }],
  ["missing stable kickoff", (g) => { delete g.date; }],
]) test(`cross-page identity rejects ${name}`, () => {
  const row = saved(), game = finalGame();
  change(game);
  assert.equal(withGameResult(row, game), row);
  assert.equal(ui.findLedgerRow([row], ui.mapScheduleGame(game)), undefined);
});

for (const status of ["Scheduled", "In Progress", "Halftime", "Delayed", "Postponed"])
  test(`status ${status} never becomes completed from scores or elapsed kickoff`, () => {
    const game = { ...finalGame(), completed: false, status };
    assert.equal(isFinalGame(game), false);
    const row = saved();
    assert.equal(withGameResult(row, game), row);
  });

for (const status of ["Final", "Completed", "Closed", "post"])
  test(`existing Results final-status rule accepts ${status}`, () => {
    const game = { ...finalGame(), completed: false, status };
    assert.equal(isFinalGame(game), true);
    assert.equal(withGameResult(saved(), game).actualWinner, "CHI");
  });

for (const score of [null, "", undefined, "not a score"])
  test(`missing/invalid final score ${String(score)} cannot fabricate a result`, () => {
    const game = { ...finalGame(), visitor_team_score: score }, row = saved();
    assert.equal(getGameScore(game, "away"), null);
    assert.equal(withGameResult(row, game), row);
  });

test("L: Results hydrates and renders the same existing final source without changing grading behaviour", async () => {
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ games: [finalGame()] }) };
  };
  try {
    const row = saved(), before = structuredClone(row);
    const [graded] = await results.hydrateFinalScores([row]);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /results=1/);
    assert.equal(results.isValidCompletedResult(graded), true);
    assert.deepEqual([graded.actualAwayScore, graded.actualHomeScore, graded.actualWinner], [24, 30, "CHI"]);
    assert.equal(graded.fourthDownCorrect, true);
    assert.equal(graded.fourthDownAwayScore, 24);
    assert.equal(graded.fourthDownHomeScore, 28);
    assert.match(renderToStaticMarkup(createElement(results.ResultGameCard, { result: graded })), /24 - 30/);
    assert.deepEqual(row, before);
  } finally { globalThis.fetch = originalFetch; }
});

test("completed schedule identities travel in the existing display GET without additional fetches or writes", async () => {
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => JSON.stringify({ snapshots: [saved()] }) };
  };
  try {
    await fetchSharedPredictionLedger({ season: 2026, week: 7, displayBets: true, historicalGames: [resultGameKey(finalGame())] });
    assert.equal(calls.length, 1);
    const query = new URL(calls[0].url, "https://example.test").searchParams;
    assert.equal(query.get("historicalGames"), resultGameKey(finalGame()));
    assert.equal(query.get("bets"), "display");
    assert.equal(calls[0].options.method, undefined);
  } finally { globalThis.fetch = originalFetch; }
});
