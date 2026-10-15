import test from "node:test";
import assert from "node:assert/strict";
import { validateOddsEvents } from "../src/services/quoteValidation.js";
import { buildBestBets } from "../src/services/bestBetsService.js";
import { buildWeeklyMultiSelection } from "./weeklyMulti.js";
import { handleOddsRequest } from "../api/nfl/odds.js";

const NOW = new Date("2026-10-15T03:16:31Z");
const QUOTE = "2026-10-14T20:00:00Z";
const KICKOFF = "2026-10-18T17:00:00Z";
const context = { season: 2026, week: 6, lockAt: "2026-10-15T00:00:00Z" };
const decimal = price => price > 0 ? 1 + price / 100 : 1 + 100 / -price;

function outcome(player, side, line, price, extra = {}) {
  return {
    name: side, playerName: player, playerId: player, point: line, price,
    period: "full_game", updatedAt: QUOTE,
    quoteSource: {
      id: `${player}-${side}-${line}-${price}`, eventId: "event",
      playerName: player, market: "player_receiving_yards", marketId: `${player}-${line}`,
      side: side.toLowerCase(), line, americanOdds: price, decimalOdds: decimal(price),
      isMainLine: true, isAlternateLine: false, isActive: true, isLive: false, timestamp: QUOTE,
      ...extra,
    },
  };
}
const pair = (player, line = 49.5, over = -110, under = -110, extra = {}) => [
  outcome(player, "Over", line, over, extra), outcome(player, "Under", line, under, extra),
];
const book = (key, rows, market = "player_reception_yds") => ({
  key, title: key, last_update: QUOTE, markets: [{ key: market, last_update: QUOTE, outcomes: rows }],
});
const event = (books) => ({ id: "event", away_team: "SEA", home_team: "DEN",
  commence_time: KICKOFF, bookmakers: books });
const validate = e => validateOddsEvents([e], { now: NOW });
const checked = result => result.events[0].bookmakers.flatMap(b => b.markets.flatMap(m => m.outcomes));
const reasons = row => row.quoteValidation.reasons;

function brokenLadder() {
  return event([
    book("draftkings", [
      ...pair("Normal One"), ...pair("Normal Two"), ...pair("Normal Three"), ...pair("Normal Four"),
      outcome("Named Receiver", "Over", 69.5, 1500),
    ]),
    book("fanduel", [outcome("Named Receiver", "Over", 89.5, -122)]),
  ]);
}
function input(oddsEvent = brokenLadder()) {
  return {
    game: { away: "SEA", home: "DEN", season: 2026, week: 6 },
    prediction: { away: { code: "SEA", score: 31 }, home: { code: "DEN", score: 20 },
      awayWinProbability: .8, homeWinProbability: .2, confidenceScore: .8 },
    playerProjections: ["Named Receiver", "Normal One", "Normal Two"].map(playerName => ({
      playerName, team: "SEA", position: "WR", receivingYards: 120, rushingYards: 80,
      roleConfidence: .9, dataQuality: .9,
    })),
    oddsEvent, dataQuality: { playByPlay: true, teamForm: true, personnel: true,
      sources: { odds: { available: true } } },
    asOf: NOW.toISOString(), quoteAsOf: NOW,
  };
}
function saved(away, home, bestBets) {
  return { season: 2026, week: 6, awayCode: away, homeCode: home, kickoff: KICKOFF,
    bestBets, dataQuality: { sources: { odds: { available: true } } } };
}

test("unpaired +1500-style quote is quarantined with ladder evidence, never repriced", () => {
  const original = brokenLadder(), before = JSON.stringify(original);
  const result = validate(original);
  const bad = result.quarantined.find(o => o.price === 1500);
  assert.deepEqual(bad.quoteValidation.reasons, ["missing_market_pair", "inconsistent_market_ladder"]);
  assert.equal(bad.decimalOdds, 16);
  assert.equal(bad.source.americanOdds, 1500);
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.quarantined.length, 1);
  assert.ok(checked(result).filter(o => o.price !== 1500).every(o => o.quoteValidation.status === "validated"));
});

test("quarantine is persistent diagnostic data, not an optional audit-only field", () => {
  const best = buildBestBets(input());
  assert.equal(best.quarantinedOffers.length, 1);
  assert.equal(best.marketDiagnostics.quarantinedOffers, 1);
  assert.equal(best.quarantinedOffers[0].source.americanOdds, 1500);
  assert.ok(![...best.candidates, ...best.recommendations].some(b => b.price === 1500));
  assert.ok(best.candidates.some(b => b.selection.includes("89.5")));
  assert.ok(best.candidates.every(b => b.quoteValidation.status === "validated"));
});

