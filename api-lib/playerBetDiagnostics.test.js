import test from "node:test";
import assert from "node:assert/strict";
import { classifyPlayerAvailability, availableForPlayerBet, buildPersonnelView } from "./personnelView.js";
import { activePersonnelRecord, personnelViewFixture } from "./personnelTestHelpers.js";
import { buildBestBets } from "../src/services/bestBetsService.js";
import { scorerProbabilityLabel, playerDiagnosticSummary, playerReasonMessage, primaryPlayerReason, tdBettingDisplay } from "../src/services/playerBetDiagnostics.js";

const NOW = "2026-10-28T23:00:00Z";
const CUTOFF = "2026-10-30T00:15:00Z";
for (const [status, state, eligible] of [
  ["Active", "AVAILABLE", true], ["Probable", "EXPECTED_ACTIVE", true], ["Questionable", "QUESTIONABLE", true],
  ["Doubtful", "DOUBTFUL", false], ["Out", "OUT", false], ["IR", "IR", false], ["PUP", "PUP", false],
  ["Suspended", "SUSPENDED", false], ["Unknown", "UNKNOWN_GAME_STATUS", false],
]) {
  test(`availability ${status} is explicitly ${state}, eligible=${eligible}`, () => {
    const player = activePersonnelRecord("player", "NE", { status, statusKnown: status !== "Unknown",
      propEligible: eligible, observationTimestamp: NOW, cutoff: CUTOFF });
    assert.equal(classifyPlayerAvailability(player), state);
    assert.equal(availableForPlayerBet(player), eligible);
  });
}
for (const [name, player, options, state] of [
  ["identity missing", null, {}, "UNKNOWN_IDENTITY"],
  ["source missing", activePersonnelRecord("p", "NE"), { sourceAvailable: false }, "UNKNOWN_SOURCE_UNAVAILABLE"],
  ["not in lineup", { ...activePersonnelRecord("p", "NE"), inLineup: false }, {}, "UNKNOWN_NOT_IN_LINEUP"],
  ["stale evidence", { ...activePersonnelRecord("p", "NE"), observationTimestamp: "2026-10-01T00:00:00Z",
    cutoff: CUTOFF }, {}, "UNKNOWN_STALE"],
  ["unsupported role", { ...activePersonnelRecord("p", "NE"), position: "K" }, {}, "UNSUPPORTED_ROLE"],
  ["conflicting identity", { ...activePersonnelRecord("p", "NE"), identityConflict: true }, {}, "UNKNOWN_IDENTITY"],
]) {
  test(`availability separates ${name}`, () => {
    assert.equal(classifyPlayerAvailability(player, options), state);
    assert.equal(availableForPlayerBet(player, options), false);
  });
}

function input(market, status = "Unknown") {
  const player = { playerId: "player", personnelId: "player", playerName: "Example Player", team: "NE",
    position: "QB", roleConfidence: .9, dataQuality: .9, personnel: { eligible: status === "Active" },
    anytimeTouchdownProbability: .65, receivingYards: 80, rushingYards: 70, passingYards: 300 };
  const record = activePersonnelRecord("player", "NE", { position: "QB", status,
    statusKnown: status !== "Unknown", propEligible: status === "Active",
    observationTimestamp: NOW, cutoff: CUTOFF });
  return {
    game: { away: "NE", home: "CHI", season: 2026, week: 8 },
    prediction: { awayWinProbability: .7, homeWinProbability: .3 },
    playerProjections: [player], personnelViews: {
      away: personnelViewFixture("NE", 2026, 8, CUTOFF, [record]),
      home: personnelViewFixture("CHI", 2026, 8, CUTOFF),
    },
    dataQuality: {}, quoteAsOf: NOW,
    oddsEvent: { id: "example", away_team: "NE", home_team: "CHI",
      bookmakers: [{ key: "book", title: "Book", last_update: NOW,
        markets: [{ key: market, outcomes: [{ name: market === "player_anytime_td" ? "Yes" : "Over",
          playerName: "Example Player", price: 100,
          point: market === "player_anytime_td" ? null : market === "player_pass_yds" ? 200.5 : 30.5 }] }] }] },
  };
}

