import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { handleOddsRequest } from "../api/nfl/odds.js";
import { summarizeSnapshots } from "./oddsSnapshots.js";
import { findOddsForGame, getCoreMarket } from "../src/services/oddsApi.js";

const NOW = Date.parse("2026-10-27T07:12:54.783Z");
const kickoff = "2026-10-30T00:15:00.000Z";
const game = { season: 2026, week: 8, away: "CAR", home: "GB", sourceDate: kickoff };
const quote = (selection, price) => ({
  event_id: "week8-car-gb", event_start_time: kickoff,
  away_team: "Carolina Panthers", home_team: "Green Bay Packers",
  sportsbook: "fixture-book", market_type: "moneyline", selection,
  odds_american: price, timestamp: "2026-10-27T07:00:00.000Z",
});
const snapshot = (rows, extra = {}) => ({
  sport: "nfl", season: 2026, week: 8, market: "moneyline",
  provider: "SharpAPI", status: "ok", fetched_at: "2026-10-27T07:00:00.000Z",
  rows, row_count: rows.length, ...extra,
});
const current = () => snapshot([quote("Carolina Panthers", 160), quote("Green Bay Packers", -180)]);

async function readOnlyCore(snapshots) {
  const calls = [];
  const client = {
    from(table) {
      assert.equal(table, "odds_market_snapshots");
      calls.push("select");
      return { select() {
        const predicates = [];
        const query = {
          eq(key, value) { predicates.push((row) => row[key] === value); return query; },
          lt(key, value) { predicates.push((row) => row[key] < value); return query; },
          then(resolve, reject) {
            return Promise.resolve({ data: snapshots.filter((row) => predicates.every((fn) => fn(row))), error: null })
              .then(resolve, reject);
          },
        };
        return query;
      } };
    },
  };
  const res = { status(code) { assert.equal(code, 200); return this; },
    setHeader() {}, json(body) { this.body = body; return this; } };
  await handleOddsRequest({ method: "GET", url: "/api/nfl/odds" }, res, { client, now: NOW });
  assert.ok(calls.every((method) => method === "select"));
  return res.body;
}

let server, ui;
before(async () => {
  server = await createServer({
    server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    plugins: [{ name: "oddsmakers-handoff-test", transform(code, id) {
      if (id.replace(/\\/g, "/").endsWith("/src/pages/Predictions.jsx")) {
        return `${code}\nexport { enrichSavedPredictionWithCurrentMarket };`;
      }
    } }],
  });
  ui = await server.ssrLoadModule("/src/pages/Predictions.jsx");
});
after(async () => { await server?.close(); });

test("Week 8 read-only snapshot API, event mapping and median moneyline consensus preserve the market pick", async () => {
  const response = await readOnlyCore([current()]);
  const event = findOddsForGame(response.events, game);
  assert.equal(event.id, "week8-car-gb");
  assert.equal(getCoreMarket(event).pick, "GB");
  assert.equal(response.markets.find((market) => market.market === "moneyline").stale, false);
});

test("actual missing Week 8 core-market shape remains unavailable rather than becoming a model pick", async () => {
  const response = await readOnlyCore([snapshot([], { market: "player_rush_reception_yds" })]);
  assert.deepEqual(response.events, []);
  assert.equal(response.cacheStatus, "unavailable");
  assert.equal(getCoreMarket(findOddsForGame(response.events, game)).pick, null);
});

test("stale Week 8 data is explicitly marked stale by the existing snapshot contract", async () => {
  const old = current();
  old.fetched_at = "2026-10-25T00:00:00.000Z";
  const response = await readOnlyCore([old]);
  assert.equal(response.markets.find((market) => market.market === "moneyline").stale, true);
  assert.equal(summarizeSnapshots([old], ["moneyline"], NOW).cacheStatus, "stale-fallback");
});