test("Weekly Multi independently rejects an anomalous legacy stored candidate before ranking", () => {
  const best = { candidates: [{ market: "Receiving yards", selection: "Named Receiver Over 69.5 receiving yards",
    sportsbook: "draftkings", line: 69.5, price: 1500, decimalOdds: 16,
    modelProbability: .95, roleConfidence: .9, updatedAt: QUOTE }] };
  const result = buildWeeklyMultiSelection([saved("SEA", "DEN", best)],
    { cacheStatus: "fresh", events: [brokenLadder()] }, context, NOW);
  assert.equal(result.legs.length, 0);
  assert.equal(result.quarantinedOffers.length, 1);
  assert.equal(result.quarantinedOffers[0].price, 1500);
});

test("a stale persisted candidate cannot borrow a valid current offer's identity but retain another price", () => {
  const e = event([book("draftkings", pair("Named Receiver"))]);
  const bets = { candidates: [{ market: "Receiving yards", selection: "Named Receiver Over 49.5 receiving yards",
    sportsbook: "draftkings", line: 49.5, price: 1500, decimalOdds: 16, modelProbability: .8, updatedAt: QUOTE }] };
  assert.equal(buildWeeklyMultiSelection([saved("SEA", "DEN", bets)],
    { cacheStatus: "fresh", events: [e] }, context, NOW).legs.length, 0);
});

test("normal pairs and legitimate long odds survive without a blanket odds cap", () => {
  const result = validate(event([book("book", [
    ...pair("Normal"), ...pair("Longshot", 99.5, 1500, -2500),
  ])]));
  assert.equal(result.quarantined.length, 0);
  assert.equal(checked(result).find(o => o.price === 1500).quoteValidation.status, "validated");
});

test("different lines are not equivalent offers and ordinary ladder movement is accepted", () => {
  const result = validate(event([
    book("a", pair("Receiver", 49.5, -150, 120)),
    book("b", pair("Receiver", 69.5, 200, -240)),
  ]));
  assert.equal(result.quarantined.length, 0);
});

test("alternative/main classifications and periods never establish cross-book or ladder equivalence", () => {
  const result = validate(event([
    book("main", pair("Receiver", 69.5, 1500, -2500)),
    book("alternate", pair("Receiver", 89.5, -122, -105, { isMainLine: false, isAlternateLine: true })),
    book("half", pair("Receiver", 89.5, -122, -105, { period: "first_half" })),
  ]));
  const main = checked(result).filter(o => o.quoteSource.isMainLine === true && !o.quoteSource.period);
  assert.ok(main.every(o => !reasons(o).includes("inconsistent_market_ladder") && !reasons(o).includes("cross_book_outlier")));
  assert.ok(result.quarantined.some(o => o.quoteValidation.reasons.includes("alternate_offer")));
  assert.ok(result.quarantined.some(o => o.quoteValidation.reasons.includes("mismatched_period")));
});

test("two agreeing independent same-line books establish an extreme cross-book outlier", () => {
  const result = validate(event([
    book("odd", pair("Receiver", 69.5, 1500, -2500)),
    book("normal1", pair("Receiver", 69.5, -110, -110)),
    book("normal2", pair("Receiver", 69.5, -115, -105)),
  ]));
  const over = result.quarantined.find(o => o.sportsbook === "odd" && o.side === "over");
  assert.deepEqual(over.quoteValidation.reasons, ["cross_book_outlier"]);
  assert.equal(over.quoteValidation.evidence[0].peerBooks.length, 2);
});

test("two disagreeing books alone cannot prove which same-line price is wrong", () => {
  const result = validate(event([
    book("odd", pair("Receiver", 69.5, 1500, -2500)),
    book("normal", pair("Receiver", 69.5, -110, -110)),
  ]));
  assert.ok(!result.quarantined.some(o => o.quoteValidation.reasons.includes("cross_book_outlier")));
});

test("different player/event/period/main-alt scopes never become equivalent peers", () => {
  const a = event([book("odd", pair("Receiver", 69.5, 1500, -2500)),
    book("different-player", pair("Another Receiver", 69.5)),
    book("alternate", pair("Receiver", 69.5, -110, -110, { isAlternateLine: true }))]);
  const b = structuredClone(event([book("other-event1", pair("Receiver", 69.5)),
    book("other-event2", pair("Receiver", 69.5))]));
  b.id = "other";
  for (const row of b.bookmakers.flatMap(b => b.markets.flatMap(m => m.outcomes))) row.quoteSource.eventId = "other";
  const result = validateOddsEvents([a, b], { now: NOW });
  assert.ok(!result.quarantined.some(o => o.quoteValidation.reasons.includes("cross_book_outlier")));
});

