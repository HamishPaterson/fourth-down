import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { buildBestBets, selectTdModelPick } from "../src/services/bestBetsService.js";
import { tdBettingDisplay } from "../src/services/playerBetDiagnostics.js";
import { refreshSavedBestBets } from "./serverPredictions.js";

const NOW = new Date("2026-10-23T04:05:00Z");
function input() {
  const players = [
    { playerName: "Alpha Runner", personnelId: "alpha", team: "KC", position: "RB",
      anytimeTouchdownProbability: .8, roleConfidence: .6, dataQuality: .9, personnel: { eligible: true } },
    { playerName: "Beta Receiver", personnelId: "beta", team: "LV", position: "WR",
      anytimeTouchdownProbability: .65, roleConfidence: .9, dataQuality: .9, personnel: { eligible: true } },
  ];
  return { game: { away: "KC", home: "LV" }, quoteAsOf: NOW, playerProjections: players,
    personnelViews: Object.fromEntries(["KC", "LV"].map((team, index) => [index ? "home" : "away", { team,
      players: players.filter((player) => player.team === team).map((player) => ({
        canonicalId: player.personnelId, team, status: "Active", statusKnown: true, position: player.position,
        propEligible: true, projectedAvailable: true, eligibleBeforeCutoff: true,
      })) }])),
    prediction: { awayWinProbability: .5, homeWinProbability: .5,
      away: { code: "KC", score: 20 }, home: { code: "LV", score: 20 } },
    dataQuality: {}, oddsEvent: { away_team: "KC", home_team: "LV", bookmakers: [] } };
}
function prices(value, alpha, beta) {
  value.oddsEvent.bookmakers = [{ key: "book", title: "Book", last_update: NOW.toISOString(), markets: [{
    key: "player_anytime_td", outcomes: [
      { name: "Yes", playerName: "Alpha Runner", price: alpha },
      { name: "Yes", playerName: "Beta Receiver", price: beta },
    ],
  }] }];
  return value;
}
let server, ui;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    plugins: [{ name: "td-model-render-exports", transform(code, id) {
      if (id.replace(/\\/g, "/").endsWith("/src/pages/Predictions.jsx"))
        return `${code}\nexport { AnytimeTdScorer, BestBetsPanel, buildDisplayHighlights, enrichSavedPredictionWithCurrentMarket };`;
    } }] });
  ui = await server.ssrLoadModule("/src/pages/Predictions.jsx");
});
after(async () => { await server?.close(); });
const render = (pick) => renderToStaticMarkup(createElement(ui.AnytimeTdScorer, { scorer: pick, awayCode: "KC", homeCode: "LV" }));

test("A: unpriced TD projection still renders the model player, raw probability, real confidence and unavailable price", () => {
  const result = buildBestBets(input()), pick = result.anytimeTdModelPick;
  assert.equal(pick.playerName, "Alpha Runner");
  assert.equal(pick.modelProbability, .8);
  assert.equal(pick.roleConfidence, .6);
  assert.equal(pick.confidenceScore, .765);
  assert.equal(pick.confidenceLevel, "High");
  assert.equal(pick.bettingEligible, false);
  const markup = render(pick);
  assert.match(markup, /Alpha Runner/);
  assert.match(markup, /Model pick/);
  assert.match(markup, /80\.0%/);
  assert.match(markup, /High.*Role 60%/);
  assert.match(markup, /Price<\/small><strong>Unavailable/);
  assert.equal(result.anytimeTdScorer.primaryReason, "PRICE_UNAVAILABLE");
  assert.ok(!result.candidates.some((bet) => bet.market === "Anytime touchdown"));
});

for (const [title, price, reason] of [
  ["B: invalid price", 0, "INVALID_PRICE"],
  ["C: valid negative-edge price", -1000, "NON_POSITIVE_EDGE"],
]) test(`${title} cannot remove the Model Pick or create a priced TD bet`, () => {
  const value = prices(input(), price, price), result = buildBestBets(value);
  assert.equal(result.anytimeTdModelPick.playerName, "Alpha Runner");
  assert.equal(result.anytimeTdModelPick.modelProbability, .8);
  assert.match(render(result.anytimeTdModelPick), /Model pick/);
  assert.equal(result.anytimeTdScorer.primaryReason, reason);
  assert.ok(!result.candidates.some((bet) => bet.market === "Anytime touchdown"));
});

