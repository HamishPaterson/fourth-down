import test from "node:test";
import assert from "node:assert/strict";
import { savedGameIdentity } from "./savedGameIdentity.js";
import { findOddsForGame, resolveOddsForGame } from "./oddsApi.js";
import { savedBestBetsDisplay } from "./savedBestBetsDisplay.js";
import { BEST_BETS_CANDIDATE_VERSION } from "./bestBetsService.js";

const now = new Date("2026-10-28T00:00:00Z");
const snapshot = () => ({
  id: "8:CHI:SEA:2026-11-03T01:15Z", season: 2026, week: 8,
  awayCode: "CHI", homeCode: "SEA", kickoff: "2026-11-03T01:15:00Z",
  game: { id: "1392336", season: 2026, week: 8, away: "CHI", home: "SEA",
    sourceDate: "2026-11-03T01:15:00Z", venue: "Lumen Field" },
  bestBets: { candidateVersion: BEST_BETS_CANDIDATE_VERSION, candidates: [{
    category: "Game", market: "Moneyline", selection: "CHI", teamCode: "CHI",
    sportsbook: "Fanduel", price: 148, decimalOdds: 2.48, modelProbability: .501,
    marketProbability: .3904, edge: .1106, expectedValue: .24248,
  }], recommendations: [] },
});
const event = {
  id: "nfl_bears_seahawks_2026-11-02_b3", away_team: "CHI", home_team: "SEA",
  commence_time: "2026-11-03T01:16:00Z", bookmakers: [{ key: "fanduel", title: "Fanduel",
    last_update: now.toISOString(), markets: [{ key: "h2h", outcomes: [
      { name: "CHI", price: 148, quoteSource: { provider: "SharpAPI", id: "quote",
        eventId: "nfl_bears_seahawks_2026-11-02_b3", timestamp: now.toISOString(),
        snapshotId: `nfl:2026:8:moneyline:${now.toISOString()}` } },
    ] }] }],
};

test("saved canonical game remains separate from composite prediction ID across serialized client display", () => {
  const saved = JSON.parse(JSON.stringify(snapshot()));
  const before = structuredClone(saved);
  const game = savedGameIdentity(saved);
  assert.equal(game.id, "1392336");
  assert.notEqual(game.id, saved.id);
  const mapped = findOddsForGame([event], game);
  assert.equal(mapped.id, event.id);
  assert.equal(mapped.scheduleMapping.scheduleGameId, game.id);
  const display = savedBestBetsDisplay(saved, [event], now);
  assert.equal(display.candidates.length, 1);
  assert.equal(display.recommendations[0].selection, "CHI");
  assert.equal(display.recommendations[0].price, 148);
  assert.deepEqual(saved, before);
});

test("missing, malformed, composite or conflicting saved game identities fail closed", () => {
  const invalid = [
    { game: undefined }, { game: { ...snapshot().game, id: undefined } },
    ...["bad", snapshot().id, "0", "9007199254740992"].map((id) => ({ game: { ...snapshot().game, id } })),
    ...[{ season: 2025 }, { week: 7 }, { away: "SEA", home: "CHI" },
      { sourceDate: "2026-11-03T01:16:00Z" }].map((change) => ({ game: { ...snapshot().game, ...change } })),
  ];
  for (const change of invalid) {
    const saved = { ...snapshot(), ...change };
    assert.equal(savedGameIdentity(saved), null);
    const display = savedBestBetsDisplay(saved, [event], now);
    assert.equal(display.candidates.length, 0);
    assert.equal(display.displayDiagnostics[0].rejectionCode, "CANONICAL_GAME_IDENTITY_UNAVAILABLE");
  }
});

test("wrong audited ID/context, ambiguity and ineligible bets remain excluded", () => {
  for (const change of [{ id: "1392337" }, { season: 2025 }, { week: 7 }, { away: "SEA", home: "CHI" }]) {
    assert.equal(findOddsForGame([event], { ...savedGameIdentity(snapshot()), ...change }), null);
  }
  assert.equal(resolveOddsForGame([event, { ...event, id: "second" }],
    savedGameIdentity(snapshot())).status, "AMBIGUOUS");
  const saved = snapshot();
  saved.bestBets.candidates[0].edge = -.1;
  assert.equal(savedBestBetsDisplay(saved, [event], now).candidates.length, 0);
});

test("other 13 Week 8 mappings and canonical historical game mappings remain exact", () => {
  const pairs = ["CAR-GB", "BAL-BUF", "TEN-CIN", "ARI-DAL", "MIN-DET", "LV-NYJ",
    "CLE-PIT", "ATL-TB", "IND-JAX", "LAC-LAR", "KC-DEN", "NE-MIA", "PHI-WSH"];
  for (const week of [7, 8]) for (const pair of pairs) {
    const [away, home] = pair.split("-");
    const s = snapshot();
    Object.assign(s, { week, awayCode: away, homeCode: home });
    Object.assign(s.game, { week, away, home });
    const exact = { ...event, away_team: away, home_team: home, commence_time: s.kickoff };
    assert.equal(findOddsForGame([exact], savedGameIdentity(s)), exact);
  }
});