test("missing pair uses observed source completeness, not an unconditional two-side assumption", () => {
  const result = validate(event([
    book("paired-feed", [...pair("A"), ...pair("B"), ...pair("E"), ...pair("F"), outcome("C", "Over", 49.5, -110)]),
    book("one-side-feed", [outcome("D", "Over", 49.5, -110)]),
  ]));
  assert.deepEqual(result.quarantined.map(o => [o.playerName, o.quoteValidation.reasons]), [
    ["C", ["missing_market_pair"]],
  ]);
});

test("an explicitly two-sided source must not fabricate a missing Under", () => {
  const row = outcome("A", "Over", 49.5, -110, { requiresPair: true });
  const result = validate(event([book("book", [row])]));
  assert.equal(checked(result).length, 1);
  assert.deepEqual(result.quarantined[0].quoteValidation.reasons, ["missing_market_pair"]);
});

test("inconsistent decimal/American conversion fails while source rounding remains valid", () => {
  const result = validate(event([book("book", [
    ...pair("Good", 49.5, -122, 102).map(o => ({ ...o,
      quoteSource: { ...o.quoteSource, decimalOdds: Math.round(o.quoteSource.decimalOdds * 1000) / 1000 } })),
    ...pair("Bad", 49.5, 1500, -2500).map(o => ({ ...o, quoteSource: { ...o.quoteSource, decimalOdds: 1.82 } })),
  ])]));
  assert.ok(checked(result).filter(o => o.playerName === "Good").every(o => o.quoteValidation.status === "validated"));
  assert.ok(checked(result).filter(o => o.playerName === "Bad").every(o => reasons(o).includes("inconsistent_price_conversion")));
});

test("impossible paired-side pricing quarantines both sides independent of outcome order", () => {
  for (const rows of [pair("Bad", 49.5, 1500, 1500), pair("Bad", 49.5, -1000, -1000)]) {
    for (const outcomes of [rows, [...rows].reverse()]) {
      const result = validate(event([book("book", outcomes)]));
      assert.equal(result.quarantined.length, 2);
      assert.ok(result.quarantined.every(o => o.quoteValidation.reasons.includes("malformed_market_pair")));
    }
  }
});

test("mismatched paired lines and provider market/player identifiers fail explicitly", () => {
  for (const defect of ["line", "market", "player"]) {
    const rows = pair("A");
    if (defect === "line") { rows[1].point = 59.5; rows[1].quoteSource.line = 59.5; }
    if (defect === "market") rows[1].quoteSource.marketId = "other";
    if (defect === "player") rows[1].playerId = "other";
    const result = validate(event([book("book", rows)]));
    assert.equal(result.quarantined.length, 2);
    const expected = { line: "mismatched_line", market: "mismatched_market", player: "mismatched_player" }[defect];
    assert.ok(result.quarantined.every(o => o.quoteValidation.reasons.includes(expected)));
  }
});

test("source event/player/market/side/line, staleness and live metadata cannot bypass quarantine", () => {
  const cases = [
    [{ eventId: "other" }, "mismatched_event"],
    [{ playerName: "Other" }, "mismatched_player"],
    [{ market: "player_passing_yards" }, "mismatched_market"],
    [{ side: "under" }, "mismatched_side"], [{ line: 59.5 }, "mismatched_line"],
    [{ timestamp: "2026-10-12T00:00:00Z" }, "stale_offer"],
    [{ timestamp: "2026-10-16T00:00:00Z" }, "stale_offer"],
    [{ isLive: true }, "live_offer"], [{ isActive: false }, "inactive_offer"],
    [{ period: "unrecognized" }, "mismatched_period"],
  ];
  for (const [metadata, expected] of cases) {
    const result = validate(event([book("book", [outcome("A", "Over", 49.5, -110, metadata)])]));
    assert.ok(result.quarantined[0].quoteValidation.reasons.includes(expected), expected);
  }
});

test("null, nonfinite and invalid American or decimal prices remain diagnostic but never qualify", () => {
  for (const price of [null, 0, NaN, Infinity, -Infinity, 20]) {
    const row = outcome("Bad", "Over", 49.5, -110);
    row.price = price;
    const result = validate(event([book("book", [row])]));
    assert.ok(result.quarantined[0].quoteValidation.reasons.includes("malformed_price"));
    assert.equal(checked(result).length, 1);
  }
});

