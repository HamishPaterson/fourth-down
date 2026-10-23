import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { tdBettingDisplay, scorerProbabilityLabel } from "../src/services/playerBetDiagnostics.js";

const NOW = "2026-10-22T06:34:36.781Z";
const oldMessage = "Player touchdown projections were not available for this matchup.";
function fixture() {
  return {
    generatedAt: NOW, awayCode: "NE", homeCode: "CHI",
    playerProjections: { available: true, away: { team: "NE", players: [{
      personnelId: "player-1", playerId: "player-1", playerName: "Example Player", team: "NE",
      anytimeTouchdownProbability: .65, roleConfidence: .9,
      personnel: { confidence: "matched-by-identity", status: "Unknown", statusKnown: false, eligible: false },
    }] }, home: { team: "CHI", players: [] } },
    bestBets: { anytimeTdScorer: { source: "unavailable", modelProbability: 0, decimalOdds: null,
      selection: "No eligible scorer projection", explanation: oldMessage, risk: "No player-level touchdown projection was available." } },
    game: { oddsEvent: { bookmakers: [] } },
  };
}
const player = (snapshot) => snapshot.playerProjections.away.players[0];
const display = (snapshot) => tdBettingDisplay(snapshot.bestBets.anytimeTdScorer, new Date(NOW), snapshot);
function eligiblePersonnel(snapshot) {
  Object.assign(player(snapshot).personnel, { status: "Active", statusKnown: true, eligible: true });
}
function quote(snapshot, changes = {}) {
  snapshot.game.oddsEvent.bookmakers = [{ last_update: NOW, markets: [{
    key: "player_anytime_td", outcomes: [{ name: "Yes", playerName: "Example Player", price: 100, ...changes }],
  }] }];
}

test("saved NE-CHI legacy contradiction is corrected using unknown availability, without mutation", () => {
  const snapshot = fixture(), original = structuredClone(snapshot);
  const result = display(snapshot);
  assert.equal(result.primaryReason, "PLAYER_AVAILABILITY_UNKNOWN");
  assert.doesNotMatch(result.explanation, /projections.*unavailable|identity|mismatch/i);
  assert.notEqual(result.explanation, oldMessage);
  assert.equal(result.source, "unavailable");
  assert.equal(result.modelProbability, null);
  assert.equal(result.decimalOdds, null);
  assert.equal(scorerProbabilityLabel(result), "Unavailable");
  assert.doesNotMatch(result.selection, /Example Player/);
  assert.deepEqual(snapshot, original);
});

for (const [name, change, reason] of [
  ["true missing TD projections", (s) => { s.playerProjections.away.players = []; }, "PLAYER_PROJECTION_UNAVAILABLE"],
  ["yardage projections without TD projections", (s) => {
    delete player(s).anytimeTouchdownProbability; player(s).rushingYards = 50;
  }, "PLAYER_PROJECTION_UNAVAILABLE"],
  ["identity mismatch", (s) => { player(s).personnel.confidence = "unmatched"; }, "PLAYER_IDENTITY_MISMATCH"],
  ["price missing", (s) => { eligiblePersonnel(s); }, "PRICE_UNAVAILABLE"],
  ["stale price", (s) => { eligiblePersonnel(s); quote(s); s.game.oddsEvent.bookmakers[0].last_update = "2026-10-19T00:00Z"; }, "PRICE_STALE"],
  ["invalid zero price", (s) => { eligiblePersonnel(s); quote(s, { price: 0 }); }, "INVALID_PRICE"],
  ["invalid non-finite price", (s) => { eligiblePersonnel(s); quote(s, { price: Infinity }); }, "INVALID_PRICE"],
  ["non-positive saved edge", (s) => { eligiblePersonnel(s); quote(s, { price: -200, edge: -.4667 }); }, "NON_POSITIVE_EDGE"],
  ["below probability threshold", (s) => { eligiblePersonnel(s); quote(s); player(s).anytimeTouchdownProbability = .4; }, "PROBABILITY_BELOW_THRESHOLD"],
  ["insufficient role", (s) => { eligiblePersonnel(s); player(s).roleConfidence = .4; }, "ROLE_CONFIDENCE_INSUFFICIENT"],
  ["missing personnel evidence", (s) => { delete player(s).personnel; }, "NO_ELIGIBLE_CANDIDATE"],
  ["missing quote evidence", (s) => { eligiblePersonnel(s); delete s.game; }, "NO_ELIGIBLE_CANDIDATE"],
  ["insufficient evidence for value", (s) => { eligiblePersonnel(s); quote(s); }, "NO_ELIGIBLE_CANDIDATE"],
  ["mixed candidate failures", (s) => {
    s.playerProjections.away.players.push({ ...player(s), personnelId: "other",
      personnel: { confidence: "unmatched" } });
  }, "NO_ELIGIBLE_CANDIDATE"],
  ["no saved context", (s) => { delete s.playerProjections; }, "NO_ELIGIBLE_CANDIDATE"],
]) {
  test(`legacy TD: ${name}`, () => {
    const snapshot = fixture(); change(snapshot);
    const original = structuredClone(snapshot), result = display(snapshot);
    assert.equal(result.primaryReason, reason);
    assert.equal(result.source, "unavailable");
    assert.equal(scorerProbabilityLabel(result), "Unavailable");
    assert.equal(result.modelProbability, null);
    assert.equal(result.decimalOdds, null);
    assert.deepEqual(snapshot, original);
  });
}

