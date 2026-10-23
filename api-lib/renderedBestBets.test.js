import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { refreshPredictionLedger } from "../src/services/predictionLedger.js";
import { savedBestBetsDisplay } from "../src/services/savedBestBetsDisplay.js";
import { refreshSavedBestBets } from "./serverPredictions.js";
const rows = JSON.parse(readFileSync(new URL("./fixtures/week7-rendered-bets.json", import.meta.url)));
const odds = JSON.parse(readFileSync(new URL("./fixtures/week7-rendered-quotes.json", import.meta.url)));
const NOW = new Date("2026-10-23T03:30:00Z");
const quoteEvents = (snapshot) => [{
  id: "saved-matchup", away_team: snapshot.awayCode, home_team: snapshot.homeCode,
  commence_time: snapshot.kickoff,
  bookmakers: (snapshot.bestBets.candidates || []).filter((bet) => bet.category === "Game").map((bet) => ({
    key: bet.sportsbook.toLowerCase(), title: bet.sportsbook, last_update: NOW.toISOString(),
    markets: [{ key: bet.market === "Moneyline" ? "h2h" : "spreads",
      outcomes: [{ name: bet.teamCode, price: bet.price, point: bet.line }] }],
  })),
}];

test("full shared ledger remains usable when browser persistence throws QuotaExceededError", async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch, previousWarn = console.warn;
  const warnings = [], calls = [];
  globalThis.window = { localStorage: { getItem: () => null, setItem: () => {
    const error = new Error("Quota reached"); error.name = "QuotaExceededError"; throw error;
  } }, dispatchEvent() {} };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const snapshots = rows.map((row) => ({ ...row,
      dataQuality: { ...row.dataQuality, diagnosticPadding: "x".repeat(400000) },
    }));
    const body = JSON.stringify({ snapshots });
    assert.ok(body.length > 5 * 1024 * 1024);
    return { ok: true, text: async () => body };
  };
  console.warn = (...args) => warnings.push(args);
  try {
    const loaded = await refreshPredictionLedger({ season: 2026, week: 7, displayBets: true });
    assert.equal(loaded.length, 14);
    for (const row of rows) {
      const actual = loaded.find((candidate) => candidate.id === row.id);
      assert.deepEqual(actual.bestBets, row.bestBets);
      assert.deepEqual(actual.playerProjections, row.playerProjections);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, undefined);
    assert.match(calls[0].url, /bets=display/);
    assert.match(warnings[0][0], /remain available in memory/);
    assert.equal(warnings[0][1], "QuotaExceededError");
  } finally {
    globalThis.window = previousWindow; globalThis.fetch = previousFetch; console.warn = previousWarn;
  }
});

let server, ui;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    plugins: [{ name: "rendered-bets-test-exports", transform(code, id) {
      if (id.replace(/\\/g, "/").endsWith("/src/pages/Predictions.jsx"))
        return `${code}\nexport { BestBetsPanel, enrichSavedPredictionWithCurrentMarket, buildDisplayHighlights };`;
    } }] });
  ui = await server.ssrLoadModule("/src/pages/Predictions.jsx");
});
after(async () => { await server?.close(); });

for (const originalSnapshot of rows) {
  const snapshot = refreshSavedBestBets(originalSnapshot, odds, NOW, { displayOnly: true });
  test(`Production-shaped ${snapshot.awayCode}@${snapshot.homeCode} retains only eligible saved candidates through render`, () => {
    const original = structuredClone(snapshot), events = odds.events;
    const display = savedBestBetsDisplay(snapshot, events, NOW);
    assert.ok(display.candidates.every((bet) => bet.edge >= .045 && bet.expectedValue >= .03));
    assert.equal(display.candidates.length, snapshot.bestBets.candidates.length);
    const mapped = ui.enrichSavedPredictionWithCurrentMarket(snapshot, { away: snapshot.awayCode,
      home: snapshot.homeCode }, events, NOW);
    const markup = renderToStaticMarkup(createElement(ui.BestBetsPanel, {
      bestBets: mapped.bestBets, kickoff: snapshot.kickoff,
      awayCode: snapshot.awayCode, homeCode: snapshot.homeCode,
    }));
    for (const bet of display.candidates) assert.ok(markup.includes(bet.selection));
    if (display.candidates.length) assert.doesNotMatch(markup, /None qualified|No Best Bets/);
    else assert.match(markup, /None qualified/);
    assert.match(markup, /Model pick/);
    assert.ok(mapped.bestBets.anytimeTdModelPick.modelPickEligible);
    assert.doesNotMatch(markup, /No player touchdown projection was available|No eligible TD betting recommendation|(?<![\d.])0\.0%/);
    assert.deepEqual(snapshot, original);
  });
}

