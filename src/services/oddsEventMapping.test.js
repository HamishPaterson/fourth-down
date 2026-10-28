import test from "node:test";
import assert from "node:assert/strict";
import { findOddsForGame, resolveOddsForGame } from "./oddsApi.js";

const game = { id: "1392336", season: 2026, week: 8, away: "CHI", home: "SEA",
  kickoff: "2026-11-03T01:15:00.000Z" };
const event = (minutes = 1) => ({
  id: "nfl_bears_seahawks_2026-11-02_b3",
  away_team: "Chicago Bears", home_team: "Seattle Seahawks",
  commence_time: new Date(Date.parse(game.kickoff) + minutes * 60000).toISOString(),
  bookmakers: [{ key: "fanduel", markets: [{ key: "h2h", outcomes: [
    { name: "Chicago Bears", price: 148 }, { name: "Seattle Seahawks", price: -176 },
  ].map((quote) => ({ ...quote, quoteSource: { provider: "SharpAPI",
    eventId: "nfl_bears_seahawks_2026-11-02_b3",
    snapshotId: "nfl:2026:8:moneyline:2026-10-27T12:34:16.964Z" } })) }] }],
});

test("exact kickoff matching retains the original event without reconciliation", () => {
  const exact = event(0);
  assert.equal(findOddsForGame([exact], game), exact);
  assert.equal(resolveOddsForGame([exact], game).status, "EXACT");
});

test("audited CHI–SEA one-minute and five-minute shifts retain both identities and discrepancy provenance", () => {
  for (const minutes of [1, 5]) {
    const source = event(minutes), before = structuredClone(source);
    const result = resolveOddsForGame([source], game);
    assert.equal(result.status, "RECONCILED");
    assert.equal(result.event.id, source.id);
    assert.equal(result.event.commence_time, source.commence_time);
    assert.equal(result.event.bookmakers, source.bookmakers);
    assert.deepEqual(result.event.scheduleMapping, {
      status: "RECONCILED", rule: "2026-week-8-chi-sea-kickoff",
      season: 2026, week: 8, scheduleGameId: game.id, providerEventId: source.id,
      canonicalKickoff: game.kickoff, providerKickoff: source.commence_time,
      discrepancyMs: minutes * 60000, toleranceMs: 300000,
    });
    assert.deepEqual(source, before);
    assert.equal(game.kickoff, "2026-11-03T01:15:00.000Z");
  }
});

test("reconciliation rejects six minutes, reversed/unrelated teams, wrong season/week and unproven schedule identity", () => {
  assert.equal(findOddsForGame([event(6)], game), null);
  for (const wrong of [
    { ...game, away: "SEA", home: "CHI" }, { ...game, away: "CAR" },
    { ...game, season: 2025 }, { ...game, week: 7 }, { ...game, season: undefined },
    { ...game, week: undefined }, { ...game, id: "different-game" },
    { ...game, kickoff: "2026-11-03T01:14:00.000Z" },
  ]) assert.equal(findOddsForGame([event()], wrong), null);
  assert.equal(findOddsForGame([{ ...event(), away_team: "Seattle Seahawks", home_team: "Chicago Bears" }], game), null);
  assert.equal(findOddsForGame([{ ...event(), week: 7 }], game), null);
  assert.equal(findOddsForGame([{ ...event(), season: 2025 }], game), null);
});

test("a second candidate within tolerance is AMBIGUOUS even with a different provider event ID", () => {
  assert.equal(resolveOddsForGame([event(), event()], game).status, "AMBIGUOUS");
  assert.equal(resolveOddsForGame([event(), { ...event(5), id: "second-event" }], game).status, "AMBIGUOUS");
  assert.equal(resolveOddsForGame([event(), event(6)], game).status, "RECONCILED");
});

test("wrong or missing quote season/week/provider/event provenance cannot reconcile", () => {
  for (const change of [
    { snapshotId: "nfl:2026:7:moneyline:2026-10-27T12:34:16Z" },
    { snapshotId: "nfl:2025:8:moneyline:2026-10-27T12:34:16Z" },
    { provider: "unverified" }, { eventId: "different-event" }, { snapshotId: null },
  ]) {
    const source = event();
    Object.assign(source.bookmakers[0].markets[0].outcomes[0].quoteSource, change);
    assert.equal(resolveOddsForGame([source], game).status, "PROVENANCE_UNAVAILABLE");
  }
  assert.equal(findOddsForGame([{ ...event(), id: "unverified-event" }], game), null);
});

test("other 13 Week 8 mappings and historical Week 7 retain exact-only behavior", () => {
  const pairs = ["CAR-GB", "BAL-BUF", "TEN-CIN", "ARI-DAL", "MIN-DET", "LV-NYJ", "CLE-PIT",
    "ATL-TB", "IND-JAX", "LAC-LAR", "KC-DEN", "NE-MIA", "PHI-WSH"];
  for (const [away, home] of pairs.map((pair) => pair.split("-"))) {
    const target = { ...game, id: `${away}-${home}`, away, home };
    const exact = { id: target.id, away_team: away, home_team: home, commence_time: target.kickoff };
    assert.equal(findOddsForGame([exact], target), exact);
    assert.equal(findOddsForGame([{ ...exact, commence_time: event().commence_time }], target), null);
  }
  const historical = { ...game, season: 2026, week: 7, kickoff: "2026-10-26T01:15:00.000Z" };
  const exact = { ...event(), commence_time: historical.kickoff };
  assert.equal(findOddsForGame([exact], historical), exact);
  assert.equal(findOddsForGame([{ ...exact, commence_time: "2026-10-26T01:16:00.000Z" }], historical), null);
});