test("TD-specific structured diagnostics are used; unrelated player markets cannot supply the reason", () => {
  const snapshot = fixture();
  snapshot.bestBets.marketDiagnostics = { playerDiagnostics: [
    { market: "player_pass_yds", rejectionCode: "PLAYER_IDENTITY_MISMATCH" },
    { market: "player_anytime_td", rejectionCode: "PRICE_STALE" },
  ] };
  assert.equal(display(snapshot).primaryReason, "PRICE_STALE");
});

test("current structured unavailable payload is preserved without reinterpretation", () => {
  const snapshot = fixture();
  Object.assign(snapshot.bestBets.anytimeTdScorer, { primaryReason: "NON_POSITIVE_EDGE",
    explanation: "Valid prices offer no positive model edge.", modelProbability: null });
  assert.strictEqual(display(snapshot), snapshot.bestBets.anytimeTdScorer);
});

test("a genuine zero statistical projection is not rendered as an eligible zero-percent recommendation", () => {
  const snapshot = fixture(); player(snapshot).anytimeTouchdownProbability = 0;
  assert.equal(display(snapshot).primaryReason, "PLAYER_AVAILABILITY_UNKNOWN");
  assert.equal(scorerProbabilityLabel(display(snapshot)), "Unavailable");
  assert.equal(player(snapshot).anytimeTouchdownProbability, 0);
});

const current = () => ({ source: "priced-market", selection: "Example Player anytime TD",
  personnelId: "player-1", playerTeam: "NE", bettingEligible: true,
  modelProbability: .65, roleConfidence: .9, price: 100, decimalOdds: 2,
  edge: .15, expectedValue: .3, updatedAt: NOW, quoteValidation: { status: "validated" } });
test("current eligible priced scorer is preserved", () => {
  const scorer = current();
  assert.strictEqual(tdBettingDisplay(scorer, new Date(NOW), fixture()), scorer);
  assert.equal(scorerProbabilityLabel(scorer), "65.0%");
});

let server, ui;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom",
    plugins: [{ name: "legacy-td-test-exports", transform(code, id) {
      if (id.replace(/\\/g, "/").endsWith("/src/pages/Predictions.jsx"))
        return `${code}\nexport { AnytimeTdScorer, mapLedgerPrediction, enrichSavedPredictionWithCurrentMarket };`;
    } }] });
  ui = await server.ssrLoadModule("/src/pages/Predictions.jsx");
});
after(async () => { await server?.close(); });

test("Predictions restores the independent model pick from legacy saved projections without fake active status or zero", () => {
  const snapshot = fixture();
  snapshot.personnelViews = { away: { team: "NE", players: [{
    canonicalId: "player-1", team: "NE", status: "Unknown", statusKnown: false,
    propEligible: false, projectedAvailable: true, eligibleBeforeCutoff: true,
  }] } };
  const original = structuredClone(snapshot);
  const mapped = ui.mapLedgerPrediction(snapshot);
  const markup = renderToStaticMarkup(createElement(ui.AnytimeTdScorer, {
    scorer: mapped.bestBets.anytimeTdModelPick, awayCode: "NE", homeCode: "CHI",
  }));
  assert.match(markup, /Example Player/);
  assert.match(markup, /Model pick/);
  assert.match(markup, /Availability is unconfirmed/);
  assert.match(markup, /Model probability<\/small><strong>65\.0%/);
  assert.match(markup, /Role 90%/);
  assert.match(markup, /Price<\/small><strong>Unavailable/);
  assert.doesNotMatch(markup, /0\.0%|projections were not available|No player-level touchdown projection/);
  assert.deepEqual(snapshot, original);
});

test("saved TD evidence is normalized before current market enrichment, not from replacement odds", () => {
  const snapshot = fixture(); eligiblePersonnel(snapshot);
  const result = ui.enrichSavedPredictionWithCurrentMarket(snapshot,
    { away: "NE", home: "CHI" }, []);
  assert.equal(result.bestBets.anytimeTdScorer.primaryReason, "PRICE_UNAVAILABLE");
  assert.deepEqual(snapshot.game.oddsEvent.bookmakers, []);
});
