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

function scorer(candidates, odds = null) {
  return buildBestBets({ game: { away: "KC", home: "LV" }, prediction,
    playerProjections: candidates, oddsEvent: odds, dataQuality: {} }).anytimeTdScorer;
}

test("dedicated scorer probability affects selection with equal role confidence", () => {
  assert.match(scorer(players).selection, /Alpha Runner/);
  assert.match(scorer(players.map((player, index) => ({
    ...player, anytimeTouchdownProbability: index ? .8 : .4,
  }))).selection, /Beta Receiver/);
});

test("dedicated scorer uses probability times role confidence and displays raw probability", () => {
  const candidates = [
    { ...players[0], anytimeTouchdownProbability: .8, roleConfidence: .6 },
    { ...players[1], anytimeTouchdownProbability: .65, roleConfidence: .9 },
  ];
  for (const odds of [null, oddsEvent(true)]) {
    const result = scorer(candidates, odds);
    assert.match(result.selection, /Beta Receiver/);
    assert.equal(result.modelProbability, .65);
    assert.match(result.explanation, /65%/);
  }
  candidates[0].roleConfidence = .95;
  assert.match(scorer(candidates).selection, /Alpha Runner/);
});

test("data quality cannot change ranking between eligible players", () => {
  const candidates = [
    { ...players[0], anytimeTouchdownProbability: .8, roleConfidence: .6, dataQuality: .99 },
    { ...players[1], anytimeTouchdownProbability: .65, roleConfidence: .9, dataQuality: .5 },
  ];
  assert.match(scorer(candidates).selection, /Beta Receiver/);
  candidates[0].dataQuality = .5;
  candidates[1].dataQuality = .99;
  assert.match(scorer(candidates).selection, /Beta Receiver/);
});

test("unsupported identities, roles, probabilities and explicit ineligibility cannot win", () => {
  const unsupported = [
    { ...players[0], playerName: "", anytimeTouchdownProbability: .99 },
    ...[undefined, null, NaN, 0].map((roleConfidence) => ({
      ...players[0], roleConfidence, anytimeTouchdownProbability: .99,
    })),
    { ...players[0], eligible: false, anytimeTouchdownProbability: .99 },
    { ...players[0], available: false, anytimeTouchdownProbability: .99 },
    { ...players[0], anytimeTouchdownProbability: 2 },
  ];
  for (const player of unsupported) {
    assert.match(scorer([player, players[1]]).selection, /Beta Receiver/);
    assert.equal(scorer([player], oddsEvent(true)).source, "unavailable");
  }
  assert.equal(scorer({ available: false, away: { players } }, oddsEvent(true)).source, "unavailable");
  assert.equal(scorer([]).source, "unavailable");
});

test("priced scorer displays raw probability even outside normal bet probability caps", () => {
  assert.equal(scorer([{ ...players[0], anytimeTouchdownProbability: .98 }], oddsEvent(true)).modelProbability, .98);
});