test("D: positive-edge priced TD qualifies separately without relabelling the Model Pick as a bet", () => {
  const result = buildBestBets(prices(input(), 100, 200));
  assert.equal(result.anytimeTdModelPick.playerName, "Alpha Runner");
  assert.equal(result.anytimeTdModelPick.bettingEligible, false);
  assert.equal(result.anytimeTdModelPick.price, 100);
  assert.equal(result.anytimeTdScorer.bettingEligible, true);
  assert.equal(tdBettingDisplay(result.anytimeTdScorer, NOW).source, "priced-market");
  assert.match(render(result.anytimeTdModelPick), /Model pick/);
  assert.match(render(result.anytimeTdModelPick), /Price<\/small><strong>\$2\.00/);
});

test("E: better sportsbook price or EV for the lower-probability player cannot change Model Pick", () => {
  const first = buildBestBets(prices(input(), -1000, 900));
  assert.equal(first.anytimeTdModelPick.playerName, "Alpha Runner");
  assert.match(first.anytimeTdScorer.selection, /Beta Receiver/);
  for (const price of [100, 200, 900, 0, undefined]) {
    const result = buildBestBets(prices(input(), price, 5000));
    assert.equal(result.anytimeTdModelPick.playerName, "Alpha Runner");
    assert.equal(result.anytimeTdModelPick.confidenceScore, first.anytimeTdModelPick.confidenceScore);
  }
});

test("model display probability is not subject to the priced TD probability floor", () => {
  const value = prices(input(), 900, 900);
  value.playerProjections.forEach((player, index) => { player.anytimeTouchdownProbability = index ? .3 : .48; });
  const result = buildBestBets(value);
  assert.equal(result.anytimeTdModelPick.playerName, "Alpha Runner");
  assert.equal(result.anytimeTdModelPick.modelProbability, .48);
  assert.equal(result.anytimeTdScorer.source, "unavailable");
  assert.ok(!result.candidates.some((bet) => bet.market === "Anytime touchdown"));
});

test("a stale optional TD quote disappears without removing the independent model player", () => {
  const value = prices(input(), 100, 200);
  value.oddsEvent.bookmakers[0].last_update = "2026-10-19T00:00Z";
  const result = buildBestBets(value);
  assert.equal(result.anytimeTdModelPick.playerName, "Alpha Runner");
  assert.equal(result.anytimeTdModelPick.price, null);
  assert.equal(result.anytimeTdScorer.primaryReason, "PRICE_STALE");
});

for (const status of ["Out", "Inactive", "IR", "PUP", "Suspended", "NFI", "Doubtful"]) {
  test(`F: highest-probability ${status} player cannot be the Model Pick`, () => {
    const value = input();
    value.personnelViews.away.players[0].status = status;
    assert.equal(selectTdModelPick(value).playerName, "Beta Receiver");
  });
}
test("G: unknown availability permits supported model roles, never priced eligibility or fabricated active status", () => {
  const value = prices(input(), 500, 500);
  for (const view of Object.values(value.personnelViews)) for (const player of view.players) {
    Object.assign(player, { status: "Unknown", statusKnown: false, propEligible: false });
  }
  value.playerProjections.forEach((player) => { player.personnel = { eligible: false, statusKnown: false, status: "Unknown" }; });
  const before = structuredClone(value), result = buildBestBets(value);
  assert.equal(result.anytimeTdModelPick.playerName, "Alpha Runner");
  assert.match(result.anytimeTdModelPick.personnelState, /^UNKNOWN/);
  assert.equal(result.anytimeTdModelPick.availabilityKnown, false);
  assert.match(render(result.anytimeTdModelPick), /Availability is unconfirmed/);
  assert.equal(result.anytimeTdScorer.source, "unavailable");
  assert.equal(result.anytimeTdScorer.primaryReason, "PLAYER_AVAILABILITY_UNKNOWN");
  assert.ok(!result.candidates.some((bet) => bet.market === "Anytime touchdown"));
  assert.deepEqual(value, before);
});
test("H: genuinely missing TD projections render an accurate model-only empty state without fake zero", () => {
  const value = input();
  value.playerProjections = [];
  const pick = selectTdModelPick(value);
  assert.equal(pick.modelProbability, null);
  assert.equal(pick.primaryReason, "PLAYER_PROJECTION_UNAVAILABLE");
  assert.match(render(pick), /Player projections are unavailable/);
  assert.doesNotMatch(render(pick), /priced player|betting recommendation|0\.0%/);
});

