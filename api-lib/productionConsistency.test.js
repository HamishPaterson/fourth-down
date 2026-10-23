import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { applyPredictionSnapshot } from "../src/services/predictionSnapshot.js";
import { choosePredictionSnapshot, readPredictionLedger, savePredictionSnapshot, refreshPredictionLedger, migrateLocalPredictionLedger } from "../src/services/predictionLedger.js";
import { fetchSharedPredictionLedger } from "../src/services/sharedPredictionLedger.js";
import { combinedDecimalOdds, formatAustralianOdds, usableDecimalOdds } from "../src/services/oddsDisplay.js";
import { createPredictionLedgerHandler, snapshotToDatabase } from "../api/nfl/game-stats.js";
import { createScheduleHandler } from "../api/nfl/schedule.js";
import { createWeeklyMultiCurrentHandler } from "./weeklyMulti.js";
import { BEST_BETS_CANDIDATE_VERSION } from "../src/services/bestBetsService.js";
import { predictionFeatureFixture } from "./personnelTestHelpers.js";
import { CURRENT_MODEL_VERSION, CURRENT_MODEL_KEY } from "../src/services/modelIdentity.js";
import { resultGameKey } from "../src/services/gameResults.js";
import { getCurrentWeekWindow } from "../api/nfl/odds.js";

const saved = () => {
  const cutoff = "2030-10-16T00:15:00Z";
  const features = predictionFeatureFixture("SEA", "DEN", 2030, 6, cutoff);
  return ({
  id: "6:SEA:DEN:2030-10-16T00:15:00Z", season: 2030, week: 6,
  awayCode: "SEA", homeCode: "DEN", kickoff: "2030-10-16T00:15:00Z",
  modelVersion: CURRENT_MODEL_VERSION, modelKey: CURRENT_MODEL_KEY,
  predictionFeatureVersion: features.predictionFeatureVersion,
  opponentNetworkStatus: features.opponentNetworkStatus,
  personnelVersion: features.personnelVersion,
  personnelViews: features.personnelViews,
  fourthDownAwayScore: 21, fourthDownHomeScore: 19, fourthDownPick: "SEA",
  fourthDownAwayWinProbability: .585, fourthDownHomeWinProbability: .415, fourthDownWinnerProbability: .585,
  confidenceScore: .6, confidenceLabel: "Medium",
  bestBets: { candidateVersion: BEST_BETS_CANDIDATE_VERSION, candidates: [], recommendations: [], assessed: 3 },
  playerProjections: { available: true },
  predictionPayload: { away: { code: "SEA", score: 22 }, home: { code: "DEN", score: 19 },
    total: 99, winner: "SEA", winnerWinProbability: .6, confidence: "Medium",
    modelLayers: { opponentNetwork: features.predictionPayloadFeatures.opponentNetwork },
    matchupIntelligence: features.predictionPayloadFeatures },
  dataQuality: { personnelTiming: { cutoff }, sources: {
    odds: { available: true }, opponentNetwork: { available: true },
  } },
  shared: true, authoritative: true,
  generatedAt: "2026-10-15T01:24:49.759Z", snapshotAt: "2026-10-15T01:24:49.759Z", updatedAt: "2026-10-15T01:25:30.904Z",
  });
};

for (const [name, value] of [["null", null], ["zero", 0], ["undefined", undefined], ["Infinity", Infinity], ["NaN", NaN]]) {
  test(`invalid ${name} odds never produce a monetary price or combined return`, () => {
    assert.equal(usableDecimalOdds(value), null);
    assert.equal(formatAustralianOdds(value), "Odds unavailable");
    assert.equal(combinedDecimalOdds([{ decimalOdds: 2 }, { decimalOdds: value }]), null);
    assert.equal(formatAustralianOdds(null, value), "Odds unavailable");
  });
}
test("finite priced legs combine; model-only and overflowing combinations stay pending", () => {
  assert.equal(combinedDecimalOdds([{ decimalOdds: 2 }, { decimalOdds: 1.5 }]), 3);
  assert.equal(combinedDecimalOdds([{ decimalOdds: 2 }, { decimalOdds: null, price: null }]), null);
  assert.equal(combinedDecimalOdds([{ decimalOdds: Number.MAX_VALUE }, { decimalOdds: 2 }]), null);
  assert.equal(formatAustralianOdds(null, -110), "$1.91");
  assert.equal(formatAustralianOdds(0, -110), "Odds unavailable");
  assert.equal(combinedDecimalOdds([]), null);
});