test("under-side ladder inversions are quarantined without changing a quote", () => {
  const result = validate(event([
    book("a", pair("Receiver", 49.5, -110, -110)),
    book("b", pair("Receiver", 89.5, -2500, 1500)),
  ]));
  assert.ok(result.quarantined.some(o => o.side === "under" && o.line === 89.5 &&
    o.quoteValidation.reasons.includes("inconsistent_market_ladder")));
});

test("five legitimate mixed-family distinct-game legs survive; ordering is deterministic", () => {
  const pairs = [["SEA", "DEN"], ["CHI", "ATL"], ["HOU", "JAX"], ["PIT", "TB"], ["CAR", "PHI"]];
  const events = [], snapshots = [];
  for (let i = 0; i < pairs.length; i++) {
    const [away, home] = pairs[i];
    const e = event([book("book", pair("Normal One"))]);
    e.id = `${away}-${home}`; e.away_team = away; e.home_team = home;
    const rushing = i === 2 || i === 3;
    for (const row of e.bookmakers[0].markets[0].outcomes) {
      row.quoteSource.eventId = e.id;
      if (rushing) row.quoteSource.market = "player_rushing_yards";
    }
    if (rushing) e.bookmakers[0].markets[0].key = "player_rush_yds";
    const args = input(e);
    args.game = { ...args.game, away, home };
    args.prediction.away.code = away; args.prediction.home.code = home;
    for (const player of args.playerProjections) player.team = away;
    if (i === 4) e.bookmakers[0].markets = [{ key: "h2h", outcomes: [
      { name: away, price: 100 }, { name: home, price: -110 },
    ] }];
    const best = buildBestBets(args);
    assert.ok(best.candidates.length);
    events.push(e); snapshots.push(saved(away, home, best));
  }
  const payload = { cacheStatus: "fresh", events };
  const result = buildWeeklyMultiSelection(snapshots, payload, context, NOW);
  assert.equal(result.legs.length, 5);
  assert.equal(new Set(result.legs.map(l => l.matchupKey)).size, 5);
  assert.equal(result.legs.filter(l => l.marketFamily === "receiving-props").length, 2);
  assert.equal(result.legs.filter(l => l.marketFamily === "rushing-props").length, 2);
  assert.ok(result.legs.some(l => l.marketFamily === "moneyline"));
  assert.deepEqual(buildWeeklyMultiSelection([...snapshots].reverse(),
    { ...payload, events: [...events].reverse() }, context, NOW).legs, result.legs);
});

test("stored adapter preserves original anomalous source prices and provenance for validation", async () => {
  const rows = [{ id: 123, event_id: "event", away_team: "SEA", home_team: "DEN",
    event_start_time: KICKOFF, sportsbook: "draftkings", market_type: "player_receiving_yards",
    player_name: "Named Receiver", selection: "Over", selection_type: "over", line: 69.5,
    odds_decimal: 16, odds_american: 1500, market_id: "provider-market",
    selection_id: "provider-selection", is_main_line: true, is_alternate_line: false,
    is_active: true, is_live: false, timestamp: QUOTE }];
  const snapshot = { sport: "nfl", season: 2026, week: 6, market: "player_reception_yds",
    provider: "SharpAPI", rows, row_count: 1, status: "ok", fetched_at: QUOTE };
  const client = { from() { return { select() { return this; }, eq() { return this; },
    then(resolve) { return Promise.resolve({ data: [snapshot], error: null }).then(resolve); } }; } };
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handleOddsRequest({ method: "GET", url: "/api/nfl/odds?props=1&source=snapshot" }, res, { client, now: NOW.getTime() });
  assert.equal(res.code, 200);
  const row = res.body.events[0].bookmakers[0].markets[0].outcomes[0];
  assert.equal(row.price, 1500);
  assert.equal(row.quoteSource.decimalOdds, 16);
  assert.equal(row.quoteSource.marketId, "provider-market");
  assert.equal(row.quoteSource.selectionId, "provider-selection");
  assert.equal(row.quoteSource.fetchedAt, QUOTE);
  assert.equal(row.quoteSource.timestamp, QUOTE);
  assert.equal(row.quoteSource.period, null);
  assert.equal(row.period, "full_game");
});