for (const market of ["player_anytime_td", "player_reception_yds", "player_rush_yds", "player_pass_yds"]) {
  test(`${market} unknown availability is not a name mismatch or an eligible bet`, () => {
    const result = buildBestBets(input(market));
    const diagnostic = result.marketDiagnostics.playerDiagnostics[0];
    assert.equal(diagnostic.identityState, "MATCHED");
    assert.equal(diagnostic.rejectionCode, "PLAYER_AVAILABILITY_UNKNOWN");
    assert.equal(diagnostic.providerPlayerName, "Example Player");
    assert.equal(diagnostic.projectionPlayerName, "Example Player");
    assert.equal(diagnostic.normalizedProviderName, "exampleplayer");
    assert.equal(diagnostic.normalizedProjectionName, "exampleplayer");
    assert.deepEqual(diagnostic.eventTeams, ["NE", "CHI"]);
    assert.equal(result.candidates.length, 0);
    assert.match(playerDiagnosticSummary(result), /Player availability is unknown/);
    assert.ok(result.marketDiagnostics.providerPlayerNames.includes("Example Player"));
    assert.ok(result.marketDiagnostics.projectionPlayerNames.includes("Example Player"));
  });
}

test("TD empty state reports unavailable probability, exact availability reason, never fake zero", () => {
  const scorer = buildBestBets(input("player_anytime_td")).anytimeTdScorer;
  assert.equal(scorer.source, "unavailable");
  assert.equal(scorer.modelProbability, null);
  assert.equal(scorer.primaryReason, "PLAYER_AVAILABILITY_UNKNOWN");
  assert.equal(scorerProbabilityLabel(scorer), "Unavailable");
  assert.equal(scorerProbabilityLabel({ source: "unavailable", modelProbability: 0 }), "Unavailable");
});

for (const hasSource of [false, true]) {
  test(`missing personnel distinguishes ${hasSource ? "absent lineup player" : "unavailable source"} from identity`, () => {
    const value = input("player_anytime_td");
    value.personnelViews.away.players = [];
    if (!hasSource) value.personnelViews.away.chart.available = false;
    const result = buildBestBets(value);
    const diagnostic = result.marketDiagnostics.playerDiagnostics[0];
    assert.equal(diagnostic.identityState, "MATCHED");
    assert.equal(diagnostic.availabilityState, hasSource ? "UNKNOWN_NOT_IN_LINEUP" : "UNKNOWN_SOURCE_UNAVAILABLE");
    assert.equal(diagnostic.rejectionCode, "PLAYER_AVAILABILITY_UNKNOWN");
    assert.equal(result.anytimeTdScorer.primaryReason, "PLAYER_AVAILABILITY_UNKNOWN");
    assert.equal(result.anytimeTdScorer.modelProbability, null);
  });
}

test("a real zero probability remains distinguishable from missing/unavailable probability", () => {
  assert.equal(scorerProbabilityLabel({ source: "priced-market", modelProbability: 0 }), "0.0%");
  assert.equal(scorerProbabilityLabel(null), "Unavailable");
});

for (const [name, price, probability, reason] of [
  ["positive edge", 100, .7, null],
  ["reproduced negative edge", -200, .2, "NON_POSITIVE_EDGE"],
  ["zero edge", 100, .5, "NON_POSITIVE_EDGE"],
  ["negative edge", 100, .4, "NON_POSITIVE_EDGE"],
  ["zero price", 0, .7, "INVALID_PRICE"],
  ["malformed price", "invalid", .7, "INVALID_PRICE"],
  ["NaN price", NaN, .7, "INVALID_PRICE"],
  ["infinite price", Infinity, .7, "INVALID_PRICE"],
  ["negative infinite price", -Infinity, .7, "INVALID_PRICE"],
  ["invalid American odds", 50, .7, "INVALID_PRICE"],
  ["missing price", undefined, .7, "PRICE_UNAVAILABLE"],
  ["null price", null, .7, "PRICE_UNAVAILABLE"],
  ["probability below threshold with positive edge", 400, .4, "PROBABILITY_BELOW_THRESHOLD"],
]) {
  test(`TD betting display: ${name}`, () => {
    const value = input("player_anytime_td", "Active");
    value.playerProjections[0].anytimeTouchdownProbability = probability;
    value.oddsEvent.bookmakers[0].markets[0].outcomes[0].price = price;
    const result = buildBestBets(value), scorer = result.anytimeTdScorer;
    if (!reason) {
      assert.equal(scorer.source, "priced-market");
      assert.match(scorer.selection, /Example Player/);
      assert.equal(scorer.modelProbability, probability);
      assert.ok(Number.isFinite(scorer.edge) && scorer.edge > 0);
      assert.equal(scorer.sportsbook, "Book");
      assert.equal(scorer.updatedAt, NOW);
      assert.equal(scorer.quoteValidation.status, "validated");
      assert.deepEqual(tdBettingDisplay(scorer, new Date(NOW)), scorer);
    } else {
      assert.equal(scorer.source, "unavailable");
      assert.equal(scorer.primaryReason, reason);
      assert.equal(scorer.modelProbability, null);
      assert.equal(scorer.decimalOdds, null);
      assert.equal(scorerProbabilityLabel(scorer), "Unavailable");
      assert.doesNotMatch(scorer.selection, /Example Player/);
      assert.equal(result.candidates.length, 0);
      assert.equal(result.marketDiagnostics.playerFailureCounts[reason], 1);
      assert.equal(playerDiagnosticSummary(result), playerReasonMessage(reason));
      assert.equal(scorer.statisticalProjection.bettingEligible, false);
      assert.equal(scorer.statisticalProjection.modelProbability, probability);
      if (reason === "INVALID_PRICE") assert.equal(result.marketDiagnostics.playerFailureCounts.PRICE_UNAVAILABLE, undefined);
    }
  });
}

