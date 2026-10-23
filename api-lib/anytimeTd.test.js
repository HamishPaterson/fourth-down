import test from "node:test";
import assert from "node:assert/strict";
import { buildBestBets } from "../src/services/bestBetsService.js";

const players = [
  { playerName: "Alpha Runner", team: "KC", rushingYards: 70, anytimeTouchdownProbability: 0.65, roleConfidence: 0.9, dataQuality: 0.9 },
  { playerName: "Beta Receiver", team: "LV", receivingYards: 60, anytimeTouchdownProbability: 0.6, roleConfidence: 0.9, dataQuality: 0.9 },
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
      { key: "a", title: "A", last_update: new Date().toISOString(), markets },
      { key: "b", title: "B", last_update: new Date().toISOString(), markets },
    ],
  };
}

const prediction = {
  awayWinProbability: 0.5,
  homeWinProbability: 0.5,
  away: { code: "KC", score: 20 },
  home: { code: "LV", score: 20 },
};

function personnelFor(candidates) {
  const byTeam = { KC: [], LV: [] };
  const players = Array.isArray(candidates) ? candidates
    : ["away", "home"].flatMap((side) => candidates?.[side]?.players || []);
  for (const [index, player] of players.entries()) {
    player.personnelId ||= `test-player-${index}`;
    player.personnel ||= { eligible: true };
    byTeam[player.team].push({
      canonicalId: player.personnelId,
      team: player.team,
      status: "Active",
      statusKnown: true,
      propEligible: true,
      projectedAvailable: true,
      eligibleBeforeCutoff: true,
      identityConflict: false,
      sourceConflict: false,
    });
  }
  return {
    away: { team: "KC", players: byTeam.KC },
    home: { team: "LV", players: byTeam.LV },
  };
}

function run(withTdPrices) {
  const playerProjections = structuredClone(players);
  return buildBestBets({
    game: { away: "KC", home: "LV" },
    prediction,
    playerProjections,
    personnelViews: personnelFor(playerProjections),
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

test("an unpriced statistical leader cannot displace an eligible priced scorer", () => {
  const only = oddsEvent(true);
  for (const book of only.bookmakers) book.markets = book.markets.filter((m) => m.outcomes[0].playerName === "Beta Receiver");
  const playerProjections = structuredClone(players);
  const result = buildBestBets({ game: { away: "KC", home: "LV" }, prediction,
    playerProjections, personnelViews: personnelFor(playerProjections), oddsEvent: only, dataQuality: {} });
  assert.match(result.anytimeTdScorer.selection, /Beta Receiver/);
  assert.equal(result.anytimeTdScorer.source, "priced-market");
});

test("without bookmaker TD odds only non-betting statistical diagnostics remain", () => {
  const result = run(false);
  assert.equal(tdPlayers(result).length, 0);
  assert.equal(result.anytimeTdScorer.source, "unavailable");
  assert.equal(result.anytimeTdScorer.modelProbability, null);
  assert.equal(result.anytimeTdScorer.primaryReason, "PRICE_UNAVAILABLE");
  assert.equal(result.anytimeTdScorer.statisticalProjection.modelProbability, 0.65);
});

function scorer(candidates, odds = null) {
  const playerProjections = structuredClone(candidates);
  return buildBestBets({ game: { away: "KC", home: "LV" }, prediction,
    playerProjections, personnelViews: personnelFor(playerProjections),
    oddsEvent: odds, dataQuality: {} }).anytimeTdScorer;
}

test("dedicated scorer probability affects selection with equal role confidence", () => {
  assert.match(scorer(players).statisticalProjection.playerName, /Alpha Runner/);
  assert.match(scorer(players.map((player, index) => ({
    ...player, anytimeTouchdownProbability: index ? .8 : .4,
  }))).statisticalProjection.playerName, /Beta Receiver/);
});

test("dedicated scorer uses probability times role confidence and displays raw probability", () => {
  const candidates = [
    { ...players[0], anytimeTouchdownProbability: .8, roleConfidence: .6 },
    { ...players[1], anytimeTouchdownProbability: .65, roleConfidence: .9 },
  ];
  for (const odds of [null, oddsEvent(true)]) {
    const result = scorer(candidates, odds);
    if (odds) {
      assert.match(result.selection, /Beta Receiver/);
      assert.equal(result.modelProbability, .65);
      assert.match(result.explanation, /65%/);
    } else {
      assert.equal(result.source, "unavailable");
      assert.equal(result.statisticalProjection.playerName, "Beta Receiver");
      assert.equal(result.statisticalProjection.modelProbability, .65);
    }
  }
  candidates[0].roleConfidence = .95;
  assert.match(scorer(candidates).statisticalProjection.playerName, /Alpha Runner/);
});

test("data quality cannot change ranking between eligible players", () => {
  const candidates = [
    { ...players[0], anytimeTouchdownProbability: .8, roleConfidence: .6, dataQuality: .99 },
    { ...players[1], anytimeTouchdownProbability: .65, roleConfidence: .9, dataQuality: .5 },
  ];
  assert.match(scorer(candidates).statisticalProjection.playerName, /Beta Receiver/);
  candidates[0].dataQuality = .5;
  candidates[1].dataQuality = .99;
  assert.match(scorer(candidates).statisticalProjection.playerName, /Beta Receiver/);
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
    assert.match(scorer([player, players[1]]).statisticalProjection.playerName, /Beta Receiver/);
    assert.equal(scorer([player], oddsEvent(true)).source, "unavailable");
  }
  assert.equal(scorer({ available: false, away: { players } }, oddsEvent(true)).source, "unavailable");
  assert.equal(scorer([]).source, "unavailable");
});

test("priced scorer uses the same probability as the qualified priced candidate", () => {
  assert.equal(scorer([{ ...players[0], anytimeTouchdownProbability: .98 }], oddsEvent(true)).modelProbability, .95);
});