test("both views preserve saved identity/version/timestamps and use saved scores, not stale payload totals", () => {
  const snapshot = saved(), prediction = applyPredictionSnapshot(snapshot);
  assert.deepEqual([prediction.away.score, prediction.home.score, prediction.total], [21, 19, 40]);
  assert.equal(prediction.margin, 2);
  assert.equal(prediction.winner, "SEA");
  assert.equal(prediction.winnerWinProbability, .585);
  assert.equal(snapshot.id, saved().id);
  assert.equal(snapshot.modelVersion, CURRENT_MODEL_VERSION);
  assert.equal(snapshot.snapshotAt, saved().snapshotAt);
  assert.equal(snapshot.predictionPayload.total, 99);
});

test("complete shared predictions defeat newer partial/local data; richer current records replace incomplete ones", () => {
  const snapshot = saved();
  const local = { ...snapshot, shared: false, authoritative: false, fourthDownAwayScore: 22, updatedAt: "2026-10-15T02:00:00Z" };
  assert.equal(choosePredictionSnapshot(snapshot, local), snapshot);
  assert.equal(choosePredictionSnapshot(local, snapshot), snapshot);
  const partial = { ...local, bestBets: null };
  assert.equal(choosePredictionSnapshot(snapshot, partial), snapshot);
  assert.equal(choosePredictionSnapshot(partial, snapshot), snapshot);
  const old = { ...snapshot, modelVersion: 6 };
  assert.equal(choosePredictionSnapshot(old, snapshot), snapshot);
  const newer = { ...snapshot, updatedAt: "2026-10-15T02:00:00Z" };
  assert.equal(choosePredictionSnapshot(snapshot, newer), newer);
  assert.equal(choosePredictionSnapshot(newer, snapshot), newer);
});

test("a local Matchup save cannot overwrite a shared complete browser row or issue a duplicate write", () => {
  const originalWindow = global.window, originalFetch = global.fetch;
  const storage = new Map([["fourth-down:prediction-ledger:v1", JSON.stringify([saved()])]]);
  global.window = { localStorage: { getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value) }, dispatchEvent() {} };
  let writes = 0;
  global.fetch = async () => { writes++; throw new Error("Unexpected write"); };
  try {
    savePredictionSnapshot({ ...saved(), fourthDownAwayScore: 22, source: "matchup-full-model" });
    const row = readPredictionLedger().find((r) => r.id === saved().id);
    assert.equal(row.fourthDownAwayScore, 21);
    assert.equal(row.snapshotAt, saved().snapshotAt);
    assert.equal(writes, 0);
  } finally { global.window = originalWindow; global.fetch = originalFetch; }
});

test("shared-ledger refresh retains the action query and sends only a GET with valid season/week", async () => {
  const original = global.fetch;
  let requested;
  global.fetch = async (url, options) => {
    requested = { url, options };
    return { ok: true, text: async () => JSON.stringify({ snapshots: [saved()] }) };
  };
  try {
    const rows = await fetchSharedPredictionLedger({ season: 2026, week: 6 });
    const url = new URL(requested.url, "https://example.test");
    assert.equal(url.searchParams.get("action"), "predictions");
    assert.equal(url.searchParams.get("season"), "2026");
    assert.equal(url.searchParams.get("week"), "6");
    assert.equal(requested.options.body, undefined);
    assert.equal(rows[0].modelVersion, CURRENT_MODEL_VERSION);
  } finally { global.fetch = original; }
});

test("real ledger refresh repairs corrupted local scores at the same saved timestamp without posting a snapshot", async () => {
  const originalWindow = global.window, originalFetch = global.fetch;
  const corrupt = { ...saved(), fourthDownAwayScore: 22 };
  const storage = new Map([["fourth-down:prediction-ledger:v1", JSON.stringify([corrupt])]]);
  global.window = { localStorage: { getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value) }, dispatchEvent() {} };
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, text: async () => JSON.stringify({ snapshots: [saved()] }) };
  };
  try {
    await refreshPredictionLedger({ season: 2030, week: 6 });
    await migrateLocalPredictionLedger();
    const row = readPredictionLedger().find((r) => r.id === saved().id);
    assert.equal(row.fourthDownAwayScore, 21);
    assert.equal(row.snapshotAt, saved().snapshotAt);
    assert.equal(row.modelVersion, CURRENT_MODEL_VERSION);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.body, undefined);
  } finally { global.window = originalWindow; global.fetch = originalFetch; }
});