test("finished prior-week odds cannot supply a Week 8 Oddsmakers Pick", async () => {
  const old = current();
  old.week = 7;
  old.rows = old.rows.map((row) => ({ ...row, event_start_time: "2026-10-23T00:15:00.000Z" }));
  const response = await readOnlyCore([old]);
  assert.equal(findOddsForGame(response.events, game), null);
});

test("wrong kickoff or event team identity cannot match the Week 8 game", async () => {
  const response = await readOnlyCore([current()]);
  assert.equal(findOddsForGame(response.events, { ...game, sourceDate: "2026-11-06T00:15:00.000Z" }), null);
  assert.equal(findOddsForGame(response.events, { ...game, away: "CHI" }), null);
});

test("CHI–SEA audited core prices reconcile only with complete schedule and snapshot provenance", async () => {
  const scheduledKickoff = "2026-11-03T01:15:00.000Z";
  const rows = [
    { selection: "Seattle Seahawks", odds_american: -176 },
    { selection: "Chicago Bears", odds_american: 148 },
  ].map((price) => ({
    ...quote(price.selection, price.odds_american),
    event_id: "nfl_bears_seahawks_2026-11-02_b3",
    away_team: "Chicago Bears", home_team: "Seattle Seahawks",
    event_start_time: "2026-11-03T01:16Z", sportsbook: "fanduel",
  }));
  rows.push(...rows.map((row) => ({ ...row, sportsbook: "draftkings", event_start_time: "2026-11-03T01:20Z" })));
  const response = await readOnlyCore([
    snapshot(rows),
    snapshot(rows.map((row) => ({ ...row, market_type: "point_spread",
      line: row.selection === "Seattle Seahawks" ? -3.5 : 3.5 })), { market: "point_spread" }),
    snapshot([{ ...rows[0], market_type: "total_points", selection: "Under", line: 46.5 }],
      { market: "total_points" }),
  ]);
  assert.equal(response.events.length, 1);
  assert.equal(getCoreMarket(response.events[0]).pick, "SEA");
  const scheduled = { season: 2026, week: 8, away: "CHI", home: "SEA", sourceDate: scheduledKickoff };
  assert.equal(findOddsForGame(response.events, scheduled), null);
  const display = ui.enrichSavedPredictionWithCurrentMarket({
    id: "8:CHI:SEA", awayCode: "CHI", homeCode: "SEA", oddsPick: null,
    fourthDownPick: "CHI", fourthDownAwayScore: 24, fourthDownHomeScore: 20,
    game: scheduled,
  }, scheduled, response.events, new Date(NOW));
  assert.equal(display.oddsPick, null);
  assert.match(renderToStaticMarkup(createElement(ui.PredictionCard, { prediction: display })), /No current market pick/);
  const verifiedSchedule = { ...scheduled, id: "1392336" };
  const reconciled = findOddsForGame(response.events, verifiedSchedule);
  assert.equal(reconciled.id, rows[0].event_id);
  assert.equal(reconciled.scheduleMapping.canonicalKickoff, scheduledKickoff);
  const verifiedDisplay = ui.enrichSavedPredictionWithCurrentMarket({
    id: "8:CHI:SEA", awayCode: "CHI", homeCode: "SEA", oddsPick: null,
    fourthDownPick: "CHI", fourthDownAwayScore: 24, fourthDownHomeScore: 20,
    game: verifiedSchedule,
  }, verifiedSchedule, response.events, new Date(NOW));
  assert.equal(verifiedDisplay.oddsPick, "SEA");
  const html = renderToStaticMarkup(createElement(ui.PredictionCard, { prediction: verifiedDisplay }));
  assert.match(html, /Seattle Seahawks/);
  assert.doesNotMatch(html, /No current market pick/);
});

test("invalid or one-sided moneyline prices leave consensus unavailable", async () => {
  for (const price of [null, 0, "not-a-price"]) {
    const response = await readOnlyCore([snapshot([quote("Carolina Panthers", price), quote("Green Bay Packers", -180)])]);
    assert.equal(getCoreMarket(findOddsForGame(response.events, game)).pick, null);
  }
});

