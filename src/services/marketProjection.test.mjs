import test from "node:test";
import assert from "node:assert/strict";
import { computeMarketProjection } from "./predictionEngine.js";
import handler, { TEAM_FORM_STATS_AVAILABLE } from "../../api/nfl/game-stats.js";
import { handler as teamForm } from "../../api/nfl/game-stats.js";

const book = (key, markets) => ({ key, markets });
const h2h = (home, away) => ({ key: "h2h", outcomes: [{ name: "Tampa Bay Buccaneers", price: home }, { name: "Carolina Panthers", price: away }] });
const totals = (point) => ({ key: "totals", outcomes: [{ name: "Over", point, price: 1.91 }, { name: "Under", point, price: 1.91 }] });
const spreads = (point) => ({ key: "spreads", outcomes: [{ name: "Tampa Bay Buccaneers", point, price: 1.91 }, { name: "Carolina Panthers", point: -point, price: 1.91 }] });
const event = (books) => ({ home_team: "Tampa Bay Buccaneers", away_team: "Carolina Panthers", bookmakers: books });

test("a posted spread is used as before", () => {
  const market = computeMarketProjection(event([book("a", [h2h(1.5, 2.6), spreads(-3.5), totals(44.5)]),
    book("b", [h2h(1.52, 2.55), spreads(-3.5), totals(44.5)])]), 12);
  assert.equal(market.active, true);
  assert.equal(market.spreadSource, "spread");
  assert.equal(market.homeSpread, -3.5);
  assert.equal(market.effectiveWeight, 0.08);
});

test("before spreads are posted, the moneyline supplies the bookmaker margin at slightly lower weight", () => {
  const market = computeMarketProjection(event([book("a", [h2h(1.5, 2.6), totals(44.5)]),
    book("b", [h2h(-200, 220), totals(44.5)])]), 12);
  assert.equal(market.active, true);
  assert.equal(market.spreadSource, "moneyline");
  assert.ok(market.homeSpread < -3.5 && market.homeSpread > -6, String(market.homeSpread));
  assert.equal(market.total, 44.5);
  assert.equal(market.awayExpected + market.homeExpected, 44.5);
  assert.equal(market.effectiveWeight, 0.072);
});

test("a moneyline alone, or one without a clear home side, is not a market projection", () => {
  assert.equal(computeMarketProjection(event([book("a", [h2h(1.5, 2.6)])]), 12).active, false);
  const unnamed = { key: "h2h", outcomes: [{ name: "Somebody", price: 1.5 }, { name: "Else", price: 2.6 }] };
  assert.equal(computeMarketProjection(event([book("a", [unnamed, totals(44.5)])]), 12).active, false);
  const lopsided = { key: "h2h", outcomes: [{ name: "Tampa Bay Buccaneers", price: -100000 }, { name: "Carolina Panthers", price: 90000 }] };
  assert.equal(computeMarketProjection(event([book("a", [lopsided, totals(44.5)])]), 12).active, false);
});

test("team form never calls the stats feed our plan does not include", async () => {
  assert.equal(TEAM_FORM_STATS_AVAILABLE, false);
  assert.equal(typeof handler, "function");
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (url) => { requests.push(String(url)); throw new Error("no provider calls expected"); };
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; } };
  try {
    await teamForm({ method: "GET", query: { season: "2026", week: "12", away: "CAR", home: "TB" } }, res);
  } finally { globalThis.fetch = original; }
  assert.deepEqual(requests, []);
  assert.equal(res.code, 200);
  assert.equal(res.body.sampleGames, 0);
  assert.equal(res.body.modelLayers.scoringBaseline.active, false);
});

test("server team form builds the scoring baseline from real final scores without the stats feed", async () => {
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (url) => { requests.push(String(url)); throw new Error("no provider calls expected"); };
  const game = (id, week, away, home, awayScore, homeScore) => ({ id, season: 2026, week, status: "Final",
    date: `2026-10-${String(week).padStart(2, "0")}T18:00:00Z`, visitor_team: { abbreviation: away }, home_team: { abbreviation: home },
    visitor_team_score: awayScore, home_team_score: homeScore });
  const predictionSeasonGames = [game(1, 2, "CAR", "NO", 31, 10), game(2, 3, "TB", "ATL", 14, 17), game(3, 4, "CAR", "ATL", 28, 20),
    game(4, 5, "NO", "TB", 24, 13), game(5, 12, "CAR", "TB", null, null)];
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; } };
  try {
    await teamForm({ method: "GET", predictionSeasonGames, query: { season: "2026", week: "12", away: "CAR", home: "TB" } }, res);
  } finally { globalThis.fetch = original; }
  assert.deepEqual(requests, []);
  const baseline = res.body.modelLayers.scoringBaseline;
  assert.equal(baseline.active, true);
  assert.deepEqual(baseline.gamesUsed, { away: 2, home: 2 });
  assert.ok(baseline.awayExpected > baseline.homeExpected, "CAR scored more and TB allowed more");
  assert.equal(res.body.modelLayers.redZone.active, false);
});