test("legacy highlight-only rejected offers never become recommendations", () => {
  const snapshot = rows.find((row) => row.awayCode === "PIT");
  assert.equal(ui.buildDisplayHighlights(snapshot.bestBets).mostLikely, null);
  assert.equal(ui.buildDisplayHighlights(snapshot.bestBets).bestValue, null);
});

test("fresh spread survives while stale quote, changed price and missing quote are rejected independently", () => {
  const snapshot = refreshSavedBestBets(rows.find((row) => row.awayCode === "IND"), odds, NOW, { displayOnly: true });
  const events = quoteEvents(snapshot);
  const ml = events[0].bookmakers.find((book) => book.markets[0].key === "h2h");
  ml.last_update = "2026-10-19T00:00Z";
  const display = savedBestBetsDisplay(snapshot, events, NOW);
  assert.ok(display.candidates.some((bet) => bet.market === "Spread"));
  assert.ok(!display.candidates.some((bet) => bet.market === "Moneyline"));
  assert.equal(display.displayDiagnostics.find((row) => row.market === "Moneyline").rejectionCode, "PRICE_STALE");
  const changed = quoteEvents(snapshot);
  changed[0].bookmakers.forEach((book) => { book.markets[0].outcomes[0].price = -999; });
  assert.equal(savedBestBetsDisplay(snapshot, changed, NOW).candidates.length, 0);
  assert.equal(savedBestBetsDisplay(snapshot, [], NOW).candidates.length, 0);
});

test("all 14 current quote assessments preserve saved model bodies, with stale totals quarantined", () => {
  const expected = [2, 0, 2, 2, 2, 2, 2, 2, 5, 3, 3, 0, 0, 0];
  rows.forEach((snapshot, index) => {
    const before = structuredClone(snapshot);
    const assessment = refreshSavedBestBets(snapshot, odds, NOW, { displayOnly: true });
    assert.equal(assessment.bestBets.candidates.length, expected[index]);
    assert.ok(assessment.bestBets.candidates.every((bet) => bet.market !== "Game total"));
    assert.deepEqual(assessment.predictionPayload, before.predictionPayload);
    assert.deepEqual(assessment.playerProjections, before.playerProjections);
    assert.deepEqual(snapshot, before);
  });

  test("missing quotes for one matchup cannot suppress the other 13 matchups", () => {
    const missing = { events: odds.events.filter((event) => !["NE", "New England Patriots"].includes(event.away_team)) };
    const assessed = rows.map((snapshot) => refreshSavedBestBets(snapshot, missing, NOW, { displayOnly: true }));
    assert.equal(assessed[0].bestBets.candidates.length, 0);
    rows.slice(1).forEach((snapshot, index) => assert.deepEqual(assessed[index + 1].bestBets.candidates,
      refreshSavedBestBets(snapshot, odds, NOW, { displayOnly: true }).bestBets.candidates));
  });
});

test("page retains returned shared rows and never rereads failed persistence after a successful fetch", () => {
  const source = readFileSync(new URL("../src/pages/Predictions.jsx", import.meta.url), "utf8");
  assert.match(source, /ledger = await refreshPredictionLedger\(/);
  assert.doesNotMatch(source, /await refreshPredictionLedger\([\s\S]*?\}\);\s*ledger = readPredictionLedger/);
});