function response() {
  return {
    statusCode: 200, body: null, headers: {}, headersSent: false, responses: 0, lateHeaders: 0,
    setHeader(key, value) {
      if (this.headersSent) { this.lateHeaders++; throw new Error("Headers already sent"); }
      this.headers[key] = value;
    },
    status(code) { assert.equal(this.headersSent, false); this.statusCode = code; return this; },
    json(body) { assert.equal(this.headersSent, false); this.headersSent = true; this.responses++; this.body = body; return this; },
    end() { return this.json(null); },
  };
}
function database({ initial = [], error = null, throwError = false } = {}) {
  const rows = [...initial], writes = [];
  return {
    rows, writes,
    from() {
      const filters = [];
      let operation, payload;
      const execute = async (single = false) => {
        if (throwError) throw new Error("Unexpected storage failure");
        if (error) return { data: null, error };
        let found = rows.filter((r) => filters.every(([key, value]) => r[key] === value));
        if (operation === "insert") {
          const row = { ...payload, id: "database-id" };
          rows.push(row); writes.push(row); found = [row];
        }
        if (operation === "update") {
          found.forEach((row) => Object.assign(row, payload)); writes.push(payload);
        }
        return { data: single ? found[0] || null : found, error: null };
      };
      return {
        select() { return this; }, order() { return this; },
        eq(key, value) { filters.push([key, value]); return this; },
        is(key, value) { filters.push([key, value]); return this; },
        insert(row) { operation = "insert"; payload = row; return this; },
        update(row) { operation = "update"; payload = row; return this; },
        maybeSingle() { return execute(true); }, single() { return execute(true); },
        then(resolve, reject) { return execute().then(resolve, reject); },
      };
    },
  };
}
async function ledgerRequest(db, overrides = {}) {
  const res = response();
  await createPredictionLedgerHandler({ createClient: () => db })({
    method: "GET", query: {}, headers: { host: "example.test", origin: "https://example.test" }, ...overrides,
  }, res);
  assert.equal(res.responses, 1);
  assert.equal(res.lateHeaders, 0);
  return res;
}
test("ledger successful and not-found reads return HTTP 200 exactly once", async () => {
  for (const initial of [[], [snapshotToDatabase(saved())]]) {
    const res = await ledgerRequest(database({ initial }), { query: { season: "2030", week: "6" } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.snapshots.length, initial.length);
  }
});

test("completed display exclusions preserve saved Best Bets and skip all current-quote reads when only finals remain", async () => {
  const week = getCurrentWeekWindow().week;
  const snapshot = { ...saved(), season: 2026, week, kickoff: "2026-10-23T00:15Z" };
  const initial = [snapshotToDatabase(snapshot)];
  const before = structuredClone(initial);
  const db = database({ initial }), tables = [], originalFrom = db.from;
  db.from = (table) => { tables.push(table); assert.equal(table, "prediction_snapshots"); return originalFrom.call(db, table); };
  const res = await ledgerRequest(db, { query: { season: "2026", week: String(week), bets: "display",
    historicalGames: resultGameKey(snapshot) } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.snapshots.length, 1);
  assert.deepEqual(res.body.snapshots[0].bestBets, snapshot.bestBets);
  assert.equal(res.body.snapshots[0].displayBestBetsAsOf, undefined);
  assert.deepEqual(tables, ["prediction_snapshots"]);
  assert.deepEqual(db.writes, []);
  assert.deepEqual(initial, before);
});
test("ledger validation, persistence and unexpected errors send explicit JSON once", async () => {
  const invalid = await ledgerRequest(database(), { query: { week: "invalid" } });
  assert.equal(invalid.statusCode, 400);
  const missing = await ledgerRequest(database(), { method: "POST", body: { snapshots: [] } });
  assert.equal(missing.statusCode, 400);
  const invalidSave = await ledgerRequest(database(), { method: "POST", body: { snapshots: [{ ...saved(), week: 0 }] } });
  assert.equal(invalidSave.statusCode, 400);
  const failure = await ledgerRequest(database({ error: { message: "Persistence unavailable" } }));
  assert.equal(failure.statusCode, 500);
  const writeFailure = await ledgerRequest(database({ error: { message: "Persistence unavailable" } }), {
    method: "POST", body: { snapshots: [saved()] },
  });
  assert.equal(writeFailure.statusCode, 500);
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    const thrown = await ledgerRequest(database({ throwError: true }));
    assert.equal(thrown.statusCode, 500);
    assert.deepEqual(logs, [["Prediction ledger request failed"]]);
  } finally { console.error = original; }
});
test("successful duplicate saves merge once; partial writes do not replace complete authoritative data", async () => {
  const incoming = { ...saved(), shared: false, authoritative: false };
  const db = database();
  const res = await ledgerRequest(db, { method: "POST", body: { snapshots: [incoming, incoming] } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.saved.length, 1);
  assert.equal(db.writes.length, 1);
  const authoritative = database({ initial: [{ ...snapshotToDatabase(saved()), id: "server-id" }] });
  const partial = { ...incoming, bestBets: null, predictionPayload: null };
  const retained = await ledgerRequest(authoritative, { method: "POST", body: { snapshots: [partial] } });
  assert.equal(retained.statusCode, 200);
  assert.equal(retained.body.saved[0].fourthDownAwayScore, 21);
  assert.equal(authoritative.writes.length, 0);
});

test("Weekly Multi dispatcher never mutates headers after successful/not-found/error read responses", async () => {
  for (const outcome of ["stored", "missing", "error"]) {
    const record = { season: 2026, week: 6, legs: [], locked_at: "2026-10-15T01:46:28Z" };
    const handler = createScheduleHandler({ currentHandler: createWeeklyMultiCurrentHandler({
      getNow: () => new Date("2026-10-15T02:00:00Z"),
      createClient: () => ({ from: () => ({
        select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: outcome === "stored" ? record : null, error: outcome === "error" ? new Error("read failed") : null }),
      }) }),
      resolveDisplayContext: async () => ({ available: false, reason: "No current record" }),
    }) });
    const res = response(), original = console.error;
    console.error = () => {};
    try { await handler({ method: "GET", query: { weeklyMultiMode: "current" } }, res); }
    finally { console.error = original; }
    assert.equal(res.responses, 1);
    assert.equal(res.lateHeaders, 0);
    assert.equal(res.statusCode, outcome === "error" ? 500 : 200);
    assert.ok(res.headers["Cache-Control"]);
  }
});