test("legacy saved scorer cards cannot bypass new betting display gates", () => {
    const eligible = buildBestBets(input("player_anytime_td", "Active")).anytimeTdScorer;
    const before = structuredClone(eligible);
    for (const [changes, reason] of [
      [{ edge: -.4667, modelProbability: .2, price: -200 }, "NON_POSITIVE_EDGE"],
      [{ price: 0 }, "INVALID_PRICE"],
      [{ source: "model-only", price: 0, decimalOdds: null }, "INVALID_PRICE"],
      [{ source: "model-only", price: null, decimalOdds: null }, "PRICE_UNAVAILABLE"],
      [{ bettingEligible: undefined }, "PLAYER_AVAILABILITY_UNKNOWN"],
      [{ updatedAt: "2026-10-01T00:00Z" }, "PRICE_STALE"],
    ]) {
      const display = tdBettingDisplay({ ...eligible, ...changes }, new Date(NOW));
      assert.equal(display.source, "unavailable");
      assert.equal(display.primaryReason, reason);
      assert.equal(scorerProbabilityLabel(display), "Unavailable");
      assert.equal(display.decimalOdds, null);
    }
    assert.deepEqual(eligible, before);
  });

  test("current core bets retain exact quote provenance while a stale total is excluded independently", () => {
    const value = input("player_anytime_td", "Active");
    value.prediction = { awayWinProbability: .8, homeWinProbability: .2,
      away: { code: "NE", score: 35 }, home: { code: "CHI", score: 10 } };
    value.oddsEvent.bookmakers[0].markets = [
      { key: "h2h", outcomes: [{ name: "NE", price: 100 }, { name: "CHI", price: -110 }] },
      { key: "spreads", outcomes: [{ name: "NE", point: -2.5, price: -110 },
        { name: "CHI", point: 2.5, price: -110 }] },
      { key: "totals", last_update: "2026-10-20T00:00Z", outcomes: [
        { name: "Over", point: 44.5, price: -110 }, { name: "Under", point: 44.5, price: -110 }] },
    ];
    for (const market of value.oddsEvent.bookmakers[0].markets) {
      for (const [i, outcome] of market.outcomes.entries()) outcome.quoteSource = {
        id: `${market.key}-${i}`, timestamp: market.last_update || NOW, fetchedAt: market.last_update || NOW,
      };
    }
    const result = buildBestBets(value);
    for (const market of ["Moneyline", "Spread"]) {
      const bet = result.candidates.find((row) => row.market === market);
      assert.ok(bet);
      assert.equal(bet.sportsbook, "Book");
      assert.equal(bet.updatedAt, NOW);
      assert.ok(bet.quoteId);
      assert.ok(bet.edge > 0);
    }
    assert.ok(result.recommendations.some((bet) => ["Moneyline", "Spread"].includes(bet.market)));
    assert.equal(result.candidates.some((bet) => bet.market === "Game total"), false);
    assert.equal(result.quarantinedOffers.filter((row) => row.market === "totals").length, 2);
  });
test("known TD identity failure is not collapsed into missing price or projection", () => {
  const value = input("player_anytime_td", "Active");
  value.oddsEvent.bookmakers[0].markets[0].outcomes[0].playerName = "Different Player";
  const result = buildBestBets(value);
  assert.equal(result.anytimeTdScorer.primaryReason, "PLAYER_IDENTITY_MISMATCH");
  assert.equal(result.marketDiagnostics.playerFailureCounts.PLAYER_IDENTITY_MISMATCH, 1);
});