test("equal moneyline consensus remains unavailable", async () => {
  const response = await readOnlyCore([snapshot([quote("Carolina Panthers", -110), quote("Green Bay Packers", -110)])]);
  assert.equal(getCoreMarket(findOddsForGame(response.events, game)).pick, null);
});

test("consensus uses per-team median implied American-price probability rather than one bookmaker", async () => {
  const rows = [
    { ...quote("Carolina Panthers", 160), sportsbook: "first" },
    { ...quote("Green Bay Packers", -180), sportsbook: "first" },
    { ...quote("Carolina Panthers", 140), sportsbook: "second" },
    { ...quote("Green Bay Packers", -160), sportsbook: "second" },
    { ...quote("Carolina Panthers", -500), sportsbook: "outlier" },
    { ...quote("Green Bay Packers", 400), sportsbook: "outlier" },
  ];
  const response = await readOnlyCore([snapshot(rows)]);
  assert.equal(getCoreMarket(findOddsForGame(response.events, game)).pick, "GB");
});

test("existing client spread/total fallback remains market-derived without moneyline", async () => {
  const base = quote("Green Bay Packers", -110);
  const response = await readOnlyCore([
    snapshot([{ ...base, market_type: "point_spread", line: -3 }], { market: "point_spread" }),
    snapshot([{ ...base, market_type: "total_points", selection: "Over", selection_type: "over", line: 45 }],
      { market: "total_points" }),
  ]);
  const saved = { id: "8:CAR:GB", season: 2026, week: 8, awayCode: "CAR", homeCode: "GB",
    kickoff, fourthDownPick: "CAR", fourthDownAwayScore: 24, fourthDownHomeScore: 20, oddsPick: null, game };
  const display = ui.enrichSavedPredictionWithCurrentMarket(saved, game, response.events, new Date(NOW));
  assert.equal(display.oddsPick, "GB");
  assert.equal(display.marketAwayScore, 21);
  assert.equal(display.marketHomeScore, 24);
});

test("missing moneyline is not substituted with ESPN, NFLverse or Fourth Down output", () => {
  assert.equal(getCoreMarket({
    ...game, away_team: "CAR", home_team: "GB", bookmakers: [],
    fourthDownPick: "CAR", espnFpiPick: "GB", nflversePick: "CAR",
  }).pick, null);
});

test("valid Week 8 pick survives client and rendered card without player artifact or saved market pick", async () => {
  const response = await readOnlyCore([current()]);
  const saved = { id: "8:CAR:GB", season: 2026, week: 8, awayCode: "CAR", homeCode: "GB",
    kickoff, fourthDownPick: "CAR", fourthDownAwayScore: 24, fourthDownHomeScore: 20,
    oddsPick: null, playerProjections: null, game };
  const display = ui.enrichSavedPredictionWithCurrentMarket(saved, game, response.events, new Date(NOW));
  assert.equal(display.oddsPick, "GB");
  const html = renderToStaticMarkup(createElement(ui.PredictionCard, { prediction: display }));
  assert.match(html, /Odds makers pick/);
  assert.match(html, /Green Bay Packers/);
  assert.match(html, /Disagreement/);
});

test("unavailable market survives client/render handoff without borrowing Fourth Down pick", async () => {
  const saved = { id: "8:CAR:GB", season: 2026, week: 8, awayCode: "CAR", homeCode: "GB",
    kickoff, fourthDownPick: "CAR", fourthDownAwayScore: 24, fourthDownHomeScore: 20, oddsPick: null, game };
  const display = ui.enrichSavedPredictionWithCurrentMarket(saved, game, [], new Date(NOW));
  assert.equal(display.oddsPick, null);
  const html = renderToStaticMarkup(createElement(ui.PredictionCard, { prediction: display }));
  assert.match(html, /No current market pick/);
});