let server, Matchup, PredictionCard, WeeklyParlay;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: "custom" });
  Matchup = (await server.ssrLoadModule("/src/components/MatchupPrediction.jsx")).default;
  const predictions = await server.ssrLoadModule("/src/pages/Predictions.jsx");
  PredictionCard = predictions.PredictionCard;
  WeeklyParlay = predictions.WeeklyParlay;
});
after(async () => { await server?.close(); });
test("actual Predictions and Matchup renders use the same saved score sum rather than the stale payload", () => {
  const snapshot = saved();
  const card = renderToStaticMarkup(createElement(PredictionCard, { prediction: snapshot }));
  const matchup = renderToStaticMarkup(createElement(Matchup, {
    awayCode: "SEA", homeCode: "DEN", week: 6, kickoff: snapshot.kickoff, savedPrediction: snapshot,
  }));
  assert.match(card, /Projected total 40/);
  assert.match(matchup, /Projected total 40/);
  assert.doesNotMatch(matchup, /Projected total (41|99)/);
  assert.doesNotMatch(matchup, /Scoring breakdown/);
  const source = readFileSync(new URL("../src/components/MatchupPrediction.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /getFullGamePrediction|createOfficialSnapshot/);
  assert.match(source, /!hasActual \|\| !officialSnapshot/);
});

test("actual Multi render guards invalid individual/combined odds while preserving probability and ticks/crosses", () => {
  for (const invalid of [null, undefined, 0, Infinity, NaN]) {
    const legs = [
      { awayCode: "SEA", homeCode: "DEN", market: "Moneyline", selection: "SEA", decimalOdds: 2, result: "won" },
      { awayCode: "CHI", homeCode: "ATL", market: "Anytime touchdown", selection: "Named Player anytime TD", decimalOdds: invalid, price: null, result: "lost" },
    ];
    const markup = renderToStaticMarkup(createElement(WeeklyParlay, {
      parlay: { legs, decimalOdds: invalid, modelProbability: .4, modelProbabilityThreshold: .55, locked: true, partial: true },
      week: 6,
    }));
    assert.match(markup, /Odds unavailable/);
    assert.match(markup, /Pending/);
    assert.match(markup, /Model probability 40.0%/);
    assert.match(markup, /Successful leg/);
    assert.match(markup, /Failed leg/);
    assert.doesNotMatch(markup, /Infinity|NaN|\$0\.00/);
  }
});