for (const [name, change] of [
  ["missing identity", (v) => { v.playerProjections[0].personnelId = "missing"; }],
  ["identity conflict", (v) => { v.personnelViews.away.players[0].identityConflict = true; }],
  ["source conflict", (v) => { v.personnelViews.away.players[0].sourceConflict = true; }],
  ["wrong matchup", (v) => { v.game.away = "NE"; }],
  ["wrong record team", (v) => { v.personnelViews.away.players[0].team = "NE"; }],
  ["stale role", (v) => { v.personnelViews.away.players[0].eligibleBeforeCutoff = false; }],
  ["unsupported role", (v) => { v.personnelViews.away.players[0].position = "K"; }],
  ["low role confidence", (v) => { v.playerProjections[0].roleConfidence = .54; }],
  ["missing role confidence", (v) => { delete v.playerProjections[0].roleConfidence; }],
  ["invalid probability", (v) => { v.playerProjections[0].anytimeTouchdownProbability = 1.2; }],
]) test(`Model Pick excludes ${name}, independently of price`, () => {
  const value = prices(input(), 1000, 100);
  change(value);
  assert.equal(selectTdModelPick(value).playerName, "Beta Receiver");
});

const rows = JSON.parse(readFileSync(new URL("./fixtures/week7-rendered-bets.json", import.meta.url)));
const nyjPersonnel = rows.find((row) => row.awayCode === "MIA").personnelViews.home.players;
nyjPersonnel.find((player) => player.canonicalId === "00-0039794").name = "Braelon Allen";
nyjPersonnel.find((player) => player.canonicalId === "00-0038120").name = "Breece Hall";
const odds = JSON.parse(readFileSync(new URL("./fixtures/week7-rendered-quotes.json", import.meta.url)));
function displayed(awayCode, quotes = odds) {
  const saved = rows.find((row) => row.awayCode === awayCode);
  const assessment = refreshSavedBestBets(saved, quotes, NOW, { displayOnly: true });
  return ui.enrichSavedPredictionWithCurrentMarket(assessment, { away: saved.awayCode, home: saved.homeCode }, quotes.events, NOW);
}
test("I/J/K: existing positive-edge props can win Most Likely/Best Value while stale totals stay quarantined", () => {
  const cle = displayed("CLE"), tb = displayed("TB");
  assert.equal(ui.buildDisplayHighlights(cle.bestBets).mostLikely.selection, "Quinshon Judkins Under 66.5 rushing + receiving yards");
  assert.equal(ui.buildDisplayHighlights(cle.bestBets).mostLikely.modelProbability, .7747);
  assert.equal(ui.buildDisplayHighlights(tb.bestBets).bestValue.selection, "Bucky Irving Under 2.5 receptions");
  for (const row of [cle, tb]) {
    assert.ok(row.bestBets.candidates.every((bet) => bet.market !== "Game total"));
    const markup = renderToStaticMarkup(createElement(ui.BestBetsPanel, { bestBets: row.bestBets,
      awayCode: row.awayCode, homeCode: row.homeCode, kickoff: row.kickoff }));
    assert.match(markup, /Model pick/);
    assert.match(markup, /Under/);
  }
});
test("L: stale player-prop markets cannot suppress independently fresh core bets", () => {
  const stale = structuredClone(odds);
  for (const event of stale.events) for (const book of event.bookmakers) for (const market of book.markets) {
    if (!market.key.startsWith("player_")) continue;
    market.last_update = "2026-10-19T00:00Z";
    for (const quote of market.outcomes) {
      quote.updatedAt = market.last_update;
      if (quote.quoteSource) quote.quoteSource.timestamp = market.last_update;
    }
  }
  const cle = displayed("CLE", stale);
  assert.ok(cle.bestBets.candidates.some((bet) => bet.market === "Moneyline" && bet.selection === "CLE"));
  assert.ok(cle.bestBets.candidates.every((bet) => bet.category === "Game"));
});

