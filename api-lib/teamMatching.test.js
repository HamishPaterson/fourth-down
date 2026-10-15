import test from "node:test";
import assert from "node:assert/strict";
import { findOddsForGame, getCoreMarket, resolveTeamCode } from "../src/services/oddsApi.js";

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

const panthersEvent = {
  id: "nfl_eagles_panthers_2026-10-18_b2",
  away_team: "Carolina Panthers", home_team: "Philadelphia Eagles", commence_time: "2026-10-18T17:00Z",
  bookmakers: [{ key: "draftkings", markets: [
    { key: "h2h", outcomes: [{ name: "CAR Panthers", price: -105 }, { name: "PHI Eagles", price: -115 }] },
    { key: "spreads", outcomes: [{ name: "CAR Panthers", point: -1.5, price: 102 }, { name: "PHI Eagles", point: 1.5, price: -122 }] },
    { key: "totals", outcomes: [{ name: "Over", point: 40.5, price: -110 }, { name: "Under", point: 40.5, price: -110 }] },
  ] }],
};

test("stored Panthers @ Eagles moneyline spread and total attach through canonical identities and kickoff", () => {
  assert.equal(resolveTeamCode("Carolina Panthers"), "CAR");
  assert.equal(resolveTeamCode("CAR Panthers"), "CAR");
  assert.equal(resolveTeamCode("Philadelphia Eagles"), "PHI");
  assert.equal(resolveTeamCode("PHI Eagles"), "PHI");
  const event = findOddsForGame([panthersEvent], { id: "1392302", away: "CAR", home: "PHI", sourceDate: "2026-10-18T17:00:00.000Z" });
  assert.equal(event, panthersEvent);
  assert.deepEqual(event.bookmakers[0].markets.map((m) => m.key), ["h2h", "spreads", "totals"]);
  assert.deepEqual(getCoreMarket(event), { away: 21, home: 19.5, total: 40.5, homeSpread: 1.5, pick: "PHI" });
});

test("a split spread consensus does not hide a real moneyline favourite", () => {
  const book = structuredClone(panthersEvent.bookmakers[0]);
  book.markets[1].outcomes[0].point = 1.5;
  book.markets[1].outcomes[1].point = -1.5;
  const result = getCoreMarket({ ...panthersEvent, bookmakers: [...panthersEvent.bookmakers, book] });
  assert.equal(result.away, result.home);
  assert.equal(result.pick, "PHI");
});

test("canonical identity never reverses orientation or cross-matches a different Carolina/Philadelphia event", () => {
  const anotherWeek = { ...panthersEvent, id: "another-week", commence_time: "2026-12-20T17:00Z" };
  const events = [anotherWeek, panthersEvent, withMarkets("other-opponent", "Carolina Panthers", "Dallas Cowboys")];
  assert.equal(findOddsForGame(events, { away: "CAR", home: "PHI", kickoff: panthersEvent.commence_time }), panthersEvent);
  assert.equal(findOddsForGame(events, { away: "CAR", home: "PHI" }), null);
  assert.equal(findOddsForGame(events, { away: "PHI", home: "CAR" }), null);
  assert.equal(findOddsForGame(events, { away: "CAR", home: "PHI", kickoff: "2026-11-01T17:00Z" }), null);
  assert.equal(findOddsForGame(events, { away: "CAR", home: "SF", kickoff: panthersEvent.commence_time }), null);
});
