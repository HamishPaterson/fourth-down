import test from "node:test";
import assert from "node:assert/strict";
import { buildBestBets } from "../src/services/bestBetsService.js";

const players = [
  { playerName: "Alpha Runner", team: "KC", rushingYards: 70, anytimeTouchdownProbability: 0.55, roleConfidence: 0.9, dataQuality: 0.9 },
  { playerName: "Beta Receiver", team: "LV", receivingYards: 60, anytimeTouchdownProbability: 0.4, roleConfidence: 0.9, dataQuality: 0.9 },
];

function oddsEvent(withTdPrices) {
  const markets = [];
  if (withTdPrices) {
    for (const [name, price] of [["Alpha Runner", 400], ["Beta Receiver", 300]]) {
      markets.push({
        key: "player_anytime_td",
        outcomes: [{ name: "Yes", playerName: name, price, period: "full_game", rawMarketType: "player_anytime_td" }],
      });
    }
  }
  return {
    bookmakers: [
      { key: "a", title: "A", markets },
      { key: "b", title: "B", markets },
    ],
  };
}

const prediction = {
  awayWinProbability: 0.5,
  homeWinProbability: 0.5,
  away: { code: "KC", score: 20 },
  home: { code: "LV", score: 20 },
};

function run(withTdPrices) {
  return buildBestBets({
    game: { away: "KC", home: "LV" },
    prediction,
    playerProjections: players,
    oddsEvent: oddsEvent(withTdPrices),
    dataQuality: {},
  });
}

const isTd = (bet) =>
  bet?.market === "Anytime touchdown" ||
  bet?.category === "Anytime touchdowns" ||
  /anytime\s*(td|touchdown)/i.test(String(bet?.selection || ""));

function tdCount(result) {
  const listed = result.recommendations.filter(isTd).length;
  const highlighted = Object.values(result.highlights || {}).filter(isTd).length;
  return { listed, highlighted, scorer: result.anytimeTdScorer ? 1 : 0 };
}

const tdPlayers = (result) =>
  result.recommendations.filter(isTd).map((bet) => bet.selection.replace(/ anytime TD$/i, ""));

test("A: the scorer's player never also appears as a normal Anytime TD bet", () => {
  const result = run(true);
  assert.match(result.anytimeTdScorer.selection, /Alpha Runner/);
  assert.ok(!tdPlayers(result).includes("Alpha Runner"));
  assert.equal(result.highlights && Object.values(result.highlights).filter((h) => isTd(h) && /Alpha Runner/.test(h.selection)).length, 0);
});

test("B: a different qualifying player keeps a normal Anytime TD bet alongside the scorer", () => {
  const result = run(true);
  assert.match(result.anytimeTdScorer.selection, /Alpha Runner/);
  assert.deepEqual(tdPlayers(result), ["Beta Receiver"]);
});

test("the scorer is the top model-probability player even if only another player is priced", () => {
  const only = oddsEvent(true);
  for (const book of only.bookmakers) book.markets = book.markets.filter((m) => m.outcomes[0].playerName === "Beta Receiver");
  const result = buildBestBets({ game: { away: "KC", home: "LV" }, prediction, playerProjections: players, oddsEvent: only, dataQuality: {} });
  assert.match(result.anytimeTdScorer.selection, /Alpha Runner/);
  assert.equal(result.anytimeTdScorer.source, "model-only");
});

test("without bookmaker TD odds the model-only scorer is still produced", () => {
  const result = run(false);
  assert.equal(tdPlayers(result).length, 0);
  assert.equal(result.anytimeTdScorer.source, "model-only");
  assert.equal(result.anytimeTdScorer.modelProbability, 0.55);
});