for (const saved of rows) test(`saved ${saved.awayCode}@${saved.homeCode} independently renders its eligible model TD pick`, () => {
  const row = displayed(saved.awayCode), pick = row.bestBets.anytimeTdModelPick;
  assert.ok(pick.modelPickEligible);
  assert.equal(pick.price, null);
  assert.ok(saved.playerProjections.away.players.concat(saved.playerProjections.home.players)
    .some((player) => player.personnelId === pick.personnelId && player.anytimeTouchdownProbability === pick.modelProbability));
  assert.ok(pick.roleConfidence >= .55);
  assert.equal(pick.bettingEligible, false);
  const markup = render(pick);
  assert.match(markup, /Model pick/);
  assert.doesNotMatch(markup, /No eligible TD betting recommendation|priced player candidate|0\.0%/);
  assert.equal(row.bestBets.anytimeTdScorer.source, "unavailable");
});

function allenCollision() {
  const snapshot = structuredClone(rows.find((row) => row.awayCode === "MIA"));
  const allen = snapshot.playerProjections.home.players.find((player) => player.playerName === "B.Allen");
  const hall = snapshot.playerProjections.home.players.find((player) => player.playerName === "B.Hall");
  assert.equal(allen.personnelId, "00-0039794");
  assert.equal(allen.anytimeTouchdownProbability, .4785);
  assert.equal(hall.anytimeTouchdownProbability, .4384);
  const view = snapshot.personnelViews.home;
  Object.assign(view.players.find((record) => record.canonicalId === allen.personnelId), { name: "Braelon Allen" });
  Object.assign(view.players.find((record) => record.canonicalId === hall.personnelId), { name: "Breece Hall" });
  return { snapshot, allen, hall, value: { game: snapshot, playerProjections: snapshot.playerProjections,
    personnelViews: snapshot.personnelViews, quoteAsOf: NOW } };
}

test("exact MIA-NYJ B. Allen / Braelon Allen / Breece Hall collision resolves only through canonical ID and matchup team", () => {
  const { snapshot, allen, value } = allenCollision(), before = structuredClone(snapshot);
  const pick = selectTdModelPick(value);
  assert.equal(pick.identityState, "MATCHED");
  assert.equal(pick.playerName, "Braelon Allen");
  assert.equal(pick.personnelId, allen.personnelId);
  assert.equal(pick.playerTeam, "NYJ");
  assert.equal(pick.modelProbability, .4785);
  assert.equal(pick.roleConfidence, 1);
  assert.equal(pick.availabilityKnown, false);
  assert.equal(pick.bettingEligible, false);
  const row = ui.enrichSavedPredictionWithCurrentMarket({ ...snapshot, bestBets: {
    ...snapshot.bestBets, anytimeTdModelPick: pick,
  } }, { away: "MIA", home: "NYJ" }, [], NOW);
  assert.equal(row.bestBets.anytimeTdModelPick.playerName, "Braelon Allen");
  const markup = render(pick);
  assert.match(markup, /Braelon Allen/);
  assert.match(markup, /47\.9%/);
  assert.match(markup, /Role 100%/);
  assert.doesNotMatch(markup, /Breece Hall/);
  assert.deepEqual(snapshot, before);
});

for (const [name, change] of [
  ["canonical full name is absent", ({ value, allen }) => {
    delete value.personnelViews.home.players.find((record) => record.canonicalId === allen.personnelId).name;
  }],
  ["conflicting full name on Allen's canonical record", ({ value, allen }) => {
    value.personnelViews.home.players.find((record) => record.canonicalId === allen.personnelId).name = "Breece Hall";
  }],
  ["duplicate canonical identity with conflicting names", ({ value, allen }) => {
    const record = value.personnelViews.home.players.find((row) => row.canonicalId === allen.personnelId);
    value.personnelViews.home.players.push({ ...record, name: "Breece Hall" });
  }],
]) test(`B. Allen returns AMBIGUOUS rather than guessing when ${name}`, () => {
  const fixture = allenCollision();
  change(fixture);
  const pick = selectTdModelPick(fixture.value);
  assert.equal(pick.identityState, "AMBIGUOUS");
  assert.equal(pick.primaryReason, "IDENTITY_AMBIGUOUS");
  assert.equal(pick.modelPickEligible, false);
  assert.equal(pick.modelProbability, null);
  assert.doesNotMatch(pick.selection, /Breece Hall/);
});

test("B. Allen cannot resolve through a canonical record from outside the saved matchup", () => {
  const { value } = allenCollision();
  value.game = { awayCode: "MIA", homeCode: "NE" };
  assert.equal(selectTdModelPick(value).modelPickEligible, false);
});