test("digits in a team name cannot become an invented source moneyline handicap", async () => {
  const snapshots = ["moneyline", "point_spread", "total_points"].map(market => ({
    sport: "nfl", season: 2026, week: 6, market, provider: "SharpAPI", status: "ok",
    fetched_at: QUOTE, row_count: 1, rows: [{
      id: market, event_id: "event", away_team: "Washington Commanders", home_team: "San Francisco 49ers",
      event_start_time: KICKOFF, sportsbook: "book", market_type: market,
      selection: market === "total_points" ? "Over" : "San Francisco 49ers",
      line: market === "moneyline" ? null : market === "point_spread" ? -3.5 : 44.5,
      odds_american: -110, timestamp: QUOTE,
    }],
  }));
  const client = { from() { return { select() { return this; }, eq() { return this; },
    then(resolve) { return Promise.resolve({ data: snapshots, error: null }).then(resolve); } }; } };
  const res = { setHeader() {}, status() { return this; }, json(body) { this.body = body; return this; } };
  await handleOddsRequest({ method: "GET", url: "/api/nfl/odds" }, res, { client, now: NOW.getTime() });
  const ml = res.body.events[0].bookmakers[0].markets.find(m => m.key === "h2h").outcomes[0];
  assert.equal(ml.quoteSource.line, null);
  assert.equal(ml.playerName, null);
  assert.equal(validateOddsEvents(res.body.events, { now: NOW }).quarantined.length, 0);
});

test("a normalized full-game outcome cannot override a contradictory parent market period", () => {
  const e = event([book("book", pair("A"))]);
  e.bookmakers[0].markets[0].period = "first_half";
  assert.ok(validate(e).quarantined.every(o => o.quoteValidation.reasons.includes("mismatched_period")));
});

test("alternate pairs cannot establish that a main-line feed normally supplies both sides", () => {
  const e = event([book("book", [
    ...pair("A", 49.5, -110, -110, { isAlternateLine: true }),
    ...pair("B", 49.5, -110, -110, { isAlternateLine: true }),
    ...pair("C", 49.5, -110, -110, { isAlternateLine: true }),
    ...pair("D", 49.5, -110, -110, { isAlternateLine: true }),
    outcome("Main", "Over", 49.5, -110),
  ])]);
  const main = checked(validate(e)).find(o => o.playerName === "Main");
  assert.equal(main.quoteValidation.status, "validated");
});

test("quarantine decisions do not depend on bookmaker or outcome ordering", () => {
  const e = brokenLadder(), reversed = structuredClone(e);
  reversed.bookmakers.reverse();
  for (const book of reversed.bookmakers) for (const market of book.markets) market.outcomes.reverse();
  const decisions = e => validate(e).quarantined.map(o =>
    [o.source.id, [...o.quoteValidation.reasons].sort()]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(decisions(reversed), decisions(e));
});

test("validated odds preserve the 55% floor, positive edge, and maximum one role-adjusted TD", () => {
  const pairs = [["SEA", "DEN"], ["CHI", "ATL"], ["HOU", "JAX"], ["PIT", "TB"]];
  const events = [], snapshots = [];
  for (const [away, home] of pairs) {
    const e = event([book("book", pair("Normal One", 49.5, 100, -110))]);
    e.id = `${away}-${home}`; e.away_team = away; e.home_team = home;
    for (const row of e.bookmakers[0].markets[0].outcomes) row.quoteSource.eventId = e.id;
    const best = buildBestBets(input(e));
    best.candidates = best.candidates.map(b => ({ ...b, modelProbability: .55 }));
    events.push(e); snapshots.push(saved(away, home, best));
  }
  for (const [away, home] of [["CAR", "PHI"], ["DAL", "GB"]]) snapshots.push(saved(away, home, {
    candidates: [], anytimeTdScorer: { source: "model-only", selection: `${away} Player anytime TD`,
      modelProbability: .9, roleConfidence: .9, decimalOdds: null },
  }));
  const select = () => buildWeeklyMultiSelection(snapshots, { cacheStatus: "fresh", events }, context, NOW);
  const result = select();
  assert.equal(result.legs.length, 5);
  assert.equal(result.threshold, .55);
  assert.equal(result.legs.filter(l => l.modelOnly).length, 1);
  assert.ok(result.legs.filter(l => !l.modelOnly).every(l => l.edge > 0 && l.expectedValue > 0));
  snapshots[0].bestBets.candidates[0].modelProbability = .5499;
  assert.equal(select().legs.length, 4);
  snapshots[0].bestBets.candidates[0].modelProbability = .55;
  snapshots[0].bestBets.candidates[0].decimalOdds = 1.5;
  const row = events[0].bookmakers[0].markets[0].outcomes[0];
  row.price = -200; row.quoteSource.americanOdds = -200; row.quoteSource.decimalOdds = 1.5;
  assert.equal(select().legs.length, 4);
});