test("TD rejection priority is deterministic across multiple failed offers", () => {
  assert.equal(primaryPlayerReason(["NON_POSITIVE_EDGE", "INVALID_PRICE"]), "INVALID_PRICE");
  assert.equal(primaryPlayerReason(["PRICE_UNAVAILABLE", "PLAYER_AVAILABILITY_UNKNOWN"]), "PLAYER_AVAILABILITY_UNKNOWN");
  const value = input("player_anytime_td", "Active");
  value.playerProjections[0].anytimeTouchdownProbability = .2;
  value.oddsEvent.bookmakers.push({ key: "invalid", title: "Invalid",
    last_update: NOW, markets: [{ key: "player_anytime_td",
      outcomes: [{ name: "Yes", playerName: "Example Player", price: 0 }] }] });
  for (const books of [value.oddsEvent.bookmakers, [...value.oddsEvent.bookmakers].reverse()]) {
    const result = buildBestBets({ ...value, oddsEvent: { ...value.oddsEvent, bookmakers: books } });
    assert.equal(result.anytimeTdScorer.primaryReason, "INVALID_PRICE");
    assert.equal(result.marketDiagnostics.playerFailureCounts.NON_POSITIVE_EDGE, 1);
    assert.equal(result.marketDiagnostics.playerFailureCounts.INVALID_PRICE, 1);
  }
});

test("missing projections are distinguished from identity mismatch", () => {
  const value = input("player_anytime_td"); value.playerProjections = [];
  const result = buildBestBets(value);
  assert.equal(result.anytimeTdScorer.primaryReason, "PLAYER_PROJECTION_UNAVAILABLE");
  assert.equal(result.marketDiagnostics.playerDiagnostics[0].identityState, "UNRESOLVED");
  assert.equal(result.marketDiagnostics.playerDiagnostics[0].rejectionCode, "PLAYER_PROJECTION_UNAVAILABLE");
  assert.equal(playerDiagnosticSummary(result), "Player projections are unavailable.");
});

test("ambiguous names fail closed rather than selecting the first player", () => {
  const value = input("player_pass_yds", "Active");
  value.playerProjections.push({ ...value.playerProjections[0], playerId: "other", personnelId: "other" });
  const result = buildBestBets(value);
  assert.equal(result.marketDiagnostics.playerDiagnostics[0].identityState, "AMBIGUOUS");
  assert.equal(result.candidates.length, 0);
});

test("wrong-team identity is explicit and cannot enter player recommendations", () => {
  const value = input("player_rush_yds", "Active"); value.playerProjections[0].team = "BUF";
  const result = buildBestBets(value);
  assert.equal(result.marketDiagnostics.playerDiagnostics[0].identityState, "TEAM_MISMATCH");
  assert.equal(result.candidates.length, 0);
});

test("stale prices are reported as stale rather than missing names", () => {
  const value = input("player_reception_yds", "Active");
  value.oddsEvent.bookmakers[0].last_update = "2026-10-20T00:00:00Z";
  assert.equal(playerDiagnosticSummary(buildBestBets(value)), "Player prices are out of date.");
});

test("low role confidence has an explicit safe rejection code", () => {
  const value = input("player_rush_yds", "Active");
  value.playerProjections[0].roleConfidence = .3;
  const result = buildBestBets(value);
  assert.equal(result.marketDiagnostics.playerDiagnostics[0].rejectionCode, "ROLE_CONFIDENCE_INSUFFICIENT");
});

test("valid price without positive edge is not reported as an identity error", () => {
  const value = input("player_pass_yds", "Active");
  value.playerProjections[0].passingYards = 100;
  const result = buildBestBets(value);
  assert.equal(result.marketDiagnostics.playerDiagnostics[0].rejectionCode, "NON_POSITIVE_EDGE");
});

for (const code of ["PRICE_UNAVAILABLE", "PRICE_STALE", "NON_POSITIVE_EDGE", "PROBABILITY_BELOW_THRESHOLD",
  "ROLE_INSUFFICIENT", "NO_ELIGIBLE_CANDIDATE", "IDENTITY_MISMATCH", "PROJECTION_UNAVAILABLE"]) {
  test(`human-readable ${code} message is bounded and specific`, () => {
    const message = playerReasonMessage(code);
    assert.ok(message.length > 10 && message.length < 100);
    assert.doesNotMatch(message, /0\.0%|names still did not match/);
  });
}

test("missing chart/live status remains unknown; roster membership does not imply healthy", () => {
  const view = buildPersonnelView({ team: "NE", season: 2026, week: 8, cutoff: CUTOFF, observedAt: NOW,
    lineup: { team: "NE", season: 2026, predictionWeek: 8, schemaVersion: 2, snapshotAt: NOW,
      roster: [{ playerId: "p", gsisId: "p", name: "Example Player", position: "QB", rank: 1 }] } });
  assert.equal(view.players[0].availabilityState, "UNKNOWN_GAME_STATUS");
  assert.equal(view.players[0].propEligible, false);
});
