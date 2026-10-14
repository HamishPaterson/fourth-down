import test from "node:test";
import assert from "node:assert/strict";
import { findOddsForGame } from "../src/services/oddsApi.js";

const withMarkets = (id, away, home) => ({
  id,
  away_team: away,
  home_team: home,
  bookmakers: [{ key: "b", markets: [{ key: "h2h", outcomes: [{ name: away, price: 250 }, { name: home, price: -300 }] }] }],
});

test("provider 'ARI Cardinals' attaches its stored odds to the Cardinals @ Rams game", () => {
  const events = [
    withMarkets("other", "Buffalo Bills", "Las Vegas Raiders"),
    withMarkets("ari", "ARI Cardinals", "Los Angeles Rams"),
  ];
  const found = findOddsForGame(events, { away: "ARI", home: "LAR" });
  assert.equal(found?.id, "ari");
  assert.equal(found.bookmakers[0].markets[0].outcomes[0].price, 250);
  assert.equal(findOddsForGame(events, { away: "Arizona Cardinals", home: "Los Angeles Rams" })?.id, "ari");
});

test("a team-code-prefixed nickname does not match a different team", () => {
  const events = [withMarkets("ari", "ARI Cardinals", "Los Angeles Rams")];
  assert.equal(findOddsForGame(events, { away: "SF", home: "LAR" }), null);
});
