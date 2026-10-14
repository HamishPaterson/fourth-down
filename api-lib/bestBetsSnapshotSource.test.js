import test from "node:test";
import assert from "node:assert/strict";
import { getNflOddsWithProps } from "../src/services/oddsApi.js";

const core = { id: "e1", away_team: "A", home_team: "H", bookmakers: [{ key: "b", markets: [{ key: "h2h", outcomes: [{ name: "A", price: 100 }] }] }] };
const prop = { id: "e1", away_team: "A", home_team: "H", bookmakers: [{ key: "b", markets: [{ key: "player_pass_yds", outcomes: [{ name: "Over", price: -110 }] }] }] };

test("Best Bets loads core odds and stored player snapshots, never the live props path", async () => {
  const urls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    const events = String(url).includes("props=1") ? [prop] : [core];
    return { ok: true, status: 200, text: async () => JSON.stringify({ events }) };
  };
  try {
    const events = await getNflOddsWithProps(undefined, { forceRefresh: true });
    assert.deepEqual(urls.sort(), ["/api/nfl/odds", "/api/nfl/odds?props=1&source=snapshot"]);
    assert.ok(urls.every((url) => !url.includes("refreshMarket") && !url.includes("weeklyMultiRefresh")));
    assert.deepEqual(events[0].bookmakers[0].markets.map((m) => m.key), ["h2h", "player_pass_yds"]);
  } finally {
    global.fetch = original;
  }
});

test("an unavailable or failing props snapshot leaves core odds unchanged without fabricating props", async () => {
  const original = global.fetch;
  global.fetch = async (url) =>
    String(url).includes("props=1")
      ? { ok: true, status: 200, text: async () => JSON.stringify({ events: [], cacheStatus: "unavailable" }) }
      : { ok: true, status: 200, text: async () => JSON.stringify({ events: [core] }) };
  try {
    const events = await getNflOddsWithProps(undefined, { forceRefresh: true });
    assert.deepEqual(events, [core]);
  } finally {
    global.fetch = original;
  }